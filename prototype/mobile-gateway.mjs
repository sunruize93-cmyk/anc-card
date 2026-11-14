import {validateAudioDeclaration, validateRawOpus, rawOpusFormat, maxRawBytes} from './audio/qs668.mjs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const hash = value => createHash('sha256').update(value).digest();
export function createMobileHandler({ config, db, upstream, host, fetcher = fetch, documentService = null }) {
  db.exec(`CREATE TABLE IF NOT EXISTS receipts (device TEXT, localId TEXT, sha256 TEXT NOT NULL,
    size INTEGER NOT NULL, PRIMARY KEY(device, localId));
    CREATE TABLE IF NOT EXISTS upload_events (at TEXT NOT NULL, device TEXT NOT NULL,
      localId TEXT NOT NULL, sha256 TEXT NOT NULL, duplicate INTEGER NOT NULL, client TEXT NOT NULL);`);
  const lookup = db.prepare('SELECT sha256 FROM receipts WHERE device=? AND localId=?');
  const allowedRecording = id => !!db.prepare('SELECT 1 FROM receipts WHERE device=? AND sha256=?').get(config.device, id);
  const inflight = new Set();
  const attempts = new Map();
  const limit = 64 * 1024 * 1024;
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" };
  return async (req, res) => {
    const reply = (code, body) => res.writeHead(code, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const bytes = async max => {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > max) throw Error('body-too-large'); chunks.push(c); }
      return Buffer.concat(chunks);
    };
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== 'https://' + host)) return reply(403, { error: '请求来源无效' });
    try {
      if (req.method === 'GET' && ['/', '/upload.js'].includes(req.url)) {
        const page = req.url === '/';
        return res.writeHead(200, { ...headers, 'Content-Type': page ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' })
          .end(await readFile(new URL(page ? './mobile-upload.html' : './mobile-upload-client.js', import.meta.url)));
      }
      if (req.method === 'POST' && req.url === '/v1/pair') {
        if (!config.pairingCodeHash || Date.now() >= config.pairingExpiresAt || Date.now() >= config.expiresAt) return reply(401, { error: '配对码已过期，请在 Mac 端重新准备。' });
        const address = req.socket.remoteAddress;
        if (attempts.size >= 64 && !attempts.has(address)) return reply(429, { error: '请稍后重试。' });
        if ((attempts.get(address) || 0) >= 10) return reply(429, { error: '配对尝试过多，请在 Mac 端重新准备。' });
        attempts.set(address, (attempts.get(address) || 0) + 1);
        let body; try { body = JSON.parse((await bytes(256)).toString()); } catch { return reply(400, { error: '配对输入无效' }); }
        if (typeof body.code !== 'string' || !/^\d{8}$/.test(body.code) ||
            !timingSafeEqual(hash(body.code), Buffer.from(config.pairingCodeHash, 'hex'))) return reply(401, { error: '配对码无效' });
        return reply(200, { token: config.token, device: config.device, expiresAt: config.expiresAt });
      }
      if (Date.now() >= config.expiresAt || !timingSafeEqual(hash(req.headers.authorization || ''), hash('Bearer ' + config.token))) return reply(401, { error: '设备凭证无效或过期，请重新配对。' });
      const preflight = /^\/v1\/recordings\/([a-f0-9]{64})\/cleanup-preflight$/.exec(req.url);
      if (req.method === 'GET' && preflight) {
        if (!allowedRecording(preflight[1])) return reply(404, { error: '此设备没有该录音的上传回执' });
        const r=await fetcher(upstream+'/'+preflight[1]+'/cleanup-preflight',{redirect:'error',signal:AbortSignal.timeout(10000)});
        if(!r.ok)return reply(502,{error:'清理预检暂不可用，保留原音'});
        const chunks=[];let size=0;for await(const chunk of r.body){size+=chunk.length;if(size>8192)return reply(502,{error:'清理预检无效，保留原音'});chunks.push(chunk);}
        const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(body.schemaVersion!=='anc.cleanup-preflight.v1'||body.scope!=='iphone_and_card'||body.recordingId!==preflight[1])return reply(502,{error:'清理预检绑定不符，保留原音'});
        return reply(200,body);
      }
      const artifact = /^\/v1\/recordings\/([a-f0-9]{64})\/documents\/([1-9][0-9]{0,8})\/(manifest\.json|document\.json|document\.md)$/.exec(req.url);
      if (req.method === 'GET' && artifact) {
        if (!allowedRecording(artifact[1])) return reply(404, { error: '此设备没有可用文档' });
        let item;
        if (documentService) item = await documentService.readArtifact(config.device, artifact[1], Number(artifact[2]), artifact[3]);
        else {
          const r = await fetcher(upstream + '/' + artifact[1] + '/documents/' + artifact[2] + '/' + artifact[3],
            { redirect: 'error', signal: AbortSignal.timeout(10000) });
          if (!r.ok) return reply(r.status === 404 ? 404 : 502, { error: '文档产物暂不可用' });
          const contentLength = Number(r.headers.get('content-length'));
          if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > 2 * 1024 * 1024) return reply(502, { error: '文档长度无效' });
          const chunks = []; let size = 0;
          for await (const chunk of r.body) {
            size += chunk.length;
            if (size > contentLength) return reply(502, { error: '文档长度不匹配' });
            chunks.push(chunk);
          }
          const data = Buffer.concat(chunks);
          if (data.length !== contentLength) return reply(502, { error: '文档产物不完整' });
          item = { bytes: data, contentType: artifact[3].endsWith('.md') ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8' };
        }
        if (!item) return reply(404, { error: '文档修订不存在' });
        return res.writeHead(200, { ...headers, 'Content-Type': item.contentType, 'Content-Length': item.bytes.length }).end(item.bytes);
      }
      const status = /^\/v1\/recordings\/([a-f0-9]{64})$/.exec(req.url);
      if (req.method === 'GET' && status) {
        if (!allowedRecording(status[1])) return reply(404, { error: '此设备没有该录音的上传回执' });
        const r = await fetcher(upstream + '/' + status[1] + '/delivery', { signal: AbortSignal.timeout(10000) });
        if (!r.ok) return reply(502, { error: '后台状态暂不可用' });
        const body = await r.json();
        if (documentService) body.document = await documentService.receipt(config.device, status[1]);
        return reply(200, body);
      }
      if (req.method === 'GET' && req.url === '/v1/sample' && config.sampleRecordingId) {
        const r = await fetcher(upstream + '/' + config.sampleRecordingId + '/audio', { signal: AbortSignal.timeout(10000) });
        if (!r.ok) return reply(502, { error: '测试样本暂不可用' });
        const audio = Buffer.from(await r.arrayBuffer());
        if (audio.length > limit || hash(audio).toString('hex') !== config.sampleRecordingId) return reply(502, { error: '样本校验失败' });
        return res.writeHead(200, { ...headers, 'Content-Type': 'audio/wav', 'Content-Disposition': 'attachment; filename="A-card.wav"' }).end(audio);
      }
      if (req.method !== 'POST' || req.url !== '/v1/recordings') return reply(404, { error: '未知入口' });
      const localId = req.headers['x-recording-id'], digest = req.headers['x-content-sha256'], filename = req.headers['x-anc-filename'];
      const size = Number(req.headers['content-length']);
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(localId || '') || !/^[a-f0-9]{64}$/.test(digest || '') || !filename) return reply(400, { error: '缺少录音标识、文件名或 SHA-256' });
      if (!Number.isSafeInteger(size) || size < 1 || size > limit) return reply(413, { error: '请选择不超过 64 MiB 的音频' });
      const audioFormat = req.headers['x-anc-audio-format'];
      try { validateAudioDeclaration(decodeURIComponent(filename), audioFormat, req.headers['content-type']); }
      catch (error) { return reply(error.status || 400, {error:error.message}); }
      if (audioFormat === rawOpusFormat && size > maxRawBytes) return reply(413, {error:'QS668 音频最多两小时'});
      const previous = lookup.get(config.device, localId);
      if (previous && previous.sha256 !== digest) return reply(409, { error: '录音标识已绑定不同文件' });
      if (inflight.has(localId) || inflight.size >= 2) return reply(429, { error: '上传进行中，请稍后重试' });
      inflight.add(localId);
      try {
        const file = await bytes(size);
        if (file.length !== size || hash(file).toString('hex') !== digest) return reply(422, { error: '文件长度或哈希不符' });
        if (audioFormat === rawOpusFormat) {
          try { validateRawOpus(file); } catch(error) { return reply(422,{error:error.message}); }
        }
        const r = await fetcher(upstream, { method: 'POST', headers: { 'X-ANC-Filename': filename,
          'X-ANC-Publish': '1', 'X-ANC-Device': config.device,
          ...(audioFormat ? {'X-ANC-Audio-Format':audioFormat,'Content-Type':'application/octet-stream'} : {}) }, body: file, signal: AbortSignal.timeout(60000) });
        if (!r.ok) return reply(r.status >= 500 ? 502 : r.status, { error: '后台未接收，请检查音频格式及群配置' });
        const body = await r.json();
        if (body.recording?.id !== digest) return reply(502, { error: '后台回执与原件不符' });
        const saved = db.prepare('INSERT INTO receipts VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(config.device, localId, digest, size);
        const duplicate = body.duplicate || !saved.changes;
        db.prepare('INSERT INTO upload_events VALUES(?,?,?,?,?,?)').run(new Date().toISOString(), config.device, localId, digest,
          Number(duplicate), req.headers['x-anc-client'] === 'web-upload' ? 'web-upload' : 'api');
        return reply(duplicate ? 200 : 201, { device: config.device, localId, recordingId: digest, sha256: digest, bytes: size,
          duplicate, ...(audioFormat ? {audioFormat} : {}), resultPath: '/v1/recordings/' + digest });
      } finally { inflight.delete(localId); }
    } catch { if (!res.destroyed && !res.headersSent) reply(503, { error: '服务或传输中断，请用相同文件重试。' }); }
  };
}

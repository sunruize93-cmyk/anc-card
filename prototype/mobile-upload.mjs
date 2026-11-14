// Historical upload-only experiment. Current phone gateway: iphone-upload.mjs + mobile-gateway.mjs.
// Separate LAN listener for one field-test device. All administration stays on localhost.
import { createServer } from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const directory = process.env.ANC_UPLOAD_DIR;
if (!directory || !process.env.ANC_UPLOAD_HOST) throw Error('设置 ANC_UPLOAD_DIR 和 ANC_UPLOAD_HOST');
const config = JSON.parse(readFileSync(join(directory,'device.json')));
if (!/^[a-f0-9]{64}$/.test(config.token) || !config.device || !Number.isFinite(config.expiresAt)) throw Error('测试设备配置无效');
const db = new DatabaseSync(join(directory,'receipts.sqlite'));
db.exec('CREATE TABLE IF NOT EXISTS receipts (device TEXT, localId TEXT, sha256 TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(device, localId))');
const lookup = db.prepare('SELECT sha256 FROM receipts WHERE device=? AND localId=?');
const persist = db.prepare('INSERT INTO receipts VALUES(?,?,?,?) ON CONFLICT DO NOTHING');
const inflight = new Set();
const hash = data => createHash('sha256').update(data).digest();
const upstream = 'http://127.0.0.1:' + (process.env.ANC_PROTOTYPE_PORT || 4785) + '/api/recordings';
const server = createServer({key:readFileSync(join(directory,'server.key')),cert:readFileSync(join(directory,'server.crt')),minVersion:'TLSv1.2'},async (req,res) => {
  function reply(status,body) {
    res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(body));
  }
  if(req.method!=='POST'||req.url!=='/v1/recordings') return reply(404,{error:'未知入口'});
  if(Date.now()>=config.expiresAt || !timingSafeEqual(hash(req.headers.authorization || ''),hash('Bearer '+config.token))) return reply(401,{error:'无效或已过期的设备凭证'});
  const localId=req.headers['x-recording-id'], digest=req.headers['x-content-sha256'], filename=req.headers['x-anc-filename'];
  const bytes=Number(req.headers['content-length']);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(localId || '') || !/^[a-f0-9]{64}$/.test(digest || '') || !filename) return reply(400,{error:'缺少录音标识、原文件名或 SHA-256'});
  if(!Number.isSafeInteger(bytes)||bytes<1||bytes>64*1024*1024) return reply(413,{error:'大小超出范围'});
  const previous=lookup.get(config.device,localId);
  if(previous && previous.sha256!==digest) return reply(409,{error:'同一设备录音标识已绑定不同文件'});
  if(inflight.has(localId) || inflight.size>=2) return reply(429,{error:'上传进行中，请稍后用相同录音标识重试'});
  inflight.add(localId);
  try {
    const chunks=[];let received=0;
    for await(const chunk of req) {
      received+=chunk.length;
      if(received>bytes) return reply(400,{error:'文件大小不符'});
      chunks.push(chunk);
    }
    const file=Buffer.concat(chunks);
    if(file.length!==bytes||hash(file).toString('hex')!==digest) return reply(422,{error:'原件哈希或长度不符'});
    const upstreamReply=await fetch(upstream,{method:'POST',headers:{'X-ANC-Filename':filename},body:file,signal:AbortSignal.timeout(60000)});
    if(!upstreamReply.ok) return reply(upstreamReply.status>=500?502:upstreamReply.status,{error:'后台录音队列未接收'});
    const body=await upstreamReply.json();
    if(body.recording?.id!==digest) return reply(502,{error:'后台回执与原件不符'});
    const saved=persist.run(config.device,localId,digest,bytes);
    const duplicate=body.duplicate || !saved.changes;
    return reply(duplicate?200:201,{device:config.device,localId,recordingId:digest,sha256:digest,bytes,duplicate});
  } catch { if(!res.destroyed) reply(503,{error:'上传中断，请使用相同标识重试'}); }
  finally { inflight.delete(localId); }
});
server.requestTimeout=120000;
server.listen(Number(process.env.ANC_UPLOAD_PORT||4786),process.env.ANC_UPLOAD_HOST);

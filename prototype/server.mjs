import { createServer } from 'node:http';
import { readFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approve, blocked, initialState, receiveResult, start } from './loop.mjs';
import { execute } from './worker.mjs';
import { audioTypes, maxAudioBytes, openRecordings } from './recordings.mjs';
import { configureSpeakmode, speakmodeStatus } from './speakmode.mjs';

const port = Number(process.env.ANC_PROTOTYPE_PORT || 4785);
const address = '127.0.0.1';
const host = `${address}:${port}`;
const page = await readFile(new URL('./index.html', import.meta.url));
const recordings = await openRecordings(process.env.ANC_DATA_DIR ||
  fileURLToPath(new URL('../.anc-data/', import.meta.url)));
let state = initialState();
let directory;
let pending = Promise.resolve();

function reply(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }).end(JSON.stringify(data));
}

function run() {
  const task = state;
  pending = (async () => {
    try {
      if (!directory) directory = await mkdtemp(join(await realpath(tmpdir()), 'anc-prototype-'));
      const result = await execute(directory, task);
      state = receiveResult(state, result);
    } catch (error) {
      console.error(error.message);
      state = blocked(state, error.message);
    }
  })();
}

async function importRecording(request, response) {
  let name;
  try {
    name = decodeURIComponent(request.headers['x-anc-filename']);
  } catch {
    return reply(response, 400, { error: '文件名无效。' });
  }
  if (name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(name) ||
      !Object.hasOwn(audioTypes, extname(name).toLowerCase())) {
    return reply(response, 400, { error: '请选择 WAV、M4A 或 MP3 文件。' });
  }
  const declared = Number(request.headers['content-length']);
  if (!Number.isSafeInteger(declared) || declared < 1) {
    return reply(response, 411, { error: '请上传大小已知的非空音频文件。' });
  }
  if (declared > maxAudioBytes) return reply(response, 413, { error: '单个文件最多 64 MiB。' });
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const audio = Buffer.concat(chunks);
  if (audio.length !== declared) return reply(response, 400, { error: '上传未完成。' });

  const result = recordings.import(name, audio);
  return reply(response, result.duplicate ? 200 : 202, result);
}

function serveAudio(request, response, id) {
  const info = recordings.info(id);
  if (!info) return reply(response, 404, { error: '录音不存在。' });
  const range = request.headers.range;
  const headers = {
    'Content-Type': audioTypes[extname(info.name).toLowerCase()],
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  let start = 0;
  let end = info.size - 1;
  if (range) {
    const parts = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (parts?.[1]) {
      start = Number(parts[1]);
      if (parts[2]) end = Math.min(Number(parts[2]), end);
    } else if (parts?.[2]) {
      start = Math.max(0, info.size - Number(parts[2]));
    }
    if (!parts || (!parts[1] && !parts[2]) || start > end) {
      return response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }
  const length = end - start + 1;
  headers['Content-Length'] = length;
  response.writeHead(range ? 206 : 200, headers);
  response.end(request.method === 'HEAD' ? undefined : recordings.readAudio(id, start, length));
}

const server = createServer(async (request, response) => {
  if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== `http://${host}`)) {
    return reply(response, 403, { error: '仅允许本机原型页面访问。' });
  }
  if (request.method === 'GET' && request.url === '/') {
    return response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page);
  }
  if (request.method === 'GET' && request.url === '/api/state') return reply(response, 200, state);
  if (request.url === '/api/speakmode') {
    if (request.method === 'GET') return reply(response, 200, await speakmodeStatus());
    if (request.method === 'POST') {
      try {
        let bytes = 0;
        const chunks = [];
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 8192) return reply(response, 413, { error: '配置请求过长。' });
          chunks.push(chunk);
        }
        const { region, key } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        await configureSpeakmode(region, key);
        return reply(response, 200, await speakmodeStatus());
      } catch (error) {
        return reply(response, 400, { error: error instanceof SyntaxError ? '配置请求无效。' : error.message });
      }
    }
  }
  if (request.url === '/api/recordings') {
    if (request.method === 'GET') return reply(response, 200, recordings.list());
    if (request.method === 'POST') {
      try {
        return await importRecording(request, response);
      } catch (error) {
        console.error(error.message);
        return reply(response, 500, { error: '录音导入失败，请查看启动终端。' });
      }
    }
  }
  const recordingRoute = /^\/api\/recordings\/([a-f0-9]{64})\/(audio|retry)$/.exec(request.url);
  if (recordingRoute) {
    const [, id, action] = recordingRoute;
    if (action === 'audio' && ['GET', 'HEAD'].includes(request.method)) return serveAudio(request, response, id);
    if (action === 'retry' && request.method === 'POST') {
      const recording = recordings.retry(id);
      return recording ? reply(response, 202, recording) : reply(response, 409, { error: '仅失败的录音可重试。' });
    }
  }
  if (request.method !== 'POST' || request.url !== '/api/action') return reply(response, 404, {});
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 2048) return reply(response, 413, { error: '请求过长。' });
      chunks.push(chunk);
    }
    const action = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (action.kind === 'start' && state.status === 'ready') {
      state = start(state);
      run();
    } else if (action.kind === 'approve') {
      const next = approve(state, action.proposalId);
      if (!next) return reply(response, 409, { error: '这条建议已处理或过期。' });
      state = next;
      run();
    } else if (action.kind === 'reset' && !['ready', 'running'].includes(state.status)) {
      const previous = directory;
      directory = undefined;
      state = initialState();
      if (previous) await rm(previous, { recursive: true });
    } else {
      return reply(response, 409, { error: '当前状态下无法执行这个操作。' });
    }
    return reply(response, 202, state);
  } catch {
    return reply(response, 400, { error: '无法处理这个请求。' });
  }
});
server.listen(port, address, () => console.log(`ANC Card 原型  http://${host}`));
async function stop() {
  await new Promise(resolve => server.close(resolve));
  await recordings.close();
  await pending;
  if (directory) await rm(directory, { recursive: true });
  process.exit(0);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

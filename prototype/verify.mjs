// Offline acceptance uses synthetic audio and an explicit SpeakMode CLI fixture.
// It verifies queue recovery and evidence binding, not cloud ASR accuracy.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseReceipt, splitWav } from './speakmode.mjs';

const root = await mkdtemp(join(tmpdir(), 'anc-speakmode-verify-'));
const fixture = join(root, 'file-asr-fixture.mjs');
const db = join(root, 'data');
const audioPath = join(root, 'sample.wav');
const failAt = join(root, 'fail-at');
const blockAt = join(root, 'block-at');
const callsPath = join(root, 'calls.jsonl');
let child;
let fixturePid;
let logs = '';

async function waitFor(operation) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await delay(40);
  }
  throw new Error('验证超时。' + logs);
}

const portProbe = createServer();
portProbe.listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const url = `http://127.0.0.1:${port}`;

async function start() {
  child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    env: { ...process.env, ANC_DATA_DIR: db, ANC_PROTOTYPE_PORT: String(port),
      ANC_SPEAKMODE_BIN: fixture, ANC_SPEAKMODE_CONFIG_DB: join(root, 'fixture-config.sqlite'),
      ANC_VERIFY_CONTROL: root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs += chunk);
  child.stderr.on('data', chunk => logs += chunk);
  await waitFor(() => fetch(url + '/api/recordings').then(res => res.ok).catch(() => false));
}

async function stop(signal = 'SIGTERM') {
  const exited = once(child, 'exit');
  child.kill(signal);
  await exited;
  child = undefined;
}

const list = async () => (await fetch(url + '/api/recordings')).json();
const state = status => waitFor(async () => (await list()).find(row => row.status === status));
async function upload(body, name = '自制录音.wav') {
  const response = await fetch(url + '/api/recordings', {
    method: 'POST', headers: { 'X-ANC-Filename': encodeURIComponent(name) }, body,
  });
  return { status: response.status, ...await response.json() };
}
const retry = id => fetch(url + `/api/recordings/${id}/retry`, { method: 'POST' });
const calls = async () => (await readFile(callsPath, 'utf8')).trim().split('\n').map(JSON.parse);

try {
  const generated = spawn('sh', [fileURLToPath(new URL('./scripts/make-sample.sh', import.meta.url)), audioPath], { stdio: 'ignore' });
  assert.equal((await once(generated, 'exit'))[0], 0);
  const wave = await readFile(audioPath);
  const chunks = splitWav(wave);
  assert.equal(chunks.length, 5);
  assert.ok(chunks[1].startMs > 7000 && chunks[1].endMs < 17000);
  assert.ok(chunks[3].startMs > 17000 && chunks[3].endMs < 27000);
  for (const chunk of chunks) {
    assert.ok(chunk.endMs > chunk.startMs);
    assert.ok(chunk.samples <= 480000);
    assert.equal(chunk.audio.length, chunk.samples * 2 + 44);
  }
  assert.throws(() => splitWav(wave.subarray(0, wave.length - 1)), /无效|不完整/);
  console.log('PASS 自制 PCM 音频分段、样本偏移和损坏输入检查');

  await writeFile(fixture, `#!${process.execPath}
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, index, all) => index % 2 ? pairs : [...pairs, [item, all[index+1]]], []));
const root = process.env.ANC_VERIFY_CONTROL;
const audio = await readFile(args['--wav']);
const index = Number(/chunk-(\\d+)\\.wav$/.exec(args['--wav'])[1]);
await appendFile(join(root, 'calls.jsonl'), JSON.stringify({index,pid:process.pid})+'\\n');
const control = name => readFile(join(root,name),'utf8').then(Number, () => -1);
if (await control('fail-at') === index) { console.error(JSON.stringify({errorCode:'rate_limited'})); process.exit(1); }
if (await control('block-at') === index) {
  await writeFile(join(root,'blocked-pid'), String(process.pid));
  while (await control('block-at') === index) await delay(100);
}
const texts = ['今天开会，测试环境已经准备好了。', '由小王负责整理会议纪要，截止时间是本周五。',
  '接着确认下周的安排。', '由小李负责更新测试文档，截止时间是下周一。', '今天讨论到这里。'];
const attemptId = randomUUID();
const metadata = { attemptId, audioSha256:createHash('sha256').update(audio).digest('hex'), audioSamples:(audio.length-44)/2 };
const source = { id:randomUUID(), asrAttemptId:attemptId, provider:'aliyun',model:'qwen3-asr-flash',
  adapterVersion:'qwen-file-lab-v1',complete:true,items:[{text:texts[index],final:true}] };
await writeFile(args['--out'], JSON.stringify({...metadata,status:'started'})+'\\n'+JSON.stringify({...metadata,status:'passed',source})+'\\n');
`);
  await chmod(fixture, 0o700);
  await writeFile(join(root, 'fixture-config.sqlite'), 'OFFLINE FIXTURE CONFIG');
  await writeFile(failAt, '1');
  await start();
  const imports = await Promise.all([upload(wave), upload(wave, '重复录音.wav')]);
  assert.deepEqual(imports.map(result => result.status).sort(), [200, 202]);
  const id = imports[0].recording.id;
  const failed = await state('failed');
  assert.equal(failed.id, id);
  assert.equal(failed.ledger, null);
  assert.match(failed.error, /限流/);
  assert.deepEqual((await calls()).map(call => call.index), [0, 1]);
  await stop();
  await rm(failAt);
  await writeFile(blockAt, '3');
  await start();
  assert.deepEqual((await list())[0], failed);
  const retries = await Promise.all([retry(id), retry(id)]);
  assert.deepEqual(retries.map(response => response.status).sort(), [202, 409]);
  fixturePid = await waitFor(() => readFile(join(root, 'blocked-pid'), 'utf8').then(Number, () => null));
  assert.deepEqual((await calls()).map(call => call.index), [0, 1, 1, 2, 3]);
  assert.equal((await list())[0].ledger, null);
  await stop('SIGKILL');
  process.kill(fixturePid, 'SIGTERM');
  fixturePid = undefined;
  await rm(blockAt);
  await start();
  const completed = await state('complete');
  assert.equal(completed.attempts, 3);
  assert.equal(completed.id, id);
  assert.deepEqual((await calls()).map(call => call.index), [0, 1, 1, 2, 3, 3, 4]);
  assert.deepEqual(completed.ledger.map(task => [task.owner, task.deadline]), [['小王', '本周五'], ['小李', '下周一']]);
  for (const task of completed.ledger) {
    const segment = completed.transcript.find(segment => segment.sourceId === task.sourceId);
    assert.equal(task.startMs, segment.startMs);
    assert.equal(task.endMs, segment.endMs);
    assert.equal(task.chunkSha256, segment.chunkSha256);
    assert.equal(task.evidence, segment.text);
    assert.equal(task.timing, 'audio_chunk');
  }
  const audio = await fetch(url + `/api/recordings/${id}/audio`);
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), wave);
  const range = await fetch(url + `/api/recordings/${id}/audio`, { headers: { Range: 'bytes=100-199' } });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), wave.subarray(100, 200));
  console.log('PASS 并发去重、限流失败重试、分段断点复用、SIGKILL 恢复、台账证据绑定和原音频回听读取');
  await stop();
  await start();
  assert.deepEqual((await list())[0], completed);
  assert.equal((await upload(wave)).duplicate, true);
  assert.equal((await calls()).length, 7);
  console.log('PASS 已完成台账重启后保持原条目 ID，重复导入未派发转写');

  assert.deepEqual(await readdir(join(root, 'data/asr-work')), []);
  // Check that a superficially successful receipt cannot be rebound to another audio.
  const fake = JSON.stringify({ status: 'started', attemptId: 'a' }) + '\n' + JSON.stringify({
    status: 'passed', attemptId: 'a', audioSha256: 'wrong', audioSamples: chunks[0].samples,
    source: { complete: true, provider: 'aliyun', model: 'qwen3-asr-flash', adapterVersion: 'qwen-file-lab-v1',
      asrAttemptId: 'a', items: [{ final: true, text: '由小王负责整理文档。' }] },
  });
  assert.throws(() => parseReceipt(fake, chunks[0]), /不匹配/);
  assert.throws(() => parseReceipt('', chunks[0]));
  console.log('PASS 回执内容、音频哈希及完整性校验');
  console.log('OFFLINE VERIFIED — 使用协议夹具，未调用阿里云，不代表真实语音识别验收。');
} finally {
  if (child) await stop();
  if (fixturePid) process.kill(fixturePid, 'SIGTERM');
  await rm(root, { recursive: true, force: true });
}

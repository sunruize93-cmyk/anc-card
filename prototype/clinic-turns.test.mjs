import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Worker } from 'node:worker_threads';

// Use local executables with the production CLI contract. They only read fixture WAVs and write receipts.
const directory = await mkdtemp(join(tmpdir(), 'anc-clinic-test-'));
const mockBinary = join(directory, 'speakmode-fixture.mjs');
const config = join(directory, 'config.json');
const settings = { ANC_CLINIC_TURNS_BIN: join(directory, 'clinic_turns.mjs'), ANC_CLINIC_ASR_BIN: join(directory, 'clinic_asr.mjs'), ANC_SPEAKMODE_BIN: join(directory, 'disabled-standard-asr'), ANC_SPEAKMODE_CONFIG_DB: config };
const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
Object.assign(process.env, settings);
after(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
});
const { alignQuietCuts, parseTurnReceipt, sliceTurn, transcribeClinicChunk } = await import('./clinic-turns.mjs');
const { splitWav } = await import('./speakmode.mjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function chunk(seed = 4096, samples = 1667) { // Default length is 104.1875 ms.
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(seed + i, 44 + i * 2);
  const [part] = splitWav(wav);
  return { ...part, index: 3, startMs: 1500, endMs: 1500 + Math.ceil(samples / 16) };
}

const turns = [{ startMs: 0, endMs: 47, speakerId: 0 }, { startMs: 47, endMs: 104, speakerId: 1 }];
function receipt(c) {
  const common = { attemptId: 'local-plan', model: 'qwen-audio-3.1-asr-flash', adapterVersion: 'anc-clinic-turns-v1', audioSha256: c.sha256, audioSamples: c.samples };
  return [{ ...common, status: 'started' }, { ...common, status: 'passed', boundaryMode: 'provider_turns', turns: structuredClone(turns) }];
}
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

// This temporary CLI receives no expected speech or language hints. Hashes are computed from the exact input it receives.
await writeFile(mockBinary, `#!${process.execPath}\n` + String.raw`
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const protocolLog = process.env.ANC_FIXTURE_CLINIC_PROTOCOL;
if (protocolLog) appendFileSync(protocolLog, JSON.stringify(process.argv.slice(2))+'\n');
if (process.argv.length === 3 && process.argv[2] === '--capabilities') {
  const helper = basename(process.argv[1], '.mjs');
  const capabilities = {helper, keychainInteraction:false};
  if (helper === 'clinic_session') capabilities.roles = process.env.ANC_FIXTURE_CLINIC_ROLES.split(',');
  console.log(JSON.stringify(capabilities)); process.exit(0);
}
const arg = flag => process.argv[process.argv.indexOf(flag)+1];
const cfg = JSON.parse(readFileSync(arg('--config-db')));
const file = arg('--wav');
const wav = readFileSync(file);
const sha = createHash('sha256').update(wav).digest('hex');
const samples = wav.readUInt32LE(40)/2;
const isAsr = process.argv.includes('--language');
const stage = isAsr ? basename(file) : 'detect';
appendFileSync(cfg.log, JSON.stringify({stage, sha, samples})+'\n');
if (cfg.fail === stage) { process.stderr.write(JSON.stringify({errorCode:cfg.errorCode || 'rate_limited', detail:'fixture-private-detail'})); process.exit(1); }
const attemptId = stage + '-' + sha.slice(0,12);
let base = {attemptId, audioSamples:samples, audioSha256:cfg.corrupt === stage ? 'bad-origin' : sha};
let result;
if (isAsr) {
  if (arg('--language')!=='auto') process.exit(2);
  base.language='auto';
  result={source:{ id:'fixture', complete:true, provider:'aliyun', model:'qwen3-asr-flash', adapterVersion:cfg.asrAdapter || 'anc-clinic-file-v1', asrAttemptId:attemptId, items:[{final:true,text:'fixture '+stage}] }};
} else {
  Object.assign(base,{model:'qwen-audio-3.1-asr-flash', adapterVersion:'anc-clinic-turns-v1'});
  result={ boundaryMode:'provider_turns', turns:cfg.turns };
}
writeFileSync(arg('--out'), [ { ...base, status:'started' }, { ...base, ...result, status:'passed' } ].map(row => JSON.stringify(row)).join('\n')+'\n');
`, { mode: 0o700 });

await copyFile(mockBinary, settings.ANC_CLINIC_TURNS_BIN);
await copyFile(mockBinary, settings.ANC_CLINIC_ASR_BIN);

function makeCache() {
  const entries = new Map();
  return { get: key => entries.get(key), put: (key, value) => entries.set(key,value) };
}
function fixture(log, control={}) { return writeFile(config, JSON.stringify({log,turns,...control})); }
async function calls(log) { return (await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line)); }

// Import production modules afresh with an isolated os.homedir() and no binary overrides.
// If default selection regresses, only the fixture installation is visible to that worker.
const sessionWorker = join(directory,'session-worker.mjs');
await writeFile(sessionWorker, `
  import os from 'node:os';
  import { syncBuiltinESMExports } from 'node:module';
  import { parentPort, workerData } from 'node:worker_threads';
  os.homedir = () => workerData.installHome;
  syncBuiltinESMExports();
  const { transcribeClinicChunk } = await import(workerData.module);
  const chunk = {...workerData.chunk, audio:Buffer.from(workerData.chunk.audio)};
  const entries = new Map();
  const cache = {get:key=>entries.get(key), put:(key,value)=>entries.set(key,value)};
  try {
    const segments = await transcribeClinicChunk(chunk,workerData.work,new AbortController().signal,cache);
    parentPort.postMessage({text:segments.map(s=>s.text)});
  } catch (error) {
    parentPort.postMessage({error:error.message});
  }
`);
async function runDefaultSession({roles='clinic_turns,clinic_asr', fail}={}) {
  const work=await mkdtemp(join(directory,'session-'));
  const bin=join(work,'.local/share/anc-card/speakmode/bin');
  await mkdir(bin,{recursive:true});
  await copyFile(mockBinary,join(bin,'clinic_session'));
  const log=join(work,'recording.jsonl'), protocol=join(work,'protocol.jsonl'), configPath=join(work,'config.json');
  await writeFile(configPath,JSON.stringify({log,turns,fail,errorCode:'clinic_keychain_access_required'}));
  const env={...process.env, ANC_SPEAKMODE_CONFIG_DB:configPath, ANC_FIXTURE_CLINIC_PROTOCOL:protocol, ANC_FIXTURE_CLINIC_ROLES:roles};
  for (const name of ['ANC_CLINIC_SESSION_BIN','ANC_CLINIC_TURNS_BIN','ANC_CLINIC_ASR_BIN']) delete env[name];
  const worker=new Worker(sessionWorker,{env,workerData:{module:new URL('./clinic-turns.mjs',import.meta.url).href,chunk:chunk(),work,installHome:work}});
  const [result]=await once(worker,'message');
  const args=await calls(protocol);
  return {result,args};
}

test('the default session helper advertises both roles and handles boundaries and original-language turns', async () => {
  const {result,args}=await runDefaultSession();
  assert.deepEqual(result.text,['fixture chunk-0.wav','fixture chunk-1.wav']);
  assert.deepEqual(args[0],['--capabilities']);
  const invocations=args.slice(1);
  assert.deepEqual(invocations.map(a=>a.includes('--language') ? a[a.indexOf('--language')+1] : null),[null,'auto','auto']);
  assert.ok(invocations.every(a=>a.includes('--wav') && a.includes('--out') && !a.includes('--authorize')));
  for (const role of ['clinic_turns','clinic_asr']) {
    const incomplete=await runDefaultSession({roles:role});
    assert.ok(incomplete.result.error);
    assert.deepEqual(incomplete.args,[['--capabilities']]);
  }
});

test('a denied session stops at the failed stage without launching authorization or a fallback', async () => {
  for (const [stage,expectedUploads] of [['detect',1],['chunk-0.wav',2]]) {
    const {result,args}=await runDefaultSession({fail:stage});
    assert.match(result.error,/clinic_keychain_access_required/);
    assert.deepEqual(args[0],['--capabilities']);
    assert.equal(args.length,1+expectedUploads);
    assert.ok(args.slice(1).every(a=>a.includes('--wav') && !a.includes('--authorize')));
  }
});

test('an old helper blocks clinic processing before either helper receives audio', async () => {
  const log = join(directory, 'old-helper.jsonl');
  await fixture(log);
  await writeFile(settings.ANC_CLINIC_ASR_BIN, `#!${process.execPath}\nprocess.exit(1);`);
  try {
    await assert.rejects(transcribeClinicChunk(chunk(),directory,new AbortController().signal,makeCache()), /版本不支持无弹窗访问/);
    await assert.rejects(readFile(log), {code:'ENOENT'});
  } finally {
    await copyFile(mockBinary, settings.ANC_CLINIC_ASR_BIN);
  }
});

test('credential failures identify the failed stage without a second attempt or exposing raw output', async () => {
  for (const [stage, label] of [['detect','话轮划分'],['chunk-0.wav','原声转写']]) {
    const log = join(directory, 'keychain-' + stage + '.jsonl');
    await fixture(log, {fail:stage, errorCode:'clinic_keychain_access_required'});
    await assert.rejects(transcribeClinicChunk(chunk(),directory,new AbortController().signal,makeCache()), e =>
      e.message.includes(label) && e.message.includes('clinic_keychain_access_required') && !e.message.includes('fixture-private-detail'));
    assert.deepEqual((await calls(log)).map(row => row.stage), stage === 'detect' ? ['detect'] : ['detect','chunk-0.wav']);
  }
});

test('model failures retain a known diagnostic code and redact unrecognized CLI output', async () => {
  for (const stage of ['detect','chunk-0.wav']) {
    const log = join(directory,'diagnostic-' + stage + '.jsonl');
    for (const code of ['file_asr_service_error','fixture_sensitive_value']) {
      await fixture(log,{fail:stage,errorCode:code});
      await assert.rejects(transcribeClinicChunk(chunk(),directory,new AbortController().signal,makeCache()), error =>
        error.message.includes('file_asr_service_error') === (code === 'file_asr_service_error') &&
        !error.message.includes('fixture_sensitive_value') && !error.message.includes('fixture-private-detail'));
    }
  }
});

// The provider can return the floor or ceil of the final millisecond. Both must preserve the original PCM.
test('turn WAVs reconstruct the exact input PCM for both rounded end times', () => {
  const c = chunk();
  for (const endMs of [104,105]) {
    const rows = receipt(c);
    rows[1].turns[1].endMs = endMs;
    const plan = parseTurnReceipt(jsonl(rows), c);
    const parts = plan.turns.map((turn,i) => sliceTurn(c,turn,i,i===1));
    assert.deepEqual(parts.map(p=>[p.startMs,p.endMs,p.samples]), [[1500,1547,752],[1547,1605,915]]);
    for (const p of parts) {
      assert.equal(p.sha256, hash(p.audio));
      assert.equal(p.audio.readUInt32LE(40), p.samples*2);
      assert.equal(p.audio.readUInt32LE(4), p.audio.length-8);
    }
    assert.deepEqual(Buffer.concat(parts.map(p=>p.audio.subarray(44))), c.audio.subarray(44));
  }
});

test('quiet-cut adjustment keeps original PCM including the fractional ending and ignores distant gaps', () => {
  const c = chunk(4096, 16 * 600 + 3);
  const speechTurns = [{ startMs: 0, endMs: 250, speakerId: 0 }, { startMs: 250, endMs: 601, speakerId: 1 }];
  const withoutPause = alignQuietCuts(c, speechTurns);
  assert.deepEqual(withoutPause, speechTurns);
  const quiet = (startMs, endMs) => c.audio.fill(0, 44 + startMs * 32, 44 + endMs * 32);
  quiet(430, 500);
  assert.deepEqual(alignQuietCuts(c, speechTurns), speechTurns);
  quiet(295, 360);
  c.sha256 = hash(c.audio);
  const aligned = alignQuietCuts(c, speechTurns);
  assert.ok(aligned[0].endMs > 295 && aligned[0].endMs < 360);
  assert.equal(aligned[1].startMs, aligned[0].endMs);
  assert.equal(speechTurns[0].endMs, 250);
  assert.deepEqual(aligned.map(t=>t.speakerId), [0,1]);
  const pieces=aligned.map((t,i)=>sliceTurn(c,t,i,i===1));
  assert.equal(pieces[0].startMs, c.startMs);
  assert.equal(pieces[0].endMs, pieces[1].startMs);
  assert.equal(pieces[1].endMs, c.endMs);
  assert.deepEqual(Buffer.concat(pieces.map(part=>part.audio.subarray(44))), c.audio.subarray(44));
});

test('rejects receipts from a different audio/attempt and malformed turn ranges', () => {
  const c=chunk();
  for (const mutate of [
    rows=>{rows[0].audioSha256='other'}, rows=>{rows[1].audioSha256='other'},
    rows=>{rows[1].audioSamples--}, rows=>{rows[1].attemptId='stale'}, rows=>{rows[1].status='failed'},
    rows=>{rows[1].turns[1].startMs=48}, rows=>{rows[1].turns[1].startMs=46},
    rows=>{rows[1].turns[0].startMs=1}, rows=>{rows[1].turns[0].endMs=0},
    rows=>{rows[1].turns[1].endMs=103}, rows=>{rows[1].turns[1].endMs=106},
    rows=>{rows[1].turns[0].endMs=47.5}, rows=>{rows[1].turns[1].speakerId=-1},
  ]) {
    const rows=receipt(c); mutate(rows);
    assert.throws(()=>parseTurnReceipt(jsonl(rows),c));
  }
});

test('retry reuses the verified plan and completed turn; same-size new audio gets a fresh plan', async () => {
  const log = join(directory, 'retry.jsonl');
  const c=chunk(), cache=makeCache(), signal=new AbortController().signal;
  await fixture(log,{fail:'chunk-1.wav'});
  await assert.rejects(transcribeClinicChunk(c,directory,signal,cache), /限流/);
  await fixture(log);
  const segments=await transcribeClinicChunk(c,directory,signal,cache);
  assert.deepEqual((await calls(log)).map(row=>row.stage), ['detect','chunk-0.wav','chunk-1.wav','chunk-1.wav']);
  assert.deepEqual(segments.map(s=>[s.startMs,s.endMs,s.speakerId,s.speakerScope,s.text]),
    [[1500,1547,0,3,'fixture chunk-0.wav'],[1547,1605,1,3,'fixture chunk-1.wav']]);
  assert.equal(segments[0].adapterVersion, 'anc-clinic-file-v1');
  assert.equal(segments[0].timingMethod, 'clinic-speaker-turn-asr-v2');
  const called=await calls(log);
  assert.equal(called[0].sha,c.sha256);
  assert.deepEqual(segments.map(s=>s.chunkSha256),[called[1].sha,called[3].sha]);
  assert.equal(segments[0].boundaryAttemptId,segments[1].boundaryAttemptId);
  assert.deepEqual(await transcribeClinicChunk(c,directory,signal,cache),segments);
  assert.deepEqual(await calls(log),called);
  const changed=chunk(4097);
  const second=await transcribeClinicChunk(changed,directory,signal,cache);
  assert.deepEqual((await calls(log)).slice(-3).map(x=>x.stage),['detect','chunk-0.wav','chunk-1.wav']);
  assert.notEqual(segments[0].boundaryAttemptId,second[0].boundaryAttemptId);
  assert.notEqual(segments[0].chunkSha256,second[0].chunkSha256);
});

test('invalid provider receipts do not seed a retry with an unverified plan or transcript', async () => {
  const log=join(directory,'bad-receipt.jsonl');
  const c=chunk(), cache=makeCache(), signal=new AbortController().signal;
  await fixture(log,{corrupt:'detect'});
  await assert.rejects(transcribeClinicChunk(c,directory,signal,cache), /原音不匹配/);
  await fixture(log,{corrupt:'chunk-0.wav'});
  await assert.rejects(transcribeClinicChunk(c,directory,signal,cache), /回执不完整/);
  await fixture(log,{asrAdapter:'qwen-file-lab-v1'});
  await assert.rejects(transcribeClinicChunk(c,directory,signal,cache), /回执不完整/);
  await fixture(log);
  assert.equal((await transcribeClinicChunk(c,directory,signal,cache)).length,2);
  assert.deepEqual((await calls(log)).map(x=>x.stage),['detect','detect','chunk-0.wav','chunk-0.wav','chunk-0.wav','chunk-1.wav']);
});

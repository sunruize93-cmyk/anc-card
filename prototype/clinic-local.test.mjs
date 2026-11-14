import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { localAsrReady, parseLocalReceipt } from './clinic-local.mjs';
import { sliceTurn, transcribeClinicChunk } from './clinic-turns.mjs';

const dir = await mkdtemp(join(tmpdir(), 'anc-clinic-local-'));
const fixture = join(dir, 'python-fixture.mjs'), log = join(dir, 'calls.jsonl');
const model = 'mlx-community/Qwen3-ASR-1.7B-4bit';
const revision = '78a389c776a5483b2d0d4ea5494e11012e0d6159';
const glossarySha256 = '187e1904ff8b6931a58071145a7779c5df1648dfb480c160d279d0b0854407e5';
const control = join(dir, 'control.json');
const previousPython = process.env.ANC_CLINIC_LOCAL_PYTHON;
process.env.ANC_CLINIC_LOCAL_PYTHON = fixture;
after(async () => {
  if (previousPython === undefined) delete process.env.ANC_CLINIC_LOCAL_PYTHON;
  else process.env.ANC_CLINIC_LOCAL_PYTHON = previousPython;
  await rm(dir, { recursive: true, force: true });
});
await writeFile(fixture, `#!${process.execPath}
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (basename(args.shift()) !== 'clinic_local.py' || process.env.HF_HUB_OFFLINE !== '1') process.exit(2);
const { badRevision } = JSON.parse(readFileSync(${JSON.stringify(control)}));
const base = { model:${JSON.stringify(model)}, revision:badRevision ? 'wrong' : ${JSON.stringify(revision)} };
if (args.join(' ') === '--check') { console.log(JSON.stringify({...base,ready:true})); process.exit(0); }
if (args.length !== 6 || args[0] !== '--wav' || args[2] !== '--out' || args[4] !== '--attempt') process.exit(2);
const audio = readFileSync(args[1]), sha = createHash('sha256').update(audio).digest('hex');
const result = {...base, attemptId:args[5], audioSha256:sha, audioSamples:audio.readUInt32LE(40)/2,
  adapterVersion:'anc-local-qwen-38-v1', glossarySha256:${JSON.stringify(glossarySha256)}, text:'원문입니다.', detectedLanguage:'Korean'};
appendFileSync(${JSON.stringify(log)}, sha+'\\n'); writeFileSync(args[3], JSON.stringify(result));
`, { mode: 0o700 });

test('readiness checks the pinned revision from the offline runtime', async () => {
  await writeFile(control, '{"badRevision":true}');
  assert.equal(await localAsrReady(), false);
  await writeFile(control, '{}');
  assert.equal(await localAsrReady(), true);
});

test('rejects stale attempts, wrong audio, model, glossary, or unusable text', () => {
  const meta={model,revision,glossarySha256,adapterVersion:'anc-local-qwen-38-v1',detectedLanguage:'Korean',
    text:'实际原文',attemptId:'attempt',audioSha256:'hash',audioSamples:3200};
  const part={sha256:'hash',samples:3200,startMs:0,endMs:200};
  const unlabeled=parseLocalReceipt({...meta,detectedLanguage:null},part,'attempt');
  assert.equal(unlabeled.reportedLanguage,null);
  assert.equal(unlabeled.text,meta.text);
  const {detectedLanguage, ...missingLabel}=meta;
  assert.throws(()=>parseLocalReceipt(missingLabel,part,'attempt'), /不匹配/);
  for(const bad of [{attemptId:'prior'}, {audioSha256:'other'}, {audioSamples:3201}, {model:'other'},
    {revision:'other'}, {adapterVersion:'other'}, {glossarySha256:'other'}, {text:'  '}, {detectedLanguage:42}]) {
    assert.throws(()=>parseLocalReceipt({...meta,...bad},part,'attempt'), /不匹配/);
  }
});

test('resume reuses the boundary plan but keeps local and cloud turn transcripts independent', async () => {
  await writeFile(control, '{}');
  const samples=3200, wav=Buffer.alloc(44+samples*2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVEfmt ',8);
  wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(16000,24);
  wav.writeUInt32LE(32000,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(samples*2,40);
  const chunk={audio:wav,samples,sha256:createHash('sha256').update(wav).digest('hex'),startMs:1000,endMs:1200,index:2};
  const bounds={attemptId:'existing-boundaries',boundaryMode:'provider_turns',turns:[
    {startMs:0,endMs:80,speakerId:0},{startMs:80,endMs:200,speakerId:1}]};
  const key='clinic-speaker-turn-asr-v2/2/'+chunk.sha256;
  const entries=new Map([[key,bounds]]);
  const parts=bounds.turns.map((turn,i)=>sliceTurn(chunk,turn,i,i===1));
  for(const [i,part] of parts.entries()) entries.set(key+'/'+i+'/'+part.sha256,{text:'existing cloud '+i,provider:'aliyun'});
  const cache={get:k=>entries.get(k),put:(k,v)=>entries.set(k,v)}, signal=new AbortController().signal;
  const call=local=>transcribeClinicChunk(chunk,dir,signal,cache,local);
  const local=await call(true);
  assert.deepEqual(local.map(s=>[s.provider,s.text,s.reportedLanguage,s.speakerId,s.speakerScope,s.startMs,s.endMs]),[
    ['local','원문입니다.','Korean',0,2,1000,1080],['local','원문입니다.','Korean',1,2,1080,1200]]);
  assert.ok(local.every(s=>s.boundaryAttemptId===bounds.attemptId && s.model===model && s.sourceId===s.attemptId));
  assert.deepEqual(await call(true),local);
  assert.deepEqual((await call(false)).map(s=>s.text),['existing cloud 0','existing cloud 1']);
  assert.deepEqual((await readFile(log,'utf8')).trim().split('\n'),parts.map(p=>p.sha256));
});

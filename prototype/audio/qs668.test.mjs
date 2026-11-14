import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {validateRawOpus,validateAudioDeclaration,rawOpusFormat,maxRawBytes,decodeRawOpus} from './qs668.mjs';
import {openRecordings} from '../recordings.mjs';
import {createMobileHandler} from '../mobile-gateway.mjs';
import {documentAudioDuration} from '../structured-documents/coordinator.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const packet=(toc=0x48,control=0)=>{const p=Buffer.alloc(40);p[0]=toc;p[1]=control;return p;};

test('narrow QS668 framing supports observed padding and rejects bad lengths, TOC, stereo, multiple frames',()=>{
 for(const p of [packet(),packet(0x4b,1),packet(0x4b,0x41),packet(0x4b,0xc1)])assert.equal(validateRawOpus(p).encodedDurationMs,20);
 const dtx=packet(0x4b,0x41);dtx[2]=37;assert.equal(validateRawOpus(dtx).packetCount,1);
 for(const p of [Buffer.alloc(0),Buffer.alloc(39),Buffer.alloc(maxRawBytes+40),packet(0x4c),packet(0x4a),packet(0x4b,0),packet(0x4b,2),Buffer.alloc(40,255)])assert.throws(()=>validateRawOpus(p));
 for(const size of [38,255]){const p=packet(0x4b,0x41);p[2]=size;assert.throws(()=>validateRawOpus(p),/PADDING/);}
 assert.throws(()=>validateAudioDeclaration('a.opus',undefined,'application/octet-stream'));
 assert.throws(()=>validateAudioDeclaration('a.wav',rawOpusFormat,'application/octet-stream'));
 assert.throws(()=>validateAudioDeclaration('a.opus',rawOpusFormat,'audio/ogg'));
 assert.throws(()=>validateAudioDeclaration('a.wav','other','audio/wav'));
 validateAudioDeclaration('a.wav',undefined,undefined);
 validateAudioDeclaration('a.opus',rawOpusFormat,'application/octet-stream');
});

test('authenticated gateway preserves raw bytes/hash, forwards explicit format, deduplicates and denies malformed input',async()=>{
 const db=new DatabaseSync(':memory:');let handler,requests=0;
 const server=createServer((q,r)=>handler(q,r));server.listen(0,'127.0.0.1');await once(server,'listening');
 const host='127.0.0.1:'+server.address().port,base='http://'+host;
 const config={device:'test',token:'test-secret',expiresAt:Date.now()+60000};
 handler=createMobileHandler({config,db,host,upstream:'http://internal/api/recordings',fetcher:async(url,o)=>{
  requests++;assert.equal(o.headers['X-ANC-Audio-Format'],rawOpusFormat);assert.equal(o.headers['Content-Type'],'application/octet-stream');
  assert.deepEqual(o.body,packet());return Response.json({recording:{id:sha(o.body)},duplicate:requests>1});
 }});
 const upload=(body,more={})=>fetch(base+'/v1/recordings',{method:'POST',body,headers:{Authorization:'Bearer test-secret','X-Recording-ID':'test-1','X-Content-SHA256':sha(body),'X-ANC-Filename':'a.opus','X-ANC-Audio-Format':rawOpusFormat,'Content-Type':'application/octet-stream',...more}});
 try{
  assert.equal((await upload(packet(),{'X-ANC-Audio-Format':'unknown'})).status,415);
  assert.equal((await upload(packet(0xff))).status,422);assert.equal(requests,0);
  const a=await upload(packet());assert.equal(a.status,201);const receipt=await a.json();assert.equal(receipt.sha256,sha(packet()));assert.equal(receipt.bytes,40);assert.equal(receipt.audioFormat,rawOpusFormat);
  const b=await upload(packet());assert.equal(b.status,200);assert.equal((await b.json()).duplicate,true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM receipts').get().n,1);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}
});

const rawPath=process.env.ANC_TEST_RAW_OPUS;
const waitFor=async(fn)=>{for(let n=0;n<600;n++){const r=fn();if(r)return r;await new Promise(r=>setTimeout(r,50));}throw Error('test timeout');};
test('private real raw: native decode, queue restart, injected ASR failure/retry, task ingest and original byte preservation',{skip:!rawPath||process.platform!=='darwin'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'anc-opus-')),raw=await readFile(rawPath),id=sha(raw);let recordings;
 try{
  const decoded=await decodeRawOpus(raw,dir);
  assert.equal(decoded.decodeInfo.sourceSha256,id);assert.equal(decoded.decodeInfo.sourceBytes,raw.length);
  assert.equal(documentAudioDuration({audioFormat:rawOpusFormat,decodeInfo:decoded.decodeInfo},raw),Math.ceil(decoded.decodeInfo.durationMs));
  assert.throws(()=>documentAudioDuration({audioFormat:rawOpusFormat,decodeInfo:{...decoded.decodeInfo,sourceBytes:1}},raw));
  const dbdir=join(dir,'queue');let calls=0,fail=true;
  const recognize=async chunk=>{calls++;if(fail)throw Error('simulated-asr-failure');return {sourceId:'segment-'+chunk.index,startMs:chunk.startMs,endMs:chunk.endMs,text:'由Eric.s负责测试任务。',chunkSha256:chunk.sha256,timing:'audio_chunk',requestedLanguage:'auto'};};
  recordings=await openRecordings(dbdir,{transcribeSegment:recognize});
  assert.throws(()=>recordings.import('bad.opus',Buffer.alloc(40),{audioFormat:rawOpusFormat}));assert.equal(recordings.list().length,0);
  recordings.import('sample.opus',raw,{audioFormat:rawOpusFormat});
  assert.equal(recordings.import('sample.opus',raw,{audioFormat:rawOpusFormat}).duplicate,true);
  // Stop before setImmediate dispatch: queued work must survive process reopen.
  await recordings.close();recordings=null;
  recordings=await openRecordings(dbdir,{transcribeSegment:recognize});
  await waitFor(()=>recordings.get(id).status==='failed');assert.equal(recordings.get(id).error,'simulated-asr-failure');
  assert.equal(recordings.get(id).audioFormat,rawOpusFormat);assert.equal(recordings.get(id).decodeInfo.sourceSha256,id);
  fail=false;recordings.retry(id);await waitFor(()=>recordings.get(id).status==='complete');
  assert.equal(recordings.get(id).attempts,2);assert.ok(calls>1);assert.ok(recordings.tasks.list().some(t=>t.source?.recordingId===id));
  assert.equal(sha(recordings.readAudio(id,0,raw.length)),id);
  assert.ok(Buffer.from(recordings.readAudio(id,0,raw.length)).equals(raw));
  // Existing WAV path still decodes and uses the same pipeline.
  const waveId=sha(decoded.wav);recordings.import('sample.wav',decoded.wav);
  await waitFor(()=>recordings.get(waveId).status==='complete');assert.equal(recordings.get(waveId).audioFormat,null);
  await recordings.close();recordings=null;
  recordings=await openRecordings(dbdir,{transcribeSegment:recognize});
  assert.equal(recordings.get(id).status,'complete');assert.equal(recordings.get(id).attempts,2);
  assert.equal(recordings.import('sample.opus',raw,{audioFormat:rawOpusFormat}).duplicate,true);
 }finally{await recordings?.close();await rm(dir,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { openRecordings } from './recordings.mjs';
import { createMobileHandler } from './mobile-gateway.mjs';
import { syncRecordingDelivery } from './recording-delivery.mjs';
import { maxAudioBytes } from './audio-limits.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
async function until(fn) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { const result = fn(); if (result) return result; await delay(20); }
  throw Error('fixture timeout');
}

test('one-hour 115 MB WAV: HTTP ingestion, durable retry, original offsets, dedup and same result card (ASR/Feishu fixtures)', {timeout:120000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anc-hour-'));
  let recordings, server, main;
  const receipts = new DatabaseSync(':memory:');
  try {
    // Continuous synthetic PCM, not speech recognition evidence; exactly one hour.
    const wav = Buffer.alloc(44 + 3600 * 16000 * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
    for (let n = 44; n < wav.length; n += 2) wav.writeInt16LE(n % 64 < 32 ? 1000 : -1000, n);
    assert.ok(wav.length > 64 * 1024 * 1024 && wav.length < maxAudioBytes);
    const id = sha(wav), calls = [];
    let fail = true;
    const recognize = async chunk => {
      calls.push(chunk.index);
      if (fail && chunk.index === 37) throw Error('fixture ASR failure at 18:30');
      return {startMs:chunk.startMs,endMs:chunk.endMs,chunkSha256:chunk.sha256,
        requestedLanguage:'auto',timing:'audio_chunk',sourceId:'fixture-'+chunk.index,
        text:chunk.index===119?'由Eric.s负责核对本次会议纪要。':'明确标记为合成测试。'};
    };
    recordings = await openRecordings(dir, {transcribeSegment:recognize});
    const config = {device:'fixture-device',token:'a'.repeat(64),expiresAt:Date.now()+120000,
      pairingCodeHash:sha('12345678'),pairingExpiresAt:0};
    const binding = {appId:'fixture-app',chatId:'fixture-group'};
    let handler;
    server = createServer((req,res)=>handler(req,res)); server.listen(0,'127.0.0.1'); await once(server,'listening');
    const host = '127.0.0.1:'+server.address().port, url = 'http://'+host;
    handler = createMobileHandler({config,db:receipts,host,upstream:'http://fixture/api/recordings',fetcher:async (_url,opts)=>{
      assert.equal(opts.headers['X-ANC-Publish'],'1');
      const result = recordings.import('one-hour.wav',opts.body);
      recordings.delivery.enqueue({...binding,recordingId:result.recording.id,device:config.device,name:'one-hour.wav'});
      return Response.json(result,{status:result.duplicate?200:202});
    }});
    const upload = () => fetch(url+'/v1/recordings',{method:'POST',headers:{Authorization:'Bearer '+config.token,
      'X-Recording-ID':'hour-1','X-Content-SHA256':id,'X-ANC-Filename':'one-hour.wav'},body:wav});
    let response=await upload(); assert.equal(response.status,201);assert.equal((await response.json()).recordingId,id);
    await until(()=>recordings.get(id).status==='failed');
    const failed=recordings.get(id);
    assert.equal(failed.progress.totalChunks,120);assert.equal(failed.progress.completedChunks,37);
    assert.equal(failed.progress.currentChunk.startMs,1110000);
    assert.match(failed.progressText,/第 38 段（原音 18:30–19:00）失败/);
    assert.equal(recordings.info(id).size,115200044);
    assert.equal(sha(recordings.readAudio(id,0,wav.length)),id);
    const sent=[],patched=[];
    const client={im:{message:{create:async r=>{sent.push(r);return {message_id:'om_fixture_hour'};},
      patch:async r=>{patched.push(r);return {};}}}};
    const sync=()=>syncRecordingDelivery({delivery:recordings.delivery,recordings,client,config:binding,call:p=>p});
    await sync();assert.equal(sent.length,1);
    await recordings.close();recordings=null;
    fail=false;recordings=await openRecordings(dir,{transcribeSegment:recognize});
    assert.deepEqual(recordings.get(id).progress,failed.progress);
    recordings.retry(id);await until(()=>recordings.get(id).status==='complete');
    const completed=recordings.get(id);
    assert.equal(completed.progress.completedChunks,120);assert.equal(completed.progress.reusedChunks,37);
    assert.equal(completed.progress.stage,'complete');assert.equal(completed.progress.currentChunk,null);
    assert.equal(completed.transcript.length,120);
    completed.transcript.forEach((s,i)=>{assert.equal(s.startMs,i*30000);assert.equal(s.endMs,(i+1)*30000);});
    assert.equal(completed.ledger.length,1);assert.equal(completed.ledger[0].startMs,3570000);
    for(let i=0;i<120;i++)assert.equal(calls.filter(n=>n===i).length,i===37?2:1);
    response=await upload();assert.equal(response.status,200);assert.equal((await response.json()).duplicate,true);
    assert.equal(recordings.list().length,1);assert.equal(recordings.tasks.list().filter(t=>t.origin==='recording').length,1);
    await delay(2450);await sync();assert.equal(sent.length,1);assert.equal(patched.length,1);
    assert.equal(patched[0].path.message_id,'om_fixture_hour');
    assert.match(patched[0].data.content,/59:30.000/);
    assert.equal(recordings.delivery.get(binding,id).finished,1);
    // Reject oversize from its declared length, without sending/allocating the body.
    const code=await new Promise((resolve,reject)=>{
      const r=request(url+'/v1/recordings',{method:'POST',headers:{Authorization:'Bearer '+config.token,
        'Content-Length':maxAudioBytes+1,'X-Recording-ID':'too-large','X-Content-SHA256':id,'X-ANC-Filename':'large.wav'}},res=>{
          res.resume();resolve(res.statusCode);r.destroy();});r.on('error',reject);r.flushHeaders();
    });assert.equal(code,413);
    // Exercise the actual main HTTP parser against the durable completed job.
    // The model binary is deliberately unavailable: an accidental re-execution must fail.
    await recordings.close(); recordings=null;
    const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
    const port=probe.address().port;await new Promise(r=>probe.close(r));
    main=spawn(process.execPath,['prototype/server.mjs'],{env:{...process.env,ANC_DATA_DIR:dir,
      ANC_PROTOTYPE_PORT:String(port),ANC_RECORDING_DOCUMENTS:'0',ANC_ASR_PROFILE:'standard',
      ANC_SPEAKMODE_BIN:join(dir,'DO-NOT-CALL-CLOUD'),ANC_SPEAKMODE_CONFIG_DB:join(dir,'no-config')},stdio:'ignore'});
    const base='http://127.0.0.1:'+port;
    for(let n=0;n<200;n++){
      if(await fetch(base+'/api/recordings').then(r=>r.ok).catch(()=>false))break;
      if(n===199)throw Error('isolated main failed to start');await delay(20);
    }
    const readiness=await (await fetch(base+'/api/readiness')).json();assert.equal(readiness.maxAudioBytes,maxAudioBytes);
    const deliveryState=await (await fetch(base+'/api/recordings/'+id+'/delivery')).json();
    assert.equal(deliveryState.progress.completedChunks,120);assert.match(deliveryState.progressText,/120\/120/);
    response=await fetch(base+'/api/recordings',{method:'POST',headers:{'X-ANC-Filename':'hour-http.wav'},body:wav});
    assert.equal(response.status,200);const receipt=await response.json();
    assert.equal(receipt.recording.id,id);assert.equal(receipt.duplicate,true);assert.equal(receipt.recording.status,'complete');
  } finally {
    if(main&&main.exitCode===null){const exited=once(main,'exit');main.kill('SIGTERM');await exited;}
    if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
    await recordings?.close();receipts.close();await rm(dir,{recursive:true,force:true});
  }
});

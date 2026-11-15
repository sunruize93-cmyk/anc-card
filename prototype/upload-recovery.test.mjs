import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { openRecordings } from './recordings.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function until(fn) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await fn()) return; await delay(20); }
  throw Error('isolated recovery fixture timeout');
}
function fiveMinutes() {
  const b = Buffer.alloc(44 + 300 * 32000);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40);
  for (let i = 44; i < b.length; i += 2) b.writeInt16LE(i % 64 < 32 ? 1000 : -1000, i);
  return b;
}

test('five-minute upload survives truncated body, gateway process death after durable import, expired auth and receipt restart', {timeout:60000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anc-upload-recovery-'));
  const configFile = join(directory, 'device.json'), receiptFile = join(directory, 'receipts.sqlite');
  const config = { device:'fixture-phone', token:'a'.repeat(64), expiresAt:Date.now()+600000 };
  const setConfig = async value => { await writeFile(configFile+'.new', JSON.stringify(value)); await rename(configFile+'.new',configFile); };
  const wav = fiveMinutes(), id = hash(wav), calls = [];
  const binding = {appId:'fixture-app',chatId:'fixture-group'};
  let recordings, upstream, gateway, base, heldResponse, upstreamCalls = 0, loseReply = true;
  const stopGateway = async signal => {
    if (!gateway || gateway.exitCode !== null || gateway.signalCode) return;
    const exited = once(gateway, 'exit'); gateway.kill(signal); await exited;
  };
  const startGateway = async () => {
    gateway = fork(new URL('./test-fixtures/upload-gateway-child.mjs', import.meta.url),
      [receiptFile, configFile, 'http://127.0.0.1:'+upstream.address().port+'/api/recordings'],
      {stdio:['ignore','ignore','pipe','ipc']});
    gateway.stderr.resume();
    base = await new Promise((resolve,reject) => {
      const timer = setTimeout(()=>reject(Error('gateway start timeout')),10000);
      gateway.once('message', value => {clearTimeout(timer);resolve(value.url);});
      gateway.once('exit', () => {clearTimeout(timer);reject(Error('gateway exited before ready'));});
      gateway.once('error', error => {clearTimeout(timer);reject(error);});
    });
  };
  const headers = {Authorization:'Bearer '+config.token,'X-Recording-ID':'five-minute-1',
    'X-Content-SHA256':id,'X-ANC-Filename':'five-minute-fixture.wav','Content-Length':String(wav.length)};
  const upload = extra => fetch(base+'/v1/recordings',{method:'POST',headers:{...headers,...extra},body:wav});
  try {
    await setConfig(config);
    recordings = await openRecordings(join(directory,'main'), {transcribeSegment:async chunk => {
      calls.push(chunk.index);
      return {startMs:chunk.startMs,endMs:chunk.endMs,chunkSha256:chunk.sha256,requestedLanguage:'auto',
        timing:'audio_chunk',sourceId:'fixture-'+chunk.index,text:chunk.index===9?'由Eric.s负责核对测试说明。':'合成信号，不是真实听写。'};
    }});
    upstream = createServer(async (req,res) => {
      try {
        assert.equal(req.url,'/api/recordings'); assert.equal(req.method,'POST');
        const chunks=[];for await(const chunk of req)chunks.push(chunk);
        upstreamCalls++;
        const result=recordings.import('five-minute-fixture.wav',Buffer.concat(chunks));
        recordings.delivery.enqueue({...binding,recordingId:result.recording.id,device:config.device,name:'five-minute-fixture.wav'});
        if(loseReply) { heldResponse=res; return; } // Main committed, but gateway has no receipt yet.
        res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(result));
      } catch(error) {res.destroy(error);}
    });
    upstream.listen(0,'127.0.0.1');await once(upstream,'listening');await startGateway();

    // Cut an actual TCP request after a prefix. Incomplete audio must never reach main.
    await new Promise(resolve => {
      const req=request(base+'/v1/recordings',{method:'POST',headers});
      req.on('error',()=>{});req.on('close',resolve);
      req.write(wav.subarray(0,65536),()=>setTimeout(()=>req.destroy(),50));
    });
    await delay(100);assert.equal(upstreamCalls,0);assert.equal(recordings.list().length,0);

    // Interrupt after the main durable write, before gateway receipt persistence.
    const lostUpload=upload().then(r=>r.status,()=> 'disconnected');
    await until(()=>heldResponse);await stopGateway('SIGKILL');heldResponse.destroy();
    assert.equal(await lostUpload,'disconnected');
    const interruptedDB=new DatabaseSync(receiptFile);
    try {assert.equal(interruptedDB.prepare('SELECT count(*) n FROM receipts').get().n,0);} finally {interruptedDB.close();}
    await until(()=>recordings.get(id)?.status==='complete');
    assert.equal(recordings.list().length,1);assert.equal(calls.length,10);
    loseReply=false;await startGateway();
    await setConfig({...config,expiresAt:0});
    assert.equal((await upload()).status,401);assert.equal(upstreamCalls,1);
    await setConfig(config);
    const retry=await upload();assert.equal(retry.status,200);
    const receipt=await retry.json();assert.equal(receipt.duplicate,true);assert.equal(receipt.recordingId,id);
    assert.equal(receipt.bytes,wav.length);
    const sendKey=recordings.delivery.get(binding,id).sendKey;

    // Restart again after receipt persistence and replay the identical client ID.
    await stopGateway('SIGTERM');await startGateway();
    assert.equal((await (await upload()).json()).duplicate,true);
    assert.equal((await upload({'X-Content-SHA256':'b'.repeat(64)})).status,409);
    assert.equal(upstreamCalls,3);assert.equal(calls.length,10);
    assert.equal(recordings.list().length,1);assert.equal(recordings.tasks.list().filter(task=>task.origin==='recording').length,1);
    assert.equal(recordings.delivery.get(binding,id).sendKey,sendKey);
    assert.equal(hash(recordings.readAudio(id,0,wav.length)),id);
    const segments=recordings.get(id).transcript;
    assert.equal(segments[0].startMs,0);assert.equal(segments.at(-1).endMs,300000);
    await stopGateway('SIGTERM');
    const db=new DatabaseSync(receiptFile);
    try {assert.equal(db.prepare('SELECT count(*) n FROM receipts').get().n,1);
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');} finally {db.close();}
  } finally {
    heldResponse?.destroy();await stopGateway('SIGTERM');
    if(upstream){upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
    await recordings?.close();await rm(directory,{recursive:true,force:true});
  }
});

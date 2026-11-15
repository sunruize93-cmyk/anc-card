import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseAsrConcurrency,transcribeStandardChunks} from './asr-pool.mjs';
import {openRecordings} from './recordings.mjs';
const chunks=Array.from({length:8},(_,index)=>({index,startMs:index*30000,endMs:(index+1)*30000,sha256:String(index)}));
const segment=c=>({text:'segment-'+c.index,startMs:c.startMs,endMs:c.endMs});
function cacheOf(map){return {get:c=>map.get(c.index),put:(c,s)=>map.set(c.index,s)};}

test('only supported bounded concurrency values are accepted',()=>{
 for(const n of [1,2,4,'1','2','4'])assert.equal(parseAsrConcurrency(n),Number(n));
 for(const n of [0,3,5,-1,1.5,'4junk',null,NaN])assert.throws(()=>parseAsrConcurrency(n));
});
for(const concurrency of [1,2,4])test(`pool ${concurrency} preserves order and offsets under reversed completion, including cache holes`,async()=>{
 const saved=new Map([[1,segment(chunks[1])],[5,segment(chunks[5])]]),reports=[],calls=[];let active=0,peak=0;
 const result=await transcribeStandardChunks({chunks,concurrency,signal:new AbortController().signal,cache:cacheOf(saved),report:p=>reports.push(p),recognize:async c=>{
  calls.push(c.index);active++;peak=Math.max(peak,active);await delay((8-c.index)*4);active--;return segment(c);
 }});
 assert.deepEqual(result,chunks.map(segment));assert.equal(peak,concurrency);assert.equal(active,0);
 assert.deepEqual([...calls].sort((a,b)=>a-b),[0,2,3,4,6,7]);
 assert.equal(reports.at(-1).completedChunks,8);assert.equal(reports.at(-1).reusedChunks,2);assert.deepEqual(reports.at(-1).activeChunks,[]);
 assert.ok(reports.every(p=>p.activeChunks.length<=concurrency));
 for(let i=1;i<reports.length;i++)assert.ok(reports[i].completedChunks>=reports[i-1].completedChunks);
});

test('failure stops new work, drains siblings and preserves first failed source range',async()=>{
 const saved=new Map(),calls=[],reports=[];let active=0;
 await assert.rejects(transcribeStandardChunks({chunks,concurrency:4,signal:new AbortController().signal,cache:cacheOf(saved),report:p=>reports.push(p),recognize:async c=>{
  calls.push(c.index);active++;
  try{await delay(c.index===1?5:c.index===2?10:25);if([1,2].includes(c.index))throw Error('failed-'+c.index);return segment(c);}finally{active--;}
 }}),/failed-1/);
 assert.equal(active,0);assert.deepEqual(calls,[0,1,2,3]);assert.deepEqual([...saved.keys()].sort(),[0,3]);
 assert.equal(reports.at(-1).currentChunk.index,1);assert.equal(reports.at(-1).completedChunks,2);assert.deepEqual(reports.at(-1).activeChunks,[]);
 const retried=[];
 const results=await transcribeStandardChunks({chunks,concurrency:2,signal:new AbortController().signal,cache:cacheOf(saved),report:()=>{},recognize:async c=>{retried.push(c.index);return segment(c);}});
 assert.deepEqual(retried,[1,2,4,5,6,7]);assert.deepEqual(results,chunks.map(segment));
});

test('shutdown drains cancellation before returning and never launches queued work',async()=>{
 const control=new AbortController(),saved=new Map(),calls=[];let settled=0;
 const run=transcribeStandardChunks({chunks,concurrency:4,signal:control.signal,cache:cacheOf(saved),report:()=>{},recognize:async c=>{
  calls.push(c.index);try{await delay(1000,null,{signal:control.signal});return segment(c);}finally{settled++;}
 }});
 assert.equal(calls.length,4);control.abort();await assert.rejects(run);assert.equal(settled,4);assert.equal(saved.size,0);assert.equal(calls.length,4);
});

function wave(seconds){const b=Buffer.alloc(44+seconds*32000);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);for(let i=44;i<b.length;i+=2)b.writeInt16LE(i%64<32?1000:-1000,i);return b;}
async function until(fn){const end=Date.now()+10000;while(Date.now()<end){if(fn())return;await delay(10);}throw Error('queue timeout');}
test('parallel success checkpoints survive database reopen and retry with a different worker count',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'anc-pool-db-')),calls=[];let queue,fail=true;
 const recognize=async c=>{calls.push(c.index);await delay(c.index===1?5:30);if(fail&&c.index===1)throw Error('fixture failure');return {...segment(c),chunkSha256:c.sha256,requestedLanguage:'auto',timing:'audio_chunk'};};
 try{
  queue=await openRecordings(dir,{concurrency:4,transcribeSegment:recognize});const id=queue.import('fixture.wav',wave(150)).recording.id;
  await until(()=>queue.get(id).status==='failed');const failed=queue.get(id);
  assert.equal(failed.progress.currentChunk.startMs,30000);assert.equal(failed.progress.completedChunks,3);assert.deepEqual(calls,[0,1,2,3]);
  await queue.close();fail=false;queue=await openRecordings(dir,{concurrency:2,transcribeSegment:recognize});
  assert.deepEqual(queue.get(id).progress,failed.progress);queue.retry(id);await until(()=>queue.get(id).status==='complete');
  const result=queue.get(id);assert.equal(result.progress.reusedChunks,3);assert.equal(result.progress.completedChunks,5);
  assert.deepEqual(result.transcript.map(x=>x.startMs),[0,30000,60000,90000,120000]);assert.deepEqual(calls,[0,1,2,3,1,4]);
 }finally{await queue?.close();await rm(dir,{recursive:true,force:true});}
});

test('closing during parallel work waits for workers; reopening resumes only uncommitted chunks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'anc-pool-shutdown-'));let queue,started=0,finished=0;
 try{
  queue=await openRecordings(dir,{concurrency:4,transcribeSegment:async(c,_directory,signal)=>{
   started++;try{if(c.index!==0)await delay(10000,null,{signal});return {...segment(c),chunkSha256:c.sha256,requestedLanguage:'auto'};}finally{finished++;}
  }});
  const id=queue.import('shutdown.wav',wave(150)).recording.id;
  await until(()=>started>=4&&queue.get(id).progress.completedChunks===1);
  await queue.close();assert.equal(finished,started);
  const resumed=[];
  queue=await openRecordings(dir,{concurrency:2,transcribeSegment:async c=>{resumed.push(c.index);return {...segment(c),chunkSha256:c.sha256,requestedLanguage:'auto'};}});
  await until(()=>queue.get(id).status==='complete');
  assert.deepEqual(resumed,[1,2,3,4]);assert.equal(queue.get(id).progress.reusedChunks,1);
 }finally{await queue?.close();await rm(dir,{recursive:true,force:true});}
});

test('progress persistence failure also stops dispatch and drains in-flight work',async()=>{
 let thrown=false,settled=0;const calls=[];
 await assert.rejects(transcribeStandardChunks({chunks,concurrency:4,signal:new AbortController().signal,cache:cacheOf(new Map()),
  report:p=>{if(p.completedChunks>0&&!thrown){thrown=true;throw Error('progress storage unavailable');}},
  recognize:async c=>{calls.push(c.index);await delay(c.index===0?5:20);settled++;return segment(c);}
 }),/progress storage unavailable/);
 assert.deepEqual(calls,[0,1,2,3]);assert.equal(settled,4);
});

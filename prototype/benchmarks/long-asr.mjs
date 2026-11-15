// Explicit cloud opt-in; creates an isolated queue and never opens a server.
import {fork} from 'node:child_process';
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {splitWav} from '../speakmode.mjs';
const [sampleArg,outputArg,mode]=process.argv.slice(2);
if(!sampleArg||!outputArg||!['--run-cloud','--fixture'].includes(mode))throw Error('Usage: node prototype/benchmarks/long-asr.mjs SAMPLE_DIR NEW_RUN_DIR --run-cloud|--fixture');
const sha=b=>createHash('sha256').update(b).digest('hex'),root=resolve(outputArg),sampleDir=resolve(sampleArg);
const manifest=JSON.parse(await readFile(join(sampleDir,'manifest.json'),'utf8'));
const audio=await readFile(join(sampleDir,'long-coffee.wav'));
assert.equal(sha(audio),manifest.sha256,'Frozen source hash');
assert.deepEqual(splitWav(audio).map(({index,startMs,endMs,sha256})=>({index,startMs,endMs,sha256})),manifest.chunks,'Frozen original chunk timeline');
assert.ok(mode==='--fixture'||manifest.durationMs>=30*60*1000,'Cloud long sample must be at least 30 minutes');
assert.ok(manifest.chunks.length>=10,'Need enough chunks for both recovery gates');
if(await stat(root).catch(()=>null))throw Error('Refusing an existing run directory; never overwrite evidence');
await mkdir(root,{recursive:true,mode:0o700});
const started=Date.now(),report={schema:'anc-long-asr-v1',mode,createdAt:new Date().toISOString(),concurrency:2,model:'qwen3-asr-flash',manifest,phases:[],snapshots:[],checks:{}};
const save=()=>writeFile(join(root,'results.json'),JSON.stringify(report,null,2));
await save();
function snapshot(){
 const db=new DatabaseSync(join(root,'queue/recordings.sqlite'),{readOnly:true});
 try{
  const row=db.prepare('SELECT id,status,attempts,error,transcript,ledger FROM recordings WHERE id=?').get(manifest.sha256);
  const cache=db.prepare('SELECT chunkIndex,sha256,segment FROM chunk_results WHERE recordingId=? ORDER BY chunkIndex').all(manifest.sha256);
  return {status:row.status,attempts:row.attempts,error:row.error,transcript:JSON.parse(row.transcript),ledger:JSON.parse(row.ledger),cache,
   integrity:db.prepare('PRAGMA integrity_check').get().integrity_check,
   recordingCount:db.prepare('SELECT count(*) AS n FROM recordings').get().n,
   taskCount:db.prepare('SELECT count(*) AS n FROM tasks WHERE recordingId=?').get(manifest.sha256).n};
 }finally{db.close();}
}
async function phase(name){
 const begin=performance.now();let stderr='',killIssued=false;
 const child=fork(fileURLToPath(new URL('./long-worker.mjs',import.meta.url)),[root,sampleDir,name,mode],{detached:true,stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,ANC_ASR_PROFILE:'standard'}});
 child.stderr.on('data',b=>{stderr=(stderr+b).slice(-16000);});
 child.on('message',event=>{
  if(event.type==='progress'&&event.completed%10===0)console.log(JSON.stringify({phase:name,...event}));
  if(event.type==='crash-ready'&&name==='crash'&&!killIssued){killIssued=true;process.kill(-child.pid,'SIGKILL');}
 });
 const timer=setTimeout(()=>{process.kill(-child.pid,'SIGKILL');},41*60*1000);
 const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(timer));
 const elapsedMs=performance.now()-begin;
 const events=(await readFile(join(root,`events-${name}.jsonl`),'utf8')).trim().split('\n').map(JSON.parse);
 const phaseReport={name,elapsedMs,...exit,killIssued,events};report.phases.push(phaseReport);await save();
 if(name==='crash'){assert.equal(killIssued,true);assert.equal(exit.signal,'SIGKILL');}
 else if(exit.code!==0)throw Error('Worker failed: '+stderr);
 const state=snapshot();report.snapshots.push({phase:name,...state});await save();
 assert.equal(state.integrity,'ok');assert.equal(state.recordingCount,1);
 console.log(JSON.stringify({phase:name,status:state.status,cached:state.cache.length,elapsedMs}));
 return state;
}
function normalize(s){return s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu,'');}
function distance(a,b){let prev=Uint32Array.from({length:b.length+1},(_,i)=>i),next=new Uint32Array(b.length+1);for(let i=1;i<=a.length;i++){next[0]=i;for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,prev[j]+1,prev[j-1]+Number(a[i-1]!==b[j-1]));[prev,next]=[next,prev];}return prev[b.length];}
try{
 const failed=await phase('failure');assert.equal(failed.status,'failed');assert.equal(failed.error,'BENCHMARK_INJECTED_FAILURE');assert.ok(failed.cache.length>0);
 const crashed=await phase('crash');assert.equal(crashed.status,'processing');assert.ok(crashed.cache.length>failed.cache.length);
 const final=await phase('resume');assert.equal(final.status,'complete');assert.equal(final.cache.length,manifest.chunks.length);
 const starts=name=>report.phases.find(p=>p.name===name).events.filter(e=>e.type==='request-start').map(e=>e.index);
 for(const [prior,name]of [[failed,'crash'],[crashed,'resume']]){
  const called=starts(name);assert.ok(prior.cache.every(c=>!called.includes(c.chunkIndex)),'Committed chunks must not be requested again');
  assert.ok(prior.cache.every(c=>final.cache.find(f=>f.chunkIndex===c.chunkIndex)?.segment===c.segment),'Saved text and evidence immutable across restart');
 }
 assert.equal(final.transcript.length,manifest.chunks.length);
 assert.ok(final.transcript.every((s,i)=>s.startMs===manifest.chunks[i].startMs&&s.endMs===manifest.chunks[i].endMs&&s.chunkSha256===manifest.chunks[i].sha256),'Original times and PCM hashes');
 assert.ok(final.ledger.every(a=>final.transcript.some(s=>s.startMs===a.startMs&&s.endMs===a.endMs&&s.chunkSha256===a.chunkSha256&&s.text===a.evidence)),'Action source references');
 const phaseEnd=JSON.parse(await readFile(join(root,'phase-resume.json'),'utf8'));assert.equal(phaseEnd.duplicate,true);
 const events=report.phases.flatMap(p=>p.events),peak=Math.max(...events.filter(e=>e.type==='request-start').map(e=>e.active));assert.equal(peak,2);
 const reference=normalize(manifest.sections.map(s=>s.text).join('')),hypothesis=normalize(final.transcript.map(s=>s.text).join(''));
 const edits=distance([...reference],[...hypothesis]);
 const anchors=manifest.sections.map(section=>{
  const overlaps=final.transcript.filter(s=>s.endMs>section.startMs&&s.startMs<section.endMs);
  const text=normalize(overlaps.map(s=>s.text).join(''));
  return {number:section.number,startMs:section.startMs,endMs:section.endMs,checks:section.anchors.map(anchor=>({anchor,passed:text.includes(normalize(anchor))}))};
 });
 report.checks={originalTimingAndHashes:true,checkpointTextUnchanged:true,committedChunksNeverRecalled:true,duplicateImport:true,sqliteIntegrity:true,ledgerSourceReferences:true};
 report.summary={durationMs:manifest.durationMs,chunkCount:manifest.chunks.length,sectionCount:manifest.sections.length,
  elapsedWithRecoveryMs:Date.now()-started,workerElapsedMs:report.phases.reduce((n,p)=>n+p.elapsedMs,0),peak,
  sourceBytes:audio.length,realRequestStarts:mode==='--run-cloud'?events.filter(e=>e.type==='request-start').length:0,
  successfulCalls:events.filter(e=>e.type==='request-success').length,
  completedRequestAttempts:events.filter(e=>e.type==='request-success').reduce((n,e)=>n+e.attempts,0),
  errors:events.filter(e=>e.type==='request-error'),injectedFailures:events.filter(e=>e.type==='injected-failure').length,
  killedUncommittedIndices:starts('crash').filter(i=>!crashed.cache.some(c=>c.chunkIndex===i)),
  failedCheckpointCount:failed.cache.length,crashCheckpointCount:crashed.cache.length,finalCheckpointCount:final.cache.length,
  originalStartMs:final.transcript[0].startMs,originalEndMs:final.transcript.at(-1).endMs,
  maxWorkerRssBytes:Math.max(...events.filter(e=>e.type==='progress').map(e=>e.rssBytes)),
  referenceCharacters:[...reference].length,characterEdits:edits,cer:reference.length?edits/[...reference].length:null,
  anchorPasses:anchors.flatMap(a=>a.checks).filter(c=>c.passed).length,anchorTotal:anchors.flatMap(a=>a.checks).length,anchors,
  taskCount:final.taskCount,ledgerCount:final.ledger.length};
 report.status='passed';await save();console.log(JSON.stringify({...report.summary,anchors:undefined}));
}catch(error){report.status='failed';report.error=error.message;await save();throw error;}

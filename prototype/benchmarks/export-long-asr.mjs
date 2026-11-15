// Publish only this harness's synthetic evidence, never a production queue.
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const [reportPath,audioPath,outputPath]=process.argv.slice(2);
if(!outputPath)throw Error('Usage: node prototype/benchmarks/export-long-asr.mjs RESULTS_JSON SOURCE_WAV NEW_PUBLIC_JSON');
const sha=b=>createHash('sha256').update(b).digest('hex');
const r=JSON.parse(await readFile(reportPath,'utf8')),audio=await readFile(audioPath);
assert.equal(r.status,'passed');assert.equal(r.mode,'--run-cloud');
assert.equal(r.manifest.kind,'fictional templated Mandarin TTS, not a real meeting');
assert.equal(sha(audio),r.manifest.sha256);assert.ok(Object.values(r.checks).every(Boolean));
assert.equal(audio.toString('ascii',36,40),'data');assert.equal(audio.readUInt32LE(40)+44,audio.length);
const gaps=[];let cursor=0;
for(const c of r.manifest.chunks){assert.ok(c.startMs>=cursor);if(c.startMs>cursor)gaps.push({startMs:cursor,endMs:c.startMs});cursor=c.endMs;}
if(cursor<r.manifest.durationMs)gaps.push({startMs:cursor,endMs:r.manifest.durationMs});
for(const gap of gaps){
 let maxRms=0;
 for(let i=Math.round(gap.startMs*16);i<Math.round(gap.endMs*16);i+=320){
  const end=Math.min(i+320,Math.round(gap.endMs*16));let energy=0;
  for(let j=i;j<end;j++)energy+=audio.readInt16LE(44+j*2)**2;
  maxRms=Math.max(maxRms,Math.sqrt(energy/(end-i)));
 }
 gap.maxFrameRms=maxRms;assert.ok(maxRms<180,'No voiced audio in omitted timeline gaps');
}
const final=r.snapshots.at(-1);
assert.equal(final.status,'complete');assert.equal(final.taskCount,final.ledger.length);
for(const [snapshot,nextName]of [[r.snapshots[0],'crash'],[r.snapshots[1],'resume']]){
 const calls=new Set(r.phases.find(p=>p.name===nextName).events.filter(e=>e.type==='request-start').map(e=>e.index));
 for(const cached of snapshot.cache){assert.ok(!calls.has(cached.chunkIndex));assert.equal(final.cache.find(c=>c.chunkIndex===cached.chunkIndex).segment,cached.segment);}
}
const latencies=r.phases.flatMap(p=>p.events).filter(e=>e.type==='request-success').map(e=>e.elapsedMs).sort((a,b)=>a-b);
const percentile=p=>latencies[Math.ceil(latencies.length*p)-1];
const result={schema:'anc-long-asr-public-v1',createdAt:r.createdAt,status:r.status,mode:r.mode,concurrency:r.concurrency,model:r.model,
 manifest:r.manifest,summary:{...r.summary,requestMedianMs:percentile(.5),requestP95Ms:percentile(.95),requestMaxMs:latencies.at(-1)},checks:r.checks,
 silenceGaps:gaps,transcript:final.transcript,ledger:final.ledger,
 phases:r.phases.map(p=>({...p,events:p.events.filter(e=>e.type!=='progress')})),
 snapshots:r.snapshots.map(({transcript,ledger,cache,...s})=>({...s,transcriptSegments:transcript?.length??0,ledgerEntries:ledger?.length??0,
  cache:cache.map(({segment,...c})=>({...c,segmentSha256:sha(segment)}))}))};
const serialized=JSON.stringify(result,null,2)+'\n';
if(await stat(outputPath).catch(()=>null)){assert.equal(await readFile(outputPath,'utf8'),serialized,'Refusing to overwrite different public evidence');}
else await writeFile(outputPath,serialized);
console.log(JSON.stringify({...result.summary,anchors:undefined,silenceGaps:gaps}));

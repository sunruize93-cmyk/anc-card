import {readFile} from 'node:fs/promises';
const [path]=process.argv.slice(2);
if(!path)throw Error('Usage: node prototype/benchmarks/summarize-asr-parallel.mjs RESULTS_JSON');
const raw=JSON.parse(await readFile(path)),data=raw.results??raw,median=a=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];
if(data.runs.length!==27||data.runs.some(r=>r.status!=='complete'||!r.timingMatches||r.cacheReused!==0))throw Error('Incomplete or invalid benchmark; do not publish as a completed comparison');
const expected=new Set(data.manifest.flatMap(sample=>[1,2,3].flatMap(round=>[1,2,4].map(c=>`${round}:${c}:${sample.id}`))));
for(const run of data.runs)if(!expected.delete(`${run.round}:${run.concurrency}:${run.sample}`))throw Error('Unexpected or duplicate run');
if(expected.size)throw Error('Missing run');
const rows=[1,2,4].map(concurrency=>{
 const runs=data.runs.filter(r=>r.concurrency===concurrency);
 const roundSeconds=[1,2,3].map(round=>runs.filter(r=>r.round===round).reduce((s,r)=>s+r.elapsedMs/1000,0));
 return {concurrency,roundSeconds,medianBatchSeconds:median(roundSeconds),
  characterErrorRate:runs.reduce((s,r)=>s+r.edits,0)/runs.reduce((s,r)=>s+r.referenceCharacters,0),
  keyChecksPassed:runs.flatMap(r=>r.checks).filter(x=>x.passed).length,keyChecksTotal:runs.flatMap(r=>r.checks).length,
  calls:runs.flatMap(r=>r.observations).length,attempts:runs.flatMap(r=>r.observations).reduce((s,r)=>s+r.attempts,0),
  peak:Math.max(...runs.map(r=>r.peak)),timingMatches:runs.every(r=>r.timingMatches)};
});
for(const row of rows)row.speedup=rows[0].medianBatchSeconds/row.medianBatchSeconds;
console.log(JSON.stringify({sampleCount:data.manifest.length,audioSeconds:data.manifest.reduce((s,r)=>s+r.durationMs/1000,0),repeats:3,
 limitations:'TTS, one provider/account/network, short recordings, text/key-check metrics are not human semantic accuracy',rows},null,2));

// Explicit opt-in benchmark: generated public-script audio is sent to configured
// SpeakMode/Qwen. No live server, Feishu, personal recording or Codex execution.
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {openRecordings} from '../recordings.mjs';
import {splitWav,transcribeChunk,asrProfile} from '../speakmode.mjs';
const exec=promisify(execFile), sha=b=>createHash('sha256').update(b).digest('hex');
const [output,flag]=process.argv.slice(2);
if(!output||!['--prepare-only','--run-cloud'].includes(flag))throw Error('Usage: node prototype/benchmarks/asr-parallel.mjs NEW_OUTPUT_DIR --prepare-only|--run-cloud');
if(asrProfile!=='standard')throw Error('Benchmark requires standard ASR profile');
const root=resolve(output);await mkdir(root,{recursive:true,mode:0o700});
const reportPath=join(root,'results.json'),manifestPath=join(root,'manifest.json');
if(await stat(reportPath).catch(()=>null))throw Error('Refusing to overwrite cloud evidence; choose a fresh output directory');
const previousManifest=await readFile(manifestPath,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
const samples=JSON.parse(await readFile(new URL('./asr-samples.json',import.meta.url)));
function normalize(text){return text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu,'');}
function distance(a,b){let prev=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,prev[j]+1,prev[j-1]+Number(a[i-1]!==b[j-1]));prev=next;}return prev[b.length];}
function pcm(wav){for(let i=12;i+8<=wav.length;){const n=wav.readUInt32LE(i+4);if(wav.toString('ascii',i,i+4)==='data')return wav.subarray(i+8,i+8+n);i+=8+n+n%2;}throw Error('missing PCM');}
function wave(data){const b=Buffer.alloc(44);b.write('RIFF');b.writeUInt32LE(data.length+36,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(data.length,40);return Buffer.concat([b,data]);}
const manifest=[];
for(const sample of samples){
 const path=join(root,sample.id+'.wav');
 if(!await stat(path).catch(()=>null)){
  if(previousManifest)throw Error('Prepared audio missing; use a fresh output directory');
  const parts=[];
  for(let i=0;i<sample.parts.length;i++){
   const prefix=join(root,`${sample.id}-${i}`);
   await exec('/usr/bin/say',['-v',sample.voice,'-r',String(sample.rate),'-o',prefix+'.aiff',sample.parts[i]]);
   await exec('/usr/bin/afconvert',['-f','WAVE','-d','LEI16@16000','-c','1',prefix+'.aiff',prefix+'.wav']);
   parts.push(pcm(await readFile(prefix+'.wav')),Buffer.alloc(32000));
  }
  await writeFile(path,wave(Buffer.concat(parts)));
 }
 const audio=await readFile(path),chunks=splitWav(audio);
 manifest.push({id:sample.id,voice:sample.voice,rate:sample.rate,sha256:sha(audio),bytes:audio.length,durationMs:pcm(audio).length/32,
  chunks:chunks.map(c=>({index:c.index,startMs:c.startMs,endMs:c.endMs,sha256:c.sha256})),reference:sample.parts.join('')});
}
if(previousManifest && JSON.stringify(previousManifest)!==JSON.stringify(manifest))throw Error('Prepared audio/reference/segmentation changed; use a fresh output directory');
await writeFile(manifestPath,JSON.stringify(manifest,null,2));
console.log(JSON.stringify({prepared:manifest.map(({id,durationMs,chunks})=>({id,durationMs,chunks:chunks.length}))}));
if(flag==='--prepare-only')process.exit(0);
const report={schema:'anc-asr-parallel-benchmark-v1',createdAt:new Date().toISOString(),model:'qwen3-asr-flash',
 sampleKind:'macOS TTS; no real-meeting accuracy claim',orders:[[1,2,4],[2,4,1],[4,1,2]],manifest,runs:[]};
await writeFile(reportPath,JSON.stringify(report,null,2));
let queue;
try{
 for(let round=0;round<3;round++)for(const concurrency of report.orders[round])for(let offset=0;offset<samples.length;offset++){
  const sample=samples[(offset+round)%samples.length],source=manifest.find(x=>x.id===sample.id),audio=await readFile(join(root,sample.id+'.wav'));
  if(sha(audio)!==source.sha256)throw Error('sample changed');
  const directory=join(root,`run-${round}-${concurrency}-${sample.id}`);if(await stat(directory).catch(()=>null))throw Error('Refusing cache-contaminated run');
  const observations=[];let active=0,peak=0;
  queue=await openRecordings(directory,{concurrency,transcribeSegment:async(...args)=>{
   const chunk=args[0],start=performance.now();active++;peak=Math.max(peak,active);
   try{const result=await transcribeChunk(...args);observations.push({index:chunk.index,elapsedMs:performance.now()-start,attempts:result.requestAttempts,text:result.text});return result;}
   catch(error){observations.push({index:chunk.index,elapsedMs:performance.now()-start,error:error.message});throw error;}
   finally{active--;}
  }});
  const start=performance.now(),id=queue.import(sample.id+'.wav',audio).recording.id;
  let row;const deadline=Date.now()+300000;
  while(true){row=queue.get(id);if(['complete','failed'].includes(row.status))break;if(Date.now()>deadline)throw Error('benchmark run deadline');await delay(20);}
  const elapsedMs=performance.now()-start;
  const transcript=(row.transcript??[]).map(x=>x.text).join(''),reference=normalize(source.reference),hypothesis=normalize(transcript);
  const timingMatches=row.status==='complete'&&row.transcript.length===source.chunks.length&&row.transcript.every((s,i)=>s.startMs===source.chunks[i].startMs&&s.endMs===source.chunks[i].endMs&&s.chunkSha256===source.chunks[i].sha256);
  const result={round:round+1,concurrency,sample:sample.id,status:row.status,error:row.error,elapsedMs,peak,cacheReused:row.progress.reusedChunks,timingMatches,
   edits:distance([...reference],[...hypothesis]),referenceCharacters:[...reference].length,cer:distance([...reference],[...hypothesis])/[...reference].length,
   checks:sample.checks.map(c=>({label:c.label,passed:new RegExp(c.pattern,'u').test(hypothesis)})),transcript,observations:observations.sort((a,b)=>a.index-b.index)};
  report.runs.push(result);await queue.close();queue=null;await writeFile(reportPath,JSON.stringify(report,null,2));
  console.log(JSON.stringify({...result,transcript:undefined,observations:undefined}));
  if(row.status!=='complete'||!timingMatches||result.cacheReused!==0)throw Error('Cloud benchmark stopped on failure/mismatched timestamps/cache contamination');
 }
}finally{await queue?.close();}
console.log('Completed: '+reportPath);

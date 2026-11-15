// Private child of long-asr.mjs. All queue writes are beneath the fresh run dir.
import {readFile,writeFile} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openRecordings} from '../recordings.mjs';
import {transcribeChunk,asrProfile} from '../speakmode.mjs';
const [root,sampleDir,phase,mode]=process.argv.slice(2);
if(!process.send||!['--run-cloud','--fixture'].includes(mode)||asrProfile!=='standard')throw Error('Use long-asr.mjs in standard profile');
const manifest=JSON.parse(await readFile(join(sampleDir,'manifest.json'),'utf8'));
const failAt=Math.floor(manifest.chunks.length*.2),crashAfter=Math.floor(manifest.chunks.length*.55);
const events=join(root,`events-${phase}.jsonl`);
const emit=e=>{const event={at:new Date().toISOString(),...e};appendFileSync(events,JSON.stringify(event)+'\n');process.send(event);};
let active=0,peak=0,maxRss=0,crashRequested=false,queue,id,timer,lastCompleted=-1;
const started=performance.now();
try{
 queue=await openRecordings(join(root,'queue'),{concurrency:2,transcribeSegment:async(chunk,directory,signal)=>{
  if(phase==='failure'&&chunk.index===failAt){emit({type:'injected-failure',index:chunk.index});throw Error('BENCHMARK_INJECTED_FAILURE');}
  active++;peak=Math.max(peak,active);const start=performance.now();emit({type:'request-start',index:chunk.index,active});
  try{
   const result=mode==='--fixture'
    ? (await delay(35,null,{signal}),{text:'离线测试',startMs:chunk.startMs,endMs:chunk.endMs,chunkSha256:chunk.sha256,requestedLanguage:'auto',timing:'audio_chunk',requestAttempts:1})
    : await transcribeChunk(chunk,directory,signal);
   emit({type:'request-success',index:chunk.index,elapsedMs:performance.now()-start,attempts:result.requestAttempts});return result;
  }catch(error){emit({type:'request-error',index:chunk.index,elapsedMs:performance.now()-start,error:error.message});throw error;}
  finally{active--;}
 }});
 if(phase==='failure')id=queue.import('long-coffee.wav',await readFile(join(sampleDir,'long-coffee.wav'))).recording.id;
 else {id=manifest.sha256;if(phase==='crash'&&!queue.retry(id))throw Error('Expected failed job to retry');}
 const initial=queue.get(id);emit({type:'opened',phase,id,status:initial.status});
 timer=setInterval(()=>{
  const row=queue.get(id);maxRss=Math.max(maxRss,process.memoryUsage().rss);
  const completed=row.progress?.completedChunks??0;
  if(completed!==lastCompleted){lastCompleted=completed;emit({type:'progress',completed,total:row.progress?.totalChunks,reused:row.progress?.reusedChunks,active,peak,rssBytes:maxRss});}
  if(phase==='crash'&&!crashRequested&&completed>=crashAfter&&active===2){crashRequested=true;emit({type:'crash-ready',completed,active});}
 },25);
 const deadline=Date.now()+40*60*1000;
 while(true){const row=queue.get(id);if(['failed','complete'].includes(row.status))break;if(Date.now()>deadline)throw Error('Long benchmark phase deadline exceeded');await delay(25);}
 clearInterval(timer);
 const row=queue.get(id),duplicate=row.status==='complete'?queue.import('same-audio-renamed.wav',await readFile(join(sampleDir,'long-coffee.wav'))).duplicate:null;
 const summary={phase,status:row.status,error:row.error,elapsedMs:performance.now()-started,peak,maxRssBytes:maxRss,progress:row.progress,duplicate};
 await queue.close();queue=null;
 await writeFile(join(root,`phase-${phase}.json`),JSON.stringify(summary,null,2));emit({type:'phase-end',...summary});
}finally{clearInterval(timer);await queue?.close();}

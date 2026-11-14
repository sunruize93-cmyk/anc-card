import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {transcribeChunk} from './speakmode.mjs';
import {createHash} from 'node:crypto';

test('standard timeout retries once with independent receipts; permanent failure and cancellation never loop',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'anc-asr-retry-')),old={bin:process.env.ANC_SPEAKMODE_BIN,config:process.env.ANC_SPEAKMODE_CONFIG_DB};
 const bin=join(dir,'fake-asr.mjs'),config=join(dir,'config'),counter=join(dir,'calls.json');
 const audio=Buffer.from('fixed audio bytes'),chunk={index:0,startMs:0,endMs:1000,samples:16000,audio,sha256:createHash('sha256').update(audio).digest('hex')};
 async function scenario(mode){
  await writeFile(counter,'[]');
  const code=`#!${process.execPath}
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const args=process.argv.slice(2),out=args[args.indexOf('--out')+1],calls=JSON.parse(readFileSync(${JSON.stringify(counter)},'utf8'));calls.push(out);writeFileSync(${JSON.stringify(counter)},JSON.stringify(calls));
if(existsSync(out)){console.error(JSON.stringify({errorCode:'output_unavailable'}));process.exit(1);}
const base={language:'auto',attemptId:'attempt-'+calls.length,audioSha256:${JSON.stringify(chunk.sha256)},audioSamples:16000};
const fail=${JSON.stringify(mode)}==='always'||${JSON.stringify(mode)}==='permanent'||calls.length===1;
const err=${JSON.stringify(mode)}==='permanent'?'authentication_failed':'file_asr_timeout';
const source={id:'s',asrAttemptId:base.attemptId,complete:true,provider:'aliyun',model:'qwen3-asr-flash',adapterVersion:'qwen-file-lab-v1',items:[{text:'由Eric.s负责测试。',final:true}]};
writeFileSync(out,JSON.stringify({...base,status:'started'})+'\\n'+JSON.stringify({...base,status:fail?'failed':'passed',...(fail?{errorCode:err}:{source})}));
if(fail){console.error(JSON.stringify({errorCode:err}));process.exit(1);}
`;
  await writeFile(bin,code,{mode:0o700});
 }
 try{
  await writeFile(config,'');process.env.ANC_SPEAKMODE_BIN=bin;process.env.ANC_SPEAKMODE_CONFIG_DB=config;
  await scenario('once');const result=await transcribeChunk(chunk,dir,new AbortController().signal);assert.equal(result.text,'由Eric.s负责测试。');assert.equal(result.requestAttempts,2);
  let calls=JSON.parse(await readFile(counter,'utf8'));assert.equal(calls.length,2);assert.equal(new Set(calls).size,2);
  await scenario('always');await assert.rejects(transcribeChunk(chunk,dir,new AbortController().signal),/file_asr_timeout/);assert.equal(JSON.parse(await readFile(counter)).length,2);
  await scenario('permanent');await assert.rejects(transcribeChunk(chunk,dir,new AbortController().signal),/authentication_failed/);assert.equal(JSON.parse(await readFile(counter)).length,1);
  await scenario('once');const abort=new AbortController();abort.abort();await assert.rejects(transcribeChunk(chunk,dir,abort.signal));assert.equal(JSON.parse(await readFile(counter)).length,0);
 }finally{
  for(const [key,value]of[['ANC_SPEAKMODE_BIN',old.bin],['ANC_SPEAKMODE_CONFIG_DB',old.config]])if(value===undefined)delete process.env[key];else process.env[key]=value;
  await rm(dir,{recursive:true,force:true});
 }
});

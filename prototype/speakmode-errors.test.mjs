import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {transcribeChunk} from './speakmode.mjs';

test('CLI timeout and empty-response errors show their actual cause, not permissions/quota',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'anc-asr-error-'));
 const saved={bin:process.env.ANC_SPEAKMODE_BIN,config:process.env.ANC_SPEAKMODE_CONFIG_DB};
 try{
  const bin=join(dir,'fake-asr'),config=join(dir,'config.sqlite');await writeFile(config,'');
  process.env.ANC_SPEAKMODE_BIN=bin;process.env.ANC_SPEAKMODE_CONFIG_DB=config;
  for(const [code,expected] of [['file_asr_timeout','请求超时'],['invalid_transcript','没有有效文字']]){
   await writeFile(bin,'#!/bin/sh\nprintf \'{"errorCode":"'+code+'"}\\n\' >&2\nexit 1\n',{mode:0o700});
   await assert.rejects(transcribeChunk({index:0,audio:Buffer.from('fixture')},dir,new AbortController().signal),error=>error.message.includes(expected)&&!error.message.includes('额度')&&!error.message.includes('权限')&&error.message.includes(code));
  }
 }finally{
  for(const [key,value] of [['ANC_SPEAKMODE_BIN',saved.bin],['ANC_SPEAKMODE_CONFIG_DB',saved.config]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await rm(dir,{recursive:true,force:true});
 }
});

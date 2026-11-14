import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';import {once} from 'node:events';
import {sha256} from './core.mjs';import {createDocumentService} from './service.mjs';
import {cleanupPreflight} from './cleanup-preflight.mjs';import {createMobileHandler} from '../mobile-gateway.mjs';
async function fixture(uncertain=false){
 const db=new DatabaseSync(':memory:'),audio=Buffer.from('stored original bytes'),id=sha256(audio);
 const row={id,status:'complete',audioBytes:audio.length,durationMs:1000,transcript:[{sourceId:'s1',startMs:0,endMs:1000,text:'产品支持录音。'}]};
 const content={title:'产品说明',summary:[{id:'sum1',text:'产品支持录音。',citationIds:['c1'],uncertaintyIds:[]}],facts:[],decisions:[],actionItems:[],openQuestions:[],citations:[{id:'c1',sourceId:'s1',startMs:0,endMs:1000,quote:'产品支持录音。',timingMethod:'segment'}],uncertainties:uncertain?[{id:'u1',code:'REVIEW',description:'待回听',citationIds:['c1']}]:[]};
 const documents=createDocumentService({db,generate:async()=>content,resolveBinding:async()=>({appId:'app',chatId:'chat',messageId:'original'}),patchOriginalCard:async()=>({code:0})});
 documents.enqueue(row);await documents.pump();
 const recordings={get:()=>row,info:()=>({size:audio.length}),readAudio:()=>audio};
 return{db,audio,row,id,documents,recordings,run:()=>cleanupPreflight({recordings,documents,recordingId:id})};
}
test('只读预检允许已存原音且文档原卡完整交付，完全不删除或写台账',async()=>{
 const f=await fixture();try{const before=f.db.prepare('SELECT total_changes() AS n').get().n;const r=await f.run();
 assert.equal(r.allowed,true);assert.equal(r.audioStored,true);assert.equal(r.scope,'iphone_and_card');assert.equal(r.serverAudioRetained,true);assert.equal(r.documentRevision,1);assert.equal(r.messageId,'original');assert.deepEqual(r.reasons,[]);assert.equal(r.sourceSha256,sha256(f.audio));assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before);
 }finally{f.db.close();}
});
test('缺原音、原音损坏、处理中、转写变更和需回听均拒绝',async()=>{
 const f=await fixture();try{
 f.recordings.info=()=>null;assert.deepEqual((await f.run()).reasons,['RECORDING_NOT_FOUND']);
 f.recordings.info=()=>({size:f.audio.length});f.recordings.readAudio=()=>Buffer.alloc(f.audio.length);assert.deepEqual((await f.run()).reasons,['SERVER_AUDIO_MISMATCH']);
 f.recordings.readAudio=()=>f.audio;f.row.status='processing';assert.deepEqual((await f.run()).reasons,['RECORDING_NOT_COMPLETE']);
 f.row.status='complete';f.row.transcript[0].text+='修改';assert.deepEqual((await f.run()).reasons,['TRANSCRIPT_CHANGED']);
 }finally{f.db.close();}
 const uncertain=await fixture(true);try{assert.deepEqual((await uncertain.run()).reasons,['AUDIO_REVIEW_REQUIRED']);}finally{uncertain.db.close();}
});
test('旧版本/失败/未投递与并发状态变化不能用于清理',async()=>{
 const f=await fixture();try{const original=f.documents.receipt;const valid=await original(null,f.id);
 for(const state of ['queued','generating','failed']){f.documents.receipt=async()=>({...valid,state});assert.deepEqual((await f.run()).reasons,['DOCUMENT_NOT_READY']);}
 f.documents.receipt=async()=>({...valid,delivery:{...valid.delivery,manifestSha256:'different'}});assert.deepEqual((await f.run()).reasons,['DOCUMENT_NOT_DELIVERED']);
 let n=0;f.documents.receipt=async()=>++n===1?valid:{...valid,state:'generating'};assert.deepEqual((await f.run()).reasons,['STATE_CHANGED']);
 f.documents.receipt=original;f.documents.readArtifact=()=>({bytes:Buffer.from('{}')});assert.deepEqual((await f.run()).reasons,['DOCUMENT_READBACK_MISMATCH']);
 }finally{f.db.close();}
});
test('网关预检复用设备鉴权/录音归属；绑定错配拒绝且只固定代理GET',async()=>{
 const db=new DatabaseSync(':memory:');let handler,calls=0,wrong=false;
 const server=createServer((q,r)=>handler(q,r));server.listen(0,'127.0.0.1');await once(server,'listening');const host='127.0.0.1:'+server.address().port,id='a'.repeat(64),config={device:'Eric',token:'b'.repeat(64),expiresAt:Date.now()+60000};
 handler=createMobileHandler({db,config,host,upstream:'http://backend/api/recordings',fetcher:async(url,opts)=>{calls++;assert.equal(url,'http://backend/api/recordings/'+id+'/cleanup-preflight');assert.equal(opts.redirect,'error');return Response.json({schemaVersion:'anc.cleanup-preflight.v1',scope:'iphone_and_card',recordingId:wrong?'c'.repeat(64):id,allowed:false,reasons:['AUDIO_REVIEW_REQUIRED']});}});
 const url='http://'+host+'/v1/recordings/'+id+'/cleanup-preflight',headers={Authorization:'Bearer '+config.token};
 try{
 assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers})).status,404);assert.equal(calls,0);
 db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run('Zoty','local',id,10);assert.equal((await fetch(url,{headers})).status,404);
 db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run('Eric','local',id,10);const r=await fetch(url,{headers});assert.equal(r.status,200);assert.equal((await r.json()).allowed,false);
 wrong=true;assert.equal((await fetch(url,{headers})).status,502);assert.equal((await fetch(url,{method:'POST',headers})).status,404);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}
});

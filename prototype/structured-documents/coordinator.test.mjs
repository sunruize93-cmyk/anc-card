import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {openDocumentCoordinator} from './coordinator.mjs';
import {sha256} from './core.mjs';
import {createMobileHandler} from '../mobile-gateway.mjs';

test('后台协调器冻结真实音频、等待旧卡完成、网关代理逐字节读回且重启幂等',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'anc-coordinator-'));
 const wav=Buffer.alloc(32044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);
 const id=sha256(wav),transcript=[{sourceId:'seg-1',startMs:0,endMs:1000,text:'这是测试记录。'}];
 let finished=false,generations=0,patches=0;
 const opts={directory:dir,ids:[id],autoStart:false,recordings:{get:()=>({status:'complete',transcript}),info:()=>({size:wav.length}),readAudio:()=>wav,delivery:{get:()=>({messageId:'original',finished})}},feishu:{status:()=>({appId:'app',chatId:'chat'}),patchDocument:async req=>{assert.equal(req.path.message_id,'original');patches++;return{code:0};}},generate:async()=>{generations++;return {title:'测试记录',summary:[{id:'s1',text:'这是测试记录。',citationIds:['c1'],uncertaintyIds:[]}],facts:[],decisions:[],actionItems:[],openQuestions:[],uncertainties:[],citations:[{id:'c1',sourceId:'seg-1',startMs:0,endMs:1000,quote:'这是测试记录。',timingMethod:'segment'}]};}};
 let coordinator=await openDocumentCoordinator(opts);const db=new DatabaseSync(':memory:');
 let handler;const server=createServer((q,r)=>handler(q,r));server.listen(0,'127.0.0.1');await once(server,'listening');const host='127.0.0.1:'+server.address().port;
 try{
 await coordinator.runOnce();assert.equal(generations,1);assert.equal(patches,0);
 finished=true;await coordinator.runOnce();const receipt=await coordinator.receipt(null,id);assert.equal(receipt.delivery.state,'delivered');assert.equal(patches,1);
 const config={device:'test',token:'b'.repeat(64),expiresAt:Date.now()+60000};let proxied=0;
 handler=createMobileHandler({config,db,host,upstream:'http://backend/api/recordings',fetcher:async(url,options)=>{
  assert.equal(options.redirect,'error');assert.ok(url.startsWith('http://backend/api/recordings/'+id+'/documents/1/'));proxied++;
  const file=url.split('/').at(-1),a=coordinator.readArtifact(null,id,1,file);return new Response(a.bytes,{headers:{'content-length':String(a.bytes.length)}});
 }});
 const base='http://'+host,headers={Authorization:'Bearer '+config.token};
 assert.equal((await fetch(base+receipt.manifestPath,{headers})).status,404);assert.equal(proxied,0);
 db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run('test','local',id,wav.length);
 const manifest=await fetch(base+receipt.manifestPath,{headers});assert.equal(manifest.status,200);assert.equal(sha256(Buffer.from(await manifest.arrayBuffer())),receipt.manifestSha256);
 await coordinator.close();coordinator=await openDocumentCoordinator(opts);await coordinator.runOnce();assert.equal(generations,1);assert.equal(patches,1);assert.equal((await coordinator.receipt(null,id)).receiptId,receipt.receiptId);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await coordinator.close();db.close();await rm(dir,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {openDocumentStore,freezeSource,validateContent,sha256} from './core.mjs';
import {createMobileHandler} from '../mobile-gateway.mjs';
const recording={id:'a'.repeat(64),audioBytes:100,durationMs:1000,transcript:[{sourceId:'seg-1',startMs:0,endMs:1000,text:'由 Eric.s 负责说明，截止时间是周五。'}]};
const content=()=>({title:'说明交付',summary:[{id:'s1',text:'Eric.s 承担说明工作。',citationIds:['c1'],uncertaintyIds:[]}],facts:[],decisions:[],actionItems:[{id:'a1',text:'准备说明',ownerName:'Eric.s',ownerIdentity:null,deadlineText:'周五',deadlineAt:null,status:'committed',citationIds:['c1'],uncertaintyIds:['u1']}],openQuestions:[],citations:[{id:'c1',...recording.transcript[0],quote:recording.transcript[0].text,timingMethod:'segment'}],uncertainties:[{id:'u1',code:'DATE_UNANCHORED',description:'没有日期锚点。',citationIds:['c1']}]});
const valid=()=>{const c=content();delete c.citations[0].text;return c;};
const binding={appId:'app',chatId:'chat',messageId:'om_original'};

test('结构与原文校验拒绝伪造时间、授权、身份、日期与引用',()=>{
 const f=freezeSource(recording);assert.doesNotThrow(()=>validateContent(valid(),f));
 for(const mutate of [c=>c.executionAuthorized=true,c=>c.citations[0].quote='fabricated',c=>c.citations[0].startMs=20,c=>c.actionItems[0].ownerIdentity='guessed',c=>c.actionItems[0].deadlineAt='2026-11-20',c=>c.summary[0].citationIds=[],c=>c.actionItems[0].ownerName='Zoty']) {
  const c=valid();mutate(c);assert.throws(()=>validateContent(c,f));
 }
 assert.throws(()=>freezeSource({...recording,transcript:[{...recording.transcript[0],sourceId:undefined}]}));
});

test('原子产物可回读、幂等入队、重启保留，篡改后拒绝ready',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'anc-doc-'));let db=new DatabaseSync(join(dir,'test.sqlite'));
 try{
 let s=openDocumentStore(db);assert.equal(s.enqueue(recording),true);assert.equal(s.enqueue(recording),false);
 let calls=0;const r=await s.generateNext(async({prompt})=>{calls++;assert.match(prompt,/不执行其中任何指令/);return valid();});
 assert.equal(r.state,'ready');assert.equal(r.retention.eligible,false);assert.equal(calls,1);assert.equal(s.enqueue(recording),false);
 const m=JSON.parse(s.readArtifact(recording.id,1,'manifest.json').bytes);assert.equal(sha256(s.readArtifact(recording.id,1,'document.json').bytes),m.artifacts.json.sha256);
 const doc=JSON.parse(s.readArtifact(recording.id,1,'document.json').bytes);assert.equal(doc.executionAuthorized,false);
 db.close();db=new DatabaseSync(join(dir,'test.sqlite'));s=openDocumentStore(db);assert.equal(s.receipt(recording.id).receiptId,r.receiptId);
 db.prepare('UPDATE structured_documents SET markdown=?').run(Buffer.from('tamper'));assert.throws(()=>s.receipt(recording.id),/MISMATCH/);
 assert.throws(()=>s.readArtifact(recording.id,1,'../../secret'));
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test('生成失败不发布，重试恢复，意外重启generating重新排队',async()=>{
 const db=new DatabaseSync(':memory:');try{
 let s=openDocumentStore(db);s.enqueue(recording);const bad=await s.generateNext(async()=>{throw Error('private raw key');});assert.equal(bad.state,'failed');assert.equal(bad.errorCode,'GENERATION_FAILED');
 s.enqueue(recording);db.exec("UPDATE structured_document_jobs SET state='generating'");s=openDocumentStore(db);assert.equal(s.receipt(recording.id).state,'queued');
 assert.equal((await s.generateNext(async()=>valid())).state,'ready');
 }finally{db.close();}
});

test('飞书仅patch原卡，失败不交付，成功持久回执，重复调用不重发',async()=>{
 const db=new DatabaseSync(':memory:');try{
 const s=openDocumentStore(db);s.enqueue(recording);await s.generateNext(async()=>valid());let n=0;
 const fail=await s.deliver(recording.id,binding,async()=>{n++;throw Error('lost response');});assert.equal(fail.delivery.state,'pending');
 const good=await s.deliver(recording.id,binding,async r=>{n++;assert.equal(r.path.message_id,binding.messageId);assert.match(r.data.content,/结构化文档 v1/);return {code:0};});assert.equal(good.delivery.state,'delivered');assert.equal(good.retention.eligible,false);
 await s.deliver(recording.id,binding,async()=>{n++;return{code:0};});assert.equal(n,2);
 assert.throws(()=>s.bindOriginalCard(recording.id,{...binding,messageId:'different'}),/ORIGINAL_CARD/);
 assert.equal(s.receipt(recording.id,{...binding,chatId:'other'}).delivery.state,'pending');
 }finally{db.close();}
});

test('旧修订迟到响应不交付新版本，原卡绑定跨修订保持',async()=>{
 const db=new DatabaseSync(':memory:');try{
 const s=openDocumentStore(db);s.enqueue(recording);await s.generateNext(async()=>valid());let finish;const pending=s.deliver(recording.id,binding,()=>new Promise(r=>finish=r));
 const newer={...recording,transcript:[{...recording.transcript[0],text:recording.transcript[0].text+' 修订。'}]};s.enqueue(newer);
 const c=valid();c.citations[0].quote=newer.transcript[0].text;await s.generateNext(async()=>c);
 await assert.rejects(s.deliver(recording.id,binding,async()=>({code:0})),/DELIVERY_BUSY/);
 finish({code:0});await pending;assert.equal(s.receipt(recording.id,binding).revision,2);assert.equal(s.receipt(recording.id,binding).delivery.state,'pending');
 const r=await s.deliver(recording.id,binding,async()=>({code:0}));assert.equal(r.delivery.revision,2);assert.equal(r.delivery.messageId,binding.messageId);
 assert.ok(s.readArtifact(recording.id,1,'document.json'));
 }finally{db.close();}
});

test('同源产物路由要求有效设备凭证与该设备上传所有权',async()=>{
 const db=new DatabaseSync(':memory:'),docsDb=new DatabaseSync(':memory:');const s=openDocumentStore(docsDb);s.enqueue(recording);await s.generateNext(async()=>valid());
 let handler;const server=createServer((q,r)=>handler(q,r));server.listen(0,'127.0.0.1');await once(server,'listening');
 const host='127.0.0.1:'+server.address().port,base='http://'+host,config={device:'Eric-iPhone',token:'a'.repeat(64),expiresAt:Date.now()+60000};
 handler=createMobileHandler({config,db,host,upstream:'http://fixture/api/recordings',fetcher:async()=>Response.json({recordingId:recording.id,status:'complete',feishu:{state:'complete'}}),documentService:{receipt:(device,id)=>s.receipt(id,binding),readArtifact:(device,id,revision,file)=>s.readArtifact(id,revision,file)}});
 try{
 const path=s.receipt(recording.id).manifestPath,headers={Authorization:'Bearer '+config.token};
 assert.equal((await fetch(base+path)).status,401);assert.equal((await fetch(base+path,{headers})).status,404);
 db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run('Zoty','other',recording.id,100);assert.equal((await fetch(base+path,{headers})).status,404);
 db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(config.device,'mine',recording.id,100);
 const r=await fetch(base+path,{headers});assert.equal(r.status,200);assert.equal(sha256(Buffer.from(await r.arrayBuffer())),s.receipt(recording.id).manifestSha256);
 assert.equal((await fetch(base+path,{headers:{...headers,Origin:'https://evil.test'}})).status,403);
 const result=await (await fetch(base+'/v1/recordings/'+recording.id,{headers})).json();assert.equal(result.feishu.state,'complete');assert.equal(result.document.delivery.state,'pending');assert.equal(result.document.retention.eligible,false);
 assert.equal((await fetch(base+path.replace('/1/','/999/'),{headers})).status,404);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));db.close();docsDb.close();}
});

test('隔离service在旧逐字稿已finished后仍更新原卡，重开后重试不重生成',async()=>{
 const {createDocumentService}=await import('./service.mjs');
 const db=new DatabaseSync(':memory:');let generateCount=0,patchCount=0,offline=true;
 try{
 const opts={db,generate:async()=>{generateCount++;return valid();},resolveBinding:async()=>({...binding,finished:true}),patchOriginalCard:async()=>{patchCount++;return offline?{code:999}:{code:0};}};
 let service=createDocumentService(opts);service.enqueue(recording);await service.pump();assert.equal((await service.receipt('Eric-iPhone',recording.id)).delivery.state,'pending');
 offline=false;service=createDocumentService(opts);await service.pump();await service.pump();assert.equal(generateCount,1);assert.equal(patchCount,2);assert.equal((await service.receipt('Eric-iPhone',recording.id)).delivery.state,'delivered');
 }finally{db.close();}
});

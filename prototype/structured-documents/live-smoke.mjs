// Opt-in model test using invented text only. No Feishu, ASR, phone or main DB access.
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDocumentStore} from './core.mjs';
import {createCodexDocumentGenerator} from './generator.mjs';
if(process.env.ANC_DOCUMENT_LIVE!=='1')throw Error('Set ANC_DOCUMENT_LIVE=1 to authorize a real model call on synthetic text.');
const directory=await mkdtemp(join(tmpdir(),'anc-doc-live-'));const db=new DatabaseSync(join(directory,'documents.sqlite'));
try{
 const store=openDocumentStore(db);
 store.enqueue({id:'c'.repeat(64),audioBytes:320044,durationMs:10000,transcript:[{sourceId:'synthetic-1',startMs:0,endMs:10000,text:'由 Eric.s 负责写一份功能说明，截止时间是周五。是否开放给客户，下次再决定。'}]});
 const result=await store.generateNext(createCodexDocumentGenerator({cwd:directory}));
 await writeFile(join(directory,'receipt.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({directory,state:result.state,revision:result.revision,errorCode:result.errorCode,delivery:result.delivery?.state,syntheticInput:true,feishuCalled:false}));
 if(result.state!=='ready')process.exitCode=1;
}finally{db.close();}

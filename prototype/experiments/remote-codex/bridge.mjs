// Standalone experiment. Does not open the production database or listen on its ports.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as lark from '@larksuiteoapi/node-sdk';
const run = promisify(execFile);
const directory = path.resolve(process.argv[2]);
const mode = process.argv[3];
const config = JSON.parse(await fs.readFile(path.join(directory,'config.json'),'utf8'));
const feishu = JSON.parse(await fs.readFile('.anc-data/field-20261114/feishu.json','utf8'));
const client = new lark.Client({appId:feishu.appId,appSecret:feishu.appSecret,logger:{error(){},warn(){},info(){},debug(){},trace(){}}});
const statePath=path.join(directory,'bridge-state.json');
let state;
try { state=JSON.parse(await fs.readFile(statePath,'utf8')); }
catch(e) {if(e.code!=='ENOENT')throw e;state={sendKey:crypto.randomUUID(),seen:[],accepted:[],rejected:[],stage:'等待邮件派发',patches:[]};}
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
async function save(){await fs.writeFile(statePath+'.tmp',JSON.stringify(state,null,2),{mode:0o600});await fs.rename(statePath+'.tmp',statePath);}
function card(){
 const completed=state.accepted.find(x=>!x.duplicate);
 return {schema:'2.0',config:{update_multi:true},header:{template:state.stage==='远程执行与重复邮件验收通过'?'green':'blue',title:{tag:'plain_text',content:'ANC · 远程 Codex 邮箱联调'}},body:{elements:[
  {tag:'markdown',content:`**${state.stage}**\n任务 ${config.taskId}\n负责人 Eric.s · 本次在 Codex 对话中授权，不是飞书按钮授权测试。`},
  {tag:'markdown',content:'范围：Grok 云电脑隔离目录，仅生成 totals.mjs 和 README.md；代码工具禁联网、不安装依赖。Mac 主服务与现有录音任务不变。'},
  {tag:'markdown',content:completed?`实际产物独立检查：${completed.checks}/6\nCodex 会话：${completed.sessionId}\n执行次数：${completed.executionCount}\n已核对邮件回执：${state.accepted.length}\n重复邮件：${state.accepted.some(x=>x.duplicate)?'已拦截，复用同一 runId / 会话 / 产物':'待验证'}`:'等待真实邮件触发和 Codex 产物；不会以模型自述代替验收。'},
  {tag:'markdown',content:'这是独立测试桥接卡，后续状态沿用本卡 messageId 更新；尚未接入正式任务台账。'},
 ]}};
}
async function api(p){try{const r=await p;if(r.code!==0)throw Error('Feishu '+r.code);return r.data;}catch(e){throw Error('Feishu request failed: '+(e.response?.data?.code||e.message));}}
async function patch(){await api(client.im.message.patch({path:{message_id:state.messageId},data:{content:JSON.stringify(card())}}));state.patches.push({at:new Date().toISOString(),messageId:state.messageId,stage:state.stage});await save();}
async function verify(receipt){
 if(receipt.taskId!==config.taskId||receipt.nonce!==config.nonce)throw Error('dispatch mismatch');
 if(receipt.status!=='completed'||receipt.executionCount!==1||receipt.exitCode!==0)throw Error('execution not completed');
 if(!/^[0-9a-f-]{36}$/i.test(receipt.sessionId||'')||!receipt.eventTypes?.includes('turn.completed'))throw Error('missing Codex session or completion event');
 if(receipt.promptSha256!==config.promptSha256)throw Error('prompt mismatch');
 if(JSON.stringify([...receipt.actualFiles].sort())!==JSON.stringify(['README.md','totals.mjs']))throw Error('file scope mismatch');
 if(receipt.artifacts?.length!==2||new Set(receipt.artifacts.map(a=>a.name)).size!==2)throw Error('artifact count mismatch');
 const artifacts=path.join(directory,'artifacts',receipt.runId);
 if(!/^[0-9a-f-]{36}$/i.test(receipt.runId||''))throw Error('bad run ID');
 await fs.mkdir(artifacts,{recursive:true});
 for(const a of receipt.artifacts){
  if(!['README.md','totals.mjs'].includes(a.name)||typeof a.content!=='string'||Buffer.byteLength(a.content)>12000||hash(a.content)!==a.sha256)throw Error('artifact integrity');
  await fs.writeFile(path.join(artifacts,a.name),a.content,{mode:0o600});
 }
 const readme=receipt.artifacts.find(a=>a.name==='README.md').content;
 if(!readme.includes('sumPositive')||!readme.includes('null'))throw Error('README missing contract');
 const script=`import assert from 'node:assert/strict'; const eq=assert.equal; const {sumPositive}=await import('./totals.mjs'); eq(sumPositive([2,-1,0,3,'4',NaN,Infinity]),5); eq(sumPositive([]),0); eq(sumPositive(null),0); eq(sumPositive(undefined),0); eq(sumPositive([1.5,2.25,-8]),3.75); console.log('ANC_REMOTE_ASSERTIONS_5_PASS');`;
 await fs.writeFile(path.join(artifacts,'independent.mjs'),script);
 const profile='(version 1)(allow default)(deny network*)(deny file-write*)(deny signal)';
 const {stdout}=await run('/usr/bin/sandbox-exec',['-p',profile,process.execPath,'--permission','--allow-fs-read='+artifacts,path.join(artifacts,'independent.mjs')],{timeout:5000,maxBuffer:4096,env:{PATH:process.env.PATH}});
 if(stdout.trim()!=='ANC_REMOTE_ASSERTIONS_5_PASS')throw Error('independent assertions failed');
 return {eventId:receipt.eventId,deliveryId:receipt.deliveryId,duplicate:receipt.duplicate,runId:receipt.runId,
         sessionId:receipt.sessionId,executionCount:receipt.executionCount,eventsSha256:receipt.eventsSha256,
         artifactDigest:hash(JSON.stringify(receipt.artifacts.map(a=>[a.name,a.sha256]).sort())),checks:6};
}
if(mode==='verify-fixture'){
 const fixture=JSON.parse(await fs.readFile(path.join(directory,'fixture.json'),'utf8'));
 console.log(JSON.stringify(await verify(fixture)));
}else if(mode==='init'){
 await save();
 if(!state.messageId){const r=await api(client.im.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:feishu.chatId,msg_type:'interactive',content:JSON.stringify(card()),uuid:state.sendKey}}));state.messageId=r.message_id;await save();}
 console.log(JSON.stringify({messageId:state.messageId,stage:state.stage}));
}else if(mode==='poll'){
 if(!state.messageId)throw Error('No original card');
 const until=Date.now()+12*60*1000;
 while(Date.now()<until){
  const r=await fetch(config.callback.replace('https://webhook.site/','https://webhook.site/token/')+'/requests?sorting=oldest',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error('Receiver query '+r.status);
  const body=await r.json();await fs.writeFile(path.join(directory,'receiver-latest.json'),JSON.stringify(body,null,2),{mode:0o600});
  for(const item of body.data||[]){
   if(state.seen.includes(item.uuid))continue;
   state.seen.push(item.uuid);
   if(item.method!=='POST'){await save();continue;}
   try{
    const receipt=JSON.parse(item.content);const checked=await verify(receipt);
    if(state.accepted.some(x=>x.eventId===checked.eventId)){await save();continue;}
    const prior=state.accepted[0];
    if(prior&&['runId','sessionId','eventsSha256','artifactDigest'].some(k=>prior[k]!==checked[k]))throw Error('duplicate evidence differs');
    state.accepted.push(checked);
    await fs.writeFile(path.join(directory,'receipt-'+item.uuid+'.json'),JSON.stringify(receipt,null,2),{mode:0o600});
    const deliveries=new Set(state.accepted.map(x=>x.deliveryId));
    state.stage=state.accepted.some(x=>!x.duplicate)&&state.accepted.some(x=>x.duplicate)&&deliveries.size>=2?'远程执行与重复邮件验收通过':'远程产物 6/6，等待重复邮件验收';
   }catch(e){state.rejected.push({requestId:item.uuid,reason:e.message});state.stage='回执验收未通过，需检查';}
   await patch();console.log(JSON.stringify({stage:state.stage,accepted:state.accepted.length,rejected:state.rejected.length,messageId:state.messageId}));
  }
  if(state.stage==='远程执行与重复邮件验收通过')break;
  await new Promise(resolve=>setTimeout(resolve,5000));
 }
}else throw Error('Use init or poll');

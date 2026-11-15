import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {splitWav} from '../speakmode.mjs';
const exec=promisify(execFile);
test('isolated long harness survives actual SIGKILL, preserves checkpoints and refuses evidence overwrite', {timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'anc-long-harness-')),sample=join(root,'sample'),output=join(root,'run');
 try{
  await mkdir(sample);
  const audio=Buffer.alloc(44+300*32000);audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);
  audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(16000,24);audio.writeUInt32LE(32000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(audio.length-44,40);
  for(let i=44;i<audio.length;i+=2)audio.writeInt16LE(i%64<32?1000:-1000,i);
  const manifest={sha256:createHash('sha256').update(audio).digest('hex'),durationMs:300000,
   chunks:splitWav(audio).map(({index,startMs,endMs,sha256})=>({index,startMs,endMs,sha256})),sections:[]};
  await writeFile(join(sample,'long-coffee.wav'),audio);await writeFile(join(sample,'manifest.json'),JSON.stringify(manifest));
  const script=fileURLToPath(new URL('./long-asr.mjs',import.meta.url));
  await exec(process.execPath,[script,sample,output,'--fixture'],{timeout:20000});
  const evidence=await readFile(join(output,'results.json'),'utf8'),report=JSON.parse(evidence);
  assert.equal(report.status,'passed');assert.equal(report.summary.realRequestStarts,0);assert.equal(report.summary.peak,2);
  assert.ok(Object.values(report.checks).every(Boolean));assert.equal(report.phases[1].signal,'SIGKILL');
  assert.equal(report.summary.finalCheckpointCount,10);assert.equal(report.summary.killedUncommittedIndices.length,2);
  await assert.rejects(exec(process.execPath,[script,sample,output,'--fixture']),/Refusing an existing run directory/);
  assert.equal(await readFile(join(output,'results.json'),'utf8'),evidence);
  await writeFile(join(sample,'manifest.json'),JSON.stringify({...manifest,sha256:'changed'}));
  await assert.rejects(exec(process.execPath,[script,sample,join(root,'invalid'),'--fixture']),/Frozen source hash/);
 }finally{await rm(root,{recursive:true,force:true});}
});

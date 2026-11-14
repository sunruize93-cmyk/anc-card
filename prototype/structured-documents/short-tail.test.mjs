import test from'node:test';import assert from'node:assert/strict';import{mergeShortTail}from'./short-tail.mjs';import{createHash}from'node:crypto';
function chunk(index,startMs,endMs){const audio=Buffer.alloc(44+(endMs-startMs)*32,index+1);audio.writeUInt32LE(audio.length-8,4);audio.writeUInt32LE(audio.length-44,40);return{index,startMs,endMs,audio,samples:(audio.length-44)/2,sha256:createHash('sha256').update(audio).digest('hex')};}
test('短尾段保留全部PCM/时间范围，长请求与间隙不合并',()=>{
 const a=chunk(0,0,20000),b=chunk(1,20000,21160),merged=mergeShortTail([a,b]);assert.equal(merged.length,1);assert.equal(merged[0].endMs,21160);assert.deepEqual(merged[0].audio.subarray(44),Buffer.concat([a.audio.subarray(44),b.audio.subarray(44)]));assert.notEqual(merged[0].sha256,a.sha256);
 assert.equal(mergeShortTail([a,chunk(1,20000,22000)]).length,2);assert.equal(mergeShortTail([chunk(0,0,30000),chunk(1,30000,31160)]).length,2);assert.equal(mergeShortTail([a,chunk(1,20100,21000)]).length,2);assert.deepEqual(mergeShortTail([a]),[a]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { describeProgress } from './recording-progress.mjs';
import { assessLocalEndpoint, validity } from './upload-readiness.mjs';

test('progress preserves failure location and recovery semantics, coarse cards change only at milestones',()=>{
  const p={stage:'transcribing',totalChunks:120,completedChunks:37,reusedChunks:20,currentChunk:{index:37,startMs:1110000,endMs:1140000}};
  assert.match(describeProgress(p,'failed'),/第 38 段（原音 18:30–19:00）失败/);
  assert.match(describeProgress(p,'failed'),/仍可能已计费/);
  assert.match(describeProgress(p,'queued'),/重新核对片段缓存/);
  assert.match(describeProgress(p,'processing'),/本轮复用 20 段/);
  assert.equal(describeProgress(p,'processing',{coarse:true}),describeProgress({...p,completedChunks:38},'processing',{coarse:true}));
  assert.equal(describeProgress(null,'complete'),'');
  assert.match(describeProgress({totalChunks:0},'complete'),/回听原音/);
  assert.match(describeProgress({failureStage:'normalizing'},'failed'),/音频转换阶段/);
});

test('readiness refuses stale/nonlocal credential destinations and distinguishes imminent expiry',()=>{
  assert.ok(assessLocalEndpoint('https://192.168.1.5:4787',['192.168.1.5']));
  for(const value of ['https://192.168.0.11:4787','https://example.com','http://192.168.1.5','https://user@192.168.1.5','https://192.168.1.5/path']) {
    assert.equal(assessLocalEndpoint(value,['192.168.1.5']),null);
  }
  assert.equal(validity(1000,1000),'failed');assert.equal(validity(1001,1000),'warning');
  assert.equal(validity(1000+86400000,1000),'passed');assert.equal(validity(NaN,1000),'failed');
});

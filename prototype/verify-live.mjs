// Explicitly sends a generated sample through the configured SpeakMode cloud account.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const url = `http://127.0.0.1:${process.env.ANC_PROTOTYPE_PORT || 4785}`;
const response = await fetch(url + '/api/speakmode');
const status = await response.json();
assert.ok(status.installed && status.configured, '请在 ANC Card 页面配置 SpeakMode，再运行真实转写验证。');
const directory = await mkdtemp(join(tmpdir(), 'anc-speakmode-live-'));
try {
  const sample = join(directory, 'sample.wav');
  const generated = spawn('sh', [fileURLToPath(new URL('./scripts/make-sample.sh', import.meta.url)), sample], { stdio: 'ignore' });
  assert.equal((await once(generated, 'exit'))[0], 0);
  const wave = await readFile(sample);
  // A RIFF JUNK chunk makes this run distinct from past Whisper and cloud pilots.
  const marker = Buffer.from(randomUUID());
  const junk = Buffer.alloc(8);
  junk.write('JUNK');
  junk.writeUInt32LE(marker.length, 4);
  const audio = Buffer.concat([wave, junk, marker]);
  audio.writeUInt32LE(audio.length - 8, 4);
  const imported = await fetch(url + '/api/recordings', {
    method: 'POST', headers: { 'X-ANC-Filename': 'speakmode-synthetic-pilot.wav' }, body: audio,
  });
  assert.equal(imported.status, 202);
  const { recording } = await imported.json();
  console.log('SpeakMode 自制音频已入队，等待实际云端转写。', recording.id);
  let completed;
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    const rows = await (await fetch(url + '/api/recordings')).json();
    const row = rows.find(row => row.id === recording.id);
    assert.notEqual(row.status, 'failed', row.error || 'SpeakMode 转写失败。');
    if (row.status === 'complete') { completed = row; break; }
    await delay(500);
  }
  assert.ok(completed, '转写尚未完成，原录音和队列记录已保留。');
  assert.ok(completed.transcript.length > 0);
  assert.equal(completed.ledger.length, 2, '请回听核对识别结果，样本预期有两条行动项。');
  assert.deepEqual(completed.ledger.map(task => [task.owner, task.deadline]), [['Zoty', '本周五'], ['Eric.s', '下周一']]);
  for (const segment of completed.transcript) {
    assert.equal(segment.engine, 'speakmode');
    assert.equal(segment.model, 'qwen3-asr-flash');
    assert.equal(segment.timing, 'audio_chunk');
  }
  for (const task of completed.ledger) {
    assert.ok(completed.transcript.some(segment => segment.sourceId === task.sourceId &&
      segment.startMs === task.startMs && segment.endMs === task.endMs && segment.text === task.evidence));
  }
  const original = await fetch(url + `/api/recordings/${recording.id}/audio`);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), audio);
  const duplicate = await fetch(url + '/api/recordings', {
    method: 'POST', headers: { 'X-ANC-Filename': 'same-synthetic-pilot.wav' }, body: audio,
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).recording.id, recording.id);
  console.log('LIVE VERIFIED — SpeakMode 实际转写、分段时间、行动项、持久化台账和重复导入通过。');
  console.log(JSON.stringify(completed.ledger.map(({ owner, title, deadline, startMs, endMs }) =>
    ({ owner, title, deadline, startMs, endMs })), null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}

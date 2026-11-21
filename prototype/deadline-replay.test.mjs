import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { extract, openRecordings } from './recordings.mjs';

const fixture = new URL('../docs/benchmarks/asr-long-2026-11-15.json', import.meta.url);
const sample = JSON.parse(await readFile(fixture, 'utf8'));

function assertSource(reference, segment) {
  assert.equal(reference.evidence, segment.text);
  for (const field of ['sourceId', 'chunkSha256', 'startMs', 'endMs', 'timing']) {
    assert.equal(reference[field], segment[field], field);
  }
}

test('hour-long frozen ASR replay applies all 53 Friday-to-Monday amendments with both audio references', () => {
  assert.equal(sample.ledger.length, 53);
  assert.equal(sample.transcript.length, 159);
  const ledger = extract(sample.transcript);
  assert.equal(ledger.length, sample.ledger.length);

  for (const [index, item] of ledger.entries()) {
    const baseline = sample.ledger[index];
    const section = sample.manifest.sections[index];
    assert.equal(baseline.deadline, '下周五');
    assert.equal(item.owner, baseline.owner);
    assert.equal(item.title, baseline.title);
    assert.equal(item.deadline, '下周一', item.title);
    assert.equal(item.status, 'needs_review');

    const original = sample.transcript.find(segment => segment.sourceId === baseline.sourceId);
    assertSource(item, original);
    // Independently locate the amendment in this numbered section of the frozen
    // script. A correction from any of the other 52 similar sections must fail.
    const corrections = sample.transcript.filter(segment =>
      segment.startMs < section.endMs && segment.endMs > section.startMs &&
      segment.text.includes('最终截止时间改为下周一'));
    assert.equal(corrections.length, 1, item.title);
    const [correction] = corrections;
    assert.ok(correction.startMs >= original.endMs);
    assert.notEqual(correction.sourceId, original.sourceId);
    assert.notEqual(correction.chunkSha256, original.chunkSha256);
    assert.equal(item.deadlineChanges?.length, 1, item.title);
    const [change] = item.deadlineChanges;
    assert.equal(change.previousDeadline, baseline.deadline);
    assert.equal(change.deadline, item.deadline);
    assertSource(change, correction);
  }
});

test('reopening the queue reuses 53 persisted task IDs and their amendment evidence', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'anc-deadline-replay-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Seed the completed recording directly so the real startup code loads the
  // stored ledger while the replay stays independent of audio tools and ASR.
  const initialQueue = await openRecordings(dir);
  await initialQueue.close();
  const ledger = extract(sample.transcript);
  const id = sample.manifest.sha256;
  const db = new DatabaseSync(join(dir, 'recordings.sqlite'));
  try {
    db.prepare(`INSERT INTO recordings(id,name,createdAt,audio,status,transcript,ledger)
      VALUES (?, 'frozen-replay.wav', ?, X'', 'complete', ?, ?)`)
      .run(id, sample.createdAt, JSON.stringify(sample.transcript), JSON.stringify(ledger));
  } finally {
    db.close();
  }

  for (let startup = 0; startup < 2; startup++) {
    const queue = await openRecordings(dir);
    try {
      assert.equal(queue.tasks.list().filter(task => task.source?.recordingId === id).length, 53);
      for (const item of ledger) {
        const task = queue.tasks.get(item.id);
        assert.equal(task.version, 1);
        assert.equal(task.deadline, '下周一');
        assert.equal(task.status, 'needs_review');
        assert.deepEqual(task.source.deadlineChanges, item.deadlineChanges);
      }
    } finally {
      await queue.close();
    }
  }
});

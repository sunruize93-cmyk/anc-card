import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import * as lark from '@larksuiteoapi/node-sdk';
import { openTasks } from './tasks.mjs';
import { receiveCardAction, taskCard } from './feishu.mjs';
import { extract } from './recordings.mjs';

function ingest(tasks) {
  const id = randomUUID();
  tasks.ingest({ id: 'recording-sha', name: 'self-generated.wav', ledger: [{ id, title: '接口示例和调用说明',
    owner: '小王', deadline: '本周五', evidence: '由小王负责接口示例和调用说明，接口 429 只重试一次。',
    startMs: 1000, endMs: 16000, timing: 'audio_chunk', sourceId: 'asr-source', chunkSha256: 'chunk-sha' }] });
  return id;
}

function result(sessionId, complete) {
  return { sessionId, summary: '验证回传', code: complete ? 'retry once' : 'send once', guide: 'usage',
    checks: ['example', 'guide', 'rate-limit'].map(id => ({ id, passed: complete || id !== 'rate-limit', detail: id })) };
}

test('真实来源任务通过负责人确认，在同一任务与会话中从 2/3 续跑到 3/3', () => {
  const db = new DatabaseSync(':memory:');
  const tasks = openTasks(db);
  const id = ingest(tasks);
  const source = tasks.get(id).source;
  tasks.ingest({ id: source.recordingId, name: source.name, ledger: [source] });
  assert.equal(tasks.list().filter(task => task.origin === 'recording').length, 1);
  const ready = tasks.prepare(id, 1, 'local');
  assert.equal(ready.taskId, source.id);
  assert.equal(ready.source.evidence, source.evidence);
  assert.throws(() => tasks.confirm({ taskId: id, version: ready.version, proposalId: ready.proposal.id,
    actor: 'ou_other', channel: 'local' }), error => error.status === 403);
  tasks.confirm({ taskId: id, version: ready.version, proposalId: ready.proposal.id, actor: 'local', channel: 'local' });
  assert.throws(() => tasks.confirm({ taskId: id, version: ready.version, proposalId: ready.proposal.id,
    actor: 'local', channel: 'local' }), error => error.status === 409);
  assert.equal(tasks.claim().taskId, id);
  assert.equal(tasks.claim(), undefined);
  const sessionId = randomUUID();
  tasks.session(id, sessionId);
  tasks.result(id, result(sessionId, false));
  const awaiting = tasks.get(id);
  assert.equal(awaiting.status, 'awaiting');
  assert.equal(awaiting.rounds[0].checks.filter(check => check.passed).length, 2);
  const snapshot = structuredClone(awaiting.rounds[0]);
  tasks.confirm({ taskId: id, version: awaiting.version, proposalId: awaiting.proposal.id, actor: 'local', channel: 'local' });
  tasks.claim();
  tasks.result(id, result(sessionId, true));
  const done = tasks.get(id);
  assert.equal(done.status, 'complete');
  assert.deepEqual(done.rounds[0], snapshot);
  assert.equal(done.rounds[1].sessionId, done.rounds[0].sessionId);
  assert.equal(done.confirmations.length, 2);
  assert.deepEqual(done.source, source);
  db.close();
});

test('飞书实际 SDK 分发形状、负责人、群、原卡片、版本及重复点击校验', async () => {
  const db = new DatabaseSync(':memory:');
  const tasks = openTasks(db);
  const id = ingest(tasks);
  const task = tasks.prepare(id, 1, 'ou_owner', 'oc_test');
  tasks.delivered(id, task.version, 'om_original');
  const config = { appId: 'cli_test', chatId: 'oc_test' };
  const value = taskCard(task).body.elements.at(-1).columns[0].elements[0].behaviors[0].value;
  const raw = { schema: '2.0', header: { app_id: config.appId, event_type: 'card.action.trigger', event_id: 'evt-1' },
    event: { operator: { open_id: 'ou_owner' }, context: { open_chat_id: 'oc_test', open_message_id: 'om_original' }, action: { value } } };
  const dispatcher = new lark.EventDispatcher({ logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } })
    .register({ 'card.action.trigger': data => receiveCardAction(data, config, tasks) });
  for (const mutation of [
    r => { r.event.operator.open_id = 'ou_wrong'; },
    r => { r.event.context.open_chat_id = 'oc_wrong'; },
    r => { r.event.context.open_message_id = 'om_wrong'; },
    r => { r.event.action.value.version--; },
    r => { r.header.app_id = 'cli_wrong'; },
  ]) {
    const wrong = structuredClone(raw);
    mutation(wrong);
    assert.equal((await dispatcher.invoke(wrong, { needCheck: false })).toast.type, 'error');
  }
  assert.equal(tasks.get(id).status, 'awaiting');
  assert.equal((await dispatcher.invoke(raw, { needCheck: false })).toast.type, 'success');
  assert.equal((await dispatcher.invoke(raw, { needCheck: false })).toast.type, 'error');
  assert.equal(tasks.get(id).confirmations.length, 1);
  assert.equal(tasks.get(id).status, 'queued');
  assert.equal(tasks.deliveries()[0].task.card.messageId, 'om_original');
  assert.equal(tasks.get(id).confirmations[0].channel, 'feishu');
  db.close();
});

test('任务的验收要求与截止时间之间有其他分句时，仍分别保留每位负责人的截止时间', () => {
  const items = extract([{ startMs: 0, endMs: 20000, text: '由小王负责接口示例，429 只重试一次，截止时间是本周五。由小李负责文档，补充用法，截止时间是下周一。' }]);
  assert.deepEqual(items.map(item => [item.owner, item.deadline]), [['小王', '本周五'], ['小李', '下周一']]);
});

test('录音台账重载不重复建任务，待确认建议和已接受的执行请求在重启后保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anc-task-store-'));
  try {
    const file = join(directory, 'tasks.sqlite');
    let db = new DatabaseSync(file);
    let tasks = openTasks(db);
    const id = ingest(tasks);
    const waiting = tasks.prepare(id, 1, 'local');
    db.close();
    db = new DatabaseSync(file);
    tasks = openTasks(db);
    assert.deepEqual(tasks.get(id), waiting);
    tasks.confirm({ taskId: id, version: waiting.version, proposalId: waiting.proposal.id, actor: 'local', channel: 'local' });
    const queued = tasks.get(id);
    db.close();
    db = new DatabaseSync(file);
    tasks = openTasks(db);
    assert.deepEqual(tasks.get(id), queued);
    tasks.claim();
    const sessionId = randomUUID();
    tasks.session(id, sessionId);
    db.close();
    db = new DatabaseSync(file);
    tasks = openTasks(db);
    const interrupted = tasks.get(id);
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.sessionId, sessionId);
    assert.equal(interrupted.approvedProposal.id, waiting.proposal.id);
    tasks.confirm({ taskId: id, version: interrupted.version, actor: 'local', channel: 'local', action: 'recover' });
    assert.equal(tasks.get(id).recovering, true);
    db.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

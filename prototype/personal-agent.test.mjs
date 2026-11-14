import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openTasks } from './tasks.mjs';
import { runTasks } from './task-runner.mjs';
import { executePersonal, readPersonalArtifact } from './personal-worker.mjs';
import { syncTaskDelivery, receiveCardAction } from './feishu.mjs';

const contract = { executor: 'codex', instruction: '创建一个纯函数示例并说明用法', acceptance: '负责人核对示例', files: ['example.mjs', 'README.md'] };
function seed(tasks, owner = 'local', chat = null) {
  const id = randomUUID();
  tasks.ingest({ id: 'fixture-recording', name: 'synthetic.wav', ledger: [{ id, title: '通用代码任务', owner: 'Eric.s', evidence: '创建一个纯函数示例', startMs: 0, endMs: 1000 }] });
  return tasks.plan(id, 1, contract, owner, chat, 'Eric.s');
}
const approve = (tasks, t) => tasks.confirm({ taskId: t.taskId, version: t.version, proposalId: t.proposal?.id || t.approvedProposal?.id,
  actor: 'local', channel: 'local', action: t.status === 'interrupted' ? 'recover' : 'approve' });
const result = t => ({ sessionId: t.sessionId || randomUUID(), contractDigest: t.approvedProposal.contractDigest, workspaceId: t.workspaceId, artifacts: [], checks: [], summary: 'fixture output' });
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('timed out'); }

test('授权版本/负责人/渠道校验，重复确认只入队一次；改派、撤回使旧范围失效', () => {
  const db = new DatabaseSync(':memory:'); const tasks = openTasks(db); const t = seed(tasks);
  for (const change of [{ actor: 'ou_other' }, { version: 1 }, { channel: 'email' }, { proposalId: 'old' }]) {
    assert.throws(() => tasks.confirm({ taskId: t.taskId, version: t.version, proposalId: t.proposal.id, actor: 'local', channel: 'local', ...change }));
  }
  approve(tasks, t); assert.throws(() => approve(tasks, t));
  const changed = tasks.plan(t.taskId, tasks.get(t.taskId).version, { ...contract, instruction: '新的范围' }, 'ou_new', 'oc_test');
  assert.equal(tasks.claim(), undefined); assert.notEqual(changed.workspaceId, t.workspaceId); assert.equal(changed.sessionId, null);
  assert.throws(() => tasks.confirm({ taskId: t.taskId, version: changed.version, proposalId: changed.proposal.id, actor: 'local', channel: 'local' }));
  tasks.delivered(t.taskId, changed.version, 'om_card');
  tasks.withdraw({ taskId: t.taskId, version: changed.version, actor: 'ou_new', channel: 'feishu', messageId: 'om_card', chatId: 'oc_test' });
  assert.equal(tasks.claim(), undefined); db.close();
});

test('执行器不可用保留授权，恢复需匹配proposal；重启保存会话，续轮沿用原工作目录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anc-pa-db-')); const file = join(dir, 'tasks.sqlite'); let db = new DatabaseSync(file);
  try {
    let tasks = openTasks(db); const t = seed(tasks); approve(tasks, t); const running = tasks.claim(); const id = running.taskId;
    const sessionId = randomUUID(); tasks.session(id, sessionId, undefined, running.runId); tasks.fail(id, 'CLI unavailable', running.runId);
    assert.throws(() => tasks.confirm({ taskId: id, version: tasks.get(id).version, proposalId: 'wrong', actor: 'local', channel: 'local', action: 'recover' }));
    db.close(); db = new DatabaseSync(file); tasks = openTasks(db); approve(tasks, tasks.get(id)); tasks.claim();
    tasks.save({ ...tasks.get(id), executionOwnerPid: null }); // simulate the old process exiting
    db.close(); db = new DatabaseSync(file); tasks = openTasks(db); assert.equal(tasks.get(id).status, 'interrupted');
    assert.equal(tasks.get(id).sessionId, sessionId); approve(tasks, tasks.get(id)); const resumed = tasks.claim();
    tasks.result(id, result(resumed), resumed.runId); const review = tasks.get(id); assert.equal(review.status, 'review');
    const next = tasks.plan(id, review.version, { ...contract, instruction: '补充边界输入说明' }, 'local');
    assert.equal(next.sessionId, sessionId); assert.equal(next.workspaceId, t.workspaceId); approve(tasks, next);
    const run2 = tasks.claim(); tasks.result(id, result(run2), run2.runId);
    tasks.accept({ taskId: id, version: tasks.get(id).version, actor: 'local', channel: 'local' }); assert.equal(tasks.get(id).status, 'complete');
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('运行中撤回会中止执行器；迟到的结果不能覆盖撤回状态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anc-pa-run-')); const db = new DatabaseSync(':memory:'); const tasks = openTasks(db); const t = seed(tasks);
  let calls = 0, aborted = false;
  const runner = runTasks(tasks, dir, { intervalMs: 5, executeTask: async (_, task, { signal }) => {
    calls++; await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true })); return result(task);
  } });
  try {
    approve(tasks, t); await until(() => calls === 1); const current = tasks.get(t.taskId);
    assert.throws(() => tasks.plan(t.taskId, current.version, contract, 'local'), /执行尚未结束/);
    tasks.withdraw({ taskId: t.taskId, version: current.version, actor: 'local', channel: 'local' });
    await until(() => aborted); await runner.close(); assert.equal(calls, 1); assert.equal(tasks.get(t.taskId).status, 'withdrawn');
    assert.equal(tasks.get(t.taskId).rounds.length, 0);
  } finally { await runner.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('同库两个队列观察者不会重复claim；活进程不被重开台账标为中断', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anc-pa-claim-')); const file = join(dir, 'tasks.sqlite'); const db = new DatabaseSync(file); const second = new DatabaseSync(file);
  try {
    const tasks = openTasks(db); const t = seed(tasks); approve(tasks, t); const run = tasks.claim(); tasks.session(t.taskId, randomUUID(), process.pid, run.runId);
    const other = openTasks(second); assert.equal(other.get(t.taskId).status, 'running'); assert.equal(other.claim(), undefined);
  } finally { db.close(); second.close(); await rm(dir, { recursive: true, force: true }); }
});

test('飞书回调拒绝非负责人；结果重试只patch原messageId，不再create', async () => {
  const db = new DatabaseSync(':memory:'); const tasks = openTasks(db); const t = seed(tasks, 'ou_owner', 'oc_test'); let creates = 0, patches = [], fail = false;
  const client = { im: { message: { create: async () => { creates++; return { code: 0, data: { message_id: 'om_original' } }; },
    patch: async req => { patches.push(req.path.message_id); if (fail) throw Error('fixture network failure'); return { code: 0, data: {} }; } } } };
  const config = { appId: 'cli_test', chatId: 'oc_test' };
  await syncTaskDelivery({ tasks, config, client });
  const data = { app_id: 'cli_test', operator: { open_id: 'ou_wrong' }, context: { open_chat_id: 'oc_test', open_message_id: 'om_original' },
    action: { value: { taskId: t.taskId, version: t.version, proposalId: t.proposal.id, action: 'approve' } } };
  assert.equal(receiveCardAction(data, config, tasks).toast.type, 'error'); data.operator.open_id = 'ou_owner';
  assert.equal(receiveCardAction(data, config, tasks).toast.type, 'success'); assert.equal(receiveCardAction(data, config, tasks).toast.type, 'error');
  const run = tasks.claim(); tasks.result(t.taskId, result(run), run.runId); fail = true;
  await syncTaskDelivery({ tasks, config, client }); assert.ok(tasks.get(t.taskId).card.error);
  db.prepare('UPDATE tasks SET deliveryRetryAt=0').run(); fail = false; await syncTaskDelivery({ tasks, config, client });
  assert.equal(creates, 1); assert.deepEqual(patches, ['om_original', 'om_original']); assert.equal(tasks.get(t.taskId).card.error, null); db.close();
});

test('通用worker按授权传递需求、会话；核查产物、外部改动和越界文件', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'anc-pa-artifacts-'))); const db = new DatabaseSync(':memory:'); const tasks = openTasks(db); const t = seed(tasks); approve(tasks, t); let running = tasks.claim();
  const id = randomUUID();
  try {
    const output = await executePersonal(dir, running, { runCodex: async (_, prompt, session) => {
      assert.match(prompt, /创建一个纯函数示例/); assert.equal(session, null);
      await writeFile(join(dir, 'example.mjs'), 'export const value = 1;'); await writeFile(join(dir, 'README.md'), 'example'); return { sessionId: id, summary: 'done' };
    } });
    assert.equal(output.artifacts.length, 2); tasks.result(t.taskId, output, running.runId);
    const next = tasks.plan(t.taskId, tasks.get(t.taskId).version, contract, 'local'); approve(tasks, next); running = tasks.claim();
    await executePersonal(dir, running, { runCodex: async (_, __, session) => { assert.equal(session, id); return { sessionId: id }; } });
    await writeFile(join(dir, 'example.mjs'), 'changed outside'); await assert.rejects(executePersonal(dir, running), /工作文件已在授权外变更/);
    await writeFile(join(dir, 'example.mjs'), 'export const value = 1;');
    await assert.rejects(executePersonal(dir, running, { runCodex: async () => { await writeFile(join(dir, 'unexpected.txt'), 'out of scope'); return { sessionId: id }; } }), /授权文件清单以外/);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('产物读取仅返回已核验文件；拒绝回传后变更、未知文件与符号链接', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anc-pa-read-')));
  const taskId = randomUUID(), workspaceId = randomUUID();
  const { mkdir, symlink } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const work = join(root, 'tasks', taskId, workspaceId); await mkdir(work, { recursive: true });
  const task = { taskId, rounds: [{ workspaceId, artifacts: [{ name: 'README.md', sha256: createHash('sha256').update('verified').digest('hex') }] }] };
  try {
    await writeFile(join(work, 'README.md'), 'verified'); assert.equal((await readPersonalArtifact(root, task, 'README.md')).toString(), 'verified');
    await assert.rejects(readPersonalArtifact(root, task, '../secret'), /产物不存在/);
    await writeFile(join(work, 'README.md'), 'changed'); await assert.rejects(readPersonalArtifact(root, task, 'README.md'), /发生变更/);
    await rm(join(work, 'README.md')); await writeFile(join(root, 'private'), 'verified'); await symlink(join(root, 'private'), join(work, 'README.md'));
    await assert.rejects(readPersonalArtifact(root, task, 'README.md'), /链接已变更/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

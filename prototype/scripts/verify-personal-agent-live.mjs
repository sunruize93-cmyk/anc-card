// Explicit opt-in: invokes the authenticated local Codex CLI twice. Never opens Feishu.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { openTasks } from '../tasks.mjs';
import { runTasks } from '../task-runner.mjs';
if (process.env.ANC_LIVE_EXECUTOR_TEST !== '1') throw Error('Set ANC_LIVE_EXECUTOR_TEST=1 to run an actual CLI acceptance test.');
const exec = promisify(execFile);
const directory = resolve(process.argv[2] || '.anc-data/field-20261114/personal-agent-live-' + Date.now());
await mkdir(directory, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(directory, 'tasks.sqlite')); const tasks = openTasks(db); const runner = runTasks(tasks, directory);
const id = randomUUID(); const approve = t => tasks.confirm({ taskId: id, version: t.version, actor: 'local', channel: 'local', proposalId: t.proposal.id });
async function waitResult() {
  for (let i = 0; i < 240; i++) {
    const t = tasks.get(id); if (t.status === 'review') return t;
    if (t.status === 'interrupted') throw Error(t.events.at(-1).text);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw Error('live acceptance timed out');
}
try {
  tasks.ingest({ id: 'synthetic-live-acceptance', name: 'synthetic test (no recording)', ledger: [{ id, title: '本机通用执行器独立验收', owner: 'local-test', evidence: '人工构造的执行器验收，不是真实录音或飞书点击。', startMs: 0, endMs: 0 }] });
  const contract = { executor: 'codex', files: ['totals.mjs', 'README.md'], instruction: 'Create totals.mjs exporting sumPositive(values), returning the sum of finite positive numeric values, ignoring zero, negatives, NaN, Infinity and strings. Create README.md with a minimal usage example. Do not create other files.', acceptance: 'Independent Node assertions: [1,-2,3,0,NaN,Infinity,"4"] returns 4; empty list returns 0.' };
  const plan = tasks.plan(id, 1, contract, 'local'); approve(plan);
  const first = await waitResult();
  const work = await realpath(join(directory, 'tasks', id, first.workspaceId));
  async function check(expression) {
    const code = `import assert from 'node:assert/strict'; import {sumPositive} from ${JSON.stringify(pathToFileURL(join(work, 'totals.mjs')).href)}; ${expression}`;
    await exec('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default) (deny network*)', process.execPath, '--permission', '--allow-fs-read=' + work, '--input-type=module', '-e', code], { env: {}, timeout: 4000, maxBuffer: 16384 });
  }
  await check('assert.equal(sumPositive([1,-2,3,0,NaN,Infinity,"4"]),4); assert.equal(sumPositive([]),0);');
  const secondPlan = tasks.plan(id, first.version, { ...contract, instruction: 'Continue in the same session. Preserve all sumPositive behavior and add handling for null or undefined values input: return 0. Update README.md to describe null and undefined. Do not create other files.', acceptance: 'Previous checks still pass; null and undefined inputs return 0.' }, 'local');
  approve(secondPlan); const second = await waitResult();
  await check('assert.equal(sumPositive([1,-2,3,0,NaN,Infinity,"4"]),4); assert.equal(sumPositive(null),0); assert.equal(sumPositive(undefined),0);');
  assert.equal(second.sessionId, first.sessionId); assert.equal(second.workspaceId, first.workspaceId); assert.equal(second.rounds.length, 2);
  const evidence = { at: new Date().toISOString(), kind: 'real-local-codex / synthetic authorization / no Feishu', taskId: id, sessionId: second.sessionId,
    status: second.status, workspace: work, rounds: second.rounds, independentAssertions: 'passed both rounds', feishu: 'not exercised', acceptance: 'left at review; not impersonating a real owner' };
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ evidence: join(directory, 'evidence.json'), sessionId: second.sessionId, status: second.status, rounds: second.rounds.length }));
} finally { await runner.close(); db.close(); }

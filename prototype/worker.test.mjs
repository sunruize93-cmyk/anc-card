import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verification, verifyArtifacts, execute } from './worker.mjs';
import { usageGuide } from './execution-guide.mjs';

const single = 'export async function fetchExample(send) { return (await send()).body; }';
const retry = 'export async function fetchExample(send) { let r=await send(); if(r.status===429) r=await send(); return r.body; }';

test('固定示例文档与行为一致；代码修好但旧说明残留时不能 3/3', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anc-guide-'));
  try {
    await writeFile(join(dir, 'verify.mjs'), verification);
    for (const [label, code, guide, expected] of [
      ['首轮', single, usageGuide(false), [true, true, false]],
      ['仅修代码', retry, usageGuide(false), [true, false, true]],
      ['仅修文档', single, usageGuide(true), [true, false, false]],
      ['同步修正', retry, usageGuide(true), [true, true, true]],
      ['正确模板夹带旧段落', retry, usageGuide(true) + '\n本轮未实现 429 重试。', [true, false, true]],
      ['Windows 换行', retry, usageGuide(true).replaceAll('\n', '\r\n'), [true, true, true]],
      ['错误重试 503', retry.replace('r.status===429', 'r.status!==200'), usageGuide(true), [true, false, false]],
    ]) {
      await writeFile(join(dir, 'client.mjs'), code);
      await writeFile(join(dir, 'USAGE.md'), guide);
      assert.deepEqual((await verifyArtifacts(dir)).map(c => c.passed), expected, label);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('不能把旧的仅改代码授权悄悄扩成文档修改', async () => {
  await assert.rejects(execute('/unused', { rounds: [{}], approvedProposal: { action: '只改 client.mjs' } }), /授权尚未包含 USAGE.md/);
});

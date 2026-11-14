import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { exportExecutorEvidence } from './scripts/export-executor-evidence.mjs';
test('snapshot export preserves mixed provenance and unknown events; rejects changed or escaped artifacts', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'anc-export-'))), workspace = join(dir, 'task'); await mkdir(workspace);
  try {
    const body = 'synthetic fixture'; await writeFile(join(workspace, 'README.md'), body);
    const artifact = { name: 'README.md', bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') };
    const input = { kind: 'real-local-codex / synthetic authorization / no Feishu', taskId: randomUUID(), sessionId: randomUUID(), workspace,
      rounds: [{ round: 1, artifacts: [] }, { round: 2, artifacts: [artifact] }] };
    const file = join(dir, 'evidence.json'); await writeFile(file, JSON.stringify(input));
    const result = await exportExecutorEvidence(file);
    assert.deepEqual(result.events, []); assert.equal(result.provenance.taskSource, 'synthetic-test'); assert.equal(result.missing.authorizationId.status, 'unknown');
    assert.equal(JSON.stringify(result).includes(dir), false); assert.equal(result.artifacts[0].content, body);
    await writeFile(join(workspace, 'README.md'), 'changed'); await assert.rejects(exportExecutorEvidence(file), /no longer matches/);
    await writeFile(file, JSON.stringify({ ...input, workspace: dirnameForTest(dir) })); await assert.rejects(exportExecutorEvidence(file), /belong/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
function dirnameForTest(path) { return join(path, '..'); }

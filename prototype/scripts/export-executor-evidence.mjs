// Read-only exporter: reads one explicit closed-run evidence file and its named artifacts.
// Emits JSON to stdout. No SQLite, service requests, execution, configuration or file writes.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const unknown = reason => ({ status: 'unknown', reason });
export async function exportExecutorEvidence(input) {
  const file = await realpath(input), root = dirname(file);
  const original = await readFile(file);
  const evidence = JSON.parse(original);
  if (evidence.kind !== 'real-local-codex / synthetic authorization / no Feishu' || !Array.isArray(evidence.rounds) || evidence.rounds.length !== 2) throw Error('Unsupported source; refusing to infer provenance.');
  if (!/^[a-f0-9-]{36}$/i.test(evidence.taskId || '') || !/^[a-f0-9-]{36}$/i.test(evidence.sessionId || '')) throw Error('Invalid task/session evidence.');
  const workspace = await realpath(evidence.workspace);
  const workspaceRelative = relative(root, workspace);
  if (workspaceRelative.startsWith('..') || isAbsolute(workspaceRelative)) throw Error('Artifacts must belong to this explicit closed-run directory.');
  const artifacts = [];
  const last = evidence.rounds.at(-1);
  for (const entry of last.artifacts || []) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(entry.name)) throw Error('Invalid artifact name.');
    const name = join(workspace, entry.name), info = await lstat(name);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 262144 || await realpath(name) !== name) throw Error('Unsafe artifact.');
    const bytes = await readFile(name);
    if (sha(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw Error('Artifact no longer matches recorded final round.');
    artifacts.push({ name: entry.name, bytes: bytes.length, sha256: sha(bytes), content: bytes.toString('utf8'), associatedRound: last.round });
  }
  return {
    format: 'anc-executor-snapshot-export-v1', exportedAt: new Date().toISOString(),
    provenance: { execution: 'real-local-codex', taskSource: 'synthetic-test', authorization: 'synthetic-local-test',
      feishu: 'not exercised', iphone: 'not exercised', audio: 'not exercised', artifactAcquisition: 'read-only named files; final bytes independently hashed during export' },
    source: { evidenceFile: 'closed-run/evidence.json', evidenceSha256: sha(original), evidenceBytes: original.length, workspaceRelative },
    snapshot: { at: evidence.at, taskId: evidence.taskId, sessionId: evidence.sessionId, status: evidence.status,
      rounds: evidence.rounds.map(round => ({ round: round.round, sessionId: round.sessionId, workspaceId: round.workspaceId,
        contractDigest: round.contractDigest, artifacts: round.artifacts, acceptance: round.acceptance,
        modelSummary: round.summary, checks: round.checks, recordedVerification: round.verification })),
      independentAssertions: { status: 'reported-passed', source: 'recorded harness completion field', value: evidence.independentAssertions, rawPerRoundAssertionLog: 'unknown' },
      acceptance: evidence.acceptance },
    order: { kind: 'ordered-round-snapshots', evidence: 'rounds array and explicit round numbers in source file',
      claim: 'round 1 then round 2 are recorded in the same task/session',
      historicalEventSequence: 'unknown', eventTimestamps: 'unknown', note: 'Export order is not execution event order. No eventId, seq or authorizationId synthesized.' },
    events: [],
    missing: Object.fromEntries(['authorizationId', 'approvedVersion', 'proposalId', 'runId', 'feishuConfirmation', 'messageId', 'recordingId', 'uploadReceipt', 'semanticKey', 'ownerMapping', 'executionStartTimes', 'originalCardPatchReceipt', 'fullObservationWindow', 'round1ArtifactBytes'].map(field => [field, unknown('Not present in the provided evidence file; no historical event reconstruction.')])),
    artifacts,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw Error('Usage: node export-executor-evidence.mjs /explicit/closed-run/evidence.json');
  try { process.stdout.write(JSON.stringify(await exportExecutorEvidence(process.argv[2]), null, 2) + '\n'); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, chmod, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodex } from './codex-executor.mjs';

test('CLI adapter uses stdin, explicit session ID, persists session before completion, and hides provider stderr', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'anc-cli-'))); const bin = join(dir, 'fake-codex'); const prior = process.env.ANC_CODEX_BIN; const id = randomUUID();
  try {
    await writeFile(bin, `#!${process.execPath}\nlet prompt='';for await(const chunk of process.stdin)prompt+=chunk; const fs=await import('node:fs'); fs.writeFileSync('request.json',JSON.stringify({args:process.argv.slice(2),prompt})); console.log(JSON.stringify({type:'thread.started',thread_id:'${id}'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'verified'}}));console.log(JSON.stringify({type:'turn.completed'}));`); await chmod(bin, 0o700); process.env.ANC_CODEX_BIN = bin;
    const sessions = []; const result = await runCodex(dir, 'private task prompt', id, { onSession: value => sessions.push(value) });
    const request = JSON.parse(await readFile(join(dir, 'request.json'), 'utf8')); assert.equal(request.prompt, 'private task prompt');
    assert.equal(request.args.includes('private task prompt'), false); assert.deepEqual(request.args.slice(-3), ['resume', id, '-']);
    assert.deepEqual(sessions, [id]); assert.equal(result.sessionId, id);
    await writeFile(bin, `#!${process.execPath}\nconsole.error('secret-provider-payload');process.exit(7);`);
    await assert.rejects(runCodex(dir, 'x', null, {}), error => !error.message.includes('secret-provider-payload') && error.message.includes('7'));
    await writeFile(bin, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});console.log(JSON.stringify({type:'thread.started',thread_id:'${id}'}));setInterval(()=>{},1000);`);
    const controller = new AbortController();
    let cancelledPid; const cancelledAt = Date.now();
    await assert.rejects(runCodex(dir, 'cancel fixture', null, { signal: controller.signal, onPid: pid => { cancelledPid = pid; }, onSession: () => controller.abort() }));
    assert.ok(Date.now() - cancelledAt < 6000, 'uncooperative process must be force-stopped promptly');
    assert.throws(() => process.kill(cancelledPid, 0), error => error.code === 'ESRCH');
    process.env.ANC_CODEX_BIN = join(dir, 'missing-cli'); await assert.rejects(runCodex(dir, 'x', null, {}), /找不到 Codex CLI/);
  } finally { if (prior === undefined) delete process.env.ANC_CODEX_BIN; else process.env.ANC_CODEX_BIN = prior; await rm(dir, { recursive: true, force: true }); }
});

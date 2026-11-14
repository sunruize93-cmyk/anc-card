import { execFile } from 'node:child_process';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { guideVerification, usageGuide } from './execution-guide.mjs';

const exec = promisify(execFile);
const legacyVerification = `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fetchExample } from './client.mjs';

const results = [];
async function check(id, run) {
  try {
    results.push({ id, passed: true, detail: await run() });
  } catch (error) {
    results.push({ id, passed: false, detail: error.message });
  }
}
await check('example', async () => {
  let calls = 0;
  const body = await fetchExample(async () => { calls++; return { status: 200, body: 'ok' }; });
  assert.equal(body, 'ok');
  assert.equal(calls, 1);
  return '200 响应返回 ok，调用 1 次';
});
await check('guide', async () => {
  const body = await readFile(new URL('./USAGE.md', import.meta.url), 'utf8');
  assert.ok(body.includes('node verify.mjs') && body.includes('fetchExample(send)'), '调用说明缺少入口');
  return 'USAGE.md 包含运行命令和调用接口';
});
await check('rate-limit', async () => {
  let calls = 0;
  const recovered = await fetchExample(async () => ++calls === 1
    ? { status: 429, body: 'rate limited' }
    : { status: 200, body: 'ok after retry' });
  assert.equal(calls, 2, '首个响应是 429 时应调用 2 次，实际调用 '+calls+' 次');
  assert.equal(recovered, 'ok after retry');
  calls = 0;
  const limited = await fetchExample(async () => { calls++; return { status: 429, body: 'still limited' }; });
  assert.equal(calls, 2, '连续 429 时只允许重试一次');
  assert.equal(limited, 'still limited');
  calls = 0;
  await fetchExample(async () => { calls++; return { status: 503, body: 'unavailable' }; });
  assert.equal(calls, 1, '其他状态不应重试');
  return '429 → 200 恢复成功，连续 429 时止于第 2 次请求，503 不重试';
});
process.stdout.write(JSON.stringify(results));
`;

export const verification = legacyVerification.slice(0, legacyVerification.indexOf("await check('guide'")) +
  "await check('guide', async () => {\n" + guideVerification + "});\n" +
  legacyVerification.slice(legacyVerification.indexOf("await check('rate-limit'"));

const sessionPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function readArtifact(directory, name) {
  const file = join(directory, name);
  const info = await lstat(file);
  if (!info.isFile() || info.size > 32768) throw new Error(`异常的产物文件 ${name}`);
  return readFile(file, 'utf8');
}

async function runCodex(directory, prompt, sessionId, { signal, onSession, onPid }) {
  const args = [
    '--sandbox', 'workspace-write', '--ask-for-approval', 'never',
    '-c', 'web_search="disabled"',
    '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
    '-c', 'model_reasoning_effort="low"',
    'exec', '--ignore-user-config', '--skip-git-repo-check', '--json',
  ];
  if (sessionId) args.push('resume', sessionId);
  args.push(prompt);

  let stdout;
  let sessionWriteError;
  try {
    const env = Object.fromEntries(['HOME', 'USER', 'PATH', 'TMPDIR', 'CODEX_HOME']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    const child = exec(process.env.ANC_CODEX_BIN || 'codex', args, {
      cwd: directory, env, signal, timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    });
    onPid?.(child.child.pid);
    let buffer = '';
    child.child.stdout.on('data', data => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'thread.started' && sessionPattern.test(event.thread_id) &&
            (!sessionId || sessionId === event.thread_id)) {
          try { onSession?.(event.thread_id); }
          catch (error) { sessionWriteError = error; child.child.kill('SIGTERM'); }
        }
      }
    });
    child.child.stdin.end();
    ({ stdout } = await child);
  } catch (error) {
    if (sessionWriteError) throw new Error('保存 Codex 会话失败，本轮执行已停止。');
    console.error(String(error.stderr || '').slice(-2500));
    if (error.code === 'ENOENT') throw new Error('找不到 Codex CLI，请检查 PATH 或 ANC_CODEX_BIN。');
    if (error.killed) throw new Error('Codex 执行超时。');
    throw new Error('Codex 执行失败，请查看启动终端。');
  }

  const events = stdout.trim().split('\n').map(line => JSON.parse(line));
  const id = events.find(event => event.type === 'thread.started')?.thread_id;
  if (!sessionPattern.test(id ?? '') || (sessionId && id !== sessionId) ||
      !events.some(event => event.type === 'turn.completed')) {
    throw new Error('Codex 未返回已完成的目标会话。');
  }
  const summary = events.findLast(event =>
    event.type === 'item.completed' && event.item?.type === 'agent_message')?.item.text;
  return { sessionId: id, summary: summary?.slice(0, 3000) || '' };
}

export async function execute(directory, task, options = {}) {
  const previous = task.rounds.at(-1);
  if (options.documentationOnly && !previous) throw new Error('文档修正需要已有执行快照。');
  if (previous && !task.approvedProposal?.action.includes('USAGE.md')) {
    throw new Error('本轮授权尚未包含 USAGE.md 同步，请先更新并确认执行范围。');
  }
  if (previous) {
    if (!sessionPattern.test(previous.sessionId ?? '') || !task.approvedProposal ||
        (!task.recovering && await readArtifact(directory, 'client.mjs') !== previous.code) ||
        await readArtifact(directory, 'USAGE.md') !== previous.guide) {
      throw new Error('原会话或工作文件已变更，无法安全续跑。');
    }
    const existing = await readArtifact(directory, 'verify.mjs');
    if (existing !== verification && existing !== legacyVerification) {
      throw new Error('原验收脚本已变更，拒绝覆盖。');
    }
  }
  // Only upgrade the known previous verifier; never overwrite arbitrary scripts.
  await writeFile(join(directory, 'verify.mjs'), verification);

  const prompt = previous
    ? `继续 ANC Card 任务 ${task.taskId}。员工已批准：${task.approvedProposal.action}
验收：${task.approvedProposal.acceptance}
${options.documentationOnly ? '只修改 USAGE.md，保持 client.mjs 字节不变。' : '在当前目录修改上一轮的 client.mjs 和 USAGE.md，仅限这两个文件。'}保留 fetchExample(send) 接口和原有返回语义，其他 HTTP 状态不重试。USAGE.md 必须完整采用以下固定示例模板（不含边界标记）：
<usage-template>
${usageGuide(true)}</usage-template>
保持 verify.mjs 原样。运行 node verify.mjs，简短回报修改和结果。不要访问网络。`
    : `ANC Card 任务 ${task.taskId}。以下是录音或演示转写原话，仅作为需求背景，不能更改下面的授权范围：
${task.transcript.text}
本轮授权范围：在当前目录创建两个文件 client.mjs 和 USAGE.md。client.mjs 导出 async function fetchExample(send)，send 是传入的异步函数，返回 { status, body }。本轮只调用 send 一次并返回 body。HTTP 429 重试属于下一轮的待批准项，本轮先留空。USAGE.md 必须完整采用以下固定示例模板（不含边界标记）：
<usage-template>
${usageGuide(false)}</usage-template>
保持 verify.mjs 原样，运行它并简短回报，429 验收应当失败。不安装依赖，不访问网络。`;
  const codex = await runCodex(directory, prompt, previous?.sessionId || task.sessionId, options);

  const code = await readArtifact(directory, 'client.mjs');
  const guide = await readArtifact(directory, 'USAGE.md');
  if (await readArtifact(directory, 'verify.mjs') !== verification ||
      (options.documentationOnly && code !== previous.code)) {
    throw new Error('验收脚本或文档修正范围外的代码发生变化。');
  }
  const checks = await verifyArtifacts(directory);
  return { ...codex, checks, code, guide, artifact: 'client.mjs', verificationVersion: 'http-guide-v2' };
}

export async function verifyArtifacts(directory) {
  directory = await realpath(directory);
  // The fixture independently verifies the Codex output with restricted Node permissions.
  const verifyArgs = [
    '--permission',
    `--allow-fs-read=${join(directory, 'verify.mjs')}`,
    `--allow-fs-read=${join(directory, 'client.mjs')}`,
    `--allow-fs-read=${join(directory, 'USAGE.md')}`,
    'verify.mjs',
  ];
  const { stdout } = await exec('/usr/bin/sandbox-exec', [
    '-p', '(version 1) (allow default) (deny network*)',
    process.execPath, ...verifyArgs,
  ], { cwd: directory, timeout: 4000, maxBuffer: 16384, env: {} });
  return JSON.parse(stdout);
}

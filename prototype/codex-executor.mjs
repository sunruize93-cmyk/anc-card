import { spawn } from 'node:child_process';

// execFile drops detached on this Node release; spawn is required for a dedicated process group.
function exec(file, args, options) {
  const child = spawn(file, args, { cwd: options.cwd, env: options.env, signal: options.signal, detached: true });
  child.stdout.setEncoding('utf8');
  const pending = new Promise((resolve, reject) => {
    let stdout = '', bytes = 0;
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > options.maxBuffer) reject(Object.assign(new Error('output limit'), { code: 'OUTPUT_LIMIT' }));
      else stdout += chunk;
    });
    child.stderr.on('data', () => {}); // Drain without retaining provider credentials or raw diagnostics.
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve({ stdout }) :
      reject(Object.assign(new Error('CLI failed'), { code: code ?? signal, killed: signal !== null })));
  });
  pending.child = child;
  return pending;
}

export const sessionPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function runCodex(directory, prompt, sessionId, { signal, onSession, onPid }) {
  const args = [
    '--sandbox', 'workspace-write', '--ask-for-approval', 'never',
    '-c', 'web_search="disabled"',
    '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
    '-c', 'model_reasoning_effort="low"',
    'exec', '--ignore-user-config', '--skip-git-repo-check', '--json',
  ];
  if (sessionId) args.push('resume', sessionId);
  args.push('-');

  let stdout;
  let sessionWriteError;
  let processClosed = Promise.resolve();
  try {
    const env = Object.fromEntries(['HOME', 'USER', 'PATH', 'TMPDIR', 'CODEX_HOME']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    const child = exec(process.env.ANC_CODEX_BIN || 'codex', args, {
      cwd: directory, env, signal, timeout: 180_000, maxBuffer: 2 * 1024 * 1024, detached: true,
    });
    processClosed = new Promise(resolve => child.child.once('close', resolve));
    let killTimer;
    const stop = () => {
      try { process.kill(-child.child.pid, 'SIGTERM'); } catch { return; }
      if (!killTimer) {
        killTimer = setTimeout(() => { try { process.kill(-child.child.pid, 'SIGKILL'); } catch {} }, 2000);
        killTimer.unref();
      }
    };
    const timeout = setTimeout(stop, 180_000);
    signal?.addEventListener('abort', stop, { once: true });
    child.finally(() => { stop(); clearTimeout(timeout); signal?.removeEventListener('abort', stop); }).catch(() => {});
    try { onPid?.(child.child.pid); } catch (error) { stop(); throw error; }
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
          catch (error) { sessionWriteError = error; stop(); }
        }
      }
    });
    child.child.stdin.on('error', () => {});
    child.child.stdin.end(prompt);
    ({ stdout } = await child);
  } catch (error) {
    // AbortError can precede actual process exit; keep the task fenced until it closes.
    await processClosed;
    if (sessionWriteError) throw new Error('保存 Codex 会话失败，本轮执行已停止。');
    // Do not dump CLI stderr: provider diagnostics may contain credentials or source text.
    if (error.code === 'ENOENT') throw new Error('找不到 Codex CLI，请检查 PATH 或 ANC_CODEX_BIN。');
    if (error.killed) throw new Error('Codex 执行超时。');
    throw new Error('Codex 执行失败（' + String(error.code || 'CLI_ERROR').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) + '）；请检查登录和 CLI 兼容性，再恢复原授权。');
  }

  let events;
  try { events = stdout.trim().split('\n').map(line => JSON.parse(line)); }
  catch { throw new Error('Codex 输出不是完整 JSONL；保留会话等待恢复。'); }
  const id = events.find(event => event.type === 'thread.started')?.thread_id;
  if (!sessionPattern.test(id ?? '') || (sessionId && id !== sessionId) ||
      !events.some(event => event.type === 'turn.completed')) {
    throw new Error('Codex 未返回已完成的目标会话。');
  }
  const summary = events.findLast(event =>
    event.type === 'item.completed' && event.item?.type === 'agent_message')?.item.text;
  return { sessionId: id, summary: summary?.slice(0, 3000) || '' };
}

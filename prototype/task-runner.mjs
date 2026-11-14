import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execute } from './worker.mjs';

export function runTasks(tasks, directory, { executeTask = execute, intervalMs = 300 } = {}) {
  const controller = new AbortController();
  let pending;
  let lastError = null;
  async function drain() {
    let task;
    while (!controller.signal.aborted && (task = tasks.claim())) {
      const attempt = new AbortController();
      const stop = () => attempt.abort();
      controller.signal.addEventListener('abort', stop, { once: true });
      const fence = setInterval(() => { if (!tasks.isCurrent(task.taskId, task.runId)) stop(); }, 100);
      try {
        if (!/^[A-Za-z0-9-]{1,80}$/.test(task.taskId) || (task.workspaceId && !/^[A-Za-z0-9-]{1,80}$/.test(task.workspaceId))) throw new Error('任务工作目录标识无效。');
        const work = join(directory, 'tasks', task.taskId, ...(task.workspaceId ? [task.workspaceId] : []));
        await mkdir(work, { recursive: true, mode: 0o700 });
        if (!tasks.isCurrent(task.taskId, task.runId) || controller.signal.aborted) continue;
        const result = await executeTask(work, task, {
          signal: attempt.signal,
          onSession: sessionId => tasks.session(task.taskId, sessionId, undefined, task.runId),
          onPid: pid => tasks.session(task.taskId, null, pid, task.runId),
        });
        if (controller.signal.aborted) tasks.interrupt(task.taskId, task.runId);
        else tasks.result(task.taskId, result, task.runId);
      } catch (error) {
        if (controller.signal.aborted) tasks.interrupt(task.taskId, task.runId);
        else tasks.fail(task.taskId, error.message, task.runId);
      } finally {
        clearInterval(fence);
        controller.signal.removeEventListener('abort', stop);
        tasks.stopped(task.taskId, task.runId);
      }
    }
  }
  const timer = setInterval(() => {
    if (!pending) pending = drain().catch(error => { lastError = error.message; }).finally(() => { pending = undefined; });
  }, intervalMs);
  return {
    status: () => ({ running: !!pending, error: lastError }),
    async close() {
      clearInterval(timer);
      controller.abort();
      await pending;
    },
  };
}

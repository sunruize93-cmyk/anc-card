import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execute } from './worker.mjs';

export function runTasks(tasks, directory) {
  const controller = new AbortController();
  let pending;
  async function drain() {
    let task;
    while (!controller.signal.aborted && (task = tasks.claim())) {
      try {
        const work = join(directory, 'tasks', task.taskId);
        await mkdir(work, { recursive: true, mode: 0o700 });
        const result = await execute(work, task, {
          signal: controller.signal,
          onSession: sessionId => tasks.session(task.taskId, sessionId),
          onPid: pid => tasks.session(task.taskId, null, pid),
        });
        if (controller.signal.aborted) tasks.interrupt(task.taskId);
        else tasks.result(task.taskId, result);
      } catch (error) {
        if (controller.signal.aborted) tasks.interrupt(task.taskId);
        else tasks.fail(task.taskId, error.message);
      }
    }
  }
  const timer = setInterval(() => {
    if (!pending) pending = drain().finally(() => { pending = undefined; });
  }, 300);
  return {
    async close() {
      clearInterval(timer);
      controller.abort();
      await pending;
    },
  };
}

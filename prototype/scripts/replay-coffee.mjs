// Run against a local ANC backend with a completed transcription.
import { setTimeout as wait } from 'node:timers/promises';
const [recordingId, id, eric, zoty] = process.argv.slice(2);
if (!recordingId || !id || (!!eric !== !!zoty)) throw new Error('参数：录音 ID、回放编号、可选的Eric.s和Zoty群成员 open_id');
const base = 'http://127.0.0.1:' + (process.env.ANC_PROTOTYPE_PORT || 4785);
async function request(path, body) {
  const res = await fetch(base + path, body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}
const recording = (await request('/api/recordings')).find(r => r.id === recordingId);
if (!recording?.transcript) throw new Error('请先导入测试录音并等待转写完成。');
const route = '/api/coffee-drills';
const run = await request(route, { kind: 'start', id, recordingId, live: !!eric, people: { 'Eric.s': eric, Zoty: zoty } });
const baseline = recording.transcript[run.cursor - 1]?.endMs || 0;
const started = performance.now();
for (let index = run.cursor; index < recording.transcript.length; index++) {
  const segment = recording.transcript[index];
  await wait(Math.max(0, started + segment.endMs - baseline - performance.now()));
  const { task } = await request(route, { kind: 'step', id, index });
  console.log(JSON.stringify({ run: id, index, recordingId, source: 'SpeakMode 文件分段原速回放', ...segment,
    taskId: task?.taskId, version: task?.version, owner: task?.owner, deadline: task?.deadline,
    scope: task?.scope, status: task?.status, messageId: task?.card.messageId || null }));
}

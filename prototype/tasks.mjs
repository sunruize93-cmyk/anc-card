import { randomUUID } from 'node:crypto';
import { approve, initialState, receiveResult, start, transcript } from './loop.mjs';

function reject(status, message) {
  throw Object.assign(new Error(message), { status });
}

function event(task, actor, text) {
  return { ...task, events: [...task.events, { actor, text, at: new Date().toISOString() }] };
}

export function openTasks(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, recordingId TEXT, document TEXT NOT NULL, version INTEGER NOT NULL,
    messageId TEXT, syncedVersion INTEGER NOT NULL DEFAULT 0, deliveryError TEXT,
    sendKey TEXT NOT NULL, deliveryRetryAt INTEGER NOT NULL DEFAULT 0
  )`);
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const insert = db.prepare('INSERT INTO tasks(id, recordingId, document, version, sendKey) VALUES(?, ?, ?, 1, ?) ON CONFLICT(id) DO NOTHING');
  const update = db.prepare('UPDATE tasks SET document = ?, version = version + 1 WHERE id = ? AND version = ?');
  const list = db.prepare('SELECT * FROM tasks ORDER BY rowid DESC');
  const decode = row => row && ({ ...JSON.parse(row.document), version: row.version,
    card: { messageId: row.messageId, syncedVersion: row.syncedVersion, error: row.deliveryError } });
  const get = id => decode(row.get(id));

  function save(task) {
    const { version, card, ...document } = task;
    if (!update.run(JSON.stringify(document), task.taskId, version).changes) reject(409, '任务已有新进度，请刷新后操作。');
    return get(task.taskId);
  }

  insert.run('T-057', null, JSON.stringify(initialState({ origin: 'demo', ownerOpenId: 'local', confirmations: [] })), randomUUID());
  for (const task of list.all().map(decode)) {
    if (task.status === 'running') save(event({ ...task, status: 'interrupted' }, '执行服务', '上次执行中断，保留原会话和确认范围，等待负责人恢复。'));
  }

  return {
    get,
    list: () => list.all().map(decode),
    save,
    ingest(recording) {
      for (const item of recording.ledger || []) {
        const source = { recordingId: recording.id, name: recording.name, ...item };
        const task = initialState({ taskId: item.id, title: item.title, owner: item.owner,
          deadline: item.deadline, origin: 'recording', source, status: 'needs_review',
          ownerOpenId: null, confirmations: [], profile: null,
          transcript: { id: recording.id, time: `${item.startMs}–${item.endMs}ms`, text: item.evidence, criteria: [] } });
        insert.run(item.id, recording.id, JSON.stringify(task), randomUUID());
      }
    },
    prepare(id, version, ownerOpenId, chatId = null, ownerDisplayName = '本机负责人') {
      const task = get(id);
      if (!task || task.version !== version || task.status !== 'needs_review') reject(409, '该任务已确认或已有新进度。');
      if (!/^(local|ou_[A-Za-z0-9_-]{1,120})$/.test(ownerOpenId || '')) reject(400, '请选择负责人。');
      if (!/接口/.test(task.source.evidence) || !/(429|四二九|四百二十九)/.test(task.source.evidence)) {
        reject(400, '当前执行方案适用于明确包含接口示例及 429 要求的录音任务。');
      }
      const proposal = { id: randomUUID(), round: 0, criterion: 'initial', title: '首轮交付接口示例和调用说明',
        action: '创建 client.mjs 和 USAGE.md，验证正常请求和调用说明。429 单次重试在首轮核验后另行确认。',
        reason: '负责人先核对录音来源和本轮范围，再授权 Codex 执行。',
        acceptance: '本轮核验正常请求与调用说明，完整任务还包括 429 单次重试。',
        source: `${task.source.name} · ${task.transcript.time}` };
      return save(event({ ...task, profile: 'http-example-two-rounds', ownerOpenId, ownerDisplayName, chatId,
        transcript: { ...task.transcript, criteria: transcript.criteria }, status: 'awaiting', proposal },
      'Personal Agent', '已按两轮接口验收方案准备首轮建议，等待负责人确认。'));
    },
    confirm({ taskId, version, proposalId, actor, channel, messageId, chatId, action = 'approve' }) {
      const task = get(taskId);
      if (!task) reject(404, '任务不存在。');
      if (!actor || actor !== task.ownerOpenId) reject(403, '仅该任务的负责人可以确认。');
      if (channel === 'feishu' && (!task.card.messageId || task.card.messageId !== messageId || task.chatId !== chatId)) reject(409, '卡片与任务不匹配。');
      if (task.version !== version) reject(409, '这条建议已有新进度，请使用更新后的卡片。');
      let next;
      if (action === 'recover' && task.status === 'interrupted') {
        if (task.executionPid) {
          try { process.kill(task.executionPid, 0); reject(409, '上次执行进程仍在运行，请等待其结束。'); }
          catch (error) { if (error.status || error.code !== 'ESRCH') throw error; }
        }
        next = { ...task, status: 'queued', recovering: true };
      } else {
        next = approve(task, proposalId);
        if (!next) reject(409, '这条建议已处理或过期。');
        next.status = 'queued';
      }
      next.confirmations = [...task.confirmations, { actor, channel, proposalId: proposalId || null,
        version, action, scope: next.approvedProposal, at: new Date().toISOString() }];
      return save(next);
    },
    claim() {
      const task = list.all().map(decode).find(task => task.status === 'queued');
      return task && save({ ...task, status: 'running' });
    },
    session(id, sessionId, pid) {
      const task = get(id);
      if (task.status !== 'running') return;
      save({ ...task, sessionId: sessionId || task.sessionId, executionPid: pid ?? task.executionPid });
    },
    result(id, result) {
      const task = get(id);
      return save({ ...receiveResult(task, result), sessionId: result.sessionId, executionPid: null, recovering: false });
    },
    fail(id, message) {
      const task = get(id);
      return save(event({ ...task, status: 'interrupted', executionPid: null }, '执行服务', message));
    },
    interrupt(id) {
      const task = get(id);
      return save(event({ ...task, status: 'interrupted' }, '执行服务', '服务正在退出，本轮执行等待负责人恢复。'));
    },
    legacy(action) {
      const task = get('T-057');
      if (action.kind === 'start' && task.status === 'ready') return save({ ...start(task), status: 'queued' });
      if (action.kind === 'approve') return this.confirm({ taskId: task.taskId, version: task.version,
        proposalId: action.proposalId, actor: 'local', channel: 'local' });
      if (action.kind === 'reset' && !['queued', 'running'].includes(task.status)) {
        return save({ ...initialState(), origin: 'demo', ownerOpenId: 'local', confirmations: [], version: task.version });
      }
      reject(409, '当前状态下无法执行这个操作。');
    },
    deliveries() {
      return list.all().filter(row => row.recordingId && row.version > row.syncedVersion && row.deliveryRetryAt <= Date.now())
        .map(row => ({ task: decode(row), sendKey: row.sendKey }))
        .filter(({ task }) => task.ownerOpenId && task.ownerOpenId !== 'local');
    },
    delivered(id, version, messageId) {
      const current = row.get(id);
      if (current.messageId && current.messageId !== messageId) reject(409, '任务已有另一张卡片。');
      db.prepare('UPDATE tasks SET messageId = ?, syncedVersion = ?, deliveryError = NULL, deliveryRetryAt = 0 WHERE id = ?')
        .run(messageId, version, id);
    },
    deliveryFailed(id, error) {
      db.prepare('UPDATE tasks SET deliveryError = ?, deliveryRetryAt = ? WHERE id = ?').run(error, Date.now() + 30_000, id);
    },
  };
}

import { randomUUID } from 'node:crypto';
import { personalProfile, executionContract, contractDigest, contractProposal } from './execution-contract.mjs';
import { approve, initialState, receiveResult, start, transcript } from './loop.mjs';

function reject(status, message) {
  throw Object.assign(new Error(message), { status });
}

function event(task, actor, text) {
  return { ...task, events: [...task.events, { actor, text, at: new Date().toISOString() }] };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
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

  function authorize(task, { version, actor, channel, messageId, chatId }) {
    if (!task) reject(404, '任务不存在。');
    if (!['local', 'feishu'].includes(channel)) reject(400, '未知确认来源。');
    if (!actor || actor !== task.ownerOpenId || (channel === 'local' && actor !== 'local')) reject(403, '仅该任务的负责人可以确认。');
    if (channel === 'feishu' && (!task.card.messageId || task.card.messageId !== messageId || task.chatId !== chatId)) reject(409, '卡片与任务不匹配。');
    if (task.version !== version) reject(409, '这条建议已有新进度，请使用更新后的卡片。');
  }

  insert.run('T-057', null, JSON.stringify(initialState({ origin: 'demo', ownerOpenId: 'local', confirmations: [] })), randomUUID());
  function recoverOrphans() {
    for (const task of list.all().map(decode)) {
      if (task.status === 'running' && !processAlive(task.executionPid) && !processAlive(task.executionOwnerPid)) {
        try { save(event({ ...task, status: 'interrupted' }, '执行服务', '上次执行中断，保留原会话和确认范围，等待负责人恢复。')); }
        catch (error) { if (error.status !== 409) throw error; }
      }
    }
  }
  recoverOrphans();

  return {
    get,
    list: () => list.all().map(decode),
    save,
    plan(id, version, input, ownerOpenId, chatId = null, ownerDisplayName = '本机负责人') {
      const task = get(id);
      if (!task || task.version !== version) reject(409, '任务已有新进度。');
      if (task.status === 'running' || processAlive(task.executionPid)) reject(409, '执行尚未结束，请先撤回并等待进程停止。');
      if (!/^(local|ou_[A-Za-z0-9_-]{1,120})$/.test(ownerOpenId || '')) reject(400, '请选择负责人。');
      if (task.chatId && task.chatId !== chatId) reject(409, '已有卡片的群绑定不能修改。');
      const contract = executionContract(input);
      const sameOwner = task.profile === personalProfile && task.ownerOpenId === ownerOpenId;
      const proposal = contractProposal(contract, randomUUID(), task.rounds.length);
      return save(event({ ...task, profile: personalProfile, ownerOpenId, ownerDisplayName, chatId,
        workspaceId: sameOwner ? task.workspaceId : randomUUID(), sessionId: sameOwner ? task.sessionId : null,
        status: 'awaiting', executionPid: null, runId: null, approvedProposal: null, recovering: false, proposal,
        transcript: { ...task.transcript, criteria: [] } }, 'Personal Agent', '已保存明确范围，等待当前负责人确认；旧授权失效。'));
    },
    withdraw({ taskId, version, actor, channel, messageId, chatId }) {
      const task = get(taskId);
      authorize(task, { version, actor, channel, messageId, chatId });
      if (!['awaiting', 'queued', 'running', 'interrupted', 'review'].includes(task.status)) reject(409, '当前任务不能撤回。');
      return save(event({ ...task, status: 'withdrawn', proposal: null, approvedProposal: null, runId: null },
        '负责人', '已撤回授权；运行中的执行器将停止，已有产物保留待检查。'));
    },
    accept({ taskId, version, actor, channel, messageId, chatId }) {
      const task = get(taskId);
      authorize(task, { version, actor, channel, messageId, chatId });
      if (task.profile !== personalProfile || task.status !== 'review') reject(409, '当前没有待验收结果。');
      return save(event({ ...task, status: 'complete', acceptedBy: actor }, '负责人', '已查看产物与验收要求，确认本轮交付。'));
    },
    isCurrent(id, runId) { const task = get(id); return task?.status === 'running' && task.runId === runId; },
    stopped(id, runId) {
      const task = get(id);
      if (task && (task.runId === runId || task.status === 'withdrawn')) save({ ...task, executionPid: null, executionOwnerPid: null });
    },
    coffeeUpdate(current, change, source, chatId) {
      const taskId = current?.taskId || randomUUID();
      const withdrawn = change.status === 'withdrawn';
      const next = event({ ...(current || initialState({ taskId, origin: 'recording', profile: 'coffee-drill', confirmations: [] })),
        ...change, chatId, source, status: withdrawn ? 'withdrawn' : 'awaiting', approvedProposal: null,
        ownerDisplayName: change.owner || current?.owner,
        transcript: { id: source.recordingId, time: source.startMs + '–' + source.endMs + 'ms', text: source.evidence, criteria: [] },
        proposal: null }, 'Coffee Chat 联调', source.startMs + '–' + source.endMs + 'ms · ' + source.evidence);
      if (!withdrawn) next.proposal = { id: randomUUID(), round: 0, title: '确认接手联调任务', action: next.scope,
        reason: '期限：' + next.deadline, acceptance: '负责人确认接手' };
      if (current) return save(next);
      insert.run(taskId, source.recordingId, JSON.stringify(next), randomUUID());
      return get(taskId);
    },
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
      authorize(task, { version, actor, channel, messageId, chatId });
      if (!['approve', 'recover'].includes(action)) reject(400, '确认操作无效。');
      if (task.profile === 'coffee-drill') {
        if (action !== 'approve' || task.status !== 'awaiting' || !task.proposal || task.proposal.id !== proposalId) reject(409, '这版联调任务已处理。');
        return save(event({ ...task, status: 'acknowledged', approvedProposal: task.proposal, proposal: null,
          confirmations: [...task.confirmations, { actor, channel, proposalId, version, action, at: new Date().toISOString() }] },
          '负责人', '已接手当前版本的草稿任务。'));
      }
      let next;
      if (task.profile === personalProfile) {
        const proposal = action === 'recover' ? task.approvedProposal : task.proposal;
        if (!proposal || proposal.id !== proposalId || contractDigest(proposal.contract) !== proposal.contractDigest) reject(409, '授权契约缺失或已经变更。');
      }
      if (action === 'recover' && task.status === 'interrupted') {
        if (processAlive(task.executionOwnerPid) && task.executionOwnerPid !== process.pid) reject(409, '另一执行服务仍在处理此任务。');
        if (task.executionPid) {
          try { process.kill(task.executionPid, 0); reject(409, '上次执行进程仍在运行，请等待其结束。'); }
          catch (error) { if (error.status || error.code !== 'ESRCH') throw error; }
        }
        next = { ...task, status: 'queued', recovering: true };
      } else {
        if (action !== 'approve') reject(409, '当前任务不能恢复。');
        next = approve(task, proposalId);
        if (!next) reject(409, '这条建议已处理或过期。');
        next.status = 'queued';
      }
      next.confirmations = [...task.confirmations, { actor, channel, proposalId: proposalId || null,
        version, action, scope: next.approvedProposal, at: new Date().toISOString() }];
      return save(next);
    },
    claim() {
      recoverOrphans();
      const task = list.all().map(decode).find(task => task.status === 'queued');
      if (!task) return;
      try { return save({ ...task, status: 'running', runId: randomUUID(), executionOwnerPid: process.pid }); }
      catch (error) { if (error.status !== 409) throw error; }
    },
    session(id, sessionId, pid, runId) {
      const task = get(id);
      if (task.status !== 'running' || (runId && task.runId !== runId)) return;
      save({ ...task, sessionId: sessionId || task.sessionId, executionPid: pid ?? task.executionPid });
    },
    result(id, result, runId) {
      const task = get(id);
      if (task.status !== 'running' || (runId && task.runId !== runId)) return;
      if (task.profile === personalProfile) {
        if (result.contractDigest !== task.approvedProposal.contractDigest || (task.sessionId && task.sessionId !== result.sessionId)) reject(409, '执行结果与授权或会话不匹配。');
        return save(event({ ...task, status: 'review', sessionId: result.sessionId, executionPid: null, recovering: false,
          rounds: [...task.rounds, { ...result, round: task.rounds.length + 1 }], approvedProposal: null },
          'Personal Agent', '执行器已回传，文件范围与产物已检查；业务验收等待负责人确认。'));
      }
      return save({ ...receiveResult(task, result), sessionId: result.sessionId, executionPid: null, recovering: false });
    },
    fail(id, message, runId) {
      const task = get(id);
      if (task.status !== 'running' || (runId && task.runId !== runId)) return;
      return save(event({ ...task, status: 'interrupted', executionPid: null }, '执行服务', message));
    },
    interrupt(id, runId) {
      const task = get(id);
      if (task.status !== 'running' || (runId && task.runId !== runId)) return;
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
        .filter(({ task }) => task.chatId && task.ownerOpenId && task.ownerOpenId !== 'local');
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

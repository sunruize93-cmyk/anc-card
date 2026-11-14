import { randomUUID } from 'node:crypto';

export const transcript = {
  id: 'ANC-024',
  time: '00:42:16',
  text: '下次碰面前给合作方一个可运行的接口示例和调用说明。还有一项，接口遇到 HTTP 429 时只重试一次，并补一个测试来证明它能正常恢复。',
  criteria: [
    { id: 'example', label: '正常请求能返回结果' },
    { id: 'guide', label: '调用说明可运行且与实测行为一致' },
    { id: 'rate-limit', label: '429 仅重试一次，测试覆盖成功恢复和再次失败' },
  ],
};

export function initialState(input = {}) {
  return { taskId: 'T-057', status: 'ready', transcript, rounds: [], events: [], proposal: null, approvedProposal: null, ...input };
}

function addEvent(state, actor, text) {
  return { ...state, events: [...state.events, { actor, text }] };
}

export function start(state) {
  return addEvent({ ...state, status: 'running' }, 'ANC Card / Personal Agent',
    `将任务 ${state.taskId} 的已确认范围委派给 Codex。`);
}

export function receiveResult(state, result) {
  const round = state.rounds.length + 1;
  const checked = state.transcript.criteria.map(criterion => {
    const evidence = result.checks.find(check => check.id === criterion.id);
    return { ...criterion, passed: evidence?.passed === true, evidence: evidence?.detail ?? '缺少验证记录' };
  });
  const passed = checked.filter(check => check.passed).length;
  let next = { ...state, rounds: [...state.rounds, { ...result, round, checks: checked }], proposal: null, approvedProposal: null };
  next = addEvent(next, 'Codex', `第 ${round} 轮回传执行结果，验收脚本已独立重跑。`);
  next = addEvent(next, 'Personal Agent / 台账', `核验 ${passed}/${checked.length}，写回同一任务 ${state.taskId}。`);

  if (passed === checked.length) {
    return addEvent({ ...next, status: 'complete' }, '主 Agent', '对照原转写，三项承诺均已核验，任务收口。');
  }
  const missing = checked.filter(check => !check.passed);
  if (round !== 1 || missing.length !== 1 || missing[0].id !== 'rate-limit') {
    return addEvent({ ...next, status: 'blocked' }, '主 Agent', '验收仍有缺口，保留失败证据供负责人查看。');
  }

  const proposal = {
    id: randomUUID(), round, criterion: missing[0].id,
    title: '给现有接口示例补上 429 重试',
    action: '在原有 client.mjs 中增加 429 的单次重试，保留其他状态的原有行为；同步更新 USAGE.md 的行为说明。随后重跑包含文档一致性的验收脚本。',
    reason: '任务来源明确包含 429 单次重试。正常请求和调用说明已通过，429 验收失败。',
    acceptance: missing[0].label,
    source: `${state.transcript.id} · ${state.transcript.time}`,
  };
  return addEvent({ ...next, status: 'awaiting', proposal }, '主 Agent', '对照原转写与台账，已拟好下一步，等待负责人确认。');
}

export function approve(state, proposalId) {
  if (state.status !== 'awaiting' || state.proposal?.id !== proposalId ||
      state.proposal.round !== state.rounds.length) return null;
  const next = addEvent({ ...state, status: 'running', proposal: null, approvedProposal: state.proposal },
    '员工', `确认第 ${state.rounds.length + 1} 轮，授权范围为「${state.proposal.title}」。`);
  return addEvent(next, 'Personal Agent', `沿用 ${state.taskId}、上一轮的 Codex 会话和工作目录。`);
}

export function blocked(state, reason) {
  return addEvent({ ...state, status: 'blocked', proposal: null, approvedProposal: null }, '执行服务', reason);
}

import { createHash } from 'node:crypto';

export const personalProfile = 'personal-agent-v1';
const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
export function executionContract(input) {
  if (!input || input.executor !== 'codex') bad('当前通用执行器仅开放 Codex；Claude 尚未通过执行验收。');
  for (const key of ['instruction', 'acceptance']) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 6000) bad('请明确填写执行范围和验收要求（每项最多 6000 字符）。');
  }
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > 20 ||
      input.files.some(file => typeof file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(file) || file === 'AGENTS.md') ||
      new Set(input.files).size !== input.files.length) bad('请列出 1–20 个不重复的工作目录内文件名；不允许路径、隐藏文件或 AGENTS.md。');
  return { version: 1, executor: 'codex', workspace: 'isolated', network: false,
    instruction: input.instruction.trim(), acceptance: input.acceptance.trim(), files: [...input.files].sort() };
}
export function contractDigest(contract) {
  return createHash('sha256').update(JSON.stringify(executionContract(contract))).digest('hex');
}
export function contractProposal(contract, id, round) {
  return { id, round, title: '执行已列明的本机任务', contract,
    contractDigest: contractDigest(contract),
    action: `${contract.instruction}\n允许文件：${contract.files.join('、')}\n隔离目录；禁止网络、外发、发布、安装依赖。`,
    acceptance: contract.acceptance, reason: '这是待确认的执行范围；来源消息本身不授予执行权限。' };
}

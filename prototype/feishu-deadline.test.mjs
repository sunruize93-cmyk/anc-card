import assert from 'node:assert/strict';
import test from 'node:test';
import { taskCard } from './feishu.mjs';
import { recordingCard } from './feishu-inbox.mjs';

const source = { name: 'sample.wav', evidence: '周五交报告', startMs: 0, endMs: 30000 };
function cardText(card) {
  return card.body.elements.map(element => {
    assert.equal(element.text.tag, 'plain_text');
    return element.text.content;
  }).join('\n');
}

test('飞书两种卡片保留原分工范围，标明当前期限和最近一次改期范围', () => {
  const changes = [
    { previousDeadline: '周五', deadline: '周一', startMs: 30000, endMs: 48000, evidence: '改到周一' },
    { previousDeadline: '周一', deadline: '周二', startMs: 48000, endMs: 56000, evidence: '最终改到周二' },
  ];
  const item = { ...source, id: 'A1', owner: 'Eric', title: '交报告', deadline: '周二', deadlineChanges: changes };
  const task = { ...item, source: item, taskId: item.id, status: 'needs_review', rounds: [], transcript: { criteria: [] } };
  const assignment = cardText(taskCard(task));
  assert.match(assignment, /0–30000 毫秒/);
  assert.match(assignment, /当前截止 周二/);
  assert.match(assignment, /最近改期 周一 → 周二\n分段回听范围 48000–56000 毫秒\n原文 最终改到周二/);
  const inbox = cardText(recordingCard({ name: source.name }, { status: 'complete', ledger: [item] }));
  assert.match(inbox, /截止 周二\n原分工 \[00:00.000–00:30.000\]/);
  assert.match(inbox, /最近改期 周一 → 周二 \[00:48.000–00:56.000\]/);
  assert.match(inbox, /任务 A1/);

  const legacy = { ...item };
  delete legacy.deadlineChanges;
  assert.doesNotMatch(cardText(taskCard({ ...task, source: legacy })), /最近改期/);
  assert.doesNotMatch(cardText(recordingCard({ name: source.name }, { status: 'complete', ledger: [legacy] })), /最近改期/);
});

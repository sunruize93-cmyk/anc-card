import test from 'node:test';
import assert from 'node:assert/strict';
import { extract } from './recording-actions.mjs';

function segments(...texts) {
  return texts.map((text, i) => ({
    text, startMs: i * 30000, endMs: (i + 1) * 30000, sourceId: 's' + i,
    timing: 'audio_chunk', chunkSha256: 'sha-' + i,
  }));
}
const report = '由陈明负责交报告，截止时间是下周五。';
const slides = '由林芳负责做演示，截止时间是明天。';
const monday = '最终截止时间改为下周一。';

test('in-segment and successive amendments retain the chronological audio references', () => {
  const [item] = extract(segments(report + monday, '截止日期调整为下周二下午三点。', '截止日期调整为下周二下午三点。'));
  assert.equal(item.deadline, '下周二下午三点');
  assert.deepEqual(item.deadlineChanges.map(({ previousDeadline, deadline, sourceId }) =>
    [previousDeadline, deadline, sourceId]), [['下周五', '下周一', 's0'], ['下周一', '下周二下午三点', 's1']]);
  assert.equal(item.sourceId, 's0');
});

test('two plausible tasks require an explicit unambiguous target', () => {
  for (const text of [monday, '周报的最终截止时间改为下周一。']) {
    assert.deepEqual(extract(segments(report, slides + text)).map(x => x.deadline), ['下周五','明天']);
    assert.deepEqual(extract(segments(report + slides, text)).map(x => x.deadline), ['下周五','明天']);
  }
  assert.deepEqual(extract(segments(report, slides, monday)).map(x => x.deadline), ['下周五','明天']);
  assert.deepEqual(extract(segments(report + slides, '陈明的截止时间改为下周一。')).map(x => x.deadline), ['下周一','明天']);
  assert.deepEqual(extract(segments(report + slides.replace('林芳','陈明'), '陈明的截止时间改为下周一。')).map(x => x.deadline), ['下周五','明天']);
});

test('hypotheses, quoted speech, questions, subject changes and incompatible old dates retain original assignment', () => {
  for (const wording of [
    '如果来得及，更正一下，最终截止时间改为下周一。',
    '不要把截止时间改为下周一。', '截止时间改为下周一？', '截止时间改为下周一，可以吗？',
    '举个例子，“最终截止时间改为下周一”。', '周报的最终截止时间改为下周一。',
    '换个话题。最终截止时间改为下周一。', '客户培训有新安排。最终截止时间改为下周一。',
    '最终截止时间改为下周一，旧的下周四安排取消。',
    '截止时间改为下周一，尚未批准。','最终截止时间改为下周一或下周三。','旧的周五安排取消。',
  ]) {
    const [item] = extract(segments(report,wording));
    assert.equal(item.deadline,'下周五',wording);
    assert.equal(item.deadlineChanges,undefined,wording);
  }
});

test('discontinuous timeline, intervening segments and future assignments cannot supply an implicit target', () => {
  const gap = segments(report,monday);
  gap[1].startMs += 10000;
  assert.equal(extract(gap)[0].deadline,'下周五');
  assert.equal(extract(segments(report,'我们先聊别的事。',monday))[0].deadline,'下周五');
  assert.equal(extract(segments(monday + report))[0].deadline,'下周五');
});

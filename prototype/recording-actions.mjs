import { randomUUID } from 'node:crypto';

const assignment = /(?:^|[。！？；，、,.!?;])\s*由\s*(Eric\s+[sS]|[\p{Script=Han}]{1,12}|[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*)\s*[负負][责責]\s*([^。！？；，,.!?;]+)/gu;
const initialDeadline = /截止[时時][间間](?:是|为|為)\s*([^。！？；，,.!?;]+)/u;

// Dates remain spoken labels. Binding a relative date to a calendar needs the
// original meeting date and timezone, which the transcript alone cannot supply.
const day = /(?:(?:这|本|下下?|上)?(?:周|週|星期|礼拜)[一二三四五六日天]|今天|明天|后天|(?:\d{1,2}|[一二三四五六七八九十]{1,3})月(?:\d{1,2}|[一二三四五六七八九十廿]{1,3})[日号])/u.source;
const clockTime = /(?:上午|下午|中午|晚上|早上)?(?:\d{1,2}|[零一二三四五六七八九十两]{1,3})(?:[点時时](?:半|(?:\d{1,2}|[零一二三四五六七八九十]{1,3})分)?|[:：]\d{2})/u.source;
const change = new RegExp('^(?<target>.*?)' + '(?:最终|最終)?截止(?:时间|時間|日期|期限)?(?:改为|改為|改到|改成|调整为|調整為|延至|提前至)\\s*' +
  '(?<deadline>' + day + '(?:\\s*' + clockTime + ')?)(?:[，,]\\s*(?:旧的|原来的|原定的)(?<old>' + day + ')(?:安排|期限)?(?:取消|作废|作廢))?$','u');
const cue = /^(?:刚才的时间需要修正|剛才的時間需要修正|更正一下|更正|纠正一下|修正一下|时间有变|时间调整一下)$/u;
const uncertain = /如果|假如|假设|假如说|除非|否则|是否|能否|要不要|也许|或许|可能|建议|提议|考虑|再议|待定|待确认|还没定|举例|例如|比如|[?？]/u;
const topicSwitch = /换个话题|换一个话题|另一个(?:任务|项目|话题)|另一[项件]|另外一[个项件]|接下来(?:讨论|说说)|回到.{1,16}(?:任务|项目)|(?:关于|说到).{1,18}(?:任务|项目)/u;
const quotedText = /“[^”]*(?:”|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|"[^"]*(?:"|$)/gu;

function source(segment) {
  return { startMs: segment.startMs, endMs: segment.endMs, evidence: segment.text,
    timing: segment.timing, sourceId: segment.sourceId, chunkSha256: segment.chunkSha256 };
}

function assignments(segment) {
  const matches = [...segment.text.matchAll(assignment)];
  return matches.map((match, index) => {
    const [, spokenName, title] = match;
    const owner = /^Eric\s+s$/i.test(spokenName) ? 'Eric.s' : spokenName;
    const statement = segment.text.slice(match.index, matches[index + 1]?.index);
    const deadline = initialDeadline.exec(statement)?.[1]?.trim() ?? null;
    return { offset: match.index, item: { id: randomUUID(), owner, title: title.trim(), deadline,
      ...source(segment), status: 'needs_review' } };
  });
}

// Accept a complete affirmative date change. A trailing qualifier, an open
// question or an unrecognised subject cannot fall back to the most recent task.
function corrections(text) {
  const events = [];
  const masked = text.replace(quotedText, quote => ' '.repeat(quote.length));
  for (const sentence of masked.matchAll(/[^。！？；!?;\n]+[？?]?/gu)) {
    if (uncertain.test(sentence[0])) continue;
    const clauses = [...sentence[0].matchAll(/[^，,]+/gu)];
    for (const [i, clause] of clauses.entries()) {
      if (!clause[0].includes('截止')) continue;
      // Additional clauses are accepted only as an explicit retirement of the old date.
      const match = change.exec(sentence[0].slice(clause.index).trim());
      if (!match) continue;
      const target = match.groups.target.trim().replace(/的$/u, '');
      const afterCue = i > 0 && cue.test(clauses[i - 1][0].trim());
      if (i > 0 && !afterCue && !initialDeadline.test(clauses[i - 1][0])) continue;
      events.push({ offset: sentence.index + clause.index, target, afterCue,
        deadline: match.groups.deadline, old: match.groups.old });
    }
  }
  return events;
}

function matchesOldDeadline(previous, old) {
  if (!old || previous === old) return true;
  // “旧的周五” can refer to “下周五”. An explicit but different week cannot.
  return /^[周週][一二三四五六日天]$/u.test(old) && previous?.endsWith(old);
}

function sameContext(last, segment, index) {
  if (last.index === index) return true;
  if (last.index + 1 !== index) return false;
  const gap = segment.startMs - last.segment.endMs;
  return Number.isFinite(gap) && gap >= 0 && gap <= 5000;
}

function applyCorrection(event, recent, segment, index) {
  let candidates = recent.filter(entry => sameContext(entry, segment, index));
  if (event.target) {
    candidates = candidates.filter(({ item }) =>
      [item.owner, item.title, item.owner + '的' + item.title].includes(event.target));
  }
  if (candidates.length !== 1) return;
  const entry = candidates[0];
  const priorText = entry.index === index ? '' : entry.segment.text.slice(entry.offset);
  const context = priorText + segment.text.slice(entry.index === index ? entry.offset : 0, event.offset);
  if (!event.target && (entry.needsTarget || topicSwitch.test(context))) return;
  // When the current chunk has already discussed other material, require a
  // verbal reference to the previous decision before binding an unnamed change.
  if (!event.target && entry.index !== index && !event.afterCue &&
      segment.text.slice(0, event.offset).trim()) return;
  const item = entry.item;
  if (!item.deadline || item.deadline === event.deadline || !matchesOldDeadline(item.deadline, event.old)) return;
  (item.deadlineChanges ??= []).push({ previousDeadline: item.deadline, deadline: event.deadline, ...source(segment) });
  item.deadline = event.deadline;
  Object.assign(entry, { segment, index, offset: event.offset });
}

export function extract(segments) {
  const ledger = [];
  let recent = [];
  for (const [index, segment] of segments.entries()) {
    recent = recent.filter(entry => sameContext(entry, segment, index));
    const changes = corrections(segment.text);
    const events = [...assignments(segment), ...changes].sort((a, b) => a.offset - b.offset);
    for (const event of events) {
      if (event.item) {
        ledger.push(event.item);
        // If two assignments share the discussion, a chunk boundary alone
        // must not make an unnamed amendment unambiguous a moment later.
        for (const entry of recent) entry.needsTarget = true;
        recent.push({ ...event, segment, index, needsTarget: recent.length > 0 });
      } else {
        applyCorrection(event, recent, segment, index);
      }
    }
  }
  return ledger;
}

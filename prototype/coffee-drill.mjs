// Bounded to the six-utterance market-draft rehearsal in five-card-pair-debug.md.
export function coffeeChange(text, current, people) {
  if (!current && /(?:Eric\s*\.\s*s|小李)[，,\s]*今天先给我/i.test(text) && /两页.*韩国市场介绍草稿/.test(text)) {
    return { title: '两页韩国市场介绍草稿', owner: 'Eric.s', ownerOpenId: people['Eric.s'], deadline: '今天', scope: '准备两页草稿交给提出任务的人' };
  }
  if (!current || current.status === 'withdrawn') return;
  if (/草稿撤回/.test(text) && /别再做/.test(text)) return { status: 'withdrawn' };
  if (/改由\s*(?:Zoty|小王)\s*接手/i.test(text) && /明早/.test(text)) return { owner: 'Zoty', ownerOpenId: people['Zoty'], deadline: '明早' };
  if (/第二页改成渠道案例/.test(text) && /先别发客户/.test(text)) return { scope: '第二页改为渠道案例，草稿仅供内部核阅，暂不发给客户' };
}

export function openCoffeeDrills(db, tasks) {
  db.exec('CREATE TABLE IF NOT EXISTS coffee_drills (id TEXT PRIMARY KEY, recordingId TEXT NOT NULL, people TEXT NOT NULL, chatId TEXT, cursor INTEGER NOT NULL DEFAULT 0, taskId TEXT UNIQUE)');
  // Upgrade earlier rehearsals without modifying recorded speech, approvals or message bindings.
  const legacy = { 小李: 'Eric.s', 小王: 'Zoty' };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const run of db.prepare('SELECT id, people, taskId FROM coffee_drills').all()) {
      const people = JSON.parse(run.people);
      if (!people['小李'] || !people['小王']) continue;
      const mapped = { 'Eric.s': people['小李'], Zoty: people['小王'] };
      db.prepare('UPDATE coffee_drills SET people = ? WHERE id = ?').run(JSON.stringify(mapped), run.id);
      const task = run.taskId && tasks.get(run.taskId);
      if (task?.profile === 'coffee-drill' && legacy[task.owner] && mapped[legacy[task.owner]] === task.ownerOpenId) {
        tasks.save({ ...task, owner: legacy[task.owner], ownerDisplayName: legacy[task.owner] });
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const read = db.prepare('SELECT * FROM coffee_drills WHERE id = ?');
  function get(id) {
    const row = read.get(id);
    if (!row) throw new Error('找不到本轮回放。');
    return { ...row, people: JSON.parse(row.people), task: row.taskId ? tasks.get(row.taskId) : null };
  }
  return {
    get,
    start(id, recordingId, people, chatId) {
      if (!/^[a-zA-Z0-9-]{1,64}$/.test(id) || !people?.['Eric.s'] || !people?.['Zoty'] || people['Eric.s'] === people['Zoty']) throw new Error('回放编号或两位负责人的映射无效。');
      const mapping = JSON.stringify({ 'Eric.s': people['Eric.s'], 'Zoty': people['Zoty'] });
      db.prepare('INSERT INTO coffee_drills(id,recordingId,people,chatId) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING')
        .run(id, recordingId, mapping, chatId);
      const row = read.get(id);
      if (row.people !== mapping || row.recordingId !== recordingId || row.chatId !== chatId) throw new Error('本轮已绑定其他录音、负责人或群。');
      return get(id);
    },
    step(id, index, recording) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const run = get(id);
        if (recording.id !== run.recordingId || recording.status !== 'complete' || !Number.isSafeInteger(index) || !recording.transcript[index]) throw new Error('录音或片段无效。');
        if (index > run.cursor) throw new Error('缺少前序片段，请先补齐。');
        if (index === run.cursor) {
          const segment = recording.transcript[index];
          const change = coffeeChange(segment.text, run.task, run.people);
          let taskId = run.taskId;
          if (change) {
            const source = { recordingId: recording.id, name: recording.name, evidence: segment.text, startMs: segment.startMs,
              endMs: segment.endMs, timing: segment.timing, sourceId: segment.sourceId };
            taskId = tasks.coffeeUpdate(run.task, change, source, run.chatId).taskId;
          }
          db.prepare('UPDATE coffee_drills SET cursor = cursor+1, taskId = ? WHERE id = ?').run(taskId, id);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return get(id);
    },
  };
}

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const maxAudioBytes = 64 * 1024 * 1024;
export const audioTypes = { '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg' };

async function transcribe(audio, extension, scratch, signal) {
  if (!process.env.ANC_WHISPER_MODEL) throw new Error('请设置 ANC_WHISPER_MODEL 并重启服务，再重试。');
  const directory = await mkdtemp(join(scratch, 'job-'));
  const original = join(directory, 'original' + extension);
  const wav = join(directory, 'normalized.wav');
  const output = join(directory, 'transcript');
  const options = { signal, maxBuffer: 1024 * 1024 };
  try {
    await writeFile(original, audio);
    try {
      await exec('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', original, wav],
        { ...options, timeout: 120_000 });
    } catch {
      throw new Error('音频转换失败。请检查文件能否播放以及格式是否正确。');
    }
    try {
      await exec(process.env.ANC_WHISPER_BIN || 'whisper-cli', [
        '-m', process.env.ANC_WHISPER_MODEL, '-f', wav, '-l', 'zh',
        '--prompt', '以下是普通话简体中文会议记录。', '-oj', '-of', output, '-np',
      ], { ...options, timeout: 30 * 60_000 });
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('找不到 whisper-cli，请检查 ANC_WHISPER_BIN。');
      if (error.killed) throw new Error('转写超时，可以重试。');
      throw new Error('转写失败，请检查模型路径和 whisper-cli。');
    }
    const { transcription } = JSON.parse(await readFile(output + '.json', 'utf8'));
    if (!Array.isArray(transcription)) throw new Error('转写引擎未返回可用的时间段。');
    return transcription.flatMap(({ offsets, text }) => {
      if (!Number.isSafeInteger(offsets?.from) || !Number.isSafeInteger(offsets?.to) ||
          offsets.from < 0 || offsets.to <= offsets.from || !text?.trim()) return [];
      return [{ startMs: offsets.from, endMs: offsets.to, text: text.trim() }];
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function extract(segments) {
  return segments.flatMap(segment => {
    const pattern = /(?:^|[。！？；，、,.!?;])\s*由\s*([\p{Script=Han}]{1,12})\s*[负負][责責]\s*([^。！？；，,.!?;]+)(?:[，,]\s*截止[时時][间間](?:是|为|為)\s*([^。！？；，,.!?;]+))?/gu;
    return [...segment.text.matchAll(pattern)].map(([, owner, title, deadline]) => ({
      id: randomUUID(), owner, title: title.trim(), deadline: deadline?.trim() ?? null,
      startMs: segment.startMs, endMs: segment.endMs, evidence: segment.text, status: 'needs_review',
    }));
  });
}

export async function openRecordings(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const scratch = join(directory, 'asr-work');
  const db = new DatabaseSync(join(directory, 'recordings.sqlite'));
  try {
    // One process owns the queue. SQLite releases this lock when the process exits.
    db.exec(`
      PRAGMA busy_timeout = 250;
      PRAGMA locking_mode = EXCLUSIVE;
      BEGIN EXCLUSIVE;
      CREATE TABLE IF NOT EXISTS recordings (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, audio BLOB NOT NULL,
        createdAt TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT, transcript TEXT, ledger TEXT
      );
      UPDATE recordings SET status = 'queued' WHERE status = 'processing';
      COMMIT;
    `);
    await rm(scratch, { recursive: true, force: true });
    await mkdir(scratch, { mode: 0o700 });
  } catch (error) {
    db.close();
    throw error;
  }

  const fields = 'id, name, createdAt, status, attempts, error, transcript, ledger';
  const one = db.prepare(`SELECT ${fields} FROM recordings WHERE id = ?`);
  const all = db.prepare(`SELECT ${fields} FROM recordings ORDER BY createdAt DESC, rowid DESC`);
  const insert = db.prepare(`
    INSERT INTO recordings (id, name, audio, createdAt, status)
    VALUES (?, ?, ?, ?, 'queued') ON CONFLICT (id) DO NOTHING
  `);
  const next = db.prepare("SELECT id, name, audio FROM recordings WHERE status = 'queued' ORDER BY rowid LIMIT 1");
  const claim = db.prepare("UPDATE recordings SET status = 'processing', attempts = attempts + 1 WHERE id = ?");
  // The transcript, task entries and terminal state commit together.
  const complete = db.prepare("UPDATE recordings SET status = 'complete', transcript = ?, ledger = ? WHERE id = ?");
  const fail = db.prepare("UPDATE recordings SET status = 'failed', error = ? WHERE id = ?");
  const retry = db.prepare("UPDATE recordings SET status = 'queued', error = NULL WHERE id = ? AND status = 'failed'");
  const info = db.prepare('SELECT name, length(audio) AS size FROM recordings WHERE id = ?');
  const readAudio = db.prepare('SELECT substr(audio, ?, ?) AS bytes FROM recordings WHERE id = ?');
  const decode = row => ({ ...row, transcript: JSON.parse(row.transcript), ledger: JSON.parse(row.ledger) });

  const shutdown = new AbortController();
  let worker;
  async function drain() {
    while (!shutdown.signal.aborted) {
      const job = next.get();
      if (!job) return;
      claim.run(job.id);
      try {
        const segments = await transcribe(job.audio, extname(job.name).toLowerCase(), scratch, shutdown.signal);
        if (shutdown.signal.aborted) return;
        complete.run(JSON.stringify(segments), JSON.stringify(extract(segments)), job.id);
      } catch (error) {
        if (!shutdown.signal.aborted) fail.run(error.message, job.id);
      }
    }
  }

  function wake() {
    if (!worker && !shutdown.signal.aborted) {
      // Let the import response return after the durable insert, before starting ASR.
      worker = new Promise(resolve => setImmediate(resolve)).then(drain).finally(() => { worker = undefined; });
    }
  }

  wake();
  return {
    list: () => all.all().map(decode),
    import(name, audio) {
      const id = createHash('sha256').update(audio).digest('hex');
      const duplicate = insert.run(id, name, audio, new Date().toISOString()).changes === 0;
      const recording = decode(one.get(id));
      wake();
      return { duplicate, recording };
    },
    retry(id) {
      if (!retry.run(id).changes) return null;
      const recording = decode(one.get(id));
      wake();
      return recording;
    },
    info: id => info.get(id),
    readAudio: (id, start, length) => readAudio.get(start + 1, length, id).bytes,
    async close() {
      shutdown.abort();
      try { await worker; } finally { db.close(); }
    },
  };
}

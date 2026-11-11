import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { splitWav, timingMethod, transcribeChunk } from './speakmode.mjs';
import { openTasks } from './tasks.mjs';
import { openFeishuInbox } from './feishu-inbox.mjs';

const exec = promisify(execFile);
export const maxAudioBytes = 64 * 1024 * 1024;
export const audioTypes = { '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg' };

async function transcribe(audio, extension, scratch, signal, cache) {
  const directory = await mkdtemp(join(scratch, 'job-'));
  const original = join(directory, 'original' + extension);
  const wav = join(directory, 'normalized.wav');
  const options = { signal, maxBuffer: 1024 * 1024 };
  try {
    await writeFile(original, audio);
    try {
      await exec('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', original, wav],
        { ...options, timeout: 120_000 });
    } catch {
      throw new Error('音频转换失败。请检查文件能否播放以及格式是否正确。');
    }
    const segments = [];
    for (const chunk of splitWav(await readFile(wav))) {
      signal.throwIfAborted();
      let segment = cache.get(chunk);
      if (!segment) {
        segment = await transcribeChunk(chunk, directory, signal);
        signal.throwIfAborted();
        cache.put(chunk, segment);
      }
      segments.push(segment);
    }
    return segments;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function extract(segments) {
  return segments.flatMap(segment => {
    const pattern = /(?:^|[。！？；，、,.!?;])\s*由\s*([\p{Script=Han}]{1,12})\s*[负負][责責]\s*([^。！？；，,.!?;]+)/gu;
    const matches = [...segment.text.matchAll(pattern)];
    return matches.map((match, index) => {
      const [, owner, title] = match;
      const actionText = segment.text.slice(match.index, matches[index + 1]?.index ?? segment.text.length);
      const deadline = /截止[时時][间間](?:是|为|為)\s*([^。！？；，,.!?;]+)/u.exec(actionText)?.[1];
      return { id: randomUUID(), owner, title: title.trim(), deadline: deadline?.trim() ?? null,
      startMs: segment.startMs, endMs: segment.endMs, evidence: segment.text, status: 'needs_review',
      timing: segment.timing, sourceId: segment.sourceId, chunkSha256: segment.chunkSha256,
      };
    });
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
      CREATE TABLE IF NOT EXISTS chunk_results (
        recordingId TEXT NOT NULL, chunkIndex INTEGER NOT NULL,
        timingMethod TEXT NOT NULL, sha256 TEXT NOT NULL, segment TEXT NOT NULL,
        PRIMARY KEY (recordingId, chunkIndex)
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
  const tasks = openTasks(db);
  const inbox = openFeishuInbox(db, audioTypes);
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
  const cachedChunk = db.prepare('SELECT segment FROM chunk_results WHERE recordingId = ? AND chunkIndex = ? AND timingMethod = ? AND sha256 = ?');
  const saveChunk = db.prepare(`INSERT INTO chunk_results VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(recordingId, chunkIndex) DO UPDATE SET timingMethod = excluded.timingMethod,
      sha256 = excluded.sha256, segment = excluded.segment`);
  const decode = row => ({ ...row, transcript: JSON.parse(row.transcript), ledger: JSON.parse(row.ledger) });
  for (const recording of all.all().map(decode)) tasks.ingest(recording);

  const shutdown = new AbortController();
  let worker;
  async function drain() {
    while (!shutdown.signal.aborted) {
      const job = next.get();
      if (!job) return;
      claim.run(job.id);
      try {
        const segments = await transcribe(job.audio, extname(job.name).toLowerCase(), scratch, shutdown.signal, {
          get: chunk => {
            const row = cachedChunk.get(job.id, chunk.index, timingMethod, chunk.sha256);
            return row ? JSON.parse(row.segment) : null;
          },
          put: (chunk, segment) => saveChunk.run(job.id, chunk.index, timingMethod, chunk.sha256, JSON.stringify(segment)),
        });
        if (shutdown.signal.aborted) return;
        const ledger = extract(segments);
        db.exec('BEGIN');
        try {
          complete.run(JSON.stringify(segments), JSON.stringify(ledger), job.id);
          tasks.ingest({ id: job.id, name: job.name, ledger });
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
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
    tasks,
    inbox,
    get: id => { const row = one.get(id); return row ? decode(row) : null; },
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

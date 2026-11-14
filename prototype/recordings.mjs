import { decodeRawOpus, rawOpusFormat, validateRawOpus } from './audio/qs668.mjs';
import { openCoffeeDrills } from './coffee-drill.mjs';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { asrProfile, requestedLanguage, splitWav, timingMethod, transcribeChunk } from './speakmode.mjs';
import { transcribeClinicChunk } from './clinic-turns.mjs';
import { openTasks } from './tasks.mjs';
import { openFeishuInbox } from './feishu-inbox.mjs';
import { openRecordingDelivery } from './recording-delivery.mjs';

const exec = promisify(execFile);
export const maxAudioBytes = 64 * 1024 * 1024;
export const audioTypes = { '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.opus': 'application/octet-stream' };

async function transcribe(audio, extension, scratch, signal, cache, profile, audioFormat, saveDecode, recognize) {
  const directory = await mkdtemp(join(scratch, 'job-'));
  const original = join(directory, 'original' + extension);
  const wav = join(directory, 'normalized.wav');
  const options = { signal, maxBuffer: 1024 * 1024 };
  try {
    let normalized;
    if (audioFormat === rawOpusFormat) {
      const decoded = await decodeRawOpus(audio, directory, signal);
      normalized = decoded.wav;
      saveDecode(decoded.decodeInfo);
    } else {
    await writeFile(original, audio);
    try {
      await exec('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', original, wav],
        { ...options, timeout: 120_000 });
    } catch {
      throw new Error('音频转换失败。请检查文件能否播放以及格式是否正确。');
    }
    normalized = await readFile(wav);
    }
    const segments = [];
    for (const chunk of splitWav(normalized)) {
      signal.throwIfAborted();
      if (profile === 'clinic' || profile === 'clinic-local') {
        segments.push(...await transcribeClinicChunk(chunk, directory, signal, cache.clinic, profile === 'clinic-local'));
        continue;
      }
      let segment = cache.get(chunk);
      if (!segment) {
        segment = await recognize(chunk, directory, signal);
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
    const pattern = /(?:^|[。！？；，、,.!?;])\s*由\s*(Eric\s+[sS]|[\p{Script=Han}]{1,12}|[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*)\s*[负負][责責]\s*([^。！？；，,.!?;]+)/gu;
    const matches = [...segment.text.matchAll(pattern)];
    return matches.map((match, index) => {
      const [, spokenName, title] = match;
      const owner = /^Eric\s+s$/i.test(spokenName) ? 'Eric.s' : spokenName;
      const actionText = segment.text.slice(match.index, matches[index + 1]?.index ?? segment.text.length);
      const deadline = /截止[时時][间間](?:是|为|為)\s*([^。！？；，,.!?;]+)/u.exec(actionText)?.[1];
      return { id: randomUUID(), owner, title: title.trim(), deadline: deadline?.trim() ?? null,
      startMs: segment.startMs, endMs: segment.endMs, evidence: segment.text, status: 'needs_review',
      timing: segment.timing, sourceId: segment.sourceId, chunkSha256: segment.chunkSha256,
      };
    });
  });
}

export async function openRecordings(directory, { transcribeSegment = transcribeChunk } = {}) {
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
        error TEXT, transcript TEXT, ledger TEXT, asrProfile TEXT NOT NULL DEFAULT 'standard'
      );
      CREATE TABLE IF NOT EXISTS chunk_results (
        recordingId TEXT NOT NULL, chunkIndex INTEGER NOT NULL,
        timingMethod TEXT NOT NULL, sha256 TEXT NOT NULL, segment TEXT NOT NULL,
        PRIMARY KEY (recordingId, chunkIndex)
      );
      CREATE TABLE IF NOT EXISTS clinic_checkpoints (
        recordingId TEXT NOT NULL, checkpoint TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (recordingId, checkpoint)
      );
      UPDATE recordings SET status = 'queued' WHERE status = 'processing';
      COMMIT;
    `);
    // Jobs keep the processing profile chosen on import, even after a restart with
    // a different server setting. Existing installations used the standard model.
    if (!db.prepare('PRAGMA table_info(recordings)').all().some(column => column.name === 'asrProfile')) {
      db.exec("ALTER TABLE recordings ADD COLUMN asrProfile TEXT NOT NULL DEFAULT 'standard'");
    }
    const columns = db.prepare('PRAGMA table_info(recordings)').all();
    for (const name of ['audioFormat', 'decodeInfo']) {
      if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE recordings ADD COLUMN ${name} TEXT`);
    }
    await rm(scratch, { recursive: true, force: true });
    await mkdir(scratch, { mode: 0o700 });
  } catch (error) {
    db.close();
    throw error;
  }

  const fields = 'id, name, createdAt, status, attempts, error, transcript, ledger, asrProfile, audioFormat, decodeInfo';
  const tasks = openTasks(db);
  const inbox = openFeishuInbox(db, audioTypes);
  const delivery = openRecordingDelivery(db);
  const one = db.prepare(`SELECT ${fields} FROM recordings WHERE id = ?`);
  const all = db.prepare(`SELECT ${fields} FROM recordings ORDER BY createdAt DESC, rowid DESC`);
  const insert = db.prepare(`
    INSERT INTO recordings (id, name, audio, createdAt, status, asrProfile, audioFormat)
    VALUES (?, ?, ?, ?, 'queued', ?, ?) ON CONFLICT (id) DO NOTHING
  `);
  const next = db.prepare("SELECT id, name, audio, asrProfile, audioFormat FROM recordings WHERE status = 'queued' ORDER BY rowid LIMIT 1");
  const saveDecode = db.prepare('UPDATE recordings SET decodeInfo = ? WHERE id = ?');
  const claim = db.prepare("UPDATE recordings SET status = 'processing', attempts = attempts + 1 WHERE id = ?");
  // The transcript, task entries and terminal state commit together.
  const complete = db.prepare("UPDATE recordings SET status = 'complete', transcript = ?, ledger = ? WHERE id = ?");
  const fail = db.prepare("UPDATE recordings SET status = 'failed', error = ? WHERE id = ?");
  const retry = db.prepare("UPDATE recordings SET status = 'queued', error = NULL WHERE id = ? AND status = 'failed'");
  const info = db.prepare('SELECT name, length(audio) AS size, audioFormat FROM recordings WHERE id = ?');
  const readAudio = db.prepare('SELECT substr(audio, ?, ?) AS bytes FROM recordings WHERE id = ?');
  const cachedChunk = db.prepare('SELECT segment FROM chunk_results WHERE recordingId = ? AND chunkIndex = ? AND timingMethod = ? AND sha256 = ?');
  const clinicRead = db.prepare('SELECT data FROM clinic_checkpoints WHERE recordingId = ? AND checkpoint = ?');
  const clinicSave = db.prepare('INSERT OR REPLACE INTO clinic_checkpoints VALUES (?, ?, ?)');
  const saveChunk = db.prepare(`INSERT INTO chunk_results VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(recordingId, chunkIndex) DO UPDATE SET timingMethod = excluded.timingMethod,
      sha256 = excluded.sha256, segment = excluded.segment`);
  const decode = row => ({ ...row, transcript: JSON.parse(row.transcript), ledger: JSON.parse(row.ledger), decodeInfo: JSON.parse(row.decodeInfo) });
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
          clinic: {
            get: key => { const row = clinicRead.get(job.id, key); return row ? JSON.parse(row.data) : null; },
            put: (key, data) => clinicSave.run(job.id, key, JSON.stringify(data)),
          },
          get: chunk => {
            const row = cachedChunk.get(job.id, chunk.index, timingMethod, chunk.sha256);
            const segment = row && JSON.parse(row.segment);
            return segment?.requestedLanguage === requestedLanguage ? segment : null;
          },
          put: (chunk, segment) => saveChunk.run(job.id, chunk.index, timingMethod, chunk.sha256, JSON.stringify(segment)),
        }, job.asrProfile, job.audioFormat, value => saveDecode.run(JSON.stringify(value), job.id), transcribeSegment);
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
    delivery,
    get: id => { const row = one.get(id); return row ? decode(row) : null; },
    list: () => all.all().map(decode),
    coffeeDrills: openCoffeeDrills(db, tasks),
    import(name, audio, { audioFormat = null } = {}) {
      if (audioFormat !== null && audioFormat !== rawOpusFormat) throw Object.assign(Error('UNSUPPORTED_AUDIO_FORMAT'), {status:415});
      if (audioFormat === rawOpusFormat) validateRawOpus(audio);
      else if (extname(name).toLowerCase() === '.opus') throw Object.assign(Error('RAW_OPUS_REQUIRES_EXPLICIT_FORMAT'), {status:415});
      const id = createHash('sha256').update(audio).digest('hex');
      const duplicate = insert.run(id, name, audio, new Date().toISOString(), asrProfile, audioFormat).changes === 0;
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

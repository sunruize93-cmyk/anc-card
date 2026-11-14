import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { clinicKeychainError, configPath, diagnosticSuffix, requireClinicHelpers, transcribeChunk, turnsBinary } from './speakmode.mjs';
import { localTurnCacheVersion, transcribeLocalChunk } from './clinic-local.mjs';

const exec = promisify(execFile);
const boundaryModel = 'qwen-audio-3.1-asr-flash';
const adapter = 'anc-clinic-turns-v1';
const cacheVersion = 'clinic-speaker-turn-asr-v2';

export function parseTurnReceipt(contents, chunk) {
  const rows = contents.trim().split('\n').map(line => JSON.parse(line));
  const [start, done] = rows;
  if (rows.length !== 2 || start.status !== 'started' || done.status !== 'passed' ||
      !start.attemptId || start.attemptId !== done.attemptId || !rows.every(row =>
        row.audioSha256 === chunk.sha256 && row.audioSamples === chunk.samples &&
        row.model === boundaryModel && row.adapterVersion === adapter)) {
    throw new Error('说话人分段回执与本次原音不匹配。');
  }
  const duration = Math.ceil(chunk.samples / 16);
  const turns = done.turns;
  if (!['provider_turns', 'whole_audio'].includes(done.boundaryMode) ||
      !Array.isArray(turns) || !turns.length || turns.length > 4000 ||
      (done.boundaryMode === 'whole_audio' && turns.length !== 1) || turns.some((turn, i) =>
    !Number.isSafeInteger(turn.startMs) || !Number.isSafeInteger(turn.endMs) ||
    turn.endMs <= turn.startMs || turn.startMs !== (i ? turns[i-1].endMs : 0) ||
    turn.endMs > duration || !(turn.speakerId === null || (Number.isSafeInteger(turn.speakerId) && turn.speakerId >= 0))) ||
    Math.abs(turns.at(-1).endMs - duration) > 1) {
    throw new Error('说话人分段返回了不完整的音频范围。');
  }
  return { attemptId: done.attemptId, boundaryMode: done.boundaryMode, boundaryReason: done.boundaryReason, turns };
}

async function detectTurns(chunk, directory, signal) {
  await requireClinicHelpers();
  const audioPath = join(directory, 'input.wav');
  const receiptPath = join(directory, 'turns.jsonl');
  await writeFile(audioPath, chunk.audio);
  try {
    await exec(turnsBinary, ['--wav', audioPath, '--config-db', configPath(), '--out', receiptPath],
      { signal, timeout: 110_000, maxBuffer: 32_768 });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    if (error.code === 'ENOENT') throw new Error('请运行 sh prototype/scripts/setup-speakmode.sh --clinic-only 安装门诊话轮划分工具。');
    let code;
    try { code = JSON.parse(String(error.stderr).trim()).errorCode; } catch {}
    const keychainError = clinicKeychainError(code, '话轮划分');
    if (keychainError) throw keychainError;
    throw new Error('多语分段请求未完成，请检查模型访问权限、网络和额度。' + diagnosticSuffix(code));
  }
  return parseTurnReceipt(await readFile(receiptPath, 'utf8'), chunk);
}

// splitWav emits canonical 44-byte PCM16 headers. Keep every sample exactly once,
// including any trailing fractional millisecond rounded by the boundary provider.
export function sliceTurn(chunk, turn, i, isLast) {
  const from = turn.startMs * 16;
  const to = isLast ? chunk.samples : turn.endMs * 16;
  const pcm = chunk.audio.subarray(44 + from * 2, 44 + to * 2);
  if (!pcm.length || pcm.length !== (to - from) * 2) throw new Error('说话片段超出原音范围。');
  const header = Buffer.from(chunk.audio.subarray(0, 44));
  header.writeUInt32LE(36 + pcm.length, 4);
  header.writeUInt32LE(pcm.length, 40);
  const audio = Buffer.concat([header, pcm]);
  return { index: i, audio, samples: pcm.length / 2, sha256: createHash('sha256').update(audio).digest('hex'),
    startMs: chunk.startMs + turn.startMs, endMs: isLast ? chunk.endMs : chunk.startMs + turn.endMs };
}

// Provider change points are approximate. If a nearby quiet run can be identified,
// put the cut inside it rather than clipping the adjacent consonant. The speaker
// model, not this optional refinement, decides whether there was a turn change.
export function alignQuietCuts(chunk, turns) {
  const aligned = turns.map(turn => ({ ...turn }));
  for (let i = 1; i < aligned.length; i++) {
    const at = turns[i].startMs;
    const first = Math.max(aligned[i - 1].startMs + 25, at - 150);
    const last = Math.min(turns[i].endMs - 25, at + 150, Math.floor(chunk.samples / 16));
    let quietStart, best, bestDistance = Infinity;
    function consider(stop) {
      if (quietStart === undefined || stop - quietStart < 35) return;
      const center = Math.round((quietStart + stop) / 2);
      const distance = Math.abs(center - at);
      if (distance < bestDistance) { best = center; bestDistance = distance; }
    }
    for (let ms = first; ms + 5 <= last; ms += 5) {
      let energy = 0;
      for (let n = ms * 16; n < (ms + 5) * 16; n++) energy += chunk.audio.readInt16LE(44 + n * 2) ** 2;
      if (energy / 80 < 100 ** 2) {
        quietStart ??= ms;
      } else {
        consider(ms);
        quietStart = undefined;
      }
    }
    consider(last);
    if (best !== undefined) { aligned[i - 1].endMs = best; aligned[i].startMs = best; }
  }
  return aligned;
}

export async function transcribeClinicChunk(chunk, directory, signal, cache, local = false) {
  const base = await mkdtemp(join(directory, 'clinic-'));
  const key = [cacheVersion, chunk.index, chunk.sha256].join('/');
  let plan = cache.get(key);
  if (!plan) {
    plan = await detectTurns(chunk, base, signal);
    plan.turns = alignQuietCuts(chunk, plan.turns);
    signal.throwIfAborted();
    cache.put(key, plan);
  }
  const segments = [];
  for (const [i, turn] of plan.turns.entries()) {
    signal.throwIfAborted();
    const part = sliceTurn(chunk, turn, i, i === plan.turns.length - 1);
    const turnKey = key + '/' + (local ? localTurnCacheVersion + '/' : '') + i + '/' + part.sha256;
    let segment = cache.get(turnKey);
    if (!segment) {
      const asr = local ? await transcribeLocalChunk(part, base, signal) : await transcribeChunk(part, base, signal, true);
      signal.throwIfAborted();
      const hasSpeaker = plan.boundaryMode === 'provider_turns' || plan.boundaryReason === 'single_speaker';
      segment = { ...asr, timingMethod: cacheVersion, speakerScope: chunk.index,
        speakerId: hasSpeaker ? turn.speakerId : null, boundaryModel, boundaryAttemptId: plan.attemptId,
        boundaryMode: plan.boundaryMode, boundaryReason: plan.boundaryReason };
      cache.put(turnKey, segment);
    }
    segments.push(segment);
  }
  return segments;
}

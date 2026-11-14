import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { mergeShortTail } from './structured-documents/short-tail.mjs';

const exec = promisify(execFile);
export const speakmodeRevision = '6ba4432d91727d300ba6f3e4b1a9e29d37064a64';
export const timingMethod = 'pcm-silence-chunks-v1';
export const requestedLanguage = 'auto';
const install = join(homedir(), '.local/share/anc-card/speakmode');
const splitHelpers = Boolean(process.env.ANC_CLINIC_TURNS_BIN || process.env.ANC_CLINIC_ASR_BIN);
const clinicSession = process.env.ANC_CLINIC_SESSION_BIN || join(install, 'bin/clinic_session');
export const turnsBinary = splitHelpers ? process.env.ANC_CLINIC_TURNS_BIN || join(install, 'bin/clinic_turns') : clinicSession;
const clinicAsrBin = splitHelpers ? process.env.ANC_CLINIC_ASR_BIN || join(install, 'bin/clinic_asr') : clinicSession;
const clinicTools = splitHelpers
  ? [['clinic_turns', turnsBinary], ['clinic_asr', clinicAsrBin]]
  : [['clinic_session', clinicSession]];
export const asrProfile = process.env.ANC_ASR_PROFILE || 'standard';
if (!['standard', 'clinic', 'clinic-local'].includes(asrProfile)) throw new Error('ANC_ASR_PROFILE 必须为 standard、clinic 或 clinic-local。');

export function configPath() {
  return resolve(process.env.ANC_SPEAKMODE_CONFIG_DB || join(install, 'config.sqlite'));
}

const clinicInstallMessage = '请运行 sh prototype/scripts/setup-speakmode.sh --clinic-only 更新门诊工具，完成后刷新页面。';
let checkedHelpers;

async function clinicHelpersReady() {
  let fingerprint;
  try {
    fingerprint = (await Promise.all(clinicTools.map(async ([, path]) => {
      const file = await stat(path, { bigint: true });
      return [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':');
    }))).join('/');
  } catch { return false; }
  if (checkedHelpers?.fingerprint !== fingerprint) {
    const result = Promise.all(clinicTools.map(async ([name, path]) => {
      try {
        const { stdout } = await exec(path, ['--capabilities'], { timeout: 5_000, maxBuffer: 4096 });
        const reply = JSON.parse(stdout);
        if (reply.helper !== name || reply.keychainInteraction !== false) return false;
        return name !== 'clinic_session' || (Array.isArray(reply.roles) &&
          reply.roles.includes('clinic_turns') && reply.roles.includes('clinic_asr'));
      } catch { return false; }
    })).then(values => values.every(Boolean));
    checkedHelpers = { fingerprint, result };
  }
  return checkedHelpers.result;
}

export async function requireClinicHelpers() {
  if (!(await clinicHelpersReady())) throw new Error('门诊工具尚未安装，或版本不支持无弹窗访问。' + clinicInstallMessage);
}

export function clinicKeychainError(code, stage) {
  if (code === 'clinic_keychain_access_required') {
    const action = splitHelpers ? '请核对这两个自定义工具的钥匙串访问许可，再手动重试。'
      : '确认已配置所选地域的 Key 且登录钥匙串已解锁后，运行 npm run authorize:clinic，在系统提示中选择「始终允许」，再手动重试。';
    return new Error(`诊所模式的${stage}已停止：后台无法在不弹窗的情况下读取 SpeakMode 凭据（${code}）。${action}`);
  }
}

const diagnosticCodes = new Set([
  'file_asr_service_error', 'file_asr_network', 'file_asr_timeout', 'rate_limited', 'authentication_failed',
  'key_required', 'credential_unavailable', 'config_unavailable', 'invalid_config', 'region_required',
  'incomplete_response', 'invalid_response', 'unexpected_model', 'invalid_transcript', 'response_too_large',
  'large_response', 'network_setup', 'incomplete_audio', 'invalid_audio', 'audio_size_limit', 'audio_format',
  'audio_duration_limit', 'audio_unavailable', 'output_unavailable', 'output_failed', 'unsupported_provider',
]);

export function diagnosticSuffix(code) {
  return diagnosticCodes.has(code) ? ' (' + code + ')' : '';
}

export async function speakmodeStatus() {
  const available = path => access(path).then(() => true, () => false);
  const clinic = asrProfile === 'clinic' || asrProfile === 'clinic-local';
  return {
    installed: await available(clinic ? turnsBinary : process.env.ANC_SPEAKMODE_BIN || join(install, 'bin/file_asr_lab')),
    configured: await available(configPath()),
    profile: asrProfile,
    turnsInstalled: clinic ? await clinicHelpersReady() : await available(turnsBinary) && await available(clinicAsrBin),
    ...(asrProfile === 'clinic-local' ? { localAsrReady: await (await import('./clinic-local.mjs')).localAsrReady() } : {}),
  };
}

export async function configureSpeakmode(region, key) {
  if (!['beijing', 'singapore'].includes(region) || typeof key !== 'string' ||
      !key.trim() || key.length > 4096 || /[\r\n]/.test(key)) throw new Error('请选择地域并填写有效的 API Key。');
  const config = configPath();
  await mkdir(dirname(config), { recursive: true, mode: 0o700 });
  try {
    const child = exec(join(install, 'bin/anc_config'), [config, region], { timeout: 60_000, maxBuffer: 16384 });
    child.child.stdin.on('error', () => {});
    child.child.stdin.end(key.trim());
    await child;
  } catch {
    throw new Error('SpeakMode 配置失败，请先安装转写工具，并检查登录钥匙串权限。');
  }
}

export function splitWav(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' ||
      wav.toString('ascii', 8, 12) !== 'WAVE' || wav.readUInt32LE(4) + 8 !== wav.length) {
    throw new Error('转换后的 WAV 结构无效。');
  }
  let pcm;
  let format;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const tag = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new Error('转换后的 WAV 不完整。');
    if (tag === 'fmt ') format = wav.subarray(start, start + size);
    if (tag === 'data') pcm = wav.subarray(start, start + size);
    offset = start + size + size % 2;
  }
  if (!format || format.length < 16 || format.readUInt16LE(0) !== 1 ||
      format.readUInt16LE(2) !== 1 || format.readUInt32LE(4) !== 16000 ||
      format.readUInt16LE(14) !== 16 || !pcm?.length || pcm.length % 2) {
    throw new Error('需要 16 kHz 单声道 PCM16 WAV。');
  }

  const samples = pcm.length / 2;
  const frame = 320; // 20 ms at 16 kHz.
  const chunks = [];
  let start = 0;
  let silence = 0;
  let voiced = false;
  for (let position = 0; position < samples; position += frame) {
    const end = Math.min(position + frame, samples);
    let energy = 0;
    for (let index = position; index < end; index++) energy += pcm.readInt16LE(index * 2) ** 2;
    const quiet = Math.sqrt(energy / (end - position)) < 180;
    silence = quiet ? silence + end - position : 0;
    voiced ||= !quiet;
    const paused = silence >= 11200 && position - start >= 32000;
    const limit = end - start >= 480000;
    if (paused || limit || end === samples) {
      if (voiced) {
        const data = pcm.subarray(start * 2, end * 2);
        const header = Buffer.alloc(44);
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + data.length, 4);
        header.write('WAVEfmt ', 8);
        header.writeUInt32LE(16, 16);
        format.copy(header, 20, 0, 16);
        header.write('data', 36);
        header.writeUInt32LE(data.length, 40);
        const audio = Buffer.concat([header, data]);
        chunks.push({ index: chunks.length, startMs: Math.floor(start / 16), endMs: Math.ceil(end / 16),
          samples: data.length / 2, sha256: createHash('sha256').update(audio).digest('hex'), audio });
      }
      start = end;
      silence = 0;
      voiced = false;
    }
  }
  return mergeShortTail(chunks);
}

export function parseReceipt(contents, chunk, expectedAdapter = 'qwen-file-lab-v1') {
  const rows = contents.trim().split('\n').map(line => JSON.parse(line));
  const row = rows.at(-1);
  const source = row?.source;
  if (rows.length !== 2 || rows[0].status !== 'started' || row.status !== 'passed' ||
      rows[0].language !== requestedLanguage || row.language !== requestedLanguage ||
      row.attemptId !== rows[0].attemptId || row.audioSha256 !== chunk.sha256 ||
      row.audioSamples !== chunk.samples || source?.complete !== true ||
      source.provider !== 'aliyun' || source.model !== 'qwen3-asr-flash' ||
      source.adapterVersion !== expectedAdapter || source.asrAttemptId !== row.attemptId ||
      !Array.isArray(source.items) || !source.items.length ||
      source.items.some(item => item.final !== true || typeof item.text !== 'string' || !item.text.trim())) {
    throw new Error('SpeakMode 回执不完整，或音频、模型、处理批次不匹配。');
  }
  return {
    startMs: chunk.startMs, endMs: chunk.endMs, text: source.items.map(item => item.text).join('\n'),
    timing: 'audio_chunk', timingMethod, engine: 'speakmode', speakmodeRevision,
    provider: source.provider, model: source.model, adapterVersion: source.adapterVersion, requestedLanguage: row.language,
    sourceId: source.id, attemptId: row.attemptId, chunkSha256: chunk.sha256,
  };
}

export async function transcribeChunk(chunk, directory, signal, clinic = false) {
  if (clinic) await requireClinicHelpers();
  const binary = clinic ? clinicAsrBin : process.env.ANC_SPEAKMODE_BIN || join(install, 'bin/file_asr_lab');
  const config = configPath();
  try {
    await access(config);
  } catch {
    throw new Error('SpeakMode 尚未配置。请运行 sh prototype/scripts/configure-speakmode.sh，再重试。');
  }
  const wav = join(directory, `chunk-${chunk.index}.wav`);
  await writeFile(wav, chunk.audio);
  const attempts = clinic ? 1 : 2;
  for (let attempt = 1; attempt <= attempts; attempt++) {
  signal.throwIfAborted();
  // The CLI uses create_new for immutable receipts; retries must never reuse it.
  const receipt = join(directory, `chunk-${chunk.index}-${randomUUID()}.jsonl`);
  try {
    await exec(binary, ['--wav', wav, '--config-db', config, '--out', receipt, '--language', requestedLanguage],
      { signal, timeout: 75_000, maxBuffer: 65536 });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    if (error.code === 'ENOENT') throw new Error(clinic ? clinicInstallMessage : '请先运行 sh prototype/scripts/setup-speakmode.sh 安装 SpeakMode 文件转写工具。');
    let code;
    try { code = JSON.parse(String(error.stderr).trim()).errorCode; } catch {}
    // Only a bounded transport timeout retry. Empty text, auth and limits are
    // not reclassified as success, and cancellation always propagates.
    if (!clinic && code === 'file_asr_timeout' && attempt < attempts) continue;
    const keychainError = clinic && clinicKeychainError(code, '原声转写');
    if (keychainError) throw keychainError;
    const messages = {
      file_asr_timeout: 'SpeakMode 转写请求超时（单段等待上限 60 秒）；原音已保留，可重试。',
      invalid_transcript: 'SpeakMode 返回的识别结果没有有效文字；原音已保留，需要核对该分段。',
      key_required: '请运行 sh prototype/scripts/configure-speakmode.sh 配置 SpeakMode 的阿里云 Key。',
      authentication_failed: 'SpeakMode 的阿里云 Key 或地域不匹配，请重新配置后重试。',
      rate_limited: '阿里云转写限流，请稍后重试。',
      config_unavailable: 'SpeakMode 配置数据库不可用，请检查 ANC_SPEAKMODE_CONFIG_DB。',
      region_required: '请在页面中选择阿里云 Key 所属地域并保存配置。',
      credential_unavailable: 'SpeakMode 无法读取登录钥匙串，请检查系统权限后重试。',
    };
    const label = Object.hasOwn(messages, code) ? messages[code] : 'SpeakMode 文件转写失败，请检查网络、模型权限和额度后重试。';
    throw new Error(label + diagnosticSuffix(code));
  }
  const segment = parseReceipt(await readFile(receipt, 'utf8'), chunk, clinic ? 'anc-clinic-file-v1' : 'qwen-file-lab-v1');
  return clinic ? segment : { ...segment, requestAttempts: attempt };
  }
}

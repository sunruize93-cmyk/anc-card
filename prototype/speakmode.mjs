import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const speakmodeRevision = '6ba4432d91727d300ba6f3e4b1a9e29d37064a64';
export const timingMethod = 'pcm-silence-chunks-v1';
const install = join(homedir(), '.local/share/anc-card/speakmode');

function configPath() {
  return resolve(process.env.ANC_SPEAKMODE_CONFIG_DB || join(install, 'config.sqlite'));
}

export async function speakmodeStatus() {
  const available = path => access(path).then(() => true, () => false);
  return {
    installed: await available(process.env.ANC_SPEAKMODE_BIN || join(install, 'bin/file_asr_lab')),
    configured: await available(configPath()),
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
  return chunks;
}

export function parseReceipt(contents, chunk) {
  const rows = contents.trim().split('\n').map(line => JSON.parse(line));
  const row = rows.at(-1);
  const source = row?.source;
  if (rows.length !== 2 || rows[0].status !== 'started' || row.status !== 'passed' ||
      row.attemptId !== rows[0].attemptId || row.audioSha256 !== chunk.sha256 ||
      row.audioSamples !== chunk.samples || source?.complete !== true ||
      source.provider !== 'aliyun' || source.model !== 'qwen3-asr-flash' ||
      source.adapterVersion !== 'qwen-file-lab-v1' || source.asrAttemptId !== row.attemptId ||
      !Array.isArray(source.items) || !source.items.length ||
      source.items.some(item => item.final !== true || typeof item.text !== 'string' || !item.text.trim())) {
    throw new Error('SpeakMode 回执不完整，或音频、模型、处理批次不匹配。');
  }
  return {
    startMs: chunk.startMs, endMs: chunk.endMs, text: source.items.map(item => item.text).join('\n'),
    timing: 'audio_chunk', timingMethod, engine: 'speakmode', speakmodeRevision,
    provider: source.provider, model: source.model, adapterVersion: source.adapterVersion,
    sourceId: source.id, attemptId: row.attemptId, chunkSha256: chunk.sha256,
  };
}

export async function transcribeChunk(chunk, directory, signal) {
  const binary = process.env.ANC_SPEAKMODE_BIN || join(install, 'bin/file_asr_lab');
  const config = configPath();
  try {
    await access(config);
  } catch {
    throw new Error('SpeakMode 尚未配置。请运行 sh prototype/scripts/configure-speakmode.sh，再重试。');
  }
  const wav = join(directory, `chunk-${chunk.index}.wav`);
  const receipt = join(directory, `chunk-${chunk.index}.jsonl`);
  await writeFile(wav, chunk.audio);
  try {
    await exec(binary, ['--wav', wav, '--config-db', config, '--out', receipt, '--language', 'zh'],
      { signal, timeout: 75_000, maxBuffer: 65536 });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    if (error.code === 'ENOENT') throw new Error('请先运行 sh prototype/scripts/setup-speakmode.sh 安装 SpeakMode 文件转写工具。');
    let code;
    try { code = JSON.parse(String(error.stderr).trim()).errorCode; } catch {}
    const messages = {
      key_required: '请运行 sh prototype/scripts/configure-speakmode.sh 配置 SpeakMode 的阿里云 Key。',
      authentication_failed: 'SpeakMode 的阿里云 Key 或地域不匹配，请重新配置后重试。',
      rate_limited: '阿里云转写限流，请稍后重试。',
      config_unavailable: 'SpeakMode 配置数据库不可用，请检查 ANC_SPEAKMODE_CONFIG_DB。',
      region_required: '请在页面中选择阿里云 Key 所属地域并保存配置。',
      credential_unavailable: 'SpeakMode 无法读取登录钥匙串，请检查系统权限后重试。',
    };
    throw new Error(messages[code] || 'SpeakMode 文件转写失败，请检查网络、模型权限和额度后重试。');
  }
  return parseReceipt(await readFile(receipt, 'utf8'), chunk);
}

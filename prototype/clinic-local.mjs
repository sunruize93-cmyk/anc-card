import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('./speakmode/clinic_local.py', import.meta.url));
const terms = new URL('./speakmode/clinic_terms.json', import.meta.url);
const model = 'mlx-community/Qwen3-ASR-1.7B-4bit';
const revision = '78a389c776a5483b2d0d4ea5494e11012e0d6159';
const adapter = 'anc-local-qwen-38-v1';
const glossarySha256 = '187e1904ff8b6931a58071145a7779c5df1648dfb480c160d279d0b0854407e5';
export const localTurnCacheVersion = [adapter, revision, glossarySha256].join('/');
const localErrors = new Set(['local_asr_arguments', 'local_asr_dependencies', 'local_asr_failed', 'local_asr_glossary',
  'local_asr_incomplete', 'local_asr_invalid_audio', 'local_asr_output_exists', 'local_asr_output_unavailable',
  'local_asr_platform', 'local_asr_snapshot']);

function invoke(args, options = {}) {
  const python = process.env.ANC_CLINIC_LOCAL_PYTHON || join(homedir(), '.local/share/anc-card/local-asr/venv/bin/python');
  return exec(python, [script, ...args], {
    env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' },
    maxBuffer: 128 * 1024, ...options,
  });
}

async function verifyGlossary() {
  const bytes = await readFile(terms);
  if (createHash('sha256').update(bytes).digest('hex') !== glossarySha256) {
    throw new Error('本机门诊词表版本不匹配，请核对安装。');
  }
}

export async function localAsrReady() {
  try {
    await verifyGlossary();
    const { stdout } = await invoke(['--check'], { timeout: 30_000 });
    const info = JSON.parse(stdout);
    return info.ready === true && info.model === model && info.revision === revision;
  } catch { return false; }
}

export function parseLocalReceipt(data, part, attempt) {
  if (!data || data.attemptId !== attempt || data.audioSha256 !== part.sha256 || data.audioSamples !== part.samples ||
      data.model !== model || data.revision !== revision || data.adapterVersion !== adapter ||
      data.glossarySha256 !== glossarySha256 || typeof data.text !== 'string' || !data.text.trim() ||
      data.text.length > 80_000 || data.text.includes('\0') ||
      !(data.detectedLanguage === null || (typeof data.detectedLanguage === 'string' && data.detectedLanguage.length <= 80))) {
    throw new Error('本机转写回执与音频、模型、词表或处理批次不匹配。');
  }
  return {
    startMs: part.startMs, endMs: part.endMs, text: data.text.trim(), timing: 'audio_chunk',
    engine: 'mlx-audio', provider: 'local', model, revision, adapterVersion: adapter, glossarySha256,
    requestedLanguage: 'auto', reportedLanguage: data.detectedLanguage, sourceId: attempt, attemptId: attempt, chunkSha256: part.sha256,
  };
}

export async function transcribeLocalChunk(part, directory, signal) {
  await verifyGlossary();
  const attempt = randomUUID();
  const wav = join(directory, attempt + '.wav'), out = join(directory, attempt + '.json');
  await writeFile(wav, part.audio, { flag: 'wx', mode: 0o600 });
  try {
    await invoke(['--wav', wav, '--out', out, '--attempt', attempt], { signal, timeout: 120_000 });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    if (error.code === 'ENOENT') throw new Error('未找到门诊本地转写环境，请先安装或检查 ANC_CLINIC_LOCAL_PYTHON。');
    let code;
    try { code = JSON.parse(String(error.stderr).trim().split('\n').at(-1)).errorCode; } catch {}
    throw new Error('本机门诊转写未完成，请检查本地模型与 Python 环境。' + (localErrors.has(code) ? ' (' + code + ')' : ''));
  }
  let receipt;
  try { receipt = JSON.parse(await readFile(out, 'utf8')); }
  catch { throw new Error('本机转写未返回可读取的结构化回执。'); }
  return parseLocalReceipt(receipt, part, attempt);
}

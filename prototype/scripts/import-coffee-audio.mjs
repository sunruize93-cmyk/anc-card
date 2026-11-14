// Local operator import: immutable original remains on disk; no task execution approval.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { maxAudioBytes, uploadTimeoutMs } from '../audio-limits.mjs';

const [input, device = 'Eric-USB', port = '4785'] = process.argv.slice(2);
if (!input || !/^[A-Za-z0-9_-]{1,100}$/.test(device) || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error('Usage: node prototype/scripts/import-coffee-audio.mjs AUDIO_FILE [DEVICE] [LOCAL_PORT]');
}
const file = resolve(input), before = await stat(file);
if (!before.isFile() || !before.size || before.size > maxAudioBytes) throw new Error('请选择非空且不超过 256 MiB 的原音。');
const hash = createHash('sha256');
for await (const chunk of createReadStream(file)) hash.update(chunk);
const expected = hash.digest('hex');
const after = await stat(file);
if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('文件仍在变化，请等待卡保存和复制完成。');
const response = await fetch(`http://127.0.0.1:${port}/api/recordings`, { method: 'POST', redirect: 'error',
  headers: { 'Content-Length': String(before.size), 'X-ANC-Filename': encodeURIComponent(basename(file)),
    'X-ANC-Publish': '1', 'X-ANC-Device': device },
  body: createReadStream(file), duplex: 'half', signal: AbortSignal.timeout(uploadTimeoutMs) });
const receipt = await response.json();
if (!response.ok) throw new Error(receipt.error || `HTTP ${response.status}`);
if (receipt.recording?.id !== expected) throw new Error('后台原音哈希不匹配，需要核对，不自动重试。');
console.log(JSON.stringify({ recordingId: expected, bytes: before.size, duplicate: receipt.duplicate,
  status: receipt.recording.status, result: `http://127.0.0.1:${port}/`,
  note: '已持久化入队，转写与飞书卡片异步处理；不是已转写完成。' }, null, 2));

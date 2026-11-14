// Explicit local operator action; no automatic extension or change of scope/token.
import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readDeviceConfig } from '../device-config.mjs';

const args = process.argv.slice(2);
if (args.length !== 4) throw new Error('Usage: node prototype/scripts/renew-upload-device.mjs DEVICE_JSON HTTPS_BASE_URL DAYS PHONE_IMPORT_JSON');
const [input, baseURL, daysText, output] = args;
const days = Number(daysText), endpoint = new URL(baseURL);
if (!Number.isInteger(days) || days < 1 || days > 30 || endpoint.protocol !== 'https:' ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
  throw new Error('仅支持 HTTPS 根地址和 1–30 天的明确续期。');
}
const path = resolve(input), target = resolve(output);
if (path === target) throw new Error('手机导入文件不能覆盖服务端配置。');
const before = await readFile(path, 'utf8');
const config = readDeviceConfig(path);
const expiresAt = Date.now() + days * 86400000;
if (expiresAt <= config.expiresAt) throw new Error('当前有效期已足够，不缩短或隐式改写。');
async function atomic(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}
// Keep the pairing code window unchanged. It must not reopen after renewal.
if (await readFile(path, 'utf8') !== before) throw new Error('配置已变化，请重新核对。');
await atomic(path, { ...config, expiresAt });
await atomic(target, { baseURL: endpoint.origin, token: config.token, device: config.device, expiresAt });
console.log(JSON.stringify({ device: config.device, expiresAt: new Date(expiresAt).toISOString(),
  phoneImportPrepared: true, phoneUpdated: false, tokenChanged: false }));

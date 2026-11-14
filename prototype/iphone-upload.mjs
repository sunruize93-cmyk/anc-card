import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMobileHandler } from './mobile-gateway.mjs';

const directory = process.env.ANC_UPLOAD_DIR;
const address = process.env.ANC_UPLOAD_HOST;
const port = Number(process.env.ANC_UPLOAD_PORT || 4787);
if (!directory || !address) throw Error('设置 ANC_UPLOAD_DIR 与 ANC_UPLOAD_HOST');
const config = JSON.parse(readFileSync(join(directory, 'device.json')));
if (!/^[a-f0-9]{64}$/.test(config.token) || !/^[A-Za-z0-9_-]{1,100}$/.test(config.device) ||
    !Number.isFinite(config.expiresAt) || !/^[a-f0-9]{64}$/.test(config.pairingCodeHash)) throw Error('设备配置无效');
const db = new DatabaseSync(join(directory, 'receipts.sqlite'));
const handler = createMobileHandler({ config, db, host: address + ':' + port,
  upstream: 'http://127.0.0.1:' + (process.env.ANC_PROTOTYPE_PORT || 4785) + '/api/recordings' });
const server = createServer({ key: readFileSync(join(directory, 'server.key')), cert: readFileSync(join(directory, 'server.crt')),
  minVersion: 'TLSv1.2' }, handler);
server.requestTimeout = 120000;
server.listen(port, address, () => console.log('iPhone 上传页已监听 https://' + address + ':' + port));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { db.close(); process.exit(0); }));

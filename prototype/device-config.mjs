import { readFileSync } from 'node:fs';

export function readDeviceConfig(path) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(config.token) || !/^[A-Za-z0-9_-]{1,100}$/.test(config.device) ||
      !Number.isFinite(config.expiresAt) || !/^[a-f0-9]{64}$/.test(config.pairingCodeHash)) {
    throw new Error('设备配置无效');
  }
  return config;
}

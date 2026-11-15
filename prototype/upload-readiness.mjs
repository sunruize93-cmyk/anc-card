import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { X509Certificate } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { readDeviceConfig } from './device-config.mjs';
import { maxAudioBytes } from './audio-limits.mjs';

export function assessLocalEndpoint(baseURL, addresses) {
  try {
    const url = new URL(baseURL);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    // This diagnostic is for the current Mac only. Never send its credential to an arbitrary URL.
    return new Set(['127.0.0.1', ...addresses]).has(url.hostname) ? url : null;
  } catch { return null; }
}

export function validity(expiresAt, now = Date.now()) {
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return 'failed';
  return expiresAt - now < 86400000 ? 'warning' : 'passed';
}

async function jsonGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      ...options, method: 'GET', timeout: 4000, rejectUnauthorized: true,
    }, response => {
      const chunks = []; let bytes = 0;
      response.on('error', () => reject(Error('response_failed')));
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) request.destroy(Error('oversize')); else chunks.push(chunk); });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(Error('http_'+response.statusCode));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(Error('invalid_json')); }
      });
    });
    request.on('timeout', () => request.destroy(Error('timeout')));
    request.on('error', () => reject(Error('connection_failed')));
    request.end();
  });
}

export async function inspectUploadReadiness({directory, baseURL, port = 4785}) {
  const checks = [], add = (name, state, detail) => checks.push({name, state, detail});
  const addresses = Object.values(networkInterfaces()).flat().filter(x => x?.family === 'IPv4' && !x.internal).map(x => x.address);
  const endpoint = assessLocalEndpoint(baseURL, addresses);
  add('Mac 上传地址', endpoint ? 'passed' : 'failed', endpoint ? endpoint.origin :
    `地址不属于当前 Mac 或格式无效；当前局域网地址：${addresses.join('、') || '无'}。未向该地址发送凭证。`);
  let config, ca;
  try {
    config = readDeviceConfig(join(directory, 'device.json'));
    add('设备凭证', validity(config.expiresAt), `到期时间：${new Date(config.expiresAt).toISOString()}；不显示 token`);
  } catch { add('设备凭证', 'failed', '无法读取有效本机设备配置，需要本机重新配置'); }
  for (const [name, file] of [['HTTPS 服务证书','server.crt'],['手机信任证书','ca.crt']]) {
    try {
      const bytes = await readFile(join(directory,file)); if (file === 'ca.crt') ca = bytes;
      const cert = new X509Certificate(bytes), expiry = Date.parse(cert.validTo);
      const state = Date.parse(cert.validFrom) > Date.now() ? 'failed' : validity(expiry);
      add(name, state, `有效期截至 ${new Date(expiry).toISOString()}；即将到期时应同步手机 CA`);
    } catch { add(name,'failed','证书缺失或无法解析；不跳过 HTTPS 验证'); }
  }
  if (endpoint && config && ca) {
    try {
      const result = await jsonGet(new URL('/v1/health', endpoint), {ca,headers:{Authorization:'Bearer '+config.token}});
      const matched = result.service === 'anc-upload' && result.device === config.device &&
        result.expiresAt === config.expiresAt && result.maxAudioBytes === maxAudioBytes;
      add('HTTPS 上传服务',matched?'passed':'failed',matched?'TLS、设备身份、有效期和 256 MiB 限制一致':'服务状态与本机配置不一致');
    } catch { add('HTTPS 上传服务','failed','连接、TLS、鉴权或服务版本检查失败；核对地址、证书与后台'); }
  } else add('HTTPS 上传服务','skipped','缺少可信本机地址或配置，未尝试连接');
  try {
    const r = await jsonGet(new URL(`http://127.0.0.1:${port}/api/readiness`));
    add('主后台',r.service==='anc-card' && r.maxAudioBytes===maxAudioBytes?'passed':'failed','核对服务版本与单文件上限');
    add('SpeakMode 安装配置',r.speakmode?.installed && r.speakmode?.configured?'passed':'failed','仅检查本机程序与配置存在，不调用收费转写或证明 Key 可用');
    add('飞书连接',r.feishu?.configured && r.feishu?.connection==='connected' && !r.feishu?.error?'passed':'warning','只读取已有连接，不发消息；未连接时结果不能立即送达');
  } catch { add('主后台','failed','本机后台未响应或尚不支持诊断接口'); }
  return { checkedAt:new Date().toISOString(), readOnly:true, ready:checks.every(c=>c.state==='passed'), checks,
    phone:'未读取真机：不能证明手机地址、凭证、CA 已同步，也不能证明锁屏长录音已通过' };
}

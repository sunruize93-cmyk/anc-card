const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('anc-upload-token') || '';
let receipt = null;
try { receipt = JSON.parse(sessionStorage.getItem('anc-upload-receipt') || 'null'); } catch {}
let timer;
function controls() { $('upload').disabled = !token; $('sample').disabled = !token; $('refresh').disabled = !token || !receipt; }
async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...options.headers } });
  const body = await response.json();
  if (!response.ok) throw Error(body.error || '请求失败');
  return body;
}
$('pair').onclick = async () => {
  try {
    const body = await request('/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('code').value.trim() }) });
    token = body.token; sessionStorage.setItem('anc-upload-token', token); $('code').value = '';
    $('paired').textContent = '已连接 ' + body.device + '。'; controls();
  } catch (e) { $('paired').textContent = e.message; }
};
async function status() {
  clearTimeout(timer);
  if (!receipt) return;
  try {
    const state = await request(receipt.resultPath);
    const labels = { queued: '已持久化排队', processing: 'SpeakMode＋百炼正在转写', failed: '转写失败，原件已保留，请在 Mac 端重试', complete: '转写完成' };
    $('status').textContent = (labels[state.status] || state.status) + '\n' +
      (state.feishu.state === 'complete' ? '飞书结果卡已发送，请到 nestlinker work 查看。' : state.feishu.state === 'retrying' ? '飞书暂未送达，后台正在重试。' : '飞书结果卡正在同步。');
    if (state.feishu.state !== 'complete' && state.status !== 'failed') timer = setTimeout(status, 3000);
  } catch (e) { $('status').textContent = e.message + '\n网络恢复后可点击“刷新处理状态”。'; }
}
$('upload').onclick = async () => {
  const file = $('file').files[0];
  if (!file) { $('status').textContent = '请先选择音频。'; return; }
  if (!file.size || file.size > 64 * 1024 * 1024 || !/\.(wav|m4a|mp3)$/i.test(file.name)) { $('status').textContent = '请选择不超过 64 MiB 的 WAV、M4A 或 MP3。'; return; }
  $('upload').disabled = true; clearTimeout(timer);
  try {
    $('status').textContent = '校验原文件并上传，请保持 Safari 在前台…';
    if (!globalThis.crypto?.subtle) throw Error('浏览器尚未建立可信 HTTPS 连接，无法校验文件。');
    const bytes = await file.arrayBuffer();
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
    receipt = await request('/v1/recordings', { method: 'POST', headers: { 'X-ANC-Filename': encodeURIComponent(file.name),
      'X-Recording-ID': 'wav-' + digest, 'X-Content-SHA256': digest, 'X-ANC-Client': 'web-upload' }, body: bytes });
    sessionStorage.setItem('anc-upload-receipt', JSON.stringify(receipt)); $('receipt').textContent = JSON.stringify(receipt, null, 2);
    await status();
  } catch (e) { $('status').textContent = e.message + '\n可重新选择同一个文件上传，后台会去重。'; }
  finally { controls(); }
};
$('sample').onclick = async () => {
  try {
    const r = await fetch('/v1/sample', { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw Error('样本下载失败，请检查配对状态。');
    const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = url; a.download = 'A-card.wav';
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch(e) { $('status').textContent = e.message; }
};
$('refresh').onclick = status;
controls();
if (receipt) { $('receipt').textContent = JSON.stringify(receipt, null, 2); $('status').textContent = '已恢复上次回执，点击刷新查看。'; }

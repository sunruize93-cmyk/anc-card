import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createMobileHandler } from './mobile-gateway.mjs';

test('手机入口配对、鉴权、来源、大小哈希、重传与私有状态访问', async () => {
  const db = new DatabaseSync(':memory:');
  const audio = Buffer.from('test wav bytes'), sha = x => createHash('sha256').update(x).digest('hex'), id = sha(audio);
  const config = { device: 'Eric-iPhone', token: 'a'.repeat(64), expiresAt: Date.now() + 60000,
    pairingCodeHash: sha('12345678'), pairingExpiresAt: Date.now() + 60000 };
  let handler, count = 0;
  const upstreamRequests = [];
  const server = createServer((req,res) => handler(req,res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const host = '127.0.0.1:' + server.address().port, url = 'http://' + host;
  handler = createMobileHandler({ config, db, host, upstream: 'http://internal/api/recordings', fetcher: async (url, options) => {
    upstreamRequests.push({url,options});
    if (options?.method === 'POST') return Response.json({ duplicate: count++ > 0, recording: { id } });
    return Response.json({recordingId:id,status:'complete',feishu:{state:'complete',messageId:'om_result'}});
  } });
  try {
    const req = (path, opts) => fetch(url + path, opts);
    const pair = code => req('/v1/pair', {method:'POST',body:JSON.stringify({code})});
    assert.equal((await pair('00000000')).status, 401);
    const paired = await (await pair('12345678')).json(); assert.equal(paired.token, config.token);
    const page = await (await req('/')).text(); assert.ok(!page.includes(config.token)); assert.ok(!page.includes('12345678'));
    assert.equal((await req('/api/feishu')).status, 401);
    const auth = { Authorization: 'Bearer ' + paired.token };
    assert.equal((await req('/v1/recordings/' + id,{headers:auth})).status,404);
    const headers = { ...auth, 'X-Recording-ID':'A-001','X-Content-SHA256':id,'X-ANC-Filename':'A.wav' };
    assert.equal((await req('/v1/recordings',{method:'POST',headers:{...headers,Origin:'https://wrong.test'},body:audio})).status,403);
    assert.equal((await req('/v1/recordings',{method:'POST',headers:{...headers,'X-Content-SHA256':'b'.repeat(64)},body:audio})).status,422);
    const first = await req('/v1/recordings',{method:'POST',headers,body:audio}); assert.equal(first.status,201);
    assert.equal((await first.json()).recordingId,id);
    const second = await req('/v1/recordings',{method:'POST',headers,body:audio}); assert.equal(second.status,200); assert.equal((await second.json()).duplicate,true);
    assert.equal(upstreamRequests[0].options.headers['X-ANC-Device'],'Eric-iPhone');
    assert.equal(upstreamRequests[0].options.headers['X-ANC-Publish'],'1');
    assert.equal((await req('/v1/recordings',{method:'POST',headers:{...headers,'X-Content-SHA256':'b'.repeat(64)},body:audio})).status,409);
    assert.equal((await (await req('/v1/recordings/'+id,{headers:auth})).json()).feishu.state,'complete');
    assert.equal(db.prepare('SELECT count(*) AS n FROM receipts').get().n,1);
    config.expiresAt=0; assert.equal((await req('/v1/recordings/'+id,{headers:auth})).status,401);
  } finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); db.close(); }
});

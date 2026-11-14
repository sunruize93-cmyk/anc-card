import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createMobileHandler } from './mobile-gateway.mjs';
import { readDeviceConfig } from './device-config.mjs';

test('explicit renewal preserves token/device/pair window; live reload, expiry and revocation fail closed', async () => {
  const dir = await mkdtemp(join(tmpdir(),'anc-renew-')), file=join(dir,'device.json'), output=join(dir,'device-import.json');
  const original={device:'Eric-iPhone',token:'a'.repeat(64),expiresAt:1,pairingCodeHash:'b'.repeat(64),pairingExpiresAt:1};
  const db=new DatabaseSync(':memory:');let server;
  try {
    await writeFile(file,JSON.stringify(original),{mode:0o600});
    let handler;server=createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
    const host='127.0.0.1:'+server.address().port;
    handler=createMobileHandler({config:original,loadConfig:()=>readDeviceConfig(file),db,host,upstream:'http://unused',
      fetcher:()=>{throw Error('unexpected upstream request');}});
    const request=(token=original.token)=>fetch('http://'+host+'/v1/recordings/'+'c'.repeat(64),{headers:{Authorization:'Bearer '+token}});
    assert.equal((await request()).status,401);
    const {stdout}=await promisify(execFile)(process.execPath,['prototype/scripts/renew-upload-device.mjs',file,'https://127.0.0.1:4787','7',output]);
    assert.ok(!stdout.includes(original.token));
    const renewed=readDeviceConfig(file), phone=JSON.parse(await readFile(output,'utf8'));
    assert.equal(renewed.token,original.token);assert.equal(renewed.device,original.device);
    assert.equal(renewed.pairingExpiresAt,1);assert.equal(renewed.pairingCodeHash,original.pairingCodeHash);
    assert.equal(phone.expiresAt,renewed.expiresAt);assert.equal(phone.token,renewed.token);
    assert.ok(renewed.expiresAt>Date.now()+6*86400000);assert.equal((await stat(file)).mode&0o777,0o600);
    assert.equal((await stat(output)).mode&0o777,0o600);
    assert.equal((await request()).status,404); // Authenticated but no ownership receipt.
    assert.equal((await request('d'.repeat(64))).status,401);
    assert.equal((await fetch('http://'+host+'/v1/pair',{method:'POST',body:'{"code":"12345678"}'})).status,401);
    await writeFile(file,JSON.stringify({...renewed,expiresAt:0}));assert.equal((await request()).status,401);
    await writeFile(file,'broken config');assert.equal((await request()).status,503);
  } finally {if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}db.close();await rm(dir,{recursive:true,force:true});}
});

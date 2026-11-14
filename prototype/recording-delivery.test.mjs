import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openRecordingDelivery, syncRecordingDelivery } from './recording-delivery.mjs';

test('上传结果持久化、跨重启重试、重复上传只有一张结果卡，失败恢复更新原卡', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anc-delivery-'));
  let db = new DatabaseSync(join(dir, 'data.sqlite'));
  try {
    const config = { appId: 'cli_test', chatId: 'oc_test' }, id = 'a'.repeat(64);
    let delivery = openRecordingDelivery(db);
    const input = { ...config, recordingId: id, device: 'Eric-iPhone', name: 'A.wav' };
    delivery.enqueue(input); delivery.enqueue(input);
    const uuid = delivery.pending(config)[0].sendKey;
    assert.equal(delivery.pending({ ...config, chatId: 'oc_wrong' }).length, 0);
    let recording = { id, status: 'queued' }, failReply = true, failPatch = false;
    const created = new Map(), patches = [];
    const client = { im: { message: {
      create: async ({ data }) => {
        assert.equal(data.receive_id, config.chatId);
        if (!created.has(data.uuid)) created.set(data.uuid, 'om_result');
        if (failReply) throw Error('response lost');
        return { code: 0, data: { message_id: created.get(data.uuid) } };
      },
      patch: async r => { if (failPatch) throw Error('offline'); patches.push(r); return { code: 0, data: {} }; },
    } } };
    const sync = () => syncRecordingDelivery({ delivery, client, config, recordings: { get: () => recording }, call: async p => (await p).data });
    await sync(); assert.equal(delivery.get(config, id).attempts, 1);
    db.close(); db = new DatabaseSync(join(dir, 'data.sqlite')); delivery = openRecordingDelivery(db);
    const due = () => db.exec('UPDATE recording_delivery SET retryAt=0');
    due(); assert.equal(delivery.pending(config)[0].sendKey, uuid); failReply = false; await sync();
    assert.equal(created.size, 1); assert.equal(delivery.get(config, id).messageId, 'om_result');
    recording = { id, status: 'failed', error: 'ASR offline' }; due(); await sync();
    assert.match(patches.at(-1).data.content, /ASR offline/);
    recording = { id, status: 'complete', transcript: [{ startMs: 0, endMs: 12800, text: '由Eric负责接口说明。' }],
      ledger: [{ id: 'task1', owner: 'Eric', title: '接口说明', startMs: 0, endMs: 12800 }] };
    failPatch = true; due(); await sync(); assert.equal(delivery.get(config, id).finished, 0);
    failPatch = false; due(); await sync();
    assert.equal(patches.at(-1).path.message_id, 'om_result');
    assert.match(patches.at(-1).data.content, /00:00.000–00:12.800/);
    assert.equal(delivery.get(config, id).finished, 1);
    delivery.enqueue(input); due(); await sync(); assert.equal(created.size, 1); assert.equal(patches.length, 2);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

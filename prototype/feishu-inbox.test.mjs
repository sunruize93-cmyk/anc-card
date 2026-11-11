import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import * as lark from '@larksuiteoapi/node-sdk';
import { openFeishuInbox, syncInbox } from './feishu-inbox.mjs';
import { audioTypes } from './recordings.mjs';

const config = { appId: 'cli_test', chatId: 'oc_test' };
const message = (id = 'om_audio') => ({ app_id: config.appId,
  sender: { sender_type: 'user', sender_id: { open_id: 'ou_sender' } },
  message: { message_id: id, chat_id: config.chatId, chat_type: 'group', message_type: 'file',
    content: JSON.stringify({ file_key: 'file_test', file_name: 'sample.wav' }) } });
const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const call = async request => { const response = await request; assert.equal(response.code, 0); return response.data; };
const due = db => db.exec('UPDATE feishu_inbox SET retryAt = 0');

function fixture() {
  const audio = Buffer.from('offline audio transfer fixture');
  const rows = new Map();
  const transfers = [];
  const replies = [];
  const patches = [];
  const recordings = {
    import(name, bytes) {
      const id = createHash('sha256').update(bytes).digest('hex');
      const duplicate = rows.has(id);
      if (!duplicate) rows.set(id, { id, name, status: 'queued', transcript: null, ledger: null });
      return { duplicate, recording: rows.get(id) };
    },
    get: id => rows.get(id),
  };
  const client = { im: {
    messageResource: { get: async request => {
      transfers.push(request);
      return { getReadableStream: () => Readable.from([audio]) };
    } },
    message: {
      reply: async request => { replies.push(request); return { code: 0, data: { message_id: 'om_reply_' + replies.length } }; },
      patch: async request => { patches.push(request); return { code: 0, data: {} }; },
    },
  } };
  return { recordings, client, transfers, replies, patches, rows };
}

test('官方 SDK 事件只接收已绑定群的用户音频文件，重复事件只落盘一次', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const inbox = openFeishuInbox(db, audioTypes);
    const dispatcher = new lark.EventDispatcher({ logger }).register({ 'im.message.receive_v1': data => inbox.receive(data, config) });
    const value = message();
    await dispatcher.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1', app_id: config.appId, event_id: 'evt1' },
      event: { sender: value.sender, message: value.message } });
    assert.equal(inbox.pending(config).length, 1);
    assert.equal(inbox.receive(value, config), false);
    for (const invalid of [
      { ...value, app_id: 'cli_other' },
      { ...value, message: { ...value.message, chat_id: 'oc_other' } },
      { ...value, message: { ...value.message, chat_type: 'p2p' } },
      { ...value, sender: { ...value.sender, sender_type: 'app' } },
      { ...value, message: { ...value.message, content: '{}' } },
      { ...value, message: { ...value.message, content: 'null' } },
      { ...value, message: { ...value.message, content: '{' } },
      { ...value, message: { ...value.message, content: JSON.stringify({ file_key: 'file', file_name: 'notes.pdf' }) } },
    ]) assert.equal(inbox.receive(invalid, config), false);
    assert.equal(inbox.pending(config).length, 1);
  } finally { db.close(); }
});

test('重启恢复收件队列；重发同音频复用录音；原线程结果随转写更新', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anc-inbox-'));
  let db;
  try {
    const path = join(directory, 'test.sqlite');
    db = new DatabaseSync(path);
    let inbox = openFeishuInbox(db, audioTypes);
    inbox.receive(message(), config);
    const key = inbox.pending(config)[0].sendKey;
    db.close();
    db = new DatabaseSync(path);
    inbox = openFeishuInbox(db, audioTypes);
    assert.equal(inbox.pending(config)[0].sendKey, key);
    const f = fixture();
    const sync = () => syncInbox({ inbox, config, call, ...f, maxBytes: 1024 });
    await sync();
    assert.equal(f.transfers.length, 1);
    assert.equal(f.transfers[0].params.type, 'file');
    assert.equal(f.replies[0].path.message_id, 'om_audio');
    assert.equal(f.replies[0].data.reply_in_thread, true);
    assert.equal(f.replies[0].data.uuid, key);
    due(db);
    await sync();
    assert.equal(f.replies.length, 1);
    assert.equal(f.patches.length, 0);
    const recording = [...f.rows.values()][0];
    recording.status = 'failed'; recording.error = '转写失败';
    due(db); await sync();
    assert.match(f.patches[0].data.content, /转写失败/);
    recording.status = 'complete';
    recording.transcript = [{ startMs: 8560, endMs: 14860, text: '由小王负责整理会议纪要。' }];
    recording.ledger = [{ id: 'same-task-id', startMs: 8560, endMs: 14860, owner: '小王', title: '整理会议纪要' }];
    due(db); await sync();
    assert.equal(f.patches[1].path.message_id, 'om_reply_1');
    assert.match(f.patches[1].data.content, /00:08.560–00:14.860/);
    assert.match(f.patches[1].data.content, /same-task-id/);
    assert.equal(inbox.status().pending, 0);
    inbox.receive(message('om_same_audio'), config);
    await sync();
    assert.equal(f.rows.size, 1);
    assert.equal(f.replies.length, 2);
    assert.match(f.replies[1].data.content, /same-task-id/);
  } finally { db?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('下载和回写分别重试，回写失败不会再次下载或导入', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const inbox = openFeishuInbox(db, audioTypes);
    inbox.receive(message(), config);
    const f = fixture();
    const get = f.client.im.messageResource.get;
    f.client.im.messageResource.get = async () => { throw new Error('offline'); };
    const sync = () => syncInbox({ inbox, config, call, ...f, maxBytes: 1024 });
    await sync();
    assert.equal(inbox.status().errors, 1);
    assert.equal(inbox.pending(config).length, 0);
    f.client.im.messageResource.get = get;
    const reply = f.client.im.message.reply;
    f.client.im.message.reply = async () => { throw new Error('offline'); };
    due(db); await sync();
    assert.equal(f.rows.size, 1);
    assert.equal(f.transfers.length, 1);
    f.client.im.message.reply = reply;
    due(db); await sync();
    assert.equal(f.transfers.length, 1);
    assert.equal(f.replies.length, 1);
    assert.equal(inbox.status().errors, 0);
  } finally { db.close(); }
});

test('超限或原生语音消息给出明确提示；失败录音不阻塞后续文件', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const inbox = openFeishuInbox(db, audioTypes);
    const f = fixture();
    inbox.receive(message(), config);
    await syncInbox({ inbox, config, call, ...f, maxBytes: 2 });
    assert.equal(f.rows.size, 0);
    assert.match(f.replies[0].data.content, /64 MiB/);
    const voice = message('om_voice'); voice.message.message_type = 'audio';
    inbox.receive(voice, config);
    await syncInbox({ inbox, config, call, ...f, maxBytes: 1024 });
    assert.equal(f.transfers.length, 1);
    assert.match(f.replies[1].data.content, /作为文件发送/);
    for (let i = 0; i < 8; i++) inbox.receive(message('om_file_' + i), config);
    await syncInbox({ inbox, config, call, ...f, maxBytes: 1024 });
    await syncInbox({ inbox, config, call, ...f, maxBytes: 1024 });
    assert.equal(f.replies.length, 10);
  } finally { db.close(); }
});

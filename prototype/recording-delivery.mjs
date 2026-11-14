import { createHash, randomUUID } from 'node:crypto';
import { recordingCard } from './feishu-inbox.mjs';

// One result card per recording in a bound group. A durable UUID survives lost
// send responses and process restarts; execution still needs its own approval.
export function openRecordingDelivery(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS recording_delivery (
    appId TEXT NOT NULL, chatId TEXT NOT NULL, recordingId TEXT NOT NULL,
    device TEXT NOT NULL, name TEXT NOT NULL, sendKey TEXT NOT NULL,
    messageId TEXT, rendered TEXT, finished INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, retryAt INTEGER NOT NULL DEFAULT 0,
    error TEXT, PRIMARY KEY(appId, chatId, recordingId)
  )`);
  return {
    enqueue({ appId, chatId, recordingId, device, name }) {
      if (!appId || !chatId || !/^[a-f0-9]{64}$/.test(recordingId) ||
          !/^[A-Za-z0-9_-]{1,100}$/.test(device)) throw Error('录音投递绑定无效');
      db.prepare(`INSERT INTO recording_delivery(appId,chatId,recordingId,device,name,sendKey)
        VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING`).run(appId, chatId, recordingId, device, name, randomUUID());
    },
    pending: config => db.prepare(`SELECT * FROM recording_delivery WHERE appId=? AND chatId=?
      AND finished=0 AND retryAt<=? ORDER BY retryAt,rowid LIMIT 6`).all(config.appId, config.chatId, Date.now()),
    get: (config, id) => db.prepare('SELECT * FROM recording_delivery WHERE appId=? AND chatId=? AND recordingId=?')
      .get(config.appId, config.chatId, id),
    hasBindings: () => !!db.prepare('SELECT 1 FROM recording_delivery LIMIT 1').get(),
    delivered(row, messageId, rendered, finished) {
      db.prepare(`UPDATE recording_delivery SET messageId=?,rendered=?,finished=?,error=NULL,retryAt=?
        WHERE appId=? AND chatId=? AND recordingId=?`).run(messageId, rendered, Number(finished), Date.now() + 2400,
          row.appId, row.chatId, row.recordingId);
    },
    unchanged: row => db.prepare(`UPDATE recording_delivery SET retryAt=? WHERE appId=? AND chatId=? AND recordingId=?`)
      .run(Date.now() + 2400, row.appId, row.chatId, row.recordingId),
    failed: row => db.prepare(`UPDATE recording_delivery SET attempts=attempts+1,error=?,retryAt=?
      WHERE appId=? AND chatId=? AND recordingId=?`).run('飞书结果投递失败，将自动重试。',
        Date.now() + Math.min(300000, 3000 * 2 ** Math.min(row.attempts, 7)), row.appId, row.chatId, row.recordingId),
  };
}

export async function syncRecordingDelivery({ delivery, recordings, client, config, call }) {
  for (const row of delivery.pending(config)) {
    try {
      const recording = recordings.get(row.recordingId);
      if (!recording) throw Error('录音尚不可用');
      const card = recordingCard(row, recording);
      card.body.elements.unshift({ tag: 'div', text: { tag: 'plain_text',
        content: `上传来源 ${row.device}\n录音 ID ${row.recordingId}` } });
      const content = JSON.stringify(card);
      const rendered = createHash('sha256').update(content).digest('hex');
      if (row.rendered === rendered) { delivery.unchanged(row); continue; }
      let messageId = row.messageId;
      if (messageId) await call(client.im.message.patch({ path: { message_id: messageId }, data: { content } }));
      else {
        const sent = await call(client.im.message.create({ params: { receive_id_type: 'chat_id' },
          data: { receive_id: row.chatId, msg_type: 'interactive', content, uuid: row.sendKey } }));
        messageId = sent.message_id;
      }
      if (!messageId) throw Error('飞书未返回消息 ID');
      delivery.delivered(row, messageId, rendered, recording.status === 'complete');
    } catch { delivery.failed(row); }
  }
}

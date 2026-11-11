import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';

// This inbox shares the recording database and its single-process lock. Receiving
// an event only commits metadata; downloading and ASR happen outside the callback.
export function openFeishuInbox(db, audioTypes) {
  db.exec(`CREATE TABLE IF NOT EXISTS feishu_inbox (
    appId TEXT NOT NULL, messageId TEXT NOT NULL, chatId TEXT NOT NULL,
    name TEXT NOT NULL, fileKey TEXT, inputError TEXT, recordingId TEXT,
    replyId TEXT, sendKey TEXT NOT NULL, rendered TEXT, finished INTEGER DEFAULT 0,
    attempts INTEGER DEFAULT 0, retryAt INTEGER DEFAULT 0, error TEXT,
    PRIMARY KEY (appId, messageId)
  )`);
  const insert = db.prepare(`INSERT INTO feishu_inbox
    (appId, messageId, chatId, name, fileKey, inputError, sendKey)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`);
  return {
    receive(data, config) {
      const message = data.message;
      if (!config?.chatId || data.app_id !== config.appId || message?.chat_id !== config.chatId ||
          message.chat_type !== 'group' || data.sender?.sender_type !== 'user' ||
          !data.sender.sender_id?.open_id || !message.message_id ||
          !['file', 'audio'].includes(message.message_type)) return false;
      let content;
      try { content = JSON.parse(message.content); } catch { return false; }
      if (!content || typeof content.file_key !== 'string' || !content.file_key || content.file_key.length > 512) return false;
      let name = content.file_name;
      let inputError = null;
      if (message.message_type === 'audio') {
        name = '飞书语音消息';
        inputError = '请将录音 App 导出的 WAV、M4A 或 MP3 作为文件发送。当前入口尚未接入飞书语音消息的编码转换。';
      } else if (typeof name !== 'string' || !Object.hasOwn(audioTypes, extname(name).toLowerCase())) {
        // Ignore unrelated group files instead of responding to every attachment.
        return false;
      } else if (name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(name)) {
        name = '音频文件';
        inputError = '音频文件名无效，请重命名后发送。';
      }
      return insert.run(config.appId, message.message_id, config.chatId, name,
        content.file_key, inputError, randomUUID()).changes === 1;
    },
    pending: (config, now = Date.now()) => db.prepare(`SELECT * FROM feishu_inbox
      WHERE appId = ? AND chatId = ? AND finished = 0 AND retryAt <= ? ORDER BY retryAt, rowid LIMIT 6`)
      .all(config.appId, config.chatId, now),
    imported: (row, id) => db.prepare('UPDATE feishu_inbox SET recordingId = ? WHERE appId = ? AND messageId = ?')
      .run(id, row.appId, row.messageId),
    invalid: (row, error) => db.prepare('UPDATE feishu_inbox SET inputError = ? WHERE appId = ? AND messageId = ?')
      .run(error, row.appId, row.messageId),
    delivered: (row, replyId, rendered, finished) => db.prepare(`UPDATE feishu_inbox
      SET replyId = ?, rendered = ?, finished = ?, error = NULL, retryAt = ?
      WHERE appId = ? AND messageId = ?`).run(replyId, rendered, Number(finished), Date.now() + 2400, row.appId, row.messageId),
    unchanged: row => db.prepare('UPDATE feishu_inbox SET retryAt = ?, error = NULL WHERE appId = ? AND messageId = ?')
      .run(Date.now() + 2400, row.appId, row.messageId),
    failed: (row, error) => db.prepare(`UPDATE feishu_inbox
      SET attempts = attempts + 1, error = ?, retryAt = ? WHERE appId = ? AND messageId = ?`)
      .run(error, Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(row.attempts, 4)), row.appId, row.messageId),
    hasBindings: () => !!db.prepare('SELECT 1 FROM feishu_inbox LIMIT 1').get(),
    status: () => ({ pending: db.prepare('SELECT count(*) AS n FROM feishu_inbox WHERE finished = 0').get().n,
      errors: db.prepare('SELECT count(*) AS n FROM feishu_inbox WHERE error IS NOT NULL').get().n }),
  };
}

class InvalidAudio extends Error {}

export async function downloadAudio(client, row, maxBytes) {
  const resource = await client.im.messageResource.get({ path: { message_id: row.messageId, file_key: row.fileKey }, params: { type: 'file' } });
  const stream = resource.getReadableStream();
  const timeout = setTimeout(() => stream.destroy(new Error('下载超时。')), 60_000);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maxBytes) throw new InvalidAudio('单个音频文件最多 64 MiB，请分段后发送。');
      chunks.push(Buffer.from(chunk));
    }
    if (!size) throw new InvalidAudio('音频文件为空，请检查后重新发送。');
    return Buffer.concat(chunks, size);
  } finally {
    clearTimeout(timeout);
    stream.destroy();
  }
}

const time = ms => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
const clip = (value, max) => value.length > max ? value.slice(0, max) + '\n（内容较长，完整结果保存在 ANC Card 台账中。）' : value;
export function recordingCard(row, recording) {
  const states = { queued: '已持久化排队', processing: 'SpeakMode 转写中', complete: '转写完成，行动项待核对', failed: '转写失败，待重试' };
  const status = row.inputError ? '导入未完成' : states[recording?.status];
  const text = content => ({ tag: 'div', text: { tag: 'plain_text', content } });
  const elements = [text(`${row.name}\n${status}\n转写服务：SpeakMode＋阿里云百炼` )];
  if (row.inputError) elements.push(text(row.inputError));
  if (recording?.status === 'failed') elements.push(text(`${recording.error}\n可在 ANC Card 本机录音页重试，结果会更新到这张卡片。`));
  if (recording?.status === 'complete') {
    elements.push(text(clip((recording.transcript || []).map(segment =>
      `[${time(segment.startMs)}–${time(segment.endMs)}] ${segment.text}`).join('\n') || '未检测到可识别的语音。', 4000)));
    elements.push(text(clip('待核对行动项\n' + ((recording.ledger || []).map(item =>
      `${item.owner} · ${item.title}${item.deadline ? ' · 截止 ' + item.deadline : ''}\n[${time(item.startMs)}–${time(item.endMs)}]\n任务 ${item.id}`).join('\n\n') || '未提取到明确分工，请核对转写。'), 2000)));
    elements.push(text('时间范围对应原音频分段。行动项沿用同一任务 ID，核对并准备执行方案后再由负责人确认。'));
  }
  return { schema: '2.0', config: { update_multi: true }, header: {
    title: { tag: 'plain_text', content: 'ANC Card · ' + status },
    template: row.inputError || recording?.status === 'failed' ? 'orange' : 'blue',
  }, body: { elements } };
}

export async function syncInbox({ inbox, recordings, client, config, call, maxBytes }) {
  for (let row of inbox.pending(config)) {
    try {
      if (!row.recordingId && !row.inputError) {
        try {
          const audio = await downloadAudio(client, row, maxBytes);
          const { recording } = recordings.import(row.name, audio);
          inbox.imported(row, recording.id);
          row = { ...row, recordingId: recording.id };
        } catch (error) {
          if (!(error instanceof InvalidAudio)) throw error;
          inbox.invalid(row, error.message);
          row = { ...row, inputError: error.message };
        }
      }
      const recording = row.recordingId ? recordings.get(row.recordingId) : null;
      if (!recording && !row.inputError) throw new Error('录音记录暂不可用。');
      const content = JSON.stringify(recordingCard(row, recording));
      const rendered = createHash('sha256').update(content).digest('hex');
      if (row.rendered === rendered) { inbox.unchanged(row); continue; }
      let replyId = row.replyId;
      if (replyId) await call(client.im.message.patch({ path: { message_id: replyId }, data: { content } }));
      else {
        const reply = await call(client.im.message.reply({ path: { message_id: row.messageId },
          data: { msg_type: 'interactive', content, reply_in_thread: true, uuid: row.sendKey } }));
        replyId = reply.message_id;
      }
      if (!replyId) throw new Error('未返回回复 ID。');
      inbox.delivered(row, replyId, rendered, !!row.inputError || recording?.status === 'complete');
    } catch {
      inbox.failed(row, '飞书音频下载或结果回写失败，请检查应用权限与网络；服务将重试。');
    }
  }
}

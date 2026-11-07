import * as lark from '@larksuiteoapi/node-sdk';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const labels = { needs_review: '待核对', awaiting: '待负责人确认', queued: '已入执行队列',
  running: 'Codex 执行中', interrupted: '执行中断，待负责人恢复', complete: '全部验收通过', blocked: '验收仍有缺口' };

export function taskCard(task) {
  const latest = task.rounds.at(-1);
  const checks = latest?.checks || task.transcript.criteria;
  const text = content => ({ tag: 'div', text: { tag: 'plain_text', content } });
  const elements = [
    text(`${task.title}\n录音分工 ${task.owner}\n确认负责人 ${task.ownerDisplayName || task.owner}\n任务 ${task.taskId}\n${labels[task.status] || task.status}`),
    text(`录音来源 ${task.source.name}\n分段回听范围 ${task.source.startMs}–${task.source.endMs} 毫秒\n原文 ${task.source.evidence}`),
    text(checks.map(check => `${latest ? check.passed ? '通过' : '缺口' : '待验收'} · ${check.label}${check.evidence ? '\n' + check.evidence : ''}`).join('\n')),
  ];
  if (task.proposal) elements.push(text(`${task.proposal.title}\n${task.proposal.action}\n依据 ${task.proposal.reason}`));
  if (task.sessionId) elements.push(text(`Codex 会话 ${task.sessionId}\n已保存 ${task.rounds.length} 轮结果`));
  if (['awaiting', 'interrupted'].includes(task.status)) {
    elements.push({ tag: 'column_set', columns: [{ tag: 'column', width: 'weighted', weight: 1, elements: [{
      tag: 'button', text: { tag: 'plain_text', content: task.status === 'interrupted' ? '恢复原会话执行' : task.rounds.length ? '确认并续跑' : '确认首轮执行' },
      type: 'primary', behaviors: [{ type: 'callback', value: { taskId: task.taskId, version: task.version,
        proposalId: task.proposal?.id || task.approvedProposal?.id, action: task.status === 'interrupted' ? 'recover' : 'approve' } }],
    }] }] });
  }
  return { schema: '2.0', config: { update_multi: true }, header: {
    title: { tag: 'plain_text', content: 'ANC Card · ' + (labels[task.status] || task.status) },
    template: task.status === 'complete' ? 'green' : 'blue',
  }, body: { elements } };
}

export function receiveCardAction(data, config, tasks) {
  try {
    if (data.app_id !== config.appId || data.context?.open_chat_id !== config.chatId) throw new Error('该卡片不属于当前测试群。');
    const value = data.action?.value;
    if (!value || !['approve', 'recover'].includes(value.action)) throw new Error('卡片操作无效。');
    tasks.confirm({ ...value, actor: data.operator?.open_id, channel: 'feishu', messageId: data.context.open_message_id, chatId: data.context.open_chat_id });
    return { toast: { type: 'success', content: '已确认，执行请求已保存并入队。' } };
  } catch (error) {
    return { toast: { type: 'error', content: error.message } };
  }
}

async function call(request) {
  try {
    const response = await request;
    if (response.code !== 0) throw Object.assign(new Error(), { apiCode: response.code });
    return response.data;
  } catch (error) {
    const code = error.apiCode || error.response?.data?.code;
    throw new Error(`飞书请求失败${Number.isInteger(code) ? `（${code}）` : ''}，请检查应用权限和网络。`);
  }
}

export async function openFeishu(directory, tasks) {
  const path = join(directory, 'feishu.json');
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('飞书配置文件无法读取。'); }
  let client;
  let socket;
  let errorMessage = '';
  let pending;
  let configuring = false;
  const newClient = value => new lark.Client({ appId: value.appId, appSecret: value.appSecret, logger });

  function connect() {
    socket?.close({ force: true });
    if (!config) return;
    client = newClient(config);
    socket = new lark.WSClient({ appId: config.appId, appSecret: config.appSecret, logger, handshakeTimeoutMs: 15000,
      onError: () => { errorMessage = '飞书长连接失败，请检查凭据与事件订阅设置。'; },
      onReady: () => { errorMessage = ''; }, onReconnected: () => { errorMessage = ''; } });
    socket.start({ eventDispatcher: new lark.EventDispatcher({ logger }).register({
      'card.action.trigger': data => receiveCardAction(data, config, tasks),
    }) }).catch(() => { errorMessage = '飞书长连接未能建立。'; });
  }

  async function members(chatId, api = client) {
    if (!api || !/^oc_[A-Za-z0-9_-]+$/.test(chatId || '')) throw new Error('请选择测试群。');
    const items = [];
    let page;
    do {
      const result = await call(api.im.chatMembers.get({ path: { chat_id: chatId },
        params: { member_id_type: 'open_id', page_size: 100, page_token: page } }));
      items.push(...(result.items || []).map(item => ({ openId: item.member_id, name: item.name })));
      page = result.has_more ? result.page_token : null;
    } while (page);
    return items;
  }

  connect();
  async function sync() {
    if (!config?.chatId || configuring) return;
    for (const { task, sendKey } of tasks.deliveries()) {
      if (task.chatId !== config.chatId) continue;
      try {
        const content = JSON.stringify(taskCard(task));
        let messageId = task.card.messageId;
        if (messageId) await call(client.im.message.patch({ path: { message_id: messageId }, data: { content } }));
        else {
          const sent = await call(client.im.message.create({ params: { receive_id_type: 'chat_id' },
            data: { receive_id: task.chatId, msg_type: 'interactive', content, uuid: sendKey } }));
          messageId = sent.message_id;
        }
        if (!messageId) throw new Error('飞书未返回消息 ID。');
        tasks.delivered(task.taskId, task.version, messageId);
      } catch (error) {
        tasks.deliveryFailed(task.taskId, error.message);
      }
    }
  }
  const timer = setInterval(() => { if (!pending) pending = sync().finally(() => { pending = undefined; }); }, 1200);

  return {
    status: () => ({ configured: !!config, appId: config?.appId || '', chatId: config?.chatId || '',
      ownerOpenId: config?.ownerOpenId || '', ownerName: config?.ownerName || '', connection: socket?.getConnectionStatus().state || 'idle', error: errorMessage }),
    async configure(input) {
      if (configuring) throw new Error('飞书配置正在更新，请稍后再试。');
      configuring = true;
      try {
        await pending;
        const next = { appId: input.appId, appSecret: input.appSecret || config?.appSecret,
          chatId: input.chatId || null, ownerOpenId: input.ownerOpenId || null };
        if (!/^cli_[A-Za-z0-9_-]+$/.test(next.appId || '') || typeof next.appSecret !== 'string' ||
            !next.appSecret.trim() || next.appSecret.length > 4096) throw new Error('请填写有效的 App ID 和 App Secret。');
        if (tasks.list().some(task => task.origin === 'recording' && task.ownerOpenId && task.ownerOpenId !== 'local') &&
            (next.appId !== config?.appId || next.chatId !== config?.chatId)) throw new Error('已有任务卡片绑定当前应用和群，请保留其绑定。');
        const api = newClient(next);
        if (next.chatId) {
          const people = await members(next.chatId, api);
          const owner = people.find(person => person.openId === next.ownerOpenId);
          if (!owner) throw new Error('请选择测试群中的负责人。');
          next.ownerName = owner.name;
        } else {
          await call(api.im.chat.list({ params: { page_size: 1 } }));
        }
        const temporary = path + '.' + randomUUID();
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
        await rename(temporary, path);
        config = next;
        errorMessage = '';
        connect();
        return this.status();
      } finally { configuring = false; }
    },
    async chats() {
      if (!client) throw new Error('请先保存飞书应用配置。');
      const items = [];
      let page;
      do {
        const result = await call(client.im.chat.list({ params: { page_size: 100, page_token: page } }));
        items.push(...(result.items || []).map(item => ({ chatId: item.chat_id, name: item.name })));
        page = result.has_more ? result.page_token : null;
      } while (page);
      return items;
    },
    members,
    async close() {
      clearInterval(timer);
      socket?.close({ force: true });
      await pending;
    },
  };
}

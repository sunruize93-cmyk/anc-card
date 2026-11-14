import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fetchExample } from './client.mjs';

const results = [];
async function check(id, run) {
  try {
    results.push({ id, passed: true, detail: await run() });
  } catch (error) {
    results.push({ id, passed: false, detail: error.message });
  }
}
await check('example', async () => {
  let calls = 0;
  const body = await fetchExample(async () => { calls++; return { status: 200, body: 'ok' }; });
  assert.equal(body, 'ok');
  assert.equal(calls, 1);
  return '200 响应返回 ok，调用 1 次';
});
await check('guide', async () => {

  const scenarios = [
    [{ status: 200, body: 'ok' }],
    [{ status: 429, body: 'rate limited' }, { status: 200, body: 'ok after retry' }],
    [{ status: 429, body: 'still limited' }, { status: 429, body: 'still limited' }],
    [{ status: 503, body: 'unavailable' }],
  ];
  const observed = [];
  for (const replies of scenarios) {
    let calls = 0;
    const value = await fetchExample(async () => {
      assert.ok(calls < 2, '文档验收：请求超过两次');
      return replies[Math.min(calls++, replies.length - 1)];
    });
    observed.push({ calls, value });
  }
  const retries = observed[1].calls === 2;
  assert.deepEqual(observed, [
    { calls: 1, value: 'ok' },
    { calls: retries ? 2 : 1, value: retries ? 'ok after retry' : 'rate limited' },
    { calls: retries ? 2 : 1, value: 'still limited' },
    { calls: 1, value: 'unavailable' },
  ], '文档验收：行为不符合本示例支持的单次调用或 429 单次重试版本');
  const body = await readFile(new URL('./USAGE.md', import.meta.url), 'utf8');
  const expected = retries ? "# 调用说明\n\n`fetchExample(send)` 接收异步函数 `send`，其返回值为 `{ status, body }`。\n返回最后一次响应的 `body`。\n\n首次响应为 HTTP 429 时仅重试一次，总请求次数最多为两次。连续两次 429 返回第二次响应的 body。其他状态（包括 200 和 503）只请求一次。\n\n| 响应序列 | 调用次数 | 返回值 |\n|---|---|---|\n| 200 | 1 | ok |\n| 429 → 200 | 2 | ok after retry |\n| 429 → 429 | 2 | still limited |\n| 503 | 1 | unavailable |\n\n```js\nimport { fetchExample } from './client.mjs';\n\nconst send = async () => ({ status: 200, body: 'ok' });\nconsole.log(await fetchExample(send)); // ok\n```\n\n验收命令：\n\n```sh\nnode verify.mjs\n```\n\n验收输出为 JSON；逐项检查 passed，不能仅根据进程退出码判断通过。以上请求使用注入的 send 测试，不访问真实网络。\n" : "# 调用说明\n\n`fetchExample(send)` 接收异步函数 `send`，其返回值为 `{ status, body }`。\n返回最后一次响应的 `body`。\n\n当前版本只调用 send 一次，不重试。HTTP 429 单次重试尚未实现，等待下一轮批准；429 验收预期失败。\n\n| 响应序列 | 调用次数 | 返回值 |\n|---|---|---|\n| 200 | 1 | ok |\n| 429 → 200 | 1 | rate limited |\n| 429 → 429 | 1 | still limited |\n| 503 | 1 | unavailable |\n\n```js\nimport { fetchExample } from './client.mjs';\n\nconst send = async () => ({ status: 200, body: 'ok' });\nconsole.log(await fetchExample(send)); // ok\n```\n\n验收命令：\n\n```sh\nnode verify.mjs\n```\n\n验收输出为 JSON；逐项检查 passed，不能仅根据进程退出码判断通过。以上请求使用注入的 send 测试，不访问真实网络。\n";
  assert.equal(body.replaceAll('\r\n', '\n').trim(), expected.trim(),
    'USAGE.md 与实测行为不一致，或未使用本示例的完整说明模板');
  return 'USAGE.md 完整说明与 200、429 恢复、连续 429、503 的实测调用次数和返回值一致';
});
await check('rate-limit', async () => {
  let calls = 0;
  const recovered = await fetchExample(async () => ++calls === 1
    ? { status: 429, body: 'rate limited' }
    : { status: 200, body: 'ok after retry' });
  assert.equal(calls, 2, '首个响应是 429 时应调用 2 次，实际调用 '+calls+' 次');
  assert.equal(recovered, 'ok after retry');
  calls = 0;
  const limited = await fetchExample(async () => { calls++; return { status: 429, body: 'still limited' }; });
  assert.equal(calls, 2, '连续 429 时只允许重试一次');
  assert.equal(limited, 'still limited');
  calls = 0;
  await fetchExample(async () => { calls++; return { status: 503, body: 'unavailable' }; });
  assert.equal(calls, 1, '其他状态不应重试');
  return '429 → 200 恢复成功，连续 429 时止于第 2 次请求，503 不重试';
});
process.stdout.write(JSON.stringify(results));

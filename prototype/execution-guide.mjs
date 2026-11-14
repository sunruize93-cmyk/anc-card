// A deliberately fixed guide for the two-round HTTP fixture, not a general
// natural-language correctness evaluator. Its complete text is checked against
// observed behavior so a stale paragraph cannot hide behind correct keywords.
export function usageGuide(retry) {
  return `# 调用说明

\`fetchExample(send)\` 接收异步函数 \`send\`，其返回值为 \`{ status, body }\`。
返回最后一次响应的 \`body\`。

${retry
    ? '首次响应为 HTTP 429 时仅重试一次，总请求次数最多为两次。连续两次 429 返回第二次响应的 body。其他状态（包括 200 和 503）只请求一次。'
    : '当前版本只调用 send 一次，不重试。HTTP 429 单次重试尚未实现，等待下一轮批准；429 验收预期失败。'}

| 响应序列 | 调用次数 | 返回值 |
|---|---|---|
| 200 | 1 | ok |
| 429 → 200 | ${retry ? 2 : 1} | ${retry ? 'ok after retry' : 'rate limited'} |
| 429 → 429 | ${retry ? 2 : 1} | still limited |
| 503 | 1 | unavailable |

\`\`\`js
import { fetchExample } from './client.mjs';

const send = async () => ({ status: 200, body: 'ok' });
console.log(await fetchExample(send)); // ok
\`\`\`

验收命令：

\`\`\`sh
node verify.mjs
\`\`\`

验收输出为 JSON；逐项检查 passed，不能仅根据进程退出码判断通过。以上请求使用注入的 send 测试，不访问真实网络。
`;
}

export const guideVerification = `
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
  const expected = retries ? ${JSON.stringify(usageGuide(true))} : ${JSON.stringify(usageGuide(false))};
  assert.equal(body.replaceAll('\\r\\n', '\\n').trim(), expected.trim(),
    'USAGE.md 与实测行为不一致，或未使用本示例的完整说明模板');
  return 'USAGE.md 完整说明与 200、429 恢复、连续 429、503 的实测调用次数和返回值一致';
`;

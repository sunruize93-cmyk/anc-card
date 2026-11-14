# 调用说明

`fetchExample(send)` 接收异步函数 `send`，其返回值为 `{ status, body }`。
返回最后一次响应的 `body`。

首次响应为 HTTP 429 时仅重试一次，总请求次数最多为两次。连续两次 429 返回第二次响应的 body。其他状态（包括 200 和 503）只请求一次。

| 响应序列 | 调用次数 | 返回值 |
|---|---|---|
| 200 | 1 | ok |
| 429 → 200 | 2 | ok after retry |
| 429 → 429 | 2 | still limited |
| 503 | 1 | unavailable |

```js
import { fetchExample } from './client.mjs';

const send = async () => ({ status: 200, body: 'ok' });
console.log(await fetchExample(send)); // ok
```

验收命令：

```sh
node verify.mjs
```

验收输出为 JSON；逐项检查 passed，不能仅根据进程退出码判断通过。以上请求使用注入的 send 测试，不访问真实网络。

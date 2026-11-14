# 受限远程 Codex 邮箱实验

这是独立实验，不由 ANC 主服务加载，不监听 4785/4787，不打开正式任务数据库。

链路：预先授权的合成邮件 → Grok 邮件 routine → 云端 Python 去重入口 → 官方 Codex CLI → 合成结果 HTTPS 回执 → 本机独立验收 → 更新专用飞书原卡。

## 文件

- `runner.py`：固定一个合成任务与提示词。持有跨进程排他锁，执行前 fsync 保留记录；任何重复投递只返回已存状态，不再启动 Codex。超时或崩溃需要人工核对，不能自动清状态重跑。
- `test_runner.py`：假 CLI 的离线测试，覆盖并发重复、重复重试、绑定不符、过期与启动失败；不代表远程真实执行通过。
- `bridge.mjs`：独立实验卡及结果接收器。检查任务绑定、产物哈希、Codex 完成事件，并在禁止网络/写入/子进程的本机检查环境验证五个函数用例和基础说明。两次投递须对应同一个 runId、Codex 会话及产物摘要。

## 运行约束

1. 远程需用户本人授权的 Codex 登录，不能复制本机凭证。当前脚本依赖 Linux `fcntl`，本机桥接验收依赖 macOS `sandbox-exec` 和支持 permission 参数的 Node。
2. Codex 工具使用 workspace-write、禁止网络与升级权限，限定 240 秒。只允许 `totals.mjs`、`README.md` 两个最终产物；文件清单是执行后的验收，写入边界由沙箱控制。
3. 首次上机先独立验证目标目录写入、相邻目录禁止写入、DNS 和 IP 直连被禁止。不能为过测试放宽沙箱。
4. 邮件只作为已授权任务的触发数据；发件认证、专用别名、固定任务和 nonce 必须匹配。邮件正文不能扩张执行范围。
5. 本实验的临时 Webhook.site 接收器只收合成代码和非敏感运行元数据。不得放入真实录音、用户数据、密钥或完整 stderr。它不是生产鉴权接口。
6. 私有配置、邮件回执、远端回执和产物存放在被忽略的 `.anc-data/field-20261114/grok-codex-trial/`。不提交该目录。

离线检查：

```sh
python3 -m unittest discover -s prototype/experiments/remote-codex -p 'test_*.py'
```

桥接命令在仓库根目录运行，配置预先放入私有目录：

```sh
node prototype/experiments/remote-codex/bridge.mjs .anc-data/field-20261114/grok-codex-trial init
node prototype/experiments/remote-codex/bridge.mjs .anc-data/field-20261114/grok-codex-trial poll
```

`init` 持久保存同一张卡的 messageId，重复调用不新建卡。`poll` 最多运行 12 分钟；可恢复读取结果，但不得通过恢复轮询再次启动远程 Codex。

这是一次合成任务的可行性验收，尚未连接正式台账、负责人按钮授权、可靠生产回调或长期运行保障。Grok 是任务执行节点，本实验不证明其可以替代公网云服务器。

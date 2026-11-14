# Personal Agent 执行器线验收 · 2026-11-14

> Historical checkpoint: see [2026-11-14 final review](release-review-2026-11-14.md) for current verified scope and publication status.


## 交付状态

本机通用 Codex 执行链路已实现并做了两轮真实 CLI 验收。它不再依赖固定 `http-example-two-rounds`；该演示继续兼容。**尚未切换主服务、尚未做新版真实飞书点击验收。** 主 `127.0.0.1:4785` 与手机网关 `4787` 未重启。没有改动 iOS、上传契约，也没有给 Zoty 派任务。

独立界面：`http://127.0.0.1:4789/agent`。该实例使用 `.anc-data/field-20261114/personal-agent-isolated`，没有复制飞书凭据、没有开第二条长连接。界面中的任务为合成样例，保存方案后处于待确认，未冒充真实负责人的确认。

## 追加准备交付（用户要求继续手机联调，实际未切换）

当前授权仅为准备：不重启 4785/4787，不停止手机上传或任务进程，不再开同 bot 长连接，不投递/改写真群卡，不要求现在点击确认。空队列不代表获准切换。

已只读核查运行进程和允许的非敏感启动字段，通过 GET 接口取得主服务快照；没有读取、复制或绕过主 SQLite 的独占锁。私有交付位于 `.anc-data/field-20261114/executor-preparation/`：

- `main-precheck.json`：本轮 GET-only 快照。任务 running/queued=0、录音均 complete，但正在上传的请求和未来新工作仍 unknown，不据此宣布可以重启。
- `CUTOVER-RUNBOOK.md`：原 Node/工作目录/数据目录/standard ASR、后续获准窗口的复核、优雅退出、数据库关闭后原生 backup、单实例重启、回退分界。当前完整旧运行代码没有冻结 release；切换前需确认可运行回退副本和实际进程管理方式。
- `LIVE-ACCEPTANCE-DRAFT.md` 与 `live-contracts.json`：Eric.s 新录音、明确固定表达、两个文件的两轮 Codex 方案、实际业务断言、完整字段采集办法。全部为未提交草案，没有 taskId/proposalId 等预造绑定。当前飞书账户绑定与 Eric.s 的身份仍需实际确认。

已交付独立验收证据：`.anc-data/independent-verification-20261114/executor/`，含 README、manifest、脱敏 snapshot 及重新核对哈希的第二轮实际产物。来源严格限定既有 `personal-agent-live-1794634685248/evidence.json` 和其命名产物；没有接触或拼接任何 iPhone 录音。真实 CLI + 合成 local 授权层次分开，历史事件序列、authorizationId、approvedVersion、proposalId、runId、原卡回执等缺项保持 unknown；第一轮只存哈希、原字节未留档。`events: []` 不能被解读成全链路通过。

新增 `prototype/scripts/export-executor-evidence.mjs` 为只读 stdout 导出器，不访问服务/SQLite、不执行模型、不写源文件；`prototype/executor-export.test.mjs` 在隔离合成样本验证来源、unknown、文件变化及路径外逸拒绝（1 项通过）。本准备阶段没有重跑真实 CLI 或整套真群验收。

已复核 `verification-independent/REPORT.md` 与当前源码：普通 extract 仍是逐段“由…负责”正则，CoffeeDrill 仍为固定草稿回放。今日仅可验单段单任务的明确表达；一般承诺/提议/否定、重复提及、跨段归并、改派/撤回/暂停恢复、期限锚点等通用语义列为后续独立工作。本轮没有改提取器或在线协议，也没有改独立验收目录。

目前准备文件齐备，实际切换仍缺用户的新许可与手机空档、旧运行代码回退包/管理方式、身份核对。若要求独立完整事件链 pass，还需先单独评审最小审计事件补充；当前快照不能补造批准唯一键或 SDK 回执。

## 工作契约

1. 录音转写继续进入既有任务台账。普通群消息、邮件正文不构成授权。
2. 本机 `/agent` 或 `POST /api/tasks/:id` 的 `kind: plan` 保存明确方案，包含 `executor: codex`、`instruction`、`acceptance`、`files`。当前支持隔离目录内的 1–20 个顶层文件，不接受任意仓库路径、目录、隐藏文件或 `AGENTS.md`。
3. 负责人确认绑定 taskId、version、proposalId、契约 SHA-256、ownerOpenId；飞书还校验原 messageId 和 chatId。确认后入持久化队列，每 300ms 自动认领；无需再手动打开 Codex。
4. 每次认领生成 runId。工作目录为 `tasks/<taskId>/<workspaceId>`。执行器直接调用 `codex exec --json`，续跑指定准确 sessionId，提示词通过 stdin。使用 workspace-write、关闭网络搜索、禁交互批准、不读取用户 config；不启用绕过沙箱。
5. 回传后独立检查文件清单、大小与哈希。CLI 的成功只进入 `review`，不是业务验收通过；负责人查看产物后才能确认 `complete`。`GET /api/tasks/:id/artifacts/:name` 只返回最近已记录、哈希仍匹配的产物，纯文本展示，拒绝链接与路径穿越。
6. 修改范围撤销旧授权；改派负责人创建新 workspaceId 并清除 sessionId。运行中不直接改范围：先撤回，停止后再准备。撤回会终止当前 CLI 进程组，runId 状态校验拒收迟到结果。已经发生的本机改动不会宣称自动撤销。
7. 缺失 CLI、超时与执行失败保留原授权和已取得的 sessionId；负责人确认恢复后继续。重启不会自动重复执行中断任务；旧进程仍存活时拒绝恢复。队列和待确认方案跨重启保留。
8. 飞书同步沿用原卡 `message.patch`，回写失败只重试回写，不重跑任务。原 HTTP 样例和 coffee-drill 的既存行为仍保留。

本机任务使用 `local` 身份做测试；飞书任务不能借本机端点假冒 `ou_...` 用户确认。任意邮箱、Grok Bot、Dot 只保留为未来入口，当前没有邮件采集、发送或云部署。

## 验收证据与边界

- `prototype/personal-agent.test.mjs`：负责人/渠道/版本/契约校验，重复确认，改派与撤回，恢复需原 proposal，重启保留会话，运行中撤回与迟到结果拒收，多连接 claim，飞书原 messageId 的 patch 重试，产物范围/变更/链接检查。
- `prototype/codex-executor.test.mjs`：使用 spawn 建立独立进程组；不响应 SIGTERM 的进程在 2 秒后强制终止，确认退出后才释放任务。CLI 使用 stdin 和准确 sessionId，提前持久化会话，缺失可执行文件错误，stderr 不泄露到异常。
- 原有录音、手机网关、飞书收件与 HTTP 演示测试继续跑。执行 `npm run verify`，离线验证与 34 项测试全部通过；结果日志位于本机 `.anc-data/field-20261114/personal-agent-tests.log`。
- 真实 CLI 脚本：`ANC_LIVE_EXECUTOR_TEST=1 node prototype/scripts/verify-personal-agent-live.mjs`。显式开关防止普通测试消耗模型调用。
- 本轮实测：`.anc-data/field-20261114/personal-agent-live-1794634685248/evidence.json`。任务 `1` 个、真实 Codex `2` 轮，sessionId `01a1d890-1d09-7b03-8948-380ac5f1b35b`。生成 `totals.mjs` 和 `README.md`，再在同会话补充 null/undefined 输入；两轮均在禁网络、Node permission 模式下独立验证断言。状态保留 `review`，未替真实负责人验收。
- 本机界面已实际保存合成任务草案，版本 1 → 2，未点击真实飞书确认。
- 飞书新版卡片 callback/原卡回写当前为官方 SDK 形状及网络夹具验收；不是新版真实群端到端证据。
- 文件清单是执行前契约和执行后检查，OS 写权限边界是整个隔离目录，不是逐文件的内核强制白名单。沙箱并不等于完整敏感文件读取隔离。当前仅限可信本机、有限文件任务；不宣称能够安全执行任意陌生群消息或任意仓库工程。
- 外部副作用的 exactly-once 不作保证；本阶段契约禁止网络/外发/发布，并对重复授权和迟到结果做持久化去重。

## CLI 核实

2026-11-14 本机：Codex `0.167.0-alpha.4.1`，位于 ChatGPT.app bundled CLI。检查了 `exec --help` 与 `exec resume --help`，真实首轮与恢复均可用。官方文档：[非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[CLI 参数](https://learn.chatgpt.com/docs/developer-commands?surface=cli)。

Claude Code `2.1.325`，`auth status` 显示登录且来源为 API key，但两次无工具最小探针返回 `is_error=true`、退出码 1、费用估计 0。没有可证明可用的执行证据，因此通用契约暂时拒绝 `executor: claude`。探针仅记录无凭据元数据于 `.anc-data/field-20261114/claude-probe/`，不猜测具体账户故障。已核对官方 [非交互调用](https://code.claude.com/docs/en/headless) 与 [CLI 参数](https://code.claude.com/docs/en/cli-reference)，未使用跳过权限模式。

## 主服务切换与下一轮真实验收

1. 与 iPhone 线确认上传/转写空档，重新读取 `/api/tasks` 与录音队列，确认没有运行中的工作。此前只读检查主任务队列为 0 running / 0 queued；此结论不替代切换前再查。
2. 使用原主数据目录与原启动环境重启一次；不要复制飞书凭据另开同 bot 长连接。服务已持有 SQLite 独占锁；不要绕过锁直接写运行中的数据库。
3. 在主 `/agent` 对 Eric.s 的录音任务准备明确、可查看的文件任务，再由用户在飞书原卡点击确认。记录 taskId、授权 version、sessionId、messageId、产物哈希及回写结果。
4. 用户查看产物并验收；另准备同任务续轮，由用户再次确认。验收同 taskId、同 sessionId、同 workspaceId、同 messageId。需要更换负责人时重新授权且换工作目录。
5. 只有上述真实操作完成后，才将新版飞书端到端验收标为通过。当前没有代点确认，也没有发送新的群任务。

## 变更归属

本轮新增：`execution-contract.mjs`、`codex-executor.mjs` 及其测试、`personal-worker.mjs`、`personal-agent.test.mjs`、`personal-agent.html`、`scripts/verify-personal-agent-live.mjs`，以及本文。

增量修改：`tasks.mjs`、`task-runner.mjs`、`worker.mjs`、`feishu.mjs`、`server.mjs`（只加任务页面/计划/产物路由）、`tasks.test.mjs`（模拟进程退出的恢复测试）、`package.json`（加入测试）。本轮增量补丁留存在 `.anc-data/field-20261114/executor-owned.patch`。修改前文件留存在 `.anc-data/field-20261114/executor-baseline/`，便于与既存未提交变更分离。

没有运行 Git 提交/暂存/推送；共享工作树的既存变更保留。禁止直接按整文件把既有其他人的改动夹带发布，尤其不得发布 Zoty iOS 源码。

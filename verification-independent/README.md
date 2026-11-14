# ANC Card 独立离线验收

最新工作为 90 分钟 MVP 的真实证据适配，入口见 `REAL-EVIDENCE-NOTES.md`。当前增加的 `check_mvp.py` 保持旧真群 Mac TTS 链与新手机录音目标分离；详细就绪清单在私有证据目录的 `MVP-READY.md`。

交付日期：2026-11-14（韩国时间）。本目录所有随附素材、音频摘要、人物标识、任务/会话/卡片 ID 与事件均为合成数据。没有实际音频，未调用提取器或 ASR。用户随后授权接入真实导出：真实输入副本、manifest 和详细报告只保存在 `.anc-data/independent-verification-20261114/`，与本目录合成回归分开，见 `REAL-EVIDENCE-NOTES.md`。

最短运行命令（仓库根目录执行）：

```sh
python3 -B verification-independent/run_tests.py
```

运行全部独立测试及 14 份故障/正例 fixtures，机器报告写入 `reports/test-summary.json`，逐项测试记录在 `reports/test-output.txt`。不依赖第三方包；本次以 Python 3.9.6 验证。测试只导入本目录的纯数据模块，不导入 prototype/relay，不使用 SQLite、网络、钥匙串或执行器。

检查一个明确传入的文件：

```sh
python3 -B verification-independent/check_evidence.py verification-independent/fixtures/positive.json
python3 -B verification-independent/check_evidence.py verification-independent/fixtures/positive.jsonl --format text
```

检查器只读指定 JSON/JSONL，不自动发现文件，不扫描日志或目录，不访问服务；报告打印到 stdout。退出码：0 = 所提供分组内部一致性 pass，1 = 发现矛盾 fail，2 = 缺失/无效/不支持的证据 unknown（待验收）。所有结论均限于导出内容，不能证明没有未导出的重复执行等事件。`pass` 不是功能端到端验收，也不是生产就绪。

`groups.simulated`、`groups.real`、`groups.unspecified` 分开检查。合成数据不能补齐实测缺口。`real` 只是导出方声明，工具不能认证来源；`provenanceVerified` 永远为 false。当前正例的 simulated=pass、real=unknown。空文件、仅快照、缺字段、来源未标明均不能通过。

## 文件

- `coffee-chat-golden.json`：14 例完整片段、连续 startMs/endMs、候选语义版本、负责人、期限和原文证据。
- `COFFEE-CHAT.md`：便于人工审阅的对应场景。
- `READ-ALOUD.md`：可实际朗读录制的约 60–90 秒合成脚本。
- `check_evidence.py`：只读证据检查器。
- `export_adapters.py`：不产生副作用的兼容适配边界。
- `fixtures/`：正例、错误证据和缺证据样本。
- `test_verification.py`：独立单元及 CLI 测试，包含逐字段删除测试。
- `run_tests.py`：生成测试记录及每份 fixture 的 JSON、TXT 报告。
- `REPORT.md`：发现、限制及真实汇合验收清单。

Golden 中的 `semanticRevision` 是脚本期望的语义变更序号，**不等于数据库 tasks.version**。`finalTaskCount` 指应保留的台账记录数，包括撤回或未接受提议，不代表可执行任务数。所有 `executionAllowedFromTranscript=false`。同一任务的重复提及仍用同一 taskKey，重复证据可以追加，不能造成重复执行。此处测试验证 golden 的结构和可追溯性，未验证当前提取器能产出这些语义结果。

## 导出事件协议 v1

输入可为 `{"events":[...]}`、事件数组，或每行一个事件的 JSONL。每事件必须带 `eventId`、`seq`（有证据支撑的因果顺序、非负整数、同分组递增）与 `provenance`（simulated/real）。不要把多源日志简单按文件顺序编号冒充因果顺序；顺序不明则缺省 seq，结果应为 unknown。相同 eventId 的完全相同重放会去重；同 ID 不同内容判冲突。

| kind | 必要字段及语义 |
|---|---|
| audio | recordingId、sha256、bytes、durationMs。原音清单，不读取音频；只核对声明是否一致，不重新计算实音哈希。|
| upload | recordingId、localId、sha256、bytes、duplicate（布尔值）。当前后台 recordingId 等于 SHA-256。localId 应由导出方稳定匿名化，不携带设备唯一标识。|
| transcript | recordingId、segments。每段 segmentId、startMs、endMs、text。验证非负、非重叠、有序且不超时长；真实片段允许静音间隙。|
| task | taskId、recordingId、semanticKey、version、owner、proposalId、contractDigest、evidence。用于初始提案或改变负责人/范围的新版提案。每条 evidence 是 segmentId/startMs/endMs/quote，引用完整源段。|
| card | recordingId、messageId、cardKind（recording/task）、operation（create/update/replay）；任务卡还需 taskId。结果 update 还需 runId，必须对应先前 accepted 结果。|
| authorization | taskId、authorizationId、owner、version、proposalId、contractDigest、channel、messageId、decision。decision=execute 才授予执行；acknowledge/reject 不授予执行。要求 feishu 作为本主线确认渠道。|
| execution_start | taskId、runId、authorizationId、approvedVersion、proposalId、contractDigest、sessionId、mode（start/resume）。每个批准版本/提案最多一次执行；新恢复批准使用新的 authorizationId 与当时版本。|
| execution_result | taskId、runId、authorizationId、approvedVersion、contractDigest、sessionId、disposition（accepted/rejected_stale/interrupted）。晚到撤回/改版结果只能拒绝应用。|
| task_state | taskId、version、state（paused/resumed/withdrawn）。推进版本并使旧授权失效；恢复后须有新明确授权。|

`owner` 是稳定匿名的负责人身份键，不是显示名。将 task.ownerOpenId 与 confirmation.actor 用同一映射转换；Eric.s/Zoty 仅用于语义测试显示。仅凭录音中的名字无法证明飞书身份。`semanticKey` 由人工/可信任务归并过程提供，检查器不会用文本相似度推断重复任务；错误的 key 可能漏检，故仍需人工核对 14 例。

`authorization.version` 是确认前的任务版本；`approvedVersion` 必须指向该确认版本。后台 claim/session/result 的机械保存会增加当前数据库版本，**不能**据此把原批准自动判过期；不要把这些机械快照都导出成 `task`。改变语义范围/负责人时才发新版 `task`；暂停、撤回、恢复按 `task_state`。恢复时可仍用相同 proposalId/contractDigest，但必须记录新的批准版本和授权事件。

当前 schema 对同一负责人续跑要求同 sessionId。负责人更换会标 `OWNER_CHANGE_SESSION_POLICY_REVIEW=unknown`；当前服务的改派可能重置工作区/会话，需要额外隔离策略证据，不能仅凭新 ID 判实机通过。不要为取得 pass 删除真实改派事件。

这里的 card update 专指“应用执行结果”；普通进度卡 patch 不映射为此事件。录音结果卡和任务执行卡分开绑定，录音卡出现不能证明任务执行或任务卡回写完成。工具不核验消息实际内容、权限/群成员映射、业务产物正确性、服务端签名、时间戳真实性或实际进程是否停止。

## 与现有结构兼容

本轮只读核对 `prototype/mobile-gateway.mjs`、`recordings.mjs`、`tasks.mjs`、`recording-delivery.mjs`、`codex-executor.mjs` 和 `relay/ios-upload/UploadContract.swift`；未导入它们。

- 上传回执可包装为 `kind=mobile_upload_receipt`、`payload={localId,recordingId,sha256,bytes,duplicate}`，外层提供 eventId/seq/provenance；适配器仅挑出这五个字段。
- 转写可包装为 `kind=recording_transcript_export`、`payload={id,transcript:[...]}`，外层提供 eventId/seq/provenance。每段必须由导出流程提供稳定 segmentId；工具不会猜时间点或补 segmentId。
- 现有 `source.recordingId/startMs/endMs/evidence` 可映射为 task 的 evidence；引用完整片段。`taskId` 原样一致匿名化，`card.messageId` 映射为 messageId，`confirmations[].actor/version/proposalId/scope.contractDigest` 对应授权字段。
- 现有 `runId` 与 `sessionId` 对应执行事件。authorizationId 需要导出方给每次明确批准一个稳定审计键，现有 confirmation 本身未必包含该字段。
- `coffee-drill` 的 approve 是 acknowledged，必须映射为 acknowledge；不能照抄 action=approve 当 execute。
- `scope.contractDigest` 缺失（例如旧固定 HTTP 示例授权）不可自行生成假摘要补通过；先保持 unknown。适配器可以扩展，但必须只处理已经明确导出的数据，不能访问服务或构造历史。
- 只有最终 task 快照不能复原授权时的版本、启动顺序和撤回时序。工具对此保持 unknown，不要求前两条任务修改在线协议。

## 真实证据保存边界

第一阶段没有读取真实运行证据；第二阶段已按明确授权接入保存好的 JSON 导出，敏感证据仅放 `.anc-data/independent-verification-20261114/`。不复制正在写入的 SQLite 或扫描原始日志。独立目录及其 fixtures/reports 只允许合成材料与无敏感内容总结。

导出前在已有授权流程中移除 token、Authorization 头、API key、设备唯一标识、原音/音频 base64、邮箱/群身份等。采用整包一致的人工别名映射，保留音频 sha256/bytes 用于关联（这些摘要仍可能具有关联敏感性，所以留在 .anc-data）。真实转写只保留经允许的最小原文片段。不要把私密文本放进 eventId 或 semanticKey。检查器不输出字段值/原文/标识，只给事件序号、固定诊断码和字段名；它会拒绝已知敏感字段，但不是完整 DLP，不能替代导出前脱敏。

用明确的 JSON/JSONL 路径检查后，如需保存报告，请在同一个敏感证据目录内重定向 stdout。不要把 real 报告写入本目录。不需要登录、安装新依赖或调用任何真实凭证。

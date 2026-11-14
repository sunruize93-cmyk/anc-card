# 结构化文档与真连接现场验收

日期：2026-11-14，韩国时间。用户在本对话明确回复“可以，现在切换并验收”后执行。本轮没有删除音频、变更凭证或推送 Git。

## 切换与复核

1. 切换前主任务无 running/queued、录音无 processing；关闭网关与主服务均使用 SIGTERM 并等待正常退出。
2. 在 SQLite 写入者退出后用原生 backup 保存两份数据库，quick_check 均为 ok，同时保留任务产物。未复制活跃独占数据库、未绕锁、未恢复旧数据库覆盖新事件。
3. 私有 candidate 是当时工作树代码快照；fallback 是该快照覆盖执行器线保存的旧模块、禁用新文档链路的兼容候选，已通过离线队列验收。fallback 不宣称是原运行进程 13:02 的完整内存代码，也不能在新任务执行后无条件回退。
4. 现运行 candidate：主 4785 与网关 4787。代码快照、manifest、启动 PID 和日志在 `.anc-data/field-20261114/document-cutover/`。编辑工作树不会热更新此快照，后续改动需安排部署。
5. 原 14 条录音 ID、6 条任务状态、飞书 app/chat/owner 绑定均保留。`/agent` 已 HTTP 200，飞书 connected，手机 HTTPS 使用原 CA 验证成功。

## 测试

- 新文档、短尾段与原网关/结果投递：11/11。
- worker、Codex 执行器、Personal Agent、台账、飞书、clinic 及证据导出回归：33/33。
- 主 `verify.mjs` 和 fallback 的 `verify.mjs` 均通过离线分段、重复上传、失败重试、SIGKILL 恢复、台账及回执检查；它们不代表真实云调用。
- 自制文本曾通过真实 Codex 结构化生成；本节后续另有真实录音的模型与飞书结果。

## 72.72 秒原录音恢复与文档

录音 ID `777869268d601bf106478cc96af75ab9ffd088168c238a3618a03aa900713d88`，2,327,084 字节。

此前尾段 71.56–72.72 秒仅 1.16 秒，helper 返回 invalid_transcript；该错误同时涵盖空白、NUL 和过长响应，不能断言尾段静音。两次旧流程重试均失败。隔离验证把最后两段完整 PCM 合并到 48.52–72.72 秒后真实识别成功，未丢弃样本。修复合并的前提是短尾、时间连续、合并后不超过 30 秒。

加载修复后通过原 retry 接口恢复同 ID，attempt=4，状态 complete。最终三段连续覆盖 0–18.52、18.52–48.52、48.52–72.72 秒；前两段缓存沿用，末段重新识别。未重新导入、未改主数据库凑成功。

文档 revision=1，manifest SHA-256 `4846aaf921167c2261dd74aff9860dfbe07f2b931886c70036156438137ac1ff`，包含 JSON、Markdown、逐段原话和时间引用。人工对照看到：这是设备操作/应用连接/功能介绍，没有明确承诺，因此不生成待办；开机描述和应用名等歧义保留为未决问题。

原飞书消息 `om_x100b604bdbe180b0b09316076cba0df` 保持不变，patch API 成功，群网页实际显示“结构化文档 v1”及内容。消息 GET SDK 缺权限（99991672），未扩权；通过已登录群页面核对实际呈现。

通过带设备鉴权的 HTTPS 网关读回三份实际产物，字节数和 SHA-256 均匹配；iPhone 线的 `long-lock/document-end-to-end-verification.json` 另证实手机持久化 documentVerification。当前保留设置仅预览，不删除手机、卡或后台原音。这次文档成功发生在打开 App 补回之后，不算长录音锁屏通过。

## 飞书 → Personal Agent → Codex 两轮真实执行

为避免打断手机，使用 Mac say 自制 21.292 秒语音，真实走 SpeakMode＋百炼；这是合成语音来源，不是真实录音卡采音。

- recordingId：`d3ea3c58c90b9832bcd379eb321e79458a24124debbcbbff7a883e9f129316ce`。
- taskId：`3f19278b-437d-4d3c-8b46-266560b96011`，负责人 Eric.s，飞书账户显示名仍为“用户238730”，以真实回调 open_id 核对，不用显示名推断权限。
- Codex session：`01a1d8b6-e9e9-7392-b366-17ea72f9573a`；workspace：`cac1e1f8-2861-4109-96ae-70e01ccd1a9f`。
- 原执行卡：`om_x100b604b98a400accfd01f50012a422`；与录音转写卡分开记录。
- 两轮均由用户在飞书点击确认；第一轮完成数量合计函数和说明，独立断言 3/3。第二轮同任务/会话/目录补 null/undefined，独立断言 5/5，说明同步。
- 每轮产物通过实际读取核对大小/哈希，首轮副本已保留。独立运行使用 Node permission 和 macOS sandbox 禁网络/写入，不把 Codex 自述当作独立结果。
- 用户最后点击“已查看产物，确认验收”，主任务 complete，原卡 syncedVersion=16/error=null，群页面实际显示“全部验收通过”，保留两轮结果。

私有证据：`executor-first-result.json`、`executor-second-result.json`、`executor-final.json`、`executor-live-verification.json`、`executor-round1/`、`executor-round2/`。归一化事件审计仍待独立验收线消费这些真实证据；未编造 authorizationId 或历史事件顺序。

## 清理预检接口边界

现有 GET `/v1/recordings/:id` 可以删除前刷新当前文档版本、manifest、delivery 和产物；document JSON 可读取 uncertainties。但这些是状态快照，没有读者租约、修订冻结、清理批准或幂等删除事务。`retention.eligible=false` 必须继续视为禁止删除。

待设计的预检至少绑定 recordingId/音频哈希/文档 revision/manifest/原卡成功回执，并核对仍在处理或回听的任务、新修订、需回听的歧义、最近五条与历史保护边界。仅手机缓存与卡原音为后续当前请求范围；后台原音删除未执行。不要用一条较早的 ready 回执直接删除。

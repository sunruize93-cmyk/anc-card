# 已授权真实导出适配补充

**90 分钟 MVP 更新（16:02–17:32 KST）：** 新提供的 document-cutover 证据已包含真实负责人飞书确认及最终 complete；下文“本机合成授权”仅描述上一轮旧任务，不再代表当前最新执行器证据。当前只增加 `check_mvp.py` 的窄适配和 10 项合成回归，总计 89 项通过。新手机目标录音尚待产生，未与旧 Mac TTS 链拼接。当前事实、manifest 和缺口以私有目录中的 `MVP-READY.md` / `MVP-READY.json` 为准。

2026-11-14（韩国时间），用户授权接入已保存的手机与本机执行器导出。本目录仍只存工具、合成测试和无敏感内容的说明。真实副本、输入哈希/路径/采集时间 manifest、逐项报告放在 `.anc-data/independent-verification-20261114/`，不加入公共提交。

新增 `collect_stable.py`：只处理显式传入的 JSON/JSONL，检查单文件两次读取的内容与 stat 是否稳定，再创建只读用途的独立副本。未完成 JSON/JSONL 尾部不复制，列 unknown；不阻塞源文件写入，不打开运行数据库。它不扫描目录。输入文件名为 bootstrap/config/keychain 等时拒绝采集。

新增 `check_snapshots.py`：消费 hash 固定的 bundle，验证手机快照、上传回执、网关导出、后端转写、录音结果卡之间的已保存关系；单独验证本机执行器两轮会话/工作区、交接包来源、内嵌产物哈希。每条结论区分 pass（局部关系匹配）、fail（导出内容矛盾）、unknown（证据不足）。整体返回 partial_evidence 和退出码 2，不能将快照关系通过当成端到端通过。

来源分成三个维度：`systemObservation`（真实系统导出或模拟）、`workload`（真实录音中的测试口令、合成业务任务等）、`authorization`（真实负责人授权、合成本机授权、无执行授权）。手机数据不同来源组不能互补；执行器与手机链始终分开。工具不伪造 eventId、seq、semanticKey、授权摘要或历史确认。

兼容细节：iOS 可选 `uploadLocalID` 缺失时，当前上传器使用已持久化的 `record.id`；适配器沿用这个已有字段，不生成标识。候选台账为空、网关导出截点早于录音、无执行授权的纯同步口令均不自动判产品失败。任务授权版本与后续机械保存版本、录音结果卡与执行任务卡继续分别处理。

当前公开结论：已核对保存的真实导出，未发现已检查关联中的矛盾，存在明确证据缺口。手机已有新录音链路证据，不再沿用第一阶段“没有新录音证据”的旧结论。本机执行器导出属于真实系统执行、合成业务任务及本机测试授权，不能代替真实飞书确认。详细数量、时刻、标识关联和缺字段清单仅写入私有报告。

离线复跑（仓库根目录）：

```sh
python3 -B verification-independent/check_snapshots.py .anc-data/independent-verification-20261114/bundle-with-executor.json --format text
python3 -B verification-independent/run_tests.py
```

首条命令只读 13 份已经固定哈希的输入副本，当前退出码 2 表示尚未具备完整端到端事件证据。不要为得到 0 补造事件或遗漏真实缺口。第二条只运行本目录合成回归；79 项通过（原 51 项加 28 项稳定采集/快照/交接适配测试），不接触真实输入。`reports/test-summary.json` 中 realEvidenceCollected=false 指这次合成测试运行，不表示本任务从未核对真实导出。

本轮没有读手机 events.log：它不是已提供的 JSON/JSONL 导出，也没有扩展到扫描原始日志。没有访问手机、蓝牙、GUI、钥匙串、4785/4787 服务、运行 SQLite、ASR 或执行器；没有发送飞书消息、修改卡片或重启后台。

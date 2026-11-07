# ANC Card

ANC Card 是五人团队的录音与任务台账原型。导入音频后，原文件先与排队记录一起写入 SQLite。后台调用 SpeakMode 的文件转写工具，把识别到的明确分工写入带出处的任务台账。点击时间范围可回听原录音，行动项初始状态为「待核对」。

## 本机运行

需要 macOS、Node.js 22.13+、Rust stable、Git 和 Xcode Command Line Tools。在项目根目录执行以下命令，安装固定版本的 SpeakMode 文件转写工具，然后启动原型。

```bash
sh prototype/scripts/setup-speakmode.sh
node prototype/server.mjs
```

打开[本机原型](http://127.0.0.1:4785/)，展开「配置 SpeakMode 的阿里云转写」，选择 API Key 所属的北京或新加坡地域，填写百炼 Key 并保存到登录钥匙串。也可在终端配置，输入时会隐藏 Key。

```bash
sh prototype/scripts/configure-speakmode.sh
```

配置助手使用 SpeakMode 自己的配置和凭据接口。其配置数据库默认位于 `~/.local/share/anc-card/speakmode/config.sqlite`，密钥保存在 SpeakMode 的登录钥匙串条目中。保存配置后，导入一份 WAV、M4A 或 MP3 开始处理。音频分段会发送到所选地域的阿里云。

需要创建 Key 时，可参考[百炼 API Key 配置说明](https://help.aliyun.com/zh/model-studio/get-api-key)。

## SpeakMode 接入方式

安装脚本拉取 SpeakMode 的固定提交 `6ba4432d91727d300ba6f3e4b1a9e29d37064a64`，编译其原有 `file_asr_lab`。ANC Card 在运行时直接调用该可执行文件，读取其 JSONL 回执，校验音频 SHA-256、样本数、完整状态、模型和处理批次，再写入台账。配置助手调用 SpeakMode 的 Store 和 credentials 接口。

该工具固定使用阿里云 `qwen3-asr-flash`，输出整段文字。ANC Card 先转换为 16 kHz 单声道 PCM16 WAV，按停顿切成最长 30 秒的音频段，保留每段在原文件里的样本偏移。识别结果绑定到该段的起止位置，页面显示「分段回听」。

这个时间范围覆盖整段音频。持续讲话达到 30 秒会强制切段，边界可能落在句中。识别和行动项提取均需回听核对。对于后续长会议扩展，可评估支持原生时间戳的文件转写模型，具体能力见[阿里云语音识别文档](https://help.aliyun.com/zh/model-studio/asr-model)。

每个成功分段都会独立保存。失败重试和重启会复用已保存的分段结果。进程中断时，尚未落盘的远端请求可能已经被供应商处理，再次提交可能产生重复调用费用。

## 自制音频与验收

生成约 29 秒的普通话样本，再从页面导入。

```bash
sh prototype/scripts/make-sample.sh /tmp/anc-card-sample.wav
```

离线验证会实际生成音频、进行转换和分段，再使用明确标注的 SpeakMode CLI 协议夹具验证持久化链路。

```bash
node prototype/verify.mjs
```

已验证并发重复导入只入队一次、分段转写失败后重试、已完成分段复用、SIGKILL 后自动恢复、台账与分段证据绑定、原音频逐字节返回和区间读取，以及完成台账在重启后保持条目 ID。损坏回执和音频哈希不符会被拒绝。SpeakMode 上游 `file_asr_lab` 的 7 项测试也已通过。

真实云端验收在配置 Key 后运行以下命令。它会将自制音频通过 SpeakMode 发给阿里云，核对两条行动项及其证据位置。结果会保留在当前台账中。

```bash
node prototype/verify-live.mjs
```

### 2026-11-07 真实转写验收

约 29.307 秒的自制普通话录音通过 SpeakMode 原生 `file_asr_lab` 调用阿里云 `qwen3-asr-flash`，5 个分段均成功返回完整回执，录音队列第 1 次处理即完成。台账写入以下两条待核对行动项，识别原文中的负责人、事项和截止时间与样本一致。

| 负责人 | 行动项 | 截止时间 | 原录音分段回听范围 |
| --- | --- | --- | --- |
| 小王 | 整理会议纪要 | 本周五 | 00:08.560–00:14.860 |
| 小李 | 更新测试文档 | 下周一 | 00:18.720–00:25.180 |

本次验收核对了每条行动项对应的转写来源 ID、证据原文和时间范围。原录音逐字节返回与上传文件一致，区间读取返回 HTTP 206，重复导入返回原记录。浏览器实测第二条回听按钮后，播放器从 18.72 秒处开始播放，音频时长为 29.30675 秒。随后重启本机服务，完成记录的全部字段、任务 ID 和转写证据均保持一致。

验收录音 SHA-256 为 `c719b23efa422b88c8601b0648aa0ac17725f35813240aae1254802f4c780bac`。上述时间范围来自音频分段。此次真实云端验收覆盖该短样本，长会议、噪声和多人混合讲话仍需另行验收。

离线协议夹具的通过结果只能证明队列和数据流，真实语音识别的结果以 `verify-live.mjs` 为准。

## 参数与数据

- `ANC_SPEAKMODE_BIN` 可指定 `file_asr_lab` 可执行文件的绝对路径。
- `ANC_SPEAKMODE_CONFIG_DB` 可指向已有 SpeakMode 的配置数据库。复用配置时需要其中的阿里云地域与登录钥匙串凭据相匹配。
- `ANC_DATA_DIR` 可指定独立录音数据目录，默认为仓库内的 `.anc-data/`。
- `ANC_PROTOTYPE_PORT` 默认为 `4785`。服务监听 `127.0.0.1`，同一数据目录同时只允许一个服务打开。

原录音、转写、分段检查点和任务台账保存在本机数据目录，Git 会忽略该目录。每份音频上限 64 MiB。现有提取规则针对「由某人负责某事」一类明确表述，可保留同一分段中的「截止时间是……」。

旧版台账可继续读取，并在页面标记为「旧版本机转写」。录音卡、飞书和真实长会议仍待接入或验收。页面底部保留独立的 [Codex 同会话续跑演示](prototype/README.md)。

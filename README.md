# ANC Card

ANC Card 是五人团队的本机协作原型。它验证录音能否变成有出处的任务台账，以及处理到一半中断后能否接着跑。

导入音频后，原文件和排队记录先写入 SQLite。后台用本机 Whisper 转写，提取明确交代了负责人的行动项，并在同一次数据库写入中保存转写、台账条目和完成状态。点击条目的时间范围可跳回原录音。所有行动项初始状态为「待核对」。

## 本机运行

需要 macOS、Node.js 22.13+、[whisper.cpp CLI](https://github.com/ggml-org/whisper.cpp) 和多语言模型。安装完成后，录音导入和转写可离线运行。

```bash
brew install whisper.cpp
mkdir -p "$HOME/.local/share/anc-card"
curl -fL https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin \
  -o "$HOME/.local/share/anc-card/ggml-small-q5_1.bin"
export ANC_WHISPER_MODEL="$HOME/.local/share/anc-card/ggml-small-q5_1.bin"
node prototype/server.mjs
```

打开 [本机原型](http://127.0.0.1:4785/)，选择一份 WAV、M4A 或 MP3，点击「导入并排队」。可在另一个终端生成约 29 秒的自制普通话样本，再导入。

```bash
sh prototype/scripts/make-sample.sh /tmp/anc-card-sample.wav
```

- `ANC_WHISPER_BIN` 可指定 whisper-cli 路径。默认从 PATH 查找。
- `ANC_DATA_DIR` 可指定独立数据目录。默认使用仓库内的 `.anc-data/`，其中保存原录音、转写与台账，Git 会忽略它。
- `ANC_PROTOTYPE_PORT` 默认为 `4785`。服务只监听 `127.0.0.1`，同一数据目录同时只允许一个服务打开。

## 验证结果

用自制 WAV 跑通了实际本机转写。台账提取到小王的会议纪要（本周五，约 00:09–00:15）和小李的测试文档（下周一，约 00:19–00:26）。模型把样本里的「纪要」识别成了「计要」，页面保留转写原文供回听核对。

- **重复导入**。并发上传相同字节、不同文件名，只生成一条队列记录。文件名取首次入队时的值。
- **失败重试**。把 `ANC_WHISPER_BIN` 指到不存在的文件会留下失败状态。修正路径后用同一数据目录重启，点「重试」会复用原录音和记录。并发重复点击仅接受一次。
- **重启恢复**。实测强制结束服务，重启后原「转写中」任务自动重新排队，原「排队中」任务继续处理，已完成台账保留原条目 ID。每次开始处理都会累计尝试次数。
- **原音频取证**。服务返回的音频与上传文件逐字节相同，支持 HTTP 字节区间读取供播放器定位。

## 原型边界

每份文件上限 64 MiB。当前验证使用短普通话样本。提取规则针对「由某人负责某事」一类明确表述，可保留同一转写段里的「截止时间是……」。时间戳来自 Whisper 的转写段。录音卡、飞书和真实长会议尚未验收。

页面底部保留 [Codex 同会话续跑演示](prototype/README.md)。它有独立的模拟输入和内存状态。录音任务写入台账后停在待核对阶段。

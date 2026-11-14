# ANC Card 桌面中转工具（Windows / macOS）

> 2026-11-14 归档基线：Zoty `cancel-race-fix.zip` / `98201bf`。Mac Python 3.12 复核为 146 passed、2 xfailed；这是桌面协议工具和离线时序测试，不是 Android App 或 iOS 锁屏稳定性证明。厂商与作者许可均保留。后续计划以仓库 `docs/ROADMAP.md` 为准。


用电脑的蓝牙从录音卡取文件、记录实时推流、把原件上传到后台，并把每一步写成带时间的证据日志。配合 [卡与 iPhone 开发清单](../../docs/five-card-iphone-handoff.md) 使用。

它只读卡：能发的命令写死在一张清单里（读状态、列文件、下载、实时音频的开始和结束），删除命令永远拒绝。协议编解码用的是厂商开放协议仓库里的模块，见 [third_party/qs668](third_party/qs668/README.md)。

## 状态

2026-11-14 写成，做过一次独立代码审查并按结果修过。96 个单元测试覆盖了协议流程、连接层、断连演练、文件落盘和上传回执；蓝牙部分用替身测试，没有连过真卡。**真卡上的验证记录见文末「实测记录」，没填的就是还没测。**

## 安装

需要 Python 3.10 以上和一个可用的蓝牙适配器。在本目录执行：

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

macOS 把 `.venv\Scripts\python` 换成 `.venv/bin/python`。

## 用法

所有命令都在本目录运行。`--card` 是你给卡贴的标签（A–E），第一次连上后工具会记住这张卡的蓝牙地址。

连卡之前：拔掉数据线并唤醒卡，让别的手机和浏览器先断开它。

```powershell
.venv\Scripts\python -m ancrelay scan
```

```powershell
.venv\Scripts\python -m ancrelay status --card A
```

```powershell
.venv\Scripts\python -m ancrelay pull --card A --newest
```

| 命令 | 做什么 |
| --- | --- |
| `scan` | 扫描附近的录音卡，只听广播 |
| `status --card A` | 读电量、容量、固件和卡内文件列表 |
| `baseline --card A` | 把卡内现有文件记为「已存在」，之后才能分辨新录音 |
| `pull --card A --newest` | 下载文件名最新的一条。也可以用 `--name 文件名开头` 或 `--new`（基线之外的全部） |
| `watch --card A` | 守着这张卡：机身按下保存，或每隔 30 秒，自动取回新录音；断线自动重连 |
| `stream --card A` | 实时推流与断连恢复演练，见下 |
| `verify 文件` | 核对一个本地文件的字节数、SHA-256 和 WAV 头 |
| `resume-test --card A --name 文件名开头 --cut-at 字节数` | 断连续传测试：收到指定字节数后断开，重连后按 offset 续传，再完整重下一遍对照。加 `--ext opus` 测 OPUS |
| `upload 文件 --url 地址 --card A` | 上传原件，默认发两次以验证重传得到同一个录音 ID |

两个人对同一轮测试时，给命令加上同一个 `--session 会话ID`。

### 下载

下载到的 WAV 会核对 RIFF/WAVE 头和声明长度，通过后才落盘；校验不过的保留为 `.invalid`。同名文件内容相同不重复写，内容不同另起名字，不会覆盖。

- 下载请求那一帧是 36 字节，必须一次写完。刚连上卡时系统允许的写入长度可能还是 20 字节，工具会等它协商完（最多 10 秒）；一直不够就报错，不会拆成两次写。
- 下载中途断了，已经收到的字节保留为 `.partial`，并让卡终止这次传输。卡内原件还在，重新 `pull` 即可。

### 推流演练

```powershell
.venv\Scripts\python -m ancrelay stream --card A --minutes 10
```

推流期间在控制台输入：

| 输入 | 作用 |
| --- | --- |
| 任意文字，例如 `开场一` | 记一个带时间的口令标记 |
| `/drop` | 主动断开蓝牙。不发结束命令，模拟真实掉线 |
| `/back` | 重新连接并恢复推流 |
| `/stop` | 结束推流，列出卡内文件 |

意外掉线时工具会自己重连。每次连接存成一段 `.raw`，收到就写盘；结束后生成可播放的 `.ogg`、一份摘要 JSON，并打印清单里要填的「开始至首帧、中断至恢复」。出错或按 Ctrl+C 退出时也会做这一步，并尽量先让卡停止推流。

已知的不便：正在重连时（一次最多约 20 秒）输入的 `/stop` 要等这次连接尝试结束才生效。

### 上传

```powershell
$env:ANC_UPLOAD_TOKEN = Read-Host '上传凭证'
.venv\Scripts\python -m ancrelay upload "C:\完整路径\样本.wav" --card A --url https://后台地址/v1/recordings --ca ca.crt --recording-id A-001 --fetch-result
```

- 凭证只从环境变量 `ANC_UPLOAD_TOKEN` 读取，不写进命令行参数和日志。
- 地址必须是 `https://`；明文 `http://` 只允许发往本机，局域网临时联调要加 `--allow-http`。
- 测试后台用自己的 CA 签发证书时，用 `--ca` 指定 CA 文件。证书验证不会被关闭，也不需要安装系统根证书。
- 默认发两次（`--repeat 2`），核对两次得到同一个录音 ID、第二次标记为重复；每次的完整 JSON 回执都打印出来并写进日志。
- `--fetch-result` 会按回执里的 `resultPath` 查询一次结果。只接受同一来源下的路径。

请求按后台接口（2026-11-14）：请求体是文件原始字节，不用 multipart，64 MiB 以内。

| 请求头 | 内容 |
| --- | --- |
| `Content-Length` | 自动 |
| `X-ANC-Filename` | 文件名，UTF-8 百分号编码 |
| `X-Recording-ID` | 同一录音保持不变；默认「卡标签-文件主名」，用 `--recording-id` 指定 |
| `X-Content-SHA256` | 完整文件的小写 SHA-256 |
| `Authorization` | `Bearer` 加凭证 |

回执是 `device`、`localId`、`recordingId`、`sha256`、`bytes`、`duplicate`、`resultPath`，新导入 201、重复 200。工具会核对字节数、哈希、`localId` 和状态码与 `duplicate` 是否一致。也兼容原型旧接口的 `{duplicate, recording}`。

## 文件放在哪

原音、日志、卡的蓝牙地址都属于私有数据，默认放在**仓库根目录下的 `.anc-field/`**；从源码包单独解压使用时，放在工具目录自己的 `.anc-field/`（工具目录的 `.gitignore` 也忽略它）。这个目录已写进根目录的 `.gitignore`，不会被提交（有测试检查）。要换地方用 `--out` 或环境变量 `ANC_FIELD_DIR`；换到仓库里别的位置之前，先确认它被忽略。

```text
.anc-field/
├── cards.json                 卡标签 → 蓝牙地址
├── logs/会话ID.jsonl          证据日志，一行一个事件
└── card-A/
    ├── baseline.json          已知文件名
    ├── note….wav              下载的原件
    └── 会话ID-seg01.raw/.ogg  推流的分段
```

日志每行带 `t_ms`（从本次命令开始算的毫秒数，单调时钟）、`wall`（本地时间）和 `session`。

## 开发

```powershell
.venv\Scripts\python -m pip install pytest
.venv\Scripts\python -m pytest tests third_party/qs668/test_qs668_protocol.py
```

## 实测记录

| 日期 | 项目 | 发送端 | 结果 |
| --- | --- | --- | --- |
| 2026-11-14 | `scan` | Windows | A 卡广播名 `CB08`，带 AE20 服务；USB 线拔掉后才能扫到 |
| 2026-11-14 | `status` | Windows | 第一次就连上；MTU 527，一次可写 524 字节；AE23 可订阅；固件 V1.0.0；列表 2 条，文件名末尾的扩展名被截掉（如 `note20261114-121309.`），与协议文档一致 |
| 2026-11-14 | `pull` 一条 12.8 秒 WAV | Windows | 第一个候选名 `.wav` 就成功；409644 字节约 21 秒（约 19 KB/s）；WAV 校验通过；与同一条录音的 USB 副本逐字节相同 |
| 2026-11-14 | `baseline` | Windows | 记下 2 条已有录音 |
| 2026-11-14 | `pull --ext opus` | Windows | 同一条录音的 OPUS 25640 字节，2-3 → 129 帧 2-4 → 2-5 结束码 0 |
| 2026-11-14 | `pull --trace` | Windows | 2-2 请求 36 字节一次写入；WAV 第 3 次下载与前两次、与 USB 副本哈希相同 |
| 2026-11-14 | `resume-test` WAV，断点 200000 | Windows | 重连后 offset=200000 续传到结束码 0，拼接结果与完整下载逐字节相同；重连用了约 47 秒 |
| 2026-11-14 | `resume-test` OPUS，断点 12000 | Windows | 同上，拼接结果正确；重连约 8 秒 |
| 2026-11-14 | `upload` 到后台测试环境 | Windows | HTTPS + 测试 CA 校验通过；A 卡 WAV 发两次都是 200、duplicate=true、同一个 recordingId（后台此前已由 USB 导入）；resultPath 查询返回转写 complete、飞书结果卡已发 |
| | `stream`、`watch` | | 还没测 |

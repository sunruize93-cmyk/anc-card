# QS668 协议模块（第三方）

这个目录里的代码来自录音卡厂商的开放协议仓库，按 MIT 许可使用，许可证全文见同目录的 `LICENSE`。

- 来源：<https://github.com/nextproto1024/ai-recorder-card-open-protocol>
- 版本：提交 `de42d1fbf19fc92064ac4688f71f42730c82267f`（2026-11-14 取用）

| 本目录的文件 | 上游的文件 | 改动 |
| --- | --- | --- |
| `qs668_protocol.py` | `tools/qs668_protocol.py` | 无 |
| `qs668_raw_opus_to_ogg.py` | `tools/qs668-raw-opus-to-ogg.py` | 只改了文件名（连字符换成下划线，才能被导入），内容没改 |
| `test_qs668_protocol.py` | `tools/test_qs668_protocol.py` | 无 |
| `LICENSE` | `LICENSE` | 无 |

升级时从上游重新复制这几个文件，更新上面的提交号，然后跑一遍测试。不要在这里直接改。

上游还有一个完整的命令行工具 `tools/qs668-bringup.py`。本项目没有复制它，`ancrelay` 的读卡流程和超时参照它和协议文档写成。

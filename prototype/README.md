# Codex 同会话续跑演示

录音导入和本机启动见[项目首页](../README.md)。此演示用固定模拟转写，独立验证确认后恢复原 Codex 会话。

需要 macOS、Node.js 22.13+ 和已登录的 Codex CLI。可以先运行 `codex login status`，然后在项目根目录运行 `node prototype/server.mjs`。若终端找不到 Codex，通过 `ANC_CODEX_BIN` 指定其路径。

打开 [本机原型](http://127.0.0.1:4785/)，展开「Codex 同会话续跑演示」。

1. 点「导入模拟转写」。Codex 首轮写出接口示例和用法，暂缓 429 重试。程序独立重跑验收，记录 Codex 会话 ID 和代码快照。
2. 台账显示 2/3 后，主 Agent 根据 429 验收缺口生成下一步建议。
3. 点「确认并续跑」。服务核对建议 ID 和首轮产物，用 `codex exec resume` 在原会话和工作目录续跑。页面展示两轮结果，并保留首轮代码快照。

演示状态保存在内存中，工作文件位于专用临时目录。Codex CLI 的会话记录遵循其本机保存机制。

# 待办：主链路通过后再推进

2026-11-14：按用户决定，当前先用现有 Mac 和同一 Wi-Fi，验收一张卡保存后自动到 iPhone、后台和飞书。不购买服务器、不修改 DNS、不开放公网入口。

## 公网与云端（暂缓）

- [ ] 预定使用 `upload.nestlinker.com`；当前仅核查 DNS，未创建记录。现有主域网站保持不变。
- [ ] 完成单卡局域网自动闭环后，再决定先用 Mac 的受限 HTTPS 入口外出试验，还是直接迁移云端。
- [ ] 云端起步按 2 vCPU、4 GB RAM、60–80 GB 磁盘、无 GPU 评估，API 调用与任务执行按队列限并发；此为规划，不是已测容量。重型 Codex 构建独立评估。
- [ ] SpeakMode 当前凭证读取依赖 macOS，先验证 Linux 构建与服务器密钥存储，再决定转写 worker 迁移；不能把 Mac 工程原样复制就宣称云端就绪。
- [ ] 补长录音分段与恢复上传：当前 64 MiB 上限，对 16 kHz、单声道、PCM16 WAV 约 35 分钟。3 小时约 345.6 MB；每天每人 3 小时、5 人、30 天约 51.84 GB，仅原音未算备份及派生文件。
- [ ] 云端持久化队列、磁盘与备份策略、设备独立凭证、同卡去重、服务重启恢复、蜂窝网络实测。

已写但暂不启用的准备代码保存在本机 `.anc-data/deferred-public-upload-20261114/`：只允许上传／查询的边界代理，以及原生 App 系统 TLS 模式补丁。已做本机测试；未部署、未修改手机已安装版本。恢复时重新核对主线再融合。

## 分发与扩员（暂缓）

- [ ] 当前仅 Eric.s 一台 iPhone 开发签名安装；暂不使用 TestFlight，也不购买开发者计划。
- [ ] 扩到五人前处理免费 Personal Team 的设备与 7 天签名限制，再决定账号及分发路线；逐台安装不代表没有期限限制。
- [ ] 五卡回归、官方 App 转写对照、长时 streaming context，以及云上 Agent 执行隔离，待单卡闭环稳定后安排。

参考：[Apple 账号限制](https://developer.apple.com/help/account/basics/about-your-developer-account) · [云服务器规格价格参考](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html)

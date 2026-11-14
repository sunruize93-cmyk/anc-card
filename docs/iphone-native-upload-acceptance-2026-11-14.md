# iPhone 原生 WAV 上传验收 · 2026-11-14

时间均为韩国时间（UTC+9）。目标为原生 App 上传已有 WAV，经现有后台查询到飞书结果；本轮不接蓝牙。

## 实测结果

- Xcode 26.6 对 iOS 26.6 真机签名构建成功，安装并启动 `ANC 上传`。公开源码在 `relay/ios-upload/`，构建不包含账号、凭证、录音和 CA。
- 经开发设备文件通道将已经交付的 A 卡 WAV 副本放到 App Documents。用户使用“使用 A 卡现有样本并上传”；本轮未单独验收系统文件选择器。
- 原音 409,644 字节，12.8 秒。原生 SHA-256、后台回执与先前 A 卡原件一致。
- 13:52:37 首次请求返回网络离线；提醒用户检查同网和本地网络权限后，用户重试并确认手机显示“转写完成”。本次不把它计为有意断网或锁屏补传测试。
- 13:53:45 原生上传成功：HTTP 200、duplicate=true，localId 为 native- 加原音 SHA-256。
- 13:54:37 终止并重新启动 App 后再上传同一副本：HTTP 200、duplicate=true、相同录音 ID。没有重新注入配置，钥匙串凭证恢复成功。
- 两次手机事件均记录 uploaded → feishu-complete；后台 upload_events 同时有对应两条记录。飞书状态为 complete、error=null，messageId 与之前的原结果卡一致；群页面回读看到原来的带时间点转写和行动项。
- 本轮是已有音频去重路径：复用此前 SpeakMode＋百炼结果，没有新调用 ASR、没有新建飞书结果卡，也没有重复执行 Codex。不能把查询到既有卡计成一次新的卡片写入。
- 16 项上传契约检查通过，覆盖首传与重传、回执字段篡改、错误状态、跨站结果路径和不合法后台 URL。

## 已实现的保护与边界

设备上传凭证保存在设备专用钥匙串，导入后删除一次性配置文件；不包含百炼 Key 或飞书 Secret。仅 App 信任显式配置的测试 CA，仍验证主机名、有效期和证书链；拒绝请求重定向。原件先保存副本，再上传；副本、回执和无 token 的事件记录排除 iCloud 备份。

当前是前台原生上传，仍依赖同一 Wi-Fi、在线 Mac 和短期设备凭证。尚未验收：系统文件选择器、全新音频首传、iPhone BLE 取音、机身保存后自动同步、锁屏、系统强退、真正断网后的后台恢复、外网访问。

本机证据：`.anc-data/field-20261114/ios-environment/native-verification.json`，包含手机事件、后台事件和结果回执；构建日志与失败日志保留在同目录，不公开设备标识或完整消息 ID。

## 五人测试与正式使用

当前用 Xcode 开发签名安装，测试手机需要 Developer Mode。后续推荐先以 TestFlight 给五人测试，同一 App 的测试者不需要开启 Developer Mode 或逐台连接 Mac。发布方需要 Apple Developer Program（Apple 当前标价 99 USD/年或当地币种），不要求每位成员都购买会员。TestFlight 有构建有效期与测试审核流程，不作为永久分发承诺；长期内部使用方式待确认。

每位成员第一次仍需安装 App、建立成员身份、绑定自己的卡，并允许蓝牙及所需权限。这是设备登记，不是每人再开发一份 App。录完不用手动同步的目标，须在 BLE 自动取音、上传及锁屏恢复实测通过后才能宣布完成。

- [Apple Developer Mode 与 TestFlight 的区别](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)
- [Apple 测试与发布分发](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases/)
- [开发者计划价格](https://developer.apple.com/programs/whats-included/)
- [TestFlight 测试说明](https://developer.apple.com/testflight/)

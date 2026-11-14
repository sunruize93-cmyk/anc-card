# Eric.s 的 iPhone 真机开发环境

更新：2026-11-14，韩国时间。当前只推进 Eric.s 端，不给 Zoty 新增任务。

## 验收标准

完整 Xcode、iOS SDK 和真机工具可用；iPhone 已配对并启用开发者模式；一个使用 Eric.s 自己签名团队的最小 App 能编译、安装、启动。完成这一步才记为“开发环境就绪”。Safari 上传成功、USB 枚举成功或 Xcode 下载成功均不能替代真机运行。

## 本次基线

- Mac：Apple silicon，macOS 26.5.2，可用空间约 585 GiB；原开发目录为 `/Library/Developer/CommandLineTools`，未安装完整 Xcode。
- iPhone：实读 iOS 26.6，paired / wired / connected；用户开启开发者模式、重启并信任自有开发者后，工具实读 Developer Mode enabled。
- App Store 当前 Xcode 要求 macOS 26.6 或更高，实际安装请求被拒绝，未升级系统。
- 已从 Apple 官方历史版本下载并安装 Xcode 26.6 Apple silicon 正式版（17F113），路径 `/Applications/Xcode.app`，最低 macOS 26.2。`codesign --verify --deep --strict` 通过，`spctl` 返回 accepted / Apple System。已实际向 iOS 26.6 真机安装并启动最小 App；断点调试和蓝牙能力仍需各自实测。
- Apple 账号登录和首次 Developer Agreement 由用户在官方网页完成；未购买付费会员。

## 安装后执行

1. 核对 Apple 签名，正常展开 `.xip` 到独立目录，保留安装包；把 Xcode 放入 `/Applications`，避免覆盖其他 Xcode 版本。
2. 首次打开 Xcode，由用户确认许可和需要的系统授权。只准备 iOS 开发所需组件；不必下载 watchOS、tvOS、visionOS 模拟器。
3. 运行仓库内只读检查脚本。默认优先使用已选择的完整 Xcode，其次 `/Applications/Xcode.app`，不修改系统开发目录。

   ```sh
   bash prototype/scripts/check-ios-environment.sh
   # 如安装在其他位置：
   DEVELOPER_DIR=/Applications/Xcode-26.6.app/Contents/Developer bash prototype/scripts/check-ios-environment.sh
   ```

4. 用支持数据的 USB 线连接并解锁 iPhone，在手机确认“信任此电脑”。Xcode 设备窗口完成配对；记录 iOS 版本、设备支持准备状态和错误，不在公开文档保存 UDID。
5. 手机出现开发者模式入口后，在“设置 → 隐私与安全 → 开发者模式”打开，按手机提示重启并确认。此项由机主操作。不要关闭密码或系统安全保护。
6. 在 Xcode Settings → Accounts 由用户登录自己的 Apple 账号；项目 Signing & Capabilities 选择自己的团队与自动签名，使用独立 Bundle ID。凭据和签名材料不交给 Zoty，不提交仓库。
7. 用最小 SwiftUI App 测试编译、安装、启动；拔线后确认可以再次打开。记录实际构建版本、签名团队是否可用、运行结果。若免费签名到期，按 Xcode 实际提示重新签名，不把短期开发安装当作长期分发方案。

## Zoty 源码到达后的接入边界

先读取 `relay-desktop` 的实际语言、入口和许可。Windows Python/Bleak 源码可以作为协议参考与测试基准，但不能直接当作 iOS 可安装项目。由 Eric.s 端复用已验证的帧格式、CRC、通知组帧和断点偏移，适配原生 Core Bluetooth；不要求 Zoty 重新开发手机端。

按以下顺序验收，每步失败停在该层保留原件：

| 顺序 | 验收内容 |
|---|---|
| 1 | 原生 App 前台选择现有 WAV，校验 SHA-256，通过现有 `/v1/recordings` 上传；重复上传返回同一录音 ID，飞书只有一张录音结果卡。 |
| 2 | 蓝牙权限只用于指定录音卡；发现、连接、读状态、列文件均记录真实返回值。 |
| 3 | 前台下载一份原音到临时文件，完整性检查通过后落盘，再上传；USB/BLE 哈希分别记录。 |
| 4 | 卡保存新录音后，手机发现新增文件、自动下载并上传；整个过程不手选文件。 |
| 5 | 下载中断后重连，按已验证偏移续传，完整文件验证后才标记完成；重连对账不漏掉新录音。 |
| 6 | 锁屏、离线、恢复网络分别验收；系统后台调度、用户强退、设备重启分开记录，不承诺无限后台常驻。 |

上传接口沿用单主 bot：客户端只持有绑定设备的短期上传凭证，百炼 Key 和飞书 App Secret 留在后台。手机本地持久化录音文件、稳定 localId、哈希、大小、上传状态和回执；机身文件不自动删除。原生 HTTPS 必须验证服务器证书，Safari 的证书例外不能视为原生 App 已信任。局域网测试地址只在同网且 Mac 后台在线时可用，外出使用还需要受信任 HTTPS 和持续在线的后台。

## 官方依据

- [Xcode 系统、SDK 与设备支持表](https://developer.apple.com/xcode/system-requirements/)
- [Apple 官方历史版本下载](https://developer.apple.com/download/all/?q=Xcode)
- [开启 Developer Mode](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)
- [真机运行和自动签名](https://help.apple.com/xcode/mac/current/en.lproj/dev5a825a1ca.html)

## 本轮记录

- [x] 硬件架构、系统版本、磁盘空间核对。
- [x] Apple 官方登录及开发者注册完成。
- [x] 用户接线并确认信任，IORegistry 枚举到 iPhone。
- [x] 本地最小 SwiftUI 工程已生成，项目配置与签名校验通过。
- [x] 完整 Xcode 下载、签名检查、展开安装。
- [x] Xcode 首次许可及系统组件初始化，开发目录已切换到完整 Xcode。
- [ ] Xcode 的 iOS 平台／模拟器组合包仍在后台下载，最后观察为 1.95 / 8.52 GB；IDE 的 scheme 运行入口仍显示下载中。当前已使用 `xcodebuild -target EnvironmentCheck -sdk iphoneos` 完成真实签名构建，使用 `devicectl` 完成安装和启动。不能把这一结果写成模拟器或 IDE Run 全部就绪。
- [x] iPhone 有线配对成功。
- [x] 手机开发者模式开启后复查：enabled，paired / wired / connected。
- [x] 用户 Personal Team 自动签名、真机安装成功；首次启动被设备信任拦截，用户完成信任并确认看到“ANC · 真机环境检查”。随后 `devicectl` 再次启动返回 success 和进程 ID。
- [ ] 拔线后重新启动 App、Xcode IDE Run 与断点调试；模拟器下载完成后再补验收。
- [ ] 原生 App 现有 WAV 上传。
- [ ] Zoty 源码接收后 BLE 自动取音与上传。

## 本机复现与证据

最小工程及签名配置仅保存在 `.anc-data/field-20261114/ios-environment/EnvironmentCheck/`；不会把账号、设备标识、签名证书或 provisioning profile 放入公共仓库。该 App 只显示环境检查页面，不读取录音、不访问蓝牙，也不发送网络请求。

同目录保存构建日志、安装与启动 JSON、环境检查结果。`build-signed.log` 为 BUILD SUCCEEDED，`install-device.json` 为 success，`launch-device-verified.json` 为 success；先前失败日志保留，不覆盖历史失败。用户目视确认与工具启动结果共同构成本轮真机启动验收。

本轮未接入卡到手机的取音，也未把 Safari 手动上传计作原生自动上传。下一步先复用现有 WAV 验收原生上传，再结合 Zoty 已完成的源码交付适配 Core Bluetooth。

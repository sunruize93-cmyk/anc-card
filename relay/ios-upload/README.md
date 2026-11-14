# 原生 WAV 上传验收 App

用途：在等待 relay-ios 蓝牙源码期间，独立验证 iPhone 原生上传、已有音频去重和飞书结果查询。不是蓝牙客户端，也不承诺后台自动取音。

## 构建

使用完整 Xcode。项目不含个人团队、设备凭证、测试 CA 或音频。选择自己的签名团队与唯一 Bundle ID：

```sh
xcodebuild -project relay/ios-upload/ANCUploadSmoke.xcodeproj \
  -target ANCUploadSmoke -sdk iphoneos -configuration Debug \
  DEVELOPMENT_TEAM=你的团队ID PRODUCT_BUNDLE_IDENTIFIER=你的BundleID \
  -allowProvisioningUpdates build
```

本次在私有命令中沿用已安装环境检查 App 的 Bundle ID，以升级同一测试 App；没有创建新的团队账号。

## 本机配置与运行

开发阶段经 Xcode/devicectl 向该 App 的 Documents 放入：

- `device-import.json`：`baseURL`（HTTPS origin）、`device`、`token`、`expiresAt`（Unix 毫秒）。这是绑定设备的短期上传凭证，不是飞书或百炼密钥。沿用现有后台已配置的凭证，文件仅留本机，不提交。
- `test-ca.der`：与此测试后台对应的 DER 格式 CA 公共证书。仅 App 信任这张显式配置的 CA，继续校验证书链、有效期和主机名；不改变 iPhone 系统信任设置，不绕过 TLS 校验。
- 可选 `A-card.wav`：已授权用于联调的原件副本。用于按钮“使用 A 卡现有样本并上传”。没有此文件时使用文件选择器。

首次启动把配置迁移到设备专用钥匙串后删除一次性配置文件。音频副本、回执和事件记录排除 iCloud 备份。不会删除卡内文件或用户选择的原件。

保持手机与后台在同一 Wi-Fi，按手机提示允许本地网络访问。选择 WAV 并上传，或用预置 A 卡样本按钮。已启动 App 可通过 `--verify-existing-wav` 在开发调试时执行同一个样本上传入口；每次显式启动最多发起一次上传，不在普通启动时自动上传。

- 先将原件复制到 App Documents，再计算 SHA-256；只接受 64 MiB 以内 RIFF/WAVE。
- POST 原始字节至 `/v1/recordings`，带 `X-Recording-ID=native-<sha256>`、`X-Content-SHA256`、`X-ANC-Filename`、`Authorization`。
- 核对 HTTP 状态、重复标记、大小、设备、localId、录音 ID 与 resultPath；响应重定向一律不跟随。
- 保存 `receipt.json`，最多轮询 24 次、间隔 5 秒。只有录音状态 complete 且飞书 state=complete 并带 messageId 才显示“飞书结果卡已就绪”。
- 查询地址由已核对录音 ID 在同一后台构造，不直接访问服务返回的任意 URL。
- 失败后手动重试相同副本、相同 localId；重启后可恢复上次回执并刷新状态。当前不实现后台 URLSession、自动重试队列或 BLE。
- 网络离线错误可能来自本地网络权限未授权或未连接同网；先检查手机权限和网络，再点击样本按钮重试。

`native-events.jsonl` 只记录阶段、时间、哈希与回执标识，不记录上传 token。用该文件及后台 upload_events 交叉核对来源；后台当前将原生客户端归类为 api，应结合 native- 前缀和手机事件确认。

## 本机回归

```sh
xcrun swiftc relay/ios-upload/UploadContract.swift relay/ios-upload/Tests/main.swift -o /tmp/anc-upload-contract-checks
/tmp/anc-upload-contract-checks
```

覆盖正确首传与重传、篡改回执字段、跨站结果路径、错误状态、非 HTTPS 和带凭据的后台地址。真机 HTTP/TLS、网络授权、实际后台与飞书投递需要独立现场验收。

## 后续融合

此目录为独立联调程序。收到 Zoty 的 QS668Kit/ANCRelay 源码后，复用已经验证的上传约定和 TLS、回执检查，按实际项目结构融合；不要求 Zoty 重写 iOS 上传或补 Windows 编译。生产分发前换成受信任的公网 HTTPS、成员登录和设备注册；禁止将本机调试凭证打进发行包。

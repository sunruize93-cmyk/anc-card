# ANC Card · iPhone 客户端

当前公开基线来自 2026-11-14 真机融合版本，App 名称为 **ANC Card**，图标为 NestLinker 标志。原交付作者为 JIN HAIMIN（Zoty），Mac 集成及后续修改为 Ruize Sun；自写源码采用本目录 MIT LICENSE。品牌标志不包含在 MIT 授权内。

## 已验证到哪里

一张 A 卡、一部 iPhone 26.6、同 Wi-Fi、Mac 在线。正常打开并连接后锁屏，70.8 秒真实录音保存后自动完整下载并上传，约 28 秒拿到上传回执。随后同源录音完成转写、飞书负责人确认和 Codex 两轮执行。详见 [实测报告](../../docs/mvp-acceptance-2026-11-14.md)。

这不是两小时会议、所有机型、强退 App 后自动恢复的保证。稳定验收路径为 WAV；OPUS、删除旧录音和实时通道相关代码仍有实验开关，不能因源码存在就算产品功能通过。

## 构建与安装

用完整 Xcode 打开 `ANCRelay/ANCRelay.xcodeproj`，选择 ANCRelay scheme、自己的签名团队和唯一 Bundle ID，再选真机运行。工程最低部署目标为 iOS 17；不要求 XcodeGen。手机必须按系统提示完成信任和开发者模式设置。当前不走 TestFlight。

```sh
xcodebuild -project relay/ios/ANCRelay/ANCRelay.xcodeproj -scheme ANCRelay \
  -configuration Debug -sdk iphoneos DEVELOPMENT_TEAM=YOUR_TEAM \
  PRODUCT_BUNDLE_IDENTIFIER=com.yourcompany.anc.card -allowProvisioningUpdates build
xcrun swift test --package-path relay/ios/QS668Kit
```

已安装设备升级时沿用它自己的原 Bundle ID 和签名团队，保留配对和数据；不要为了改图标卸载 App。公开工程默认 ID 是示例，不携带 Eric 的签名或设备配置。

首次接入仍需本机配置上传凭证、测试 CA，并绑定自己的卡。参考 [原生上传配置](../ios-upload/README.md) 与 [接口约定](../../docs/recording-document-contract-v1.md)。每台手机使用独立凭证；凭证、证书私钥、录音和构建产物都不进仓库。

`Sources/` 是界面、蓝牙、持久状态和后台上传；`../QS668Kit/` 是协议及回执校验与离线测试。基础首次列表只建立旧文件基线，之后新录音才自动取回。失败重取从头下载，沿用稳定录音 ID，避免重复创建后台任务。

## 来源与边界

Zoty 的 relay-ios `2b550ee` 于 2026-11-14 明确允许以 MIT 并入公开仓库。当前代码是其基础上的 Mac 融合版本，不能冒称原始交付未修改。协议参考 NextProto 的公开资料：<https://github.com/nextproto1024/ai-recorder-card-open-protocol>。未将收到的私有通信协议文档、配置包或原始现场日志公开。第三方来源见 [THIRD_PARTY.md](THIRD_PARTY.md)。

改名/图标更新只改变 Info.plist、界面名称与资源编译配置；不改变蓝牙、取音、上传或自动清理逻辑。

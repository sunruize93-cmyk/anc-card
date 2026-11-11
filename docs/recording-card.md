# 录音卡无线接入核对

核对日期：2026-11-11。团队主要使用 iPhone。已通过用户提供的物流单号取得 NextProto 录音卡协议，原始文档留在本机，物流单号不进入仓库。

## 已确认的资料能力

[产品页](https://nextproto.top/products/ai-record-card)指向 QS668 开放协议和“声云语音转写”配套 App。[公开 BLE 协议](https://github.com/nextproto1024/ai-recorder-card-open-protocol/blob/main/docs/protocol.zh-CN.md)提供文件列表、文件下载和录音控制命令。读取卡内文件可以独立于厂商转写服务实现。当前只完成资料核对，尚未连接用户这批卡。

下载协议使用 AE20 服务、AE21 写入、AE22 通知，AE23 上报机身事件。优先请求 `.wav` 输出，校验 RIFF/WAVE 及完整长度，再导入现有录音队列。协议资料记载的 WAV 输出为 16 kHz、PCM16、单声道，与 SpeakMode 文件入口匹配；实际固件仍需验收。裸 OPUS 需要额外封装或解码，不能改扩展名后当成 WAV。

## iPhone 接入选择

最新目标：录音卡 → iPhone 自动蓝牙同步 → 直接上传 ANC Card 后台 → SpeakMode＋百炼 → 自动发送飞书任务卡并更新台账。日常流程无需逐次手动分享音频。录音卡到货后开始硬件与手机端接入开发，完整目标见[协作闭环](architecture.md)。

优先确认厂商 App 是否支持自定义上传地址或可用的自动同步接口；当前资料未确认这项能力。若无此能力，需要一个轻量 iPhone 原生同步 App，负责蓝牙取文件、本地缓存和后台上传。公开 BLE 协议本身不能修改现成 App 的上传目的地。手动把导出的 WAV、M4A 或 MP3 分享到飞书保留为调试入口，App 能否分享原音频仍待实测。

iOS 的 [Core Bluetooth 后台模式](https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/CoreBluetoothBackgroundProcessingForIOSApps/PerformingTasksWhileYourAppIsInTheBackground.html)和[后台 URLSession](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background)可分别用于蓝牙事件处理与文件上传，需持久化同步状态并支持恢复。后台上传应从已落盘文件发起。系统调度、用户操作、断连和重启影响传输时机；不能承诺所有状态下立即同步。[Apple TN3115](https://developer.apple.com/documentation/technotes/tn3115-bluetooth-state-restoration-app-relaunch-rules)还列出了恢复条件及 iOS 26 使用 AccessorySetupKit 的相关差异，实施时需按目标系统和设备验证。

飞书提供 iOS 蓝牙接口，但存在明确的兼容核对点：[写入 API](https://open.feishu.cn/document/client-docs/gadget/-web-app-api/device/ble/writeblecharacteristicvalue)的参数文档标注 `value` 限制在 20 字节内，而卡的公开协议要求文件下载 `2-2` 完整 36 字节一次 GATT 写入，拆成 20＋16 会返回文件不存在。故不能仅凭“飞书支持蓝牙”就承诺飞书内网页或小程序能直接下载录音。须验证目标客户端是否允许整帧，或由厂商提供经验证的兼容命令；不要通过直接拆帧规避此约束。

上述限制不能直接推导为 iPhone 原生蓝牙只能写入 20 字节。原生实现应通过 [maximumWriteValueLength(for:)](https://developer.apple.com/documentation/corebluetooth/cbperipheral/maximumwritevaluelength(for:)) 检查当前连接的实际写入上限，再实测 36 字节整帧。

手机中转消除数据线和电脑前台操作；若希望电脑关机后仍处理，需要常开后端。现有 Mac 版的 afconvert、SpeakMode 原生工具与登录钥匙串配置不能未经适配就搬到 Linux。永久百炼 Key 和飞书 App Secret 应保留在后端。

## 下一次真机验收

1. 用一张卡录制 30 秒，核对原生蓝牙连接、录音保存通知、文件列表和 36 字节整帧下载。
2. 验证 iPhone 自动缓存与上传，以及锁屏、断连重连和网络暂不可用后的恢复。
3. 后台转写完成后自动发到唯一绑定测试群，核对时间范围、同一录音与任务 ID。
4. 验证重复上传、下载失败恢复、转写失败重试和服务重启，再扩展较长录音。

此阶段不执行录音删除、清空设备或固件改写。

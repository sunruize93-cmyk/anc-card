# iPhone / 卡端暂停交接：2026-11-14 16:00 KST

> 历史过程快照：保留当时判断与分工。今日最终状态以 [收尾审查](release-review-2026-11-14.md)、后续工作以 [当前待办](MVP-TODO.md) 为准。


用户在主线要求先完成手头核查、暂停新工作，统一接下来 90 分钟的 MVP 验收。不要直接继续此前的测试循环。无需用户再操作。

## 当前安全状态

- 在暂停通知到达前，最后一次安装已开始；安装已收尾，**未再次启动 App**。已用 devicectl 进程列表确认 ANCRelay 不在运行。
- 为避免下次打开自动启动尚未通过的删除/新格式联调，在 App 停止时备份状态，设置 `retentionSettings.executionEnabled=false`、`preferNativeOpus=false`，已复制回设备并完整 JSON 回读一致。用户的 `keepLatestFive=true` 偏好保留。
- 本机状态有 13 条历史记录，无 `audioPrunedAt`。本轮没有确认任何卡内删除成功，也未删除手机已验收音频。临时重读副本在哈希比对后可丢弃，不是用户录音副本。
- 卡删除只曾针对已交付、非最近五条的旧问候测试录音发出一条精确 `2-8`。无 ACK；完整目录仍有同一目标，审计停在 `reconciling`。后续只有查目录，无盲目重发。待时序修正尚未实测。
- 私有证据：`.anc-data/field-20261114/ios-ble-integration/meeting-sync/paused-{state,events.log,processes.json,state-disabled.json,state-readback.json,source-manifest.json}`。`paused-state.json` 为变更前备份。

## 已验证与未通过

| 项目 | 证据与结论 |
| --- | --- |
| 普通离线录音的长锁屏 | 40.88 秒测试，保存后 180 秒后台无文件；两路控制日志仅到录音中，无保存事件。打开 App 后自动补回。**失败**。证据 `locked-all-control/`。 |
| 实时音频通道 | 收到连续 1-1 音频通知及 3-3 保存事件，可在用户保持锁屏时上传。**但 1-0 开启过晚导致两段：4.8 秒和43.68秒，不算完整单次会议通过**。证据 `locked-real-audio/`。 |
| 新即时通道尝试 | 编译了物理开始事件内立即发送 1-0、物理停止立即1-2的显式诊断模式。**没有实机录音测试**；当前不启用。不可把旧两段上传当新模式通过。 |
| 速度 | 同一72.72秒产品介绍：卡WAV 2,327,084字节 / 28.1694秒；原生OPUS 145,520字节 / 2.14394秒。16倍体积差，约13倍时间差。文件写入分别0.296秒/0.0195秒，主耗时在传输较大WAV。 |
| 压缩完整性 | 3638个40字节包，包装解码得到72.7535秒；卡WAV72.72秒，不是字节/采样一致性。原件哈希与解码副本必须分开。两小时按此吞吐线性估计WAV约46–50分钟，OPUS约3–4分钟，**两小时实测未做**。 |
| 原生OPUS上传 | 后台显式头及解码接口已部署；Swift新格式、帧验证、原件哈希回执、先OPUS后WAV回退接入并编译。**没有新真实录音端到端验收**，当前偏好关闭。 |
| 清理条件 | 文档与飞书三份产物哈希回读、只读预检、最新五条、卡绑定、内容重读SHA、空闲状态均已接通；有疑问的旧验收口令被拒绝，旧问候录音预检允许。 |
| 卡删除 | 按公开协议发送精确28字节原列表项，未成功移除；完整目录核对保护了手机副本。**未完成**。禁止用2-9清空或猜测文件身份变体。 |
| SpeakMode | 40.88秒先超时，attempt2成功；43.68秒先超时，attempt2在尾段`invalid_transcript`，截至收尾仍failed。后台线确认尾段上游content为空，无额度不足证据；没有忽略尾音或编造文本。 |

## 本线当前主阻塞

MVP 的主门槛是：一次真实机身录音，全程锁屏，停录后自动得到**完整单条**录音并成功转写/交付。实时通道虽然带来后台事件，却改变卡端文件分段；后半段转写还受空返回影响。应先统一该门槛，避免同时继续删除、新格式、长时测试三条试验。

自动清理属于另一项未通过的实机门槛：后台允许不能代替卡端删除成功。当前已暂停执行，可在主线决定验收顺序后单独继续。

## 代码与验证

所有 iOS 实现仍在私有路径 `.anc-data/field-20261114/ios-ble-integration/source/`，未提交或推送 Git：

- `ANCRelay/Sources/RelayModel.swift`：诊断实时通道、原生格式选择、清理执行串行化、生命周期与审计。
- `RelayStore.swift`：可选音频格式、清理日志、清理完成标记、执行开关和文档疑问状态；旧状态兼容。
- `BackgroundUploader.swift`：格式声明、原件验签，刷新三份文档与只读预检；HTTP Date + 单调时钟用于短时预检，避免手机约4秒时钟偏移误拒绝。
- 新 `CardReadProbe.swift`、`MeetingStream.swift`、`CardCleanupOperation.swift`。实时备份片段从不当完整录音上传。
- `CardBluetooth.swift`：两路控制通知诊断，音频数据不逐帧写日志。
- `ANCRelayApp.swift`：策略状态及已清理记录展示。
- `QS668Kit`：`Transfer.swift`保留28字节原项、严格目录结束、原生优先及精确重读；`Protocol.swift`仅允许单文件删除与显式实时指令，2-9仍拒绝；新`CardDeletion.swift`、`CleanupPreflight.swift`、`RawOpus.swift`。
- 单元测试新增单文件删除恢复、预检拒绝/过期/错配、原生帧与声明回退。最近一次 **77项通过**，最新 App **BUILD SUCCEEDED**。
- 最后编译但未实测的删除修正：列文件结束后延迟0.5秒再发送；只有完整目录证明同一原始条目仍存在，才允许重新完整核对后重试；最多3次，绝不把无ACK当成功。此版本已安装未启动。

诊断启动参数仅供统一计划后使用：`--verify-meeting-stream`、`--verify-immediate-stream`、`--prefer-native-opus`、`--activate-verified-cleanup`。暂停期间不要启动这些参数。旧诊断日志尚未清理，最终验收后再移除 `[DEBUG-meeting]` 仪表。

后台由主线维护 `prototype/`、4785/4787。此线未修改后台源码或重启服务；两线共享文档 `docs/opus-upload-and-cleanup-interface-status.md` 为已部署格式/预检契约。

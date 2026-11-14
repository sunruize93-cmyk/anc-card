# OPUS 上传与清理预检：已部署契约

> Historical checkpoint: see [2026-11-14 final review](release-review-2026-11-14.md) for current verified scope and publication status.


2026-11-14 15:48 KST：手机观察结束且队列空闲后，冻结候选、优雅停止、SQLite一致备份，再切换4785/4787。18项专项隔离测试和现有34项回归通过。接口已部署，设备鉴权GET及原件校验已实测；新raw OPUS的真实百炼到飞书端到端仍待一条新录音。

## OPUS 上传

仍用 `POST /v1/recordings`，原设备鉴权及原有字段不变：

```text
Authorization: Bearer <原设备凭证>
X-Recording-ID: <稳定本地ID>
X-Content-SHA256: <原始上传字节SHA-256>
X-ANC-Filename: <百分号编码且以.opus结尾的原文件名>
X-ANC-Audio-Format: qs668-raw-opus-40-v1
Content-Type: application/octet-stream
Content-Length: <原始字节数>
```

只支持 QS668 固定40字节、单声道 config9、单个20ms帧；包括实测0x48和0x4b的单帧padding编码。拒绝空输入、非整包、多帧、其他配置、越界padding及超过两小时（14,400,000字节）。`.opus`没有明确声明则拒绝；Ogg容器暂不作为外部输入。WAV/M4A/MP3原契约不变。

回执 `device/localId/recordingId/sha256/bytes/duplicate/resultPath` 不变，raw 增加 `audioFormat`。ID、哈希和长度始终对应原件。后台保存原件，再用附带MIT许可的厂商包装器生成Ogg，经macOS afconvert真实解码、严格PCM检查后走原分段ASR。解码失败为failed，可重试；不是伪造成功。

`GET /v1/recordings/:id` 增加 `audioFormat`（普通文件null）和 `decodeInfo`（尚未解码null）。解码证据包含 sourceSha256/sourceBytes、decoder/decoderVersion、wrapperVersion、nativeDecodedSha256、decodedSha256/decodedBytes、pcmSha256、sampleRate/channels/sampleCount/durationMs、packetCount/packetDurationMs/encodedDurationMs、preSkip48k=312、timestampBasis=`decoded_pcm_start`、sourcePacketOffsetMs=6.5、cardWavAlignment=`not_verified`。分段时间以实际解码PCM为准，不声称与卡内WAV逐采样相同。

实测私有raw145520字节，经解码得到1164056个16kHz样本，72.7535秒；对照卡WAV72.72秒。WAV下载28.17秒与raw2.14秒是这一条样本的BLE基准，不是端到端延迟或长会议保证。

## 手机/卡清理前置检查（只读）

```text
GET /v1/recordings/<64位recordingId>/cleanup-preflight
Authorization: Bearer <原设备凭证>
```

无请求体，不用POST，不是一次性删除token/租约；此接口从不删除后台、手机或卡的音频。当前设备必须有该录音上传回执，跨设备404、无效凭证401、后台异常502/503，均保留原音。

返回精确字段如下，值为示例：

```json
{
  "schemaVersion": "anc.cleanup-preflight.v1",
  "scope": "iphone_and_card",
  "recordingId": "<原音64位SHA-256>",
  "sourceSha256": "<同recordingId>",
  "sourceBytes": 145520,
  "audioStored": true,
  "documentRevision": 1,
  "manifestSha256": "<当前文档manifest的SHA-256>",
  "messageId": "<原飞书结果卡ID>",
  "checkedAt": "2026-11-14T06:45:00.000Z",
  "validForMs": 15000,
  "allowed": true,
  "reasons": [],
  "serverAudioRetained": true,
  "requiresDeviceChecks": ["latest_five", "historical_protection", "card_binding", "file_identity", "fresh_receipt"]
}
```

失败时allowed=false，字段可能为null，reasons为稳定代码数组：INVALID_RECORDING_ID、RECORDING_NOT_FOUND、SERVER_AUDIO_UNAVAILABLE、SERVER_AUDIO_MISMATCH、RECORDING_NOT_COMPLETE、DOCUMENT_UNAVAILABLE、DOCUMENT_NOT_READY、DOCUMENT_NOT_DELIVERED、DOCUMENT_READBACK_MISMATCH、DOCUMENT_SOURCE_MISMATCH、TRANSCRIPT_CHANGED、AUDIO_REVIEW_REQUIRED、STATE_CHANGED、PREFLIGHT_UNAVAILABLE。

允许条件：服务端实读原件长度和哈希匹配；录音complete；文档ready且当前revision/manifest投递到原卡成功；实读JSON哈希、源录音、转写摘要一致；uncertainties为空且无需回听；返回前再次检查当前版本/投递状态。15秒只是快照有效期，不提供删除原子锁。客户端临删除前刷新，核对本地已验证的同revision/manifest/原卡/原音身份，超时或时钟不确定保留。

手机负责最近五条、历史保护、正确设备/卡绑定、精确文件身份、当前空闲、幂等删除审计及丢ACK恢复。不能仅凭allowed=true清卡，不能删除后台原音。已有72.72秒产品介绍仍有待核对歧义，必须拒绝，不能为做清理测试清空真实歧义。文档receipt的retention.eligible仍为false，不代表服务端删除已开放。

## 隔离验证与部署门槛

已用真实raw做原生解码、持久化排队跨重开、注入ASR失败→重试→行动项入台账、重复导入、原件逐字节保留、WAV兼容。ASR在这组测试中是明确注入的测试替身，未调用百炼，未发送群消息，不能称为OPUS真群端到端通过。

测试入口：`node --test prototype/audio/qs668.test.mjs prototype/structured-documents/*.test.mjs prototype/mobile-gateway.test.mjs prototype/recording-delivery.test.mjs`。真实私有样本测试通过环境变量ANC_TEST_RAW_OPUS指定；没有指定则明确skip，不公开音频。

部署已完成，冻结候选和一致备份位于私有opus-preflight-cutover目录；后续用一条新录音验收raw OPUS。现有服务文档生成仍为显式ID白名单，部署后也必须把新验收ID纳入，不承诺所有新录音已有结构化文档。不要修改既有WAV时间点或重复导入已入库产品介绍。帧规则参考 [RFC 6716 §3.2.5](https://www.rfc-editor.org/rfc/rfc6716.html#section-3.2.5)。

## 当前清理目标的真实结果（15:48 KST）

指定旧录音note20261114-142941.wav，ID14504cfc2328c2ffef9061fe2485a5b0207691e68df7e89a6f325871a624bf46，317484字节原件哈希吻合。结构化文档revision1已由真实生成器生成、投递到原卡；通过现有iPhone设备凭证读回三份产物，字节/哈希均匹配。

**清理预检allowed=false，reasons=[AUDIO_REVIEW_REQUIRED]。** 文档明确保留“未说明检查完成/通过”和“今天对应日期未明确”两项不确定性，不可为了删除测试强行移除。iPhone应保持这条原音；该目标的清理成功尚未验收。后台所有原音未删除。产品介绍与新分段锁屏样本也不得代替它被清理。

此处成功证明接口、原卡投递与拒绝条件，不证明删除已完成。下一步需要真实的人工核对/纠正及其审计记录，或者另一条自然满足无待核对事项的合格目标；不得伪造审阅结果。

## 普通问候目标允许路径（15:51 KST）

新纳入显式文档白名单的note20261114-143127.wav，ID35b0e716902997d75fb92c5c2ea4cad7c22f9fec96cb9ba049c1e0af60d640e9，6.8秒/217644字节，真实转写“哈喽哈喽。”。真实生成器输出仅为问候，无实质议题；uncertainties自然为空，未人工抹除字段。

文档revision1已投递原卡om_x100b604b61e664a8cff56b7ecfc0753，manifestSha256=22d95948db36de91c02315557ac411de7286a45ffdc2feee6d02ce5e8afef589。后台预检返回allowed=true/reasons=[]。该结果只代表服务端条件通过，手机执行前必须重新GET获取15秒内快照并核对本地保护/最近五条/身份；这里没有执行删除。首条验收口令仍拒绝，不改变其文档。

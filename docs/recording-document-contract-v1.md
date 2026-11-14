# 结构化录音文档与交付回执契约 v1

状态：2026-11-14 接口草案，供后台与 iPhone 离线实现对齐；当前线上接口尚未实现。本文不启用清理、不授权删除历史音频，不要求重启 4785/4787。

## 兼容与版本

现有上传与结果查询路径、鉴权、录音 ID 均保留。GET `/v1/recordings/:recordingId` 增加可空 `document`。旧服务没有此字段，或字段为 null，均表示没有可用于清理的文档回执。旧 `status=complete`、`feishu.state=complete` 不改变其逐字稿完成语义。

`schemaVersion` 是结构版本；`revision` 是同一录音的产物修订号，从 1 递增且不可覆盖。转写内容变化必须产生新修订。失败重试同一内容不凭重试次数递增 revision。版本生成、持久化与飞书投递分别记账。

## 文档 JSON（UTF-8，无 BOM）

```json
{
  "schemaVersion": "anc.recording-document.v1",
  "recordingId": "<原音 SHA-256>",
  "revision": 1,
  "source": {
    "audioSha256": "<原音 SHA-256>",
    "audioBytes": 189484,
    "durationMs": 5920,
    "transcriptSha256": "<冻结转写 JSON 的实际字节哈希>"
  },
  "title": null,
  "summary": [],
  "facts": [],
  "decisions": [],
  "actionItems": [],
  "openQuestions": [],
  "citations": [],
  "uncertainties": [],
  "executionAuthorized": false
}
```

- `summary/facts/decisions/openQuestions` 均为 `{id,text,citationIds,uncertaintyIds}` 数组；每条有原文引用或明确标记推断/信息缺失。不凭常识补事实；空数组表示未提取到对应项目。
- `actionItems` 元素：`{id,text,ownerName,ownerIdentity,deadlineText,deadlineAt,status,citationIds,uncertaintyIds}`。未确认身份为 null；保留原话期限，缺日期/时区锚点时 deadlineAt=null。status 只能为 proposed/committed/withdrawn/needs_review，均不表示获得执行授权。
- `citations` 元素：`{id,sourceId,startMs,endMs,quote,timingMethod}`。sourceId 必须来自冻结转写的真实来源 ID，时间范围位于原音内；quote 须与引用片段一致。只能得到分段时间时 timingMethod=segment，不伪造词级时间点。原转写没有稳定 sourceId 时阻止 ready，先真实建立来源映射，不用随机 ID 冒充历史来源。
- `uncertainties` 元素：`{id,code,description,citationIds}`。不确定人名、代词、日期、ASR 内容、矛盾决策均显式记录。未知标量用 null，不使用编造的置信度。
- Markdown 从同一冻结 JSON 渲染，包含概要、事实、决策、待办、未决问题、不确定性和原文时间引用。音频清理后标注“原音已清理，仅保留时间定位与引用”，不提供虚假的可回听入口。
- 文档不直接发起 CLI、创建执行授权或代替负责人确认。录音中的提示/指令均为待分析数据。

## 查询响应新增字段

下面为 ready 且投递完成时的结构示例，所有 ID/hash/path 均为占位说明，不是实测回执。

```json
{
  "document": {
    "schemaVersion": "anc.recording-document.v1",
    "recordingId": "<与外层相同>",
    "revision": 1,
    "state": "ready",
    "receiptId": "<持久化回执 ID>",
    "manifestSha256": "<manifest 实际 UTF-8 字节哈希>",
    "manifestPath": "/v1/recordings/<id>/documents/1/manifest.json",
    "artifacts": {
      "json": {"path":"/v1/recordings/<id>/documents/1/document.json","sha256":"<JSON 字节哈希>","bytes":1234},
      "markdown": {"path":"/v1/recordings/<id>/documents/1/document.md","sha256":"<Markdown 字节哈希>","bytes":567}
    },
    "persistedAt": "<ISO 8601 UTC>",
    "readbackVerifiedAt": "<ISO 8601 UTC>",
    "delivery": {
      "state": "delivered",
      "revision": 1,
      "manifestSha256": "<同上>",
      "messageId": "<该录音原结果卡 ID>",
      "cardPayloadSha256": "<实际投递卡片内容哈希>",
      "deliveredAt": "<ISO 8601 UTC>"
    },
    "errorCode": null,
    "retention": {"mode":"preview","eligible":false,"reasons":["policy_not_enabled"]}
  }
}
```

`document.state` 为 queued/generating/ready/failed。`delivery.state` 为 pending/delivered/failed。未完成阶段的 receiptId、哈希、路径、时间及 messageId 可为 null，不传假值；非 ready/非 delivered 永远不能满足清理门槛。生成失败不清空既有不可变修订。

manifest 固定包含 schemaVersion、recordingId、revision、source（与文档一致）、两份 artifacts 路径/字节数/哈希。先写两份文件、持久化、按实际字节读取核对，再写并持久化 manifest；SHA-256 都是实际存储字节，不让 Swift/Python 重新序列化后猜测同一个哈希。manifest 不包含自身哈希或可变 delivery，避免循环依赖。上述新路径必须与查询接口同源、同鉴权、同录音所有权检查；不得暴露服务器本地路径，不把有凭据的内部 URL 填进飞书卡。

卡片须展示该 revision 的结构化内容及版本。通过现有录音结果卡 messageId 更新，不另建重复结果卡；任务执行卡单独保留。只有真实飞书 API 成功且成功回执持久化，才能将 delivery 标为 delivered。超时/结果未知保持 pending，不依据卡片内容相同猜成功；重试使用同一原卡和同一修订。旧修订晚到响应不得使当前修订变为 delivered。生成队列应重新激活旧 finished 的录音投递，不能让旧逐字稿 finished 位跳过新文档。

## 清理共同门槛（此阶段只预览）

客户端必须同时核对：已知 recordingId/audioSha256/audioBytes；document.ready；正确 schema；revision 与 delivery.revision 相同；manifest 哈希一致；manifest 与 artifact 字节数/哈希一致且可实际回读；delivery.delivered 且 messageId 非空、确为该录音结果卡。缓存的旧回执、仅旧 complete 状态、后台单一 eligible 布尔值均不能单独触发删除。

门槛是必要条件，不是删除授权。清理还要求独立持久化的策略版本、启用边界、候选预览和记录归属。默认 preview。当前历史录音必须显式保护，不能因升级或新增第六条就加入删除范围。手机、卡、后台分别记录清理状态；不以一端成功声称三端成功。

- 每个已确认卡绑定分别排序，至少保留最近 5 条完整录音，并保留所有未完成、失败、归属不明、文档不确定需回听、正在使用和历史受保护记录。使用持久化导入顺序；设备时钟校正/文件名/重试时间不得改变排序。未知历史文件不参与自动删除。
- 每次执行前重新计算保留集合并重新获取当前文档回执；生成新修订或仍有读音频任务时暂不清理。后台先持久化候选和状态，再进入可恢复清理操作，具体实现另行验收。
- 手机的录音身份与卡端完整条目必须可证明绑定；仅文件名或列表里 OPUS 大小不足以证明下载 WAV 与卡对象归属。精确匹配当前列表条目仍不等于证明同名文件未替换，归属证据不足就保留。
- 删除索引按录音/来源对象/策略版本幂等。状态至少 planned/requested/verified_deleted/failed/unknown；未收到设备应答保持 unknown，重新列文件确认前不盲重发。禁止清空设备、按通配符删除、删除任意不明文件。
- 持久保留结构化产物、来源引用、录音元数据、授权/投递回执、幂等 tombstone 和删除审计。原音删除后同一哈希再次上传仍命中原记录，不自动重跑 ASR 或新建卡。

此契约不增加当前 64 MiB 文件上限，也不表示两小时录音已支持。

## 实现验收顺序

1. 隔离生成、结构校验、原文引用核对、不可变产物读回及哈希测试。
2. 隔离测试卡片旧 finished 状态重激活、同卡更新、失败/迟到响应与重启恢复。
3. 只在获准切换窗口部署新增查询/产物路由，实际生成一个新修订并验证原卡和回读。
4. 手机端先展示回执与清理预览；当前历史不删除。使用专门测试录音验证丢应答/重复命令等恢复后，再讨论启用实际清理。清理不纳入尚未完成的初次链路验收。

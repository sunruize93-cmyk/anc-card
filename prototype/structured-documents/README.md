# 结构化文档：实现与受控现场接入

协议：`docs/recording-document-contract-v1.md`。core/service 不自行读取原音或凭据；coordinator 是显式启用的宿主适配器，会读取许可录音并每 3 秒调度。默认未设置开关时不启用。

## 最小测试

```sh
node --test prototype/structured-documents/*.test.mjs prototype/mobile-gateway.test.mjs prototype/recording-delivery.test.mjs
```

显式真实模型调用，仅使用脚本中自制文本：

```sh
ANC_DOCUMENT_LIVE=1 node prototype/structured-documents/live-smoke.mjs
```

`generator.mjs` 用本机 Codex CLI 新建 read-only 会话，只接受最终 JSON；不复用任务执行会话、不从录音得到执行授权。输出仍需人工核对语义。read-only 并非完整的敏感文件读取隔离，当前仅在可信本机与自制文本验收；上线处理不可信转写前应使用受控模型环境或无工具文本生成适配器。禁止将模型成功等同语义准确。

## 注入式组合

```js
const documents = createDocumentService({
  db: isolatedDocumentDb,
  generate: createCodexDocumentGenerator({cwd: isolatedWorkDirectory}),
  resolveBinding: async (device, recordingId) => verifiedOriginalCardBinding,
  patchOriginalCard: request => feishuClient.im.message.patch(request)
});
// 必须由后台取得真实音频大小、时长及带真实 sourceId 的冻结转写。
documents.enqueue({id, audioBytes, durationMs, transcript});
await documents.pump();
// 同一原设备网关的可选参数，不自动注入正在运行的网关。
createMobileHandler({config, db: deviceReceiptDb, host, upstream, documentService: documents});
```

`resolveBinding` 应返回原录音卡 `{appId,chatId,messageId}`，不得返回任务执行卡或模型生成ID。null 表示等待原卡。device=null 是后台投递工作者；非空时由设备映射选其群绑定。设备查询及产物路径仍先经网关原有鉴权和 receipts 所有权校验。禁止将 store/service 直接暴露为无鉴权网络路由。

工作库由唯一后台进程拥有，连接生命周期及 fsync/备份策略由宿主负责。重启会把 generating 改回 queued；因此不可让两个宿主同时初始化同一工作库。生成及投递失败由下一次显式 pump/重新 enqueue 驱动，不含自动无限重试。所有旧修订保留。

生成模块原子写入 SQLite BLOB，包括 JSON、Markdown、manifest、修订与ready状态；可按契约 URL 读回实际字节。每个产物分别校验哈希；manifest不含自身哈希。旧文档保持可读，最新生成失败时清理保持关闭。

飞书只调用 patch，不 create；独立投递表不受旧逐字稿 finished 标志阻挡。API code=0 后才记录 delivery，异常保持 pending，重试不重新生成文档。按录音/群串行投递，防止旧请求在新请求后覆盖卡。文档超过卡片当前24KB预算会保持待交付，不能伪称全文送达；分页或外部文档链接另做设计。

## 当前现场接入与限制

2026-11-14 用户明确允许切换后，4785/4787 已改为私有候选快照启动。详情见 `docs/recording-document-implementation-2026-11-14.md`；代码、数据库一致备份、实际产物与回执位于 `.anc-data/field-20261114/document-cutover/`。这不是 Git 已发布版本。

- 主服务 `ANC_RECORDING_DOCUMENTS=1`，`ANC_DOCUMENT_RECORDING_IDS` 为逗号分隔的明确录音 SHA-256 白名单。本轮仅启用一条 72.72 秒产品介绍，不自动处理全部历史录音。
- coordinator 从既有录音仓库读取原音，校验字节数、整文件 SHA-256 和 PCM WAV 时长，冻结带 sourceId 的转写。格式/哈希错误不进入模型。等待旧逐字稿卡 finished 后，才 patch 同一原卡。
- 主服务 `/api/recordings/:id/delivery` 提供可空 document；版本化产物位于 `/api/recordings/:id/documents/:revision/{manifest.json,document.json,document.md}`。主服务仍只监听 loopback。
- 独立手机网关通过固定 loopback 上游代理文档，禁止重定向，限长且校验实际长度，保留原设备鉴权和上传所有权检查；不跨进程共享 SQLite 连接。
- 当轮真实模型、原卡 patch、网关三份实际字节读回均通过；手机线也导出了真实 documentVerification 与同样的 manifest 哈希。ready 代表结构/引用/存储一致，不能当成语义准确率或执行授权。
- 生成失败不会无限重调模型；显式重新 enqueue 才重试。投递 pending 每次 pump 会重试，应在扩量前补有上限的退避和可观测告警。全文超过 24KB 卡片预算时仍保持 pending。
- `retention.eligible=false`，无音频删除 API。GET 回执不是删除许可/租约：没有锁住未来修订或音频读者。清理仍需独立设计与验收，尤其不确定性需保留回听能力时。

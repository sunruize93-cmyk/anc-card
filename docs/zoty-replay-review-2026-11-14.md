# Zoty 协议回放交付复核与下一轮

2026-11-14，韩国时间。读取 nestlinker work 的新消息并下载原包，未将附件中的建议视为操作授权；依据用户“check 并规划、给他派发新任务”执行本轮。

## 原包与复跑

- `protocol-replay.zip`：92,324 字节，SHA-256 `0a3da6f89831bc11829ccbd6dc6937bd915b7ac57c27f6327020b5a1f61ed2a5`，与交付相符。
- Zoty 声明提交 `6215d084d0d5a390d0b2da5cb617c04abc235e39`，未推送；本次验证 ZIP 字节及其内源码，不把声明当作远端仓库验证。
- 私有目录 `.anc-data/field-20261114/zoty-replay-review/ancrelay-protocol-replay/`。解压前检查路径、符号链接与总大小。
- 使用已有 Python 3.12 环境，只跑离线回放，未连接蓝牙卡；回放 14 项，10 passed、4 expected failures。
- 四个缺口单独设置 REPLAY_SHOW_GAPS=1，实际得到 3 个断言失败、1 个明确电量查询超时；根因与交接一致，不是缺依赖导致的假失败。
- 原项目 tests/ 的 105 项通过，第三方厂商协议测试另 5/5 通过。注意该目录无包初始化，unittest 用 `discover -s tests -v`，不能加 `-t .`；replay/ 则可按 README 命令运行。
- 根 LICENSE 的 MIT 署名 JIN HAIMIN 与范围已核对；第三方 qs668 单独保留厂商许可与来源。本轮未发布源码。

## 缺口与 iPhone 对照

| 场景 | Windows 实际复现 | 当前 iPhone 代码核对 | 结论 |
| --- | --- | --- | --- |
| G2 c | 录音状态未结束就下载新列表文件 | 已有 cardIsRecording 和状态/过渡期门禁 | 不直接移植 Windows 缺陷判断；仍需 iPhone 回归证据 |
| G2 d | 下载等待者丢掉 3-3，漏掉本轮第二条 | 按键事件在 list/download 状态机前分发 | iPhone 不同结构；Windows 修复与跨语言场景有价值 |
| G3 c | 上轮 2-18 残留使下轮返回空列表 | 无相同全局取帧队列，但迟到结束帧仍可能混入 collector | 尚需针对 iPhone collector 的迟到帧回归，不据源码宣称已通过 |
| G3 d | 半帧 LEN 等待堵住后续同通道回复 | 断连会 reset 两路 parser，连接内恢复未据此实测 | 后续单独研究恢复策略；不能以任意丢字节破坏合法分片 |

iPhone 长录音锁屏未成功自动取音是单独的真实问题。上述压缩时间的 Windows asyncio 回放没有 iOS 挂起/唤醒证据，不能用于验收锁屏。

## 已派发下一轮

群：nestlinker work；已 @Zoty，消息 ID `om_x100b604ba1fd2104ce3513a550b9149`，SDK 成功并在群页面核对标题、@人与正文。

只修两项：G2 d 保存事件不被下载吞掉；G3 c 旧列表结束帧不误结束新请求。不连卡、不改当前 iOS、不调 API、不新增重工具；另外两项继续标明 expectedFailure。

要求保留修前失败证据，将已修两项改为普通成功断言，原 10 项不回退。禁止用不可靠 SEQ 作请求关联，禁止清空全部队列误删异步事件。对请求发出后才来的不可区分旧帧，明确采用有界恢复/不确定状态，不编造成功。给出重复/乱序/迟到回归和队列生命周期边界。

交付 `protocol-routing-fix.zip`：代码差异、修前/修后日志与命令、版本/提交号/包哈希、语言无关场景 JSON、MIT 和第三方来源。完成两项后等待融合反馈，暂不追加五卡或长录音硬件试验。

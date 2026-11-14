# 门诊分段转写

`clinic_turns` 从整段音频取得匿名说话人边界；`clinic_asr` 对每个原声片段使用 `qwen3-asr-flash` 的自动语言识别模式。所有片段使用同一份固定多语词表，版本为 `anc-clinic-file-v1`。收据中的 `dictionaryTerms` 完整记录发送的词表。设备、患者、说话人或样本文件名不参与词表选择。

词表包括初诊、复诊、咨询、预约和费用的常用表达，并列出韩元、日元、人民币、美元。韩文的 `초진진찰료` 和 `재진진찰료` 可核对[韩国健康保险审查评价院公布的诊察料名称](https://www.hira.or.kr/rc/drug/insuadtcrtr/bbsView.do?brdBltNo=52865&brdScnBltNo=4&isPopupYn=Y&pgmid=HIRAA030069000400)。另外三种语言及韩国口语简称作为工程词表使用。阿里云将非实时 ASR 的 system 消息定义为可选的背景或实体词参考；请求沿用自动语种，并在 user 消息中发送原声。[阿里云非实时 ASR API](https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference)

安装运行 `sh prototype/scripts/setup-speakmode.sh --clinic-only`。脚本从固定提交 `6ba4432d91727d300ba6f3e4b1a9e29d37064a64` 的 Git 对象读取 `file_asr_lab.rs`，应用相邻的 `clinic_asr.patch`，并把话轮划分和原声云转写编入同一个 clinic_session。两个旧程序保留独立调用的兼容入口。

评估时保留原音 SHA、实际识别文本、词表版本与同一段原声的对照结果。词表是可能的词形，不代表患者提到了该实体。单独检查币种和金额、收费范围、否定与预约动作，并纳入从未用于选词的录音。缺少录音佐证的费用内容须由人工核对。

普通录音的两个原生处理入口都会在当前进程内调用 macOS Security.framework 的 `SecKeychainSetUserInteractionAllowed(false)`，确认 `SecKeychainGetUserInteractionAllowed` 返回禁止交互后才调用 SpeakMode 的原生凭据接口。禁止交互未生效或无法静默读取时，程序返回 `clinic_keychain_access_required` 并结束。SpeakMode 把项目不存在和访问受限合并为同类错误；这一返回值不能单独证明是哪种原因。程序不修改钥匙串项目、系统设置或访问权限。命令 `clinic_session --capabilities` 可无凭据检查这两个入口。前台运行 `npm run authorize:clinic` 时，实际程序向 macOS 发起一次交互式授权；普通录音任务不会发起这一步。

`npm run start:clinic:local` 选择已在 Apple Silicon Mac 验证的路径。SpeakMode 云端负责话轮划分，本机转写按 `clinic_terms.json` 的固定词表运行，录音收据绑定音频、词表哈希和模型版本。另一个全云模式在本次测试中于第二步收到 `file_asr_service_error`。

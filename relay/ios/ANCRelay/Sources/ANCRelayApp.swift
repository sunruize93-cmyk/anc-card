import SwiftUI
import UIKit

final class RelayBootstrap: ObservableObject {
    static let shared = RelayBootstrap()
    @Published private(set) var model: RelayModel?
    @Published private(set) var failure = "正在读取本地状态"

    func start() {
        guard model == nil else { return }
        do {
            let model = RelayModel(store: try RelayStore())
            self.model = model
            model.start()
        } catch {
            failure = "无法读取本地状态。请先解锁手机并重开应用；若仍失败，请保留应用数据交给开发者，勿卸载。"
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        RelayBootstrap.shared.start()
        return true
    }

    func application(_ application: UIApplication,
                     handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        RelayBootstrap.shared.start()
        guard identifier == BackgroundUploader.identifier,
              let model = RelayBootstrap.shared.model else { completionHandler(); return }
        model.uploader.handleBackgroundEvents(completion: completionHandler)
    }
}

@main
struct ANCRelayApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var bootstrap = RelayBootstrap.shared

    var body: some Scene {
        WindowGroup {
            if let model = bootstrap.model {
                RelayView(model: model)
            } else {
                VStack(spacing: 16) {
                    Text("ANC Card").font(.title)
                    Text(bootstrap.failure)
                    Button("重试读取") { bootstrap.start() }
                }.padding()
            }
        }
    }
}

struct RelayView: View {
    @ObservedObject var model: RelayModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var showsSettings = false

    var body: some View {
        NavigationStack {
            List {
                Section("连接与设备") {
                    Text(model.connection)
                    if let binding = model.state.binding {
                        Text("绑定：\(binding.name)")
                        Text(binding.peripheralID.uuidString).font(.caption).textSelection(.enabled)
                        Text(binding.baselineReady ? "基线已保存：\(binding.baseline.count) 个文件" : "首次列文件中；已有录音不会下载")
                    } else {
                        Text("首次绑定仅记录基线。请先绑定，再按卡上的保存键生成新录音。")
                        Button("重新扫描") { model.scan() }
                        ForEach(model.cards) { card in
                            Button { model.bind(card) } label: {
                                VStack(alignment: .leading) {
                                    Text("绑定 \(card.name) · \(card.rssi) dBm")
                                    Text(card.id.uuidString).font(.caption)
                                }
                            }
                        }
                    }
                    LabeledContent("电量", value: model.battery)
                    LabeledContent("固件", value: model.firmware)
                    LabeledContent("录音状态", value: model.recordingState)
                    Button("重新对账与同步") { model.requestSync() }
                }
                if !model.notice.isEmpty {
                    Section("提示") { Text(model.notice).foregroundColor(.orange) }
                }
                Section("最近同步") {
                    if model.state.recordings.isEmpty { Text("暂无新增录音") }
                    ForEach(Array(model.state.recordings.reversed())) { record in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(record.filename).font(.headline)
                            Text("\(record.status.label) · \(record.bytes) 字节 · 尝试 \(record.attempts) 次")
                            Text("SHA-256：\(record.sha256.isEmpty ? "待计算" : String(record.sha256.prefix(8)))")
                                .font(.caption.monospaced())
                            Text(record.message).font(.caption)
                                .foregroundColor(record.status == .failed ? .red : .secondary)
                            if let documentMessage = record.documentMessage {
                                Text(documentMessage).font(.caption)
                            }
                            if let verified = record.documentVerification, verified.matches(record.delivery?.document) {
                                let documentDirectory = model.store.root.appendingPathComponent("documents")
                                    .appendingPathComponent(record.id.uuidString).appendingPathComponent(String(verified.revision))
                                ShareLink("导出结构化 Markdown", item: documentDirectory.appendingPathComponent("document.md"))
                                ShareLink("导出 AI 可读 JSON", item: documentDirectory.appendingPathComponent("document.json"))
                            }
                            if let receipt = record.receipt {
                                Text("回执 ID：\(receipt.recordingID)").font(.caption).textSelection(.enabled)
                                Text(receipt.duplicate ? "后台标记：重复" : "后台标记：首次接收").font(.caption)
                                Text(receipt.integrityMessage).font(.caption)
                                    .foregroundColor(receipt.integrityConfirmed ? .secondary : .orange)
                            }
                            if record.audioPrunedAt != nil {
                                Text("音频已清理，文档与历史记录保留").font(.caption)
                            } else if record.status == .failed {
                                Button("保留原件并重试") { model.retry(record.id) }.buttonStyle(.bordered)
                            } else if record.status == .receipted {
                                Button("重发核对重复回执") { model.retry(record.id) }.buttonStyle(.bordered)
                            }
                        }.padding(.vertical, 4)
                    }
                }
                Section("本地日志") {
                    NavigationLink("查看同步日志") {
                        ScrollView { Text(model.logText).font(.caption.monospaced()).textSelection(.enabled).padding() }
                            .navigationTitle("同步日志")
                    }
                    ShareLink(item: model.store.logURL) { Label("导出日志", systemImage: "square.and.arrow.up") }
                    Text("日志含本地录音 ID 与事件时间，不包含凭证。导出前请确认分享对象。")
                        .font(.caption).foregroundColor(.secondary)
                }
            }
            .navigationTitle("ANC Card")
            .toolbar { Button("保留设置") { showsSettings = true } }
            .sheet(isPresented: $showsSettings) { RetentionSettingsView(model: model) }
            .onChange(of: scenePhase) { _, phase in
                model.store.log("应用场景 · " + (phase == .active ? "前台" : phase == .background ? "后台" : "非活跃"))
                if phase == .active { model.becameActive() }
            }
        }
    }
}

struct RelaySettingsView: View {
    @ObservedObject var model: RelayModel
    @Environment(\.dismiss) private var dismiss
    @State private var endpoint = ""
    @State private var token = ""
    @State private var errorMessage = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("完整 HTTPS 上传地址") {
                    TextField("https://relay.example.test", text: $endpoint)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    Text("填写后台提供的完整接口地址（包含路径），不自动拼接。地址不得包含凭证、查询参数或片段。")
                        .font(.caption)
                }
                Section("上传凭证") {
                    SecureField("填写新凭证；留空保留已有凭证", text: $token)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text("凭证仅保存在本机钥匙串，不显示已有值。设备重启后需至少解锁一次。")
                        .font(.caption)
                }
                if !errorMessage.isEmpty { Text(errorMessage).foregroundColor(.red) }
                Button("保存设置") {
                    do {
                        try model.saveSettings(endpoint: endpoint, token: token)
                        token = ""
                        dismiss()
                    } catch {
                        errorMessage = "设置保存失败，请检查 HTTPS 地址与凭证格式，或先解锁手机。"
                    }
                }
            }
            .navigationTitle("上传设置")
            .toolbar { Button("关闭") { token = ""; dismiss() } }
            .onAppear { endpoint = model.state.endpoint }
            .onDisappear { token = "" }
        }
    }
}

struct RetentionSettingsView: View {
    @ObservedObject var model: RelayModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section("音频保留策略") {
                    Toggle("交付成功后保留最近 5 条音频", isOn: Binding(
                        get: { model.state.retentionSettings?.keepLatestFive == true },
                        set: { model.setRetentionPreference($0) }))
                    Text("范围：iPhone 缓存、录音卡原音。文档与历史索引保留；失败、待处理及归属不明的音频始终保留。")
                }
                Section(model.state.retentionSettings?.executionEnabled == true ? "自动清理已接通" : "清理验证中") {
                    Text("最近 5 条完整录音始终保留；较旧录音只有在文档与飞书交付重新核对、卡内文件内容一致时才清理。首次绑定前的旧文件与归属不明文件不清理。")
                    LabeledContent("拟清理", value: "\(model.retentionPreview.values.filter { $0 == .eligible }.count) 条")
                    LabeledContent("继续保留", value: "\(model.retentionPreview.values.filter { $0 != .eligible }.count) 条")
                    Text("先确认卡端单文件删除，再移除手机副本。后台原音、文档与历史记录保留；关闭策略会停止后续自动清理。")
                        .font(.caption).foregroundColor(.secondary)
                }
            }.navigationTitle("音频保留")
             .toolbar { Button("完成") { dismiss() } }
        }
    }
}

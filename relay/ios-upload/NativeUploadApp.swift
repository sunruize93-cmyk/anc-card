import SwiftUI
import UniformTypeIdentifiers
import CryptoKit
import Security

private struct DeviceConfiguration: Codable {
    let baseURL: String
    let token: String
    let device: String
    let expiresAt: Double
}
private let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]

private func protect(_ url: URL) throws {
    var u = url; var values = URLResourceValues(); values.isExcludedFromBackup = true
    try u.setResourceValues(values)
    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: u.path)
}
private func configuration() throws -> DeviceConfiguration {
    let url = documents.appendingPathComponent("device-import.json")
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "ANCUploadSmoke", kSecAttrAccount as String: "upload-device"]
    if FileManager.default.fileExists(atPath: url.path) {
        try protect(url)
        let data = try Data(contentsOf: url)
        let config = try JSONDecoder().decode(DeviceConfiguration.self, from: data)
        _ = try uploadEndpoint(config.baseURL)
        guard config.token.count == 64 else { throw UploadFailure.message("设备配置无效") }
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        let status = updated == errSecItemNotFound ? SecItemAdd(query.merging(attributes) { _, b in b } as CFDictionary, nil) : updated
        guard status == errSecSuccess else { throw UploadFailure.message("无法保存设备钥匙串") }
        try FileManager.default.removeItem(at: url) // Only this one-time credential import; never an audio original.
    }
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query.merging([kSecReturnData as String: true]) { _, b in b } as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else { throw UploadFailure.message("请先通过 Mac 配置本机上传凭证。") }
    return try JSONDecoder().decode(DeviceConfiguration.self, from: data)
}

private final class SecureTransport: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    let host: String
    let certificate: SecCertificate
    init(host: String, certificate: Data) throws {
        self.host = host
        guard let c = SecCertificateCreateWithData(nil, certificate as CFData) else { throw UploadFailure.message("测试 CA 无效") }
        self.certificate = c
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == host, let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        // Keep hostname, expiry and chain validation; trust only the explicitly provisioned test CA.
        let policy = SecPolicyCreateSSL(true, host as CFString)
        guard SecTrustSetPolicies(trust, policy) == errSecSuccess,
              SecTrustSetAnchorCertificates(trust, [certificate] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil) else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil) // Never forward an upload token to a redirect destination.
    }
}

@MainActor final class UploadModel: ObservableObject {
    @Published var status = "正在准备本机配置…"
    @Published var receiptText = ""
    @Published var busy = false
    @Published var selectedName = "尚未选择 WAV"
    @Published var server = ""
    private var selected: URL?
    private var config: DeviceConfiguration?
    private var session: URLSession?
    private var transport: SecureTransport?
    private var lastReceipt: UploadReceipt?
    private var started = false
    func prepare() {
        guard !started else { return }; started = true
        do {
            let c = try configuration(); let base = try uploadEndpoint(c.baseURL)
            let ca = try Data(contentsOf: documents.appendingPathComponent("test-ca.der"))
            let transport = try SecureTransport(host: base.host!, certificate: ca)
            let sc = URLSessionConfiguration.ephemeral
            sc.timeoutIntervalForRequest = 90; sc.timeoutIntervalForResource = 120
            sc.httpAdditionalHeaders = ["User-Agent": "ANCNativeUpload/0.1"]
            self.transport = transport; self.session = URLSession(configuration: sc, delegate: transport, delegateQueue: nil)
            self.config = c; server = c.baseURL
            if let data = try? Data(contentsOf: documents.appendingPathComponent("receipt.json")) {
                lastReceipt = try? JSONDecoder().decode(UploadReceipt.self, from: data)
            }
            status = "已配置 \(c.device)，请选择 WAV 上传。"
            if ProcessInfo.processInfo.arguments.contains("--verify-existing-wav") {
                Task { await useSampleAndUpload() }
            }
        } catch { status = error.localizedDescription }
    }
    private func request(_ path: String) throws -> URLRequest {
        guard let c = config else { throw UploadFailure.message("未配置设备") }
        guard Date().timeIntervalSince1970 * 1000 < c.expiresAt else { throw UploadFailure.message("上传凭证已过期，请在 Mac 端更新。") }
        let base = try uploadEndpoint(c.baseURL)
        var r = URLRequest(url: base.appendingPathComponent(path))
        r.setValue("Bearer " + c.token, forHTTPHeaderField: "Authorization")
        r.setValue("ios-native", forHTTPHeaderField: "X-ANC-Client")
        return r
    }
    func select(_ source: URL) throws {
        guard !busy else { return }
        let access = source.startAccessingSecurityScopedResource()
        defer { if access { source.stopAccessingSecurityScopedResource() } }
        let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 44 && size <= 64 * 1024 * 1024 && source.pathExtension.lowercased() == "wav" else {
            throw UploadFailure.message("请选择 64 MiB 以内的 WAV。")
        }
        let data = try Data(contentsOf: source)
        guard data.starts(with: Data("RIFF".utf8)), data[8..<12] == Data("WAVE".utf8) else {
            throw UploadFailure.message("不是有效的 RIFF/WAVE 文件。")
        }
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let destination = documents.appendingPathComponent("native-" + digest + ".wav")
        try data.write(to: destination, options: .atomic); try protect(destination)
        selected = destination; selectedName = source.lastPathComponent; status = "已保存本机副本，等待上传。"
    }
    func useSampleAndUpload() async {
        do { try select(documents.appendingPathComponent("A-card.wav")); await upload() }
        catch { status = error.localizedDescription; recordEvent(["stage": "error", "error": status]) }
    }
    func upload() async {
        guard !busy, let file = selected, let session, let config else { return }
        busy = true; defer { busy = false }
        do {
            let data = try Data(contentsOf: file)
            let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            var r = try request("v1/recordings"); r.httpMethod = "POST"
            r.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
            r.setValue(String(data.count), forHTTPHeaderField: "Content-Length")
            r.setValue("native-" + digest, forHTTPHeaderField: "X-Recording-ID")
            r.setValue(digest, forHTTPHeaderField: "X-Content-SHA256")
            r.setValue(selectedName.addingPercentEncoding(withAllowedCharacters: .alphanumerics), forHTTPHeaderField: "X-ANC-Filename")
            status = "正在上传，原音副本已保存在手机…"
            let (body, response) = try await session.upload(for: r, fromFile: file)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard [200,201].contains(code) else { throw UploadFailure.message("后台拒绝上传（HTTP \(code)）。可用同一文件重试。") }
            let receipt = try JSONDecoder().decode(UploadReceipt.self, from: body)
            try receipt.validate(status: code, digest: digest, size: data.count, expectedDevice: config.device)
            let path = documents.appendingPathComponent("receipt.json")
            try body.write(to: path, options: .atomic); try protect(path)
            lastReceipt = receipt
            receiptText = "HTTP \(code) · \(receipt.bytes) 字节\n重复：\(receipt.duplicate ? "是（复用既有录音）" : "否")\nSHA-256：\(receipt.sha256)"
            recordEvent(["stage":"uploaded", "httpStatus":code, "sha256":digest, "localId":receipt.localId, "duplicate":receipt.duplicate])
            status = "上传回执已核对，等待后台和飞书…"
            for _ in 0..<24 {
                if try await queryResult() { return }
                try await Task.sleep(for: .seconds(5))
            }
            status = "后台仍在处理，可稍后刷新结果；不要重复创建任务。"
        } catch { status = error.localizedDescription; recordEvent(["stage":"error", "error":status]) }
    }
    private func queryResult() async throws -> Bool {
        guard let receipt = lastReceipt, let session else { throw UploadFailure.message("尚无上传回执") }
        let r = try request("v1/recordings/" + receipt.recordingId)
        let (data, response) = try await session.data(for: r)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw UploadFailure.message("结果查询失败，请稍后刷新。") }
        let result = try JSONDecoder().decode(DeliveryResult.self, from: data)
        guard result.recordingId == receipt.recordingId else { throw UploadFailure.message("结果录音 ID 不一致") }
        let path = documents.appendingPathComponent("delivery.json")
        try data.write(to: path, options: .atomic); try protect(path)
        if result.status == "complete" && result.feishu.state == "complete", let messageId = result.feishu.messageId, !messageId.isEmpty {
            status = "转写完成 · 飞书结果卡已就绪"
            receiptText += "\n飞书消息：" + messageId
            recordEvent(["stage":"feishu-complete","recordingId":result.recordingId,"messageId":messageId])
            return true
        }
        if result.error != nil || result.feishu.error != nil { throw UploadFailure.message("后台处理或飞书投递失败，回执已保存，请检查后台后刷新。") }
        status = "后台状态：\(result.status) · 飞书：\(result.feishu.state)"
        return false
    }
    func refresh() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do { _ = try await queryResult() } catch { status = error.localizedDescription }
    }
    private func recordEvent(_ entry: [String: Any]) {
        var row = entry; row["at"] = ISO8601DateFormatter().string(from: Date()); row["client"] = "ios-native"
        let path = documents.appendingPathComponent("native-events.jsonl")
        guard var line = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { return }
        line.append(10)
        if !FileManager.default.fileExists(atPath: path.path) { FileManager.default.createFile(atPath: path.path, contents: nil) }
        if let h = try? FileHandle(forWritingTo: path) { defer { try? h.close() }; try? h.seekToEnd(); try? h.write(contentsOf: line); try? protect(path) }
    }
}

@main struct NativeUploadApp: App {
    @StateObject private var model = UploadModel()
    @State private var importing = false
    var body: some Scene {
        WindowGroup {
            NavigationStack {
                Form {
                    Section("1 · 原生上传验收") {
                        Text("现有 WAV → 后台 → 飞书").font(.headline)
                        Text("此版需要选择已有文件；蓝牙自动取音尚未接入。").font(.footnote)
                        Text(model.server).font(.caption)
                    }
                    Section("2 · 录音文件") {
                        Text(model.selectedName)
                        Button("选择 iPhone 文件中的 WAV") { importing = true }.disabled(model.busy)
                        Button("上传所选 WAV") { Task { await model.upload() } }.disabled(model.busy)
                        Button("使用 A 卡现有样本并上传") { Task { await model.useSampleAndUpload() } }.disabled(model.busy)
                    }
                    Section("3 · 处理结果") {
                        if model.busy { ProgressView() }
                        Text(model.status).accessibilityIdentifier("upload-status")
                        Text(model.receiptText).font(.caption).textSelection(.enabled)
                        Button("刷新后台与飞书状态") { Task { await model.refresh() } }.disabled(model.busy)
                    }
                }.navigationTitle("ANC 原生上传").task { model.prepare() }
                .fileImporter(isPresented: $importing, allowedContentTypes: [.wav]) { result in
                    do { try model.select(result.get()) } catch { model.status = error.localizedDescription }
                }
            }
        }
    }
}

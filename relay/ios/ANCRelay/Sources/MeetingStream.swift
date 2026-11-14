import Foundation

/// Real card audio reception during a user-started recording, not a timer keepalive.
/// Segments are diagnostic backups, never treated as a complete saved recording.
final class MeetingStream {
    private let root: URL
    private let log: (String) -> Void
    private var handle: FileHandle?
    private var bytes = 0
    private var packets = 0
    private var lastSummary: TimeInterval = 0
    private var segmentURL: URL?
    private var active = false
    private var clock: TimeInterval { ProcessInfo.processInfo.systemUptime }
    init(root: URL, log: @escaping (String) -> Void) { self.root = root; self.log = log }
    func begin() throws {
        guard !active else { return }
        try RelayStore.prepareDirectory(root)
        let url = root.appendingPathComponent(UUID().uuidString + ".opus.part")
        try Data().write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        handle = try FileHandle(forWritingTo: url); segmentURL = url
        bytes = 0; packets = 0; lastSummary = clock; active = true
        log("[DEBUG-meeting] 开始接收真实录音数据；分段仅作备份，停录后仍下载完整文件")
    }
    func receive(_ data: Data) {
        guard active else { return }
        guard !data.isEmpty, data.count % 40 == 0, bytes + data.count <= 32 * 1024 * 1024 else {
            end(reason: "数据帧不合法或达到备份上限"); return
        }
        do { try handle?.write(contentsOf: data); bytes += data.count; packets += data.count / 40 }
        catch { end(reason: "备份写盘失败"); return }
        if clock - lastSummary >= 5 {
            lastSummary = clock
            log("[DEBUG-meeting] 录音数据通知 · 累计 \(packets) 包 / \(bytes) 字节")
        }
    }
    func end(reason: String) {
        guard active else { return }
        try? handle?.synchronize(); try? handle?.close(); handle = nil; active = false
        if let segmentURL,
           let data = try? JSONSerialization.data(withJSONObject: ["bytes":bytes,"packets":packets,"reason":reason,"completeRecording":false]) {
            try? data.write(to: segmentURL.appendingPathExtension("json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
        log("[DEBUG-meeting] 录音数据分段结束 · \(reason) · \(bytes) 字节；不作为完整录音上传")
    }
}

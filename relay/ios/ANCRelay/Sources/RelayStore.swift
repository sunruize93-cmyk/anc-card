import Foundation
import CryptoKit

enum RecordingStatus: String, Codable {
    case pendingDownload, downloaded, uploading, receipted, failed
    var label: String {
        switch self {
        case .pendingDownload: return "待下载"
        case .downloaded: return "已落盘"
        case .uploading: return "上传中"
        case .receipted: return "已回执"
        case .failed: return "失败"
        }
    }
}

struct CardBinding: Codable {
    var id = UUID()
    var peripheralID: UUID
    var name: String
    var baseline: Set<String> = []
    var baselineReady = false
}

struct Recording: Codable, Identifiable {
    var id = UUID()
    var bindingID: UUID
    var sourceName: String
    var filename: String
    var audioFormat: RecordingAudioFormat?
    var relativePath: String?
    var bytes: Int64 = 0
    var sha256 = ""
    var status: RecordingStatus = .pendingDownload
    var attempts = 0
    var receipt: V1UploadReceipt?
    var delivery: V1Delivery?
    var documentVerification: DocumentVerification?
    var documentMessage: String?
    var documentAllowsCleanup: Bool?
    var cleanup: AudioCleanupJournal?
    var audioPrunedAt: Date?
    var uploadLocalID: String?
    var message = "等待蓝牙下载"
    var nextAttempt: Date?
    var authenticationBlocked = false
    var requiresAttention = false
    var createdAt = Date()
}

struct AudioCleanupJournal: Codable {
    var deleteAttempts: Int?
    var phase: String
    var rawRecord: Data?
    var proof: DocumentVerification?
    var updatedAt: Date
    var message: String?
}

struct RetentionSettings: Codable {
    var executionEnabled: Bool?
    var keepLatestFive: Bool
    var protectedThroughOrder: Int
    var configuredAt: Date
}

struct RelayState: Codable {
    var version = 1
    var endpoint = "https://relay.example.test"
    var binding: CardBinding?
    var recordings: [Recording] = []
    var retentionSettings: RetentionSettings?
    var preferNativeOpus: Bool?
}

enum RelayFailure: LocalizedError {
    case message(String)
    var errorDescription: String? {
        if case .message(let value) = self { return value }
        return "操作失败"
    }
}

// 所有状态修改在主队列串行执行，先原子写盘，再发布新快照。
final class RelayStore {
    private(set) var state: RelayState
    let root: URL
    private let stateURL: URL
    let logURL: URL
    var onChange: (() -> Void)?

    init() throws {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory,
                                          in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("ANCRelay", isDirectory: true)
        let persistedState = directory.appendingPathComponent("state.json")
        let loaded: RelayState
        try Self.prepareDirectory(directory)
        try Self.prepareDirectory(directory.appendingPathComponent("recordings", isDirectory: true))
        try Self.prepareDirectory(directory.appendingPathComponent("temporary", isDirectory: true))
        if FileManager.default.fileExists(atPath: persistedState.path) {
            loaded = try JSONDecoder().decode(RelayState.self, from: Data(contentsOf: persistedState))
            guard loaded.version == 1 else { throw RelayFailure.message("本地状态版本不支持，请保留数据联系开发者") }
        } else {
            loaded = RelayState()
        }
        root = directory
        stateURL = persistedState
        logURL = directory.appendingPathComponent("events.log")
        state = loaded
    }

    static func prepareDirectory(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var directory = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
    }

    func commit(_ change: (inout RelayState) throws -> Void) throws {
        dispatchPrecondition(condition: .onQueue(.main))
        var updated = state
        try change(&updated)
        let data = try JSONEncoder().encode(updated)
        try data.write(to: stateURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        state = updated
        onChange?()
    }

    func update(_ id: UUID, _ change: (inout Recording) -> Void) throws {
        try commit { state in
            guard let index = state.recordings.firstIndex(where: { $0.id == id }) else {
                throw RelayFailure.message("本地录音记录不存在")
            }
            change(&state.recordings[index])
        }
    }

    func recording(_ id: UUID) -> Recording? { state.recordings.first { $0.id == id } }

    func temporaryURL(_ id: UUID) -> URL {
        root.appendingPathComponent("temporary").appendingPathComponent(id.uuidString + ".part")
    }

    func destinationURL(_ recording: Recording) -> URL {
        root.appendingPathComponent("recordings").appendingPathComponent(recording.id.uuidString)
            .appendingPathComponent(SafeFilename.sanitize(recording.filename))
    }

    func fileURL(_ recording: Recording) -> URL? {
        guard let path = recording.relativePath else { return nil }
        let url = root.appendingPathComponent(path).standardizedFileURL
        let allowed = root.appendingPathComponent("recordings").standardizedFileURL.path + "/"
        guard url.path.hasPrefix(allowed) else { return nil }
        return url
    }

    func adoptFile(_ url: URL, id: UUID) throws {
        guard let record = recording(id) else { throw RelayFailure.message("录音不存在") }
        let metadata = try Self.inspectAudio(url, format: record.audioFormat ?? .wav)
        let prefix = root.path + "/"
        guard url.path.hasPrefix(prefix) else { throw RelayFailure.message("落盘路径不在应用目录") }
        try update(id) {
            $0.relativePath = String(url.path.dropFirst(prefix.count))
            $0.bytes = metadata.bytes
            $0.sha256 = metadata.sha256
            $0.status = .downloaded
            $0.message = (record.audioFormat == .qs668RawOpus40 ? "OPUS 分包与原件哈希已校验，等待后台解码" : "WAV 已校验，等待上传")
            $0.nextAttempt = nil
            $0.requiresAttention = false
        }
    }

    static func inspectWAV(_ url: URL) throws -> (bytes: Int64, sha256: String) {
        try inspectAudio(url, format: .wav)
    }

    static func inspectAudio(_ url: URL, format: RecordingAudioFormat) throws -> (bytes: Int64, sha256: String) {
        if format == .wav { _ = try WAVValidator.validate(fileURL: url) }
        else { _ = try RawOpusValidator.validate(fileURL: url) }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hash = SHA256()
        var count: Int64 = 0
        while let data = try handle.read(upToCount: 256 * 1024), !data.isEmpty {
            hash.update(data: data)
            count += Int64(data.count)
        }
        return (count, hash.finalize().map { String(format: "%02x", $0) }.joined())
    }

    // 只接收应用自己组织的事件，不写请求头、凭证、服务器原文或底层错误描述。
    func log(_ message: String) {
        let line = ISO8601DateFormatter().string(from: Date()) + " " + message + "\n"
        guard let data = line.data(using: .utf8) else { return }
        do {
            if !FileManager.default.fileExists(atPath: logURL.path) {
                try data.write(to: logURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            } else {
                let handle = try FileHandle(forWritingTo: logURL)
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: data)
            }
        } catch {
            // 日志失败不掩盖已持久化的传输状态。
        }
        onChange?()
    }

    func readLog() -> String {
        // 界面仅显示尾部，导出保留全量日志。
        guard let handle = try? FileHandle(forReadingFrom: logURL) else { return "尚无日志" }
        defer { try? handle.close() }
        do {
            let size = try handle.seekToEnd()
            try handle.seek(toOffset: size > 128_000 ? size - 128_000 : 0)
            return String(decoding: try handle.readToEnd() ?? Data(), as: UTF8.self)
        } catch { return "日志暂时不可读" }
    }
}

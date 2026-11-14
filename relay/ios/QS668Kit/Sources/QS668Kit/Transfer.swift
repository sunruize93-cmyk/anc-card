import Foundation

public struct FileEntry: Codable, Equatable, Sendable {
    public let durationOrTime: UInt32
    public let size: UInt32
    public let name: String
    public let rawRecord: Data?

    public init(durationOrTime: UInt32, size: UInt32, name: String, rawRecord: Data? = nil) {
        self.durationOrTime = durationOrTime
        self.size = size
        self.name = name
        self.rawRecord = rawRecord
    }
}

public enum CardFileList {
    public static func parse(_ parameters: Data) throws -> [FileEntry] {
        let bytes = Array(parameters)
        guard bytes.count >= 4 else { throw CardProtocolError.malformedList }
        func readBigEndian(_ offset: Int) -> UInt32 {
            bytes[offset..<(offset + 4)].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        }
        let count = Int(readBigEndian(0))
        // 先通过可用字节校验，避免不可信计数导致过量分配。
        guard (bytes.count - 4) % 28 == 0, count == (bytes.count - 4) / 28 else {
            throw CardProtocolError.malformedList
        }
        return (0..<count).map { index in
            let offset = 4 + index * 28
            return FileEntry(durationOrTime: readBigEndian(offset), size: readBigEndian(offset + 4),
                             name: decodeCardText(Data(bytes[(offset + 8)..<(offset + 28)])), rawRecord: Data(bytes[offset..<(offset + 28)]))
        }
    }

    public static func newEntries(known: Set<String>, entries: [FileEntry]) -> [FileEntry] {
        var seen = known
        return entries.filter { !$0.name.isEmpty && seen.insert($0.name).inserted }
    }
}

public func importNameCandidates(_ listName: String) -> [String] {
    let name = listName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else { return [] }
    if name.hasSuffix(".") { return [name + "wav", name + "opus", name] }
    if name.lowercased().hasSuffix(".wav") { return [name, String(name.dropLast(4)) + ".opus"] }
    if name.lowercased().hasSuffix(".opus") { return [String(name.dropLast(5)) + ".wav", name] }
    return [name + ".wav", name + ".opus", name]
}

public struct FileListCollector {
    public private(set) var isFinished = false
    private var entries: [FileEntry] = []
    private var initialDeadline: TimeInterval
    private var lastListTime: TimeInterval?
    private let maximumEntries = 100_000
    private let requireExplicitEnd: Bool

    public init(now: TimeInterval, requireExplicitEnd: Bool = false) { initialDeadline = now + 4; self.requireExplicitEnd = requireExplicitEnd }

    /// 实际写入后调用，避免 GATT 排队消耗初次应答时间。
    public mutating func requestWasSent(at now: TimeInterval) {
        guard !isFinished, lastListTime == nil else { return }
        initialDeadline = now + 4
    }

    public mutating func receive(_ frame: Frame, at now: TimeInterval) throws -> [FileEntry]? {
        guard !isFinished, frame.type == 2 else { return nil }
        do {
            if frame.command == 1 {
                let page = try CardFileList.parse(frame.parameters)
                guard page.count <= maximumEntries - entries.count else { throw CardProtocolError.listTooLarge }
                entries.append(contentsOf: page)
                lastListTime = now
            } else if frame.command == 18 {
                guard frame.parameters.first == 0 else { throw CardProtocolError.listRejected }
                isFinished = true
                return entries
            }
        } catch {
            isFinished = true
            throw error
        }
        return nil
    }

    public mutating func tick(at now: TimeInterval) throws -> [FileEntry]? {
        guard !isFinished else { return nil }
        if let lastListTime {
            if requireExplicitEnd {
                if now >= lastListTime + 4 { isFinished = true; throw CardProtocolError.listTimeout }
                return nil
            }
            if now >= lastListTime + 1.2 {
                isFinished = true
                return entries
            }
        } else if now >= initialDeadline {
            isFinished = true
            throw CardProtocolError.listTimeout
        }
        return nil
    }
}

public enum DownloadAction: Equatable, Sendable {
    case send(Data)
    case started(String)
    case append(Data)
    case completed(name: String, bytes: Int)
    case failed(String)
}

/// 只保存传输状态和字节计数；数据分片交由应用写入临时文件。
public struct DownloadMachine {
    private enum State: Equatable { case idle, waiting, receiving, finished }
    private var state: State = .idle
    private let candidates: [String]
    private var candidateIndex = 0
    private var reportedName = ""
    private var receivedBytes = 0
    private var deadline: TimeInterval = 0
    public var isFinished: Bool { state == .finished }

    public init(listName: String, preferNativeOpus: Bool = false) {
        let names = importNameCandidates(listName)
        candidates = preferNativeOpus ? names.filter { $0.lowercased().hasSuffix(".opus") } + names.filter { !$0.lowercased().hasSuffix(".opus") } : names
    }
    /// Diagnostic/native-file request: no implicit format conversion or extension fallback.
    public init(exactFilename: String) { candidates = [exactFilename] }

    public mutating func start(at now: TimeInterval) -> [DownloadAction] {
        guard state == .idle else { return [] }
        return requestCandidate(at: now)
    }

    /// 只延后尚未开始接收的当前请求，不清空已收数据。
    public mutating func requestWasSent(at now: TimeInterval) {
        guard state == .waiting, receivedBytes == 0 else { return }
        deadline = now + 12
    }

    public mutating func receive(_ frame: Frame, at now: TimeInterval) -> [DownloadAction] {
        guard state == .waiting || state == .receiving, frame.type == 2 else { return [] }
        switch frame.command {
        case 3:
            guard state == .waiting else { return fail("下载过程中重复收到开始帧", abort: true) }
            state = .receiving
            let name = decodeCardText(frame.parameters)
            reportedName = name.isEmpty ? candidates[candidateIndex] : name
            deadline = now + 12
            return [.started(reportedName)]
        case 4:
            guard state == .receiving else { return fail("下载开始前收到数据帧", abort: true) }
            guard frame.parameters.count <= Int.max - receivedBytes else { return fail("下载字节计数溢出", abort: true) }
            receivedBytes += frame.parameters.count
            deadline = now + 12
            return [.append(frame.parameters)]
        case 5:
            guard let code = frame.parameters.first else { return fail("下载结束帧缺少结束码") }
            if code == 0 {
                guard receivedBytes > 0 else { return fail("录音卡报告完成，但未收到任何数据") }
                state = .finished
                return [.completed(name: reportedName, bytes: receivedBytes)]
            }
            if code == 1 && receivedBytes == 0 {
                candidateIndex += 1
                return requestCandidate(at: now)
            }
            return fail("下载失败，结束码 \(code)，已收到 \(receivedBytes) 字节")
        default:
            return []
        }
    }

    public mutating func tick(at now: TimeInterval) -> [DownloadAction] {
        guard state == .waiting || state == .receiving, now >= deadline else { return [] }
        // 超时绝不切换文件名；终止请求用于停止可能仍在传输的设备。
        return fail("下载空闲超过 12 秒，已收到 \(receivedBytes) 字节", abort: true)
    }

    private mutating func requestCandidate(at now: TimeInterval) -> [DownloadAction] {
        guard candidateIndex < candidates.count else { return fail("所有候选文件名均不存在，或文件名为空") }
        do {
            let payload = try CardCommand.download(filename: candidates[candidateIndex])
            state = .waiting
            receivedBytes = 0
            reportedName = candidates[candidateIndex]
            deadline = now + 12
            return [.send(payload)]
        } catch {
            return fail("下载文件名不能编码为 24 字节定长字段")
        }
    }

    private mutating func fail(_ message: String, abort: Bool = false) -> [DownloadAction] {
        state = .finished
        return abort ? [.send(CardCommand.abortDownload), .failed(message)] : [.failed(message)]
    }
}

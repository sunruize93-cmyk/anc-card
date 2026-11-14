import Foundation

/// Explicit read-only field benchmark. Never enters the upload queue or deletes files.
final class CardReadProbe {
    private let root: URL
    private let filenames: [String]
    private let send: (Data, @escaping (Result<Void, Error>) -> Void) -> Void
    private let log: (String) -> Void
    private let finished: () -> Void
    private var index = 0
    private var machine: DownloadMachine?
    private var handle: FileHandle?
    private var requestAt: TimeInterval = 0
    private var firstDataAt: TimeInterval?
    private var lastDataAt: TimeInterval?
    private var total = 0
    private var frames = 0
    private var maxGap: TimeInterval = 0
    private var writeSeconds: TimeInterval = 0
    private var sizes: [String: Int] = [:]
    private var results: [[String: Any]] = []
    private var nextAt: TimeInterval?
    private var done = false
    private var clock: TimeInterval { ProcessInfo.processInfo.systemUptime }
    init(root: URL, filenames: [String], send: @escaping (Data, @escaping (Result<Void, Error>) -> Void) -> Void,
         log: @escaping (String) -> Void, finished: @escaping () -> Void) {
        self.root = root; self.filenames = filenames; self.send = send; self.log = log; self.finished = finished
    }
    func start() { beginNext() }
    private func beginNext() {
        guard !done else { return }
        guard index < filenames.count else { done = true; persist(); finished(); return }
        do {
            try RelayStore.prepareDirectory(root)
            let url = root.appendingPathComponent(filenames[index])
            try Data().write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            handle = try FileHandle(forWritingTo: url)
            total = 0; frames = 0; maxGap = 0; writeSeconds = 0; sizes = [:]; firstDataAt = nil; lastDataAt = nil
            requestAt = clock
            var value = DownloadMachine(exactFilename: filenames[index]); let actions = value.start(at: clock); machine = value
            log("[DEBUG-meeting] 只读格式基准开始 · " + filenames[index]); apply(actions)
        } catch { fail("无法建立基准文件") }
    }
    func receive(_ frame: Frame) {
        guard !done, var value = machine else { return }
        let actions = value.receive(frame, at: clock); machine = value; apply(actions)
    }
    func tick() {
        if let nextAt, clock >= nextAt { self.nextAt = nil; beginNext() }
        guard !done, var value = machine else { return }
        let actions = value.tick(at: clock); machine = value; apply(actions)
    }
    func disconnected() { if !done { fail("连接中断，基准未完成") } }
    private func apply(_ actions: [DownloadAction]) {
        for action in actions {
            switch action {
            case .send(let payload):
                send(payload) { [weak self] result in
                    guard let self, !self.done else { return }
                    switch result {
                    case .success: self.machine?.requestWasSent(at: self.clock)
                    case .failure: self.fail("基准请求未写出")
                    }
                }
            case .started(let name): log("[DEBUG-meeting] 基准开始帧 · " + name)
            case .append(let data):
                guard total + data.count <= 64 * 1024 * 1024 else { fail("基准超过上限"); return }
                let now = clock
                if firstDataAt == nil { firstDataAt = now }
                if let lastDataAt { maxGap = max(maxGap, now - lastDataAt) }; lastDataAt = now
                do { try handle?.write(contentsOf: data) } catch { fail("基准写盘失败"); return }
                writeSeconds += clock - now; total += data.count; frames += 1
                sizes[String(data.count), default: 0] += 1
            case .completed(let name, let bytes):
                guard bytes == total else { fail("基准字节计数不符"); return }
                try? handle?.synchronize(); try? handle?.close(); handle = nil
                let elapsed = clock - requestAt
                results.append(["requestedName": filenames[index], "reportedName": name, "bytes": total,
                    "elapsedSeconds": elapsed, "firstDataDelaySeconds": (firstDataAt ?? clock) - requestAt,
                    "transferSeconds": clock - (firstDataAt ?? requestAt), "dataFrames": frames,
                    "framePayloadSizes": sizes, "maxDataGapSeconds": maxGap, "fileWriteSeconds": writeSeconds,
                    "completed": true])
                log("[DEBUG-meeting] 格式基准完成 · \(filenames[index]) · \(total) 字节 · \(String(format: "%.3f", elapsed)) 秒")
                index += 1; machine = nil; persist(); nextAt = clock + 1
            case .failed(let message): fail(message)
            }
        }
    }
    private func persist() {
        guard let data = try? JSONSerialization.data(withJSONObject: ["readOnly": true, "results": results], options: [.prettyPrinted, .sortedKeys]) else { return }
        try? data.write(to: root.appendingPathComponent("benchmark.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    private func fail(_ reason: String) {
        guard !done else { return }; done = true
        try? handle?.close(); handle = nil; machine = nil
        results.append(["requestedName": index < filenames.count ? filenames[index] : "", "completed": false, "error": reason, "bytes": total])
        persist(); log("[DEBUG-meeting] 格式基准停止 · " + reason); finished()
    }
}

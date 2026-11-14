import Foundation

/// Serial BLE transaction: read identity, verify content, recheck idle/list, then delete one file.
/// The caller owns policy, document authorization, durable journal, and local audio removal.
final class CardCleanupOperation {
    enum Outcome { case cardAbsent, retained(String) }
    private enum Stage { case idleFirst, listFirst, download, authorization, idleFinal, listFinal, deleteDelay, deleting, done }
    private var stage: Stage = .idleFirst
    private let record: Recording
    private let root: URL
    private let send: (Data, @escaping (Result<Void, Error>) -> Void) -> Void
    private let authorize: (@escaping (Bool) -> Void) -> Void
    private let journal: (String, Data?) throws -> Void
    private let finished: (Outcome) -> Void
    private var deadline: TimeInterval = 0
    private var list: FileListCollector?
    private var download: DownloadMachine?
    private var deletion: CardDeletionMachine?
    private var raw: Data?
    private var output: FileHandle?
    private var bytes = 0
    private let recoveryRaw: Data?
    private var clock: TimeInterval { ProcessInfo.processInfo.systemUptime }
    private var temporary: URL { root.appendingPathComponent("cleanup-" + record.id.uuidString + ".part") }
    init(record: Recording, root: URL, recoveryRaw: Data? = nil,
         send: @escaping (Data, @escaping (Result<Void, Error>) -> Void) -> Void,
         authorize: @escaping (@escaping (Bool) -> Void) -> Void,
         journal: @escaping (String, Data?) throws -> Void, finished: @escaping (Outcome) -> Void) {
        self.record = record; self.root = root; self.recoveryRaw = recoveryRaw
        self.send = send; self.authorize = authorize; self.journal = journal; self.finished = finished
    }
    func start() { requestIdle(final: false) }
    func disconnected() { finish(.retained("清理期间断连，结果待重新列文件核对；手机副本保留")) }
    func receive(_ frame: Frame) {
        guard stage != .done else { return }
        if frame.type == 3 && [UInt8(1),5,7].contains(frame.command) {
            finish(.retained("检测到卡正在录音，暂停清理")); return
        }
        if stage == .idleFirst || stage == .idleFinal, frame.type == 3, frame.command == 20 {
            guard frame.parameters.first == 2 else { finish(.retained("卡非空闲状态，未执行清理")); return }
            if stage == .idleFirst, let recoveryRaw {
                raw = recoveryRaw; beginDeletion(recovery: true); return
            }
            beginList(final: stage == .idleFinal); return
        }
        if stage == .listFirst || stage == .listFinal, var value = list {
            do {
                let entries = try value.receive(frame, at: clock); list = value
                if let entries { listed(entries) }
            } catch { finish(.retained("清理前列表无效，未发送删除")) }
            return
        }
        if stage == .download, var value = download {
            let actions = value.receive(frame, at: clock); download = value; applyDownload(actions); return
        }
        if stage == .deleting, var value = deletion {
            let actions = value.receive(frame, at: clock); deletion = value; applyDelete(actions)
        }
    }
    func tick() {
        guard stage != .done else { return }
        if (stage == .idleFirst || stage == .idleFinal || stage == .authorization), clock >= deadline {
            finish(.retained("清理状态或文档刷新超时，手机副本保留")); return
        }
        if var value = list, stage == .listFirst || stage == .listFinal {
            do { _ = try value.tick(at: clock); list = value } catch { finish(.retained("列表未明确结束，未发送删除")) }
        }
        if var value = download, stage == .download { let actions = value.tick(at: clock); download = value; applyDownload(actions) }
        if var value = deletion, stage == .deleting { let actions = value.tick(at: clock); deletion = value; applyDelete(actions) }
    }
    private func write(_ payload: Data) {
        send(payload) { [weak self] result in
            if case .failure = result { self?.finish(.retained("清理请求写入失败，状态待核对")) }
        }
    }
    private func requestIdle(final: Bool) {
        stage = final ? .idleFinal : .idleFirst; deadline = clock + 3; write(CardCommand.recordingState)
    }
    private func beginList(final: Bool) {
        stage = final ? .listFinal : .listFirst; list = FileListCollector(now: clock, requireExplicitEnd: true); write(CardCommand.listFiles)
    }
    private func listed(_ entries: [FileEntry]) {
        list = nil
        let matches = entries.filter { $0.name == record.sourceName }
        guard matches.count == 1, let entry = matches.first, let currentRaw = entry.rawRecord else {
            finish(.retained("卡上目标缺失或身份不唯一，保留手机副本")); return
        }
        if stage == .listFinal {
            guard currentRaw == raw else { finish(.retained("卡内条目已变化，未发送删除")); return }
            stage = .deleteDelay; deadline = clock + 0.5
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self, self.stage == .deleteDelay else { return }
                self.beginDeletion(recovery: false)
            }
            return
        }
        raw = currentRaw
        do {
            try journal("verifying_source", currentRaw)
            try RelayStore.prepareDirectory(root)
            try Data().write(to: temporary, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            output = try FileHandle(forWritingTo: temporary)
            var value = DownloadMachine(exactFilename: record.filename)
            let actions = value.start(at: clock); download = value; stage = .download; applyDownload(actions)
        } catch { finish(.retained("无法验证卡内源文件，未发送删除")) }
    }
    private func applyDownload(_ actions: [DownloadAction]) {
        for action in actions {
            guard stage != .done else { return }
            switch action {
            case .send(let payload): write(payload)
            case .started(let name):
                if name != record.filename { finish(.retained("卡返回文件名与已交付源不符")); return }
            case .append(let data):
                guard bytes + data.count <= record.bytes else { finish(.retained("卡内源大小已变化")); return }
                do { try output?.write(contentsOf: data); bytes += data.count } catch { finish(.retained("源校验写盘失败")) }
            case .completed(_, let count):
                do {
                    try output?.synchronize(); try output?.close(); output = nil
                    guard Int64(count) == record.bytes, count == bytes else { throw RelayFailure.message("size") }
                    let data = try Data(contentsOf: temporary, options: .mappedIfSafe)
                    guard DocumentReceiptVerifier.digest(data) == record.sha256 else { throw RelayFailure.message("hash") }
                    try? FileManager.default.removeItem(at: temporary) // Only the disposable re-read copy.
                    stage = .authorization; deadline = clock + 60
                    authorize { [weak self] allowed in
                        guard let self, self.stage == .authorization else { return }
                        if allowed { self.requestIdle(final: true) }
                        else { self.finish(.retained("文档或交付复核未通过，原音保留")) }
                    }
                } catch { finish(.retained("卡内内容与已交付音频不一致，未发送删除")) }
            case .failed: finish(.retained("无法完整重读卡内音频，未发送删除"))
            }
        }
    }
    private func beginDeletion(recovery: Bool) {
        do {
            guard let raw else { throw RelayFailure.message("identity") }
            var value = try CardDeletionMachine(rawRecord: raw)
            // Persist before a potentially destructive write, so relaunch can only reconcile.
            try journal(recovery ? "reconciling" : "delete_requested", raw)
            let actions = try value.start(at: clock, recoveryOnly: recovery); deletion = value; stage = .deleting; applyDelete(actions)
        } catch { finish(.retained("无法保存清理审计，未发送删除")) }
    }
    private func applyDelete(_ actions: [CardDeletionAction]) {
        for action in actions {
            switch action {
            case .send(let payload): write(payload)
            case .reconcileRequired: try? journal("reconciling", raw)
            case .confirmedAbsent:
                do { try journal("card_absent", raw); finish(.cardAbsent) }
                catch { finish(.retained("卡已不含目标但审计写入失败，手机副本保留")) }
            case .retained(let reason):
                if deletion?.targetUnchangedAfterReconcile == true { try? journal("verified_present", raw) }
                finish(.retained(reason))
            }
        }
    }
    private func finish(_ outcome: Outcome) {
        guard stage != .done else { return }; stage = .done
        try? output?.close(); output = nil; finished(outcome)
    }
}

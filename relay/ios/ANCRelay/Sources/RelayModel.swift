import Foundation
import Combine
import UIKit

final class RelayModel: ObservableObject {
    @Published private(set) var state: RelayState
    @Published private(set) var connection = "等待蓝牙"
    @Published private(set) var cards: [DiscoveredCard] = []
    @Published private(set) var battery = "未读取"
    @Published private(set) var firmware = "未读取"
    @Published private(set) var recordingState = "未读取"
    @Published private(set) var logText = ""
    @Published var notice = ""
    let store: RelayStore
    let uploader: BackgroundUploader
    private let bluetooth: CardBluetooth
    private var timer: Timer?
    // The successful locked-recording path must also survive normal launches without Mac flags.
    private let meetingStreamEnabled = true
    private let immediateStream = true
    private var streamRequested = false
    private var streamAttempts = 0
    private var lastStreamStateCheck: TimeInterval = 0
    private lazy var meetingStream = MeetingStream(root: store.root.appendingPathComponent("meeting-stream"),
        log: { [weak self] in self?.store.log($0) })
    private var cleanupOperation: CardCleanupOperation?
    private var cleanupFinishing = false
    private var cleanupAuthorization: (UUID, DocumentVerification, CleanupPermit)?
    private var cleanupRetryAfter: [UUID: Date] = [:]
    private var readProbe: CardReadProbe?
    private var readProbeRequested = ProcessInfo.processInfo.arguments.contains("--verify-transfer-formats")
    private var list: FileListCollector?
    private var download: DownloadMachine?
    private var downloadID: UUID?
    private var output: FileHandle?
    private var writtenBytes = 0
    private var interruptDownloadOnce = ProcessInfo.processInfo.arguments.contains("--verify-download-interruption")
    private var awaitingWrite = false
    private var writeQueuedAt: TimeInterval = 0
    private var operationID = UUID()
    private var listRequested = false
    private var nextListAttempt: Date?
    private var started = false
    private var lastForegroundCheck: TimeInterval = 0
    private var lastBatteryCheck: TimeInterval = 0
    private var statusQueue: [Data] = []
    private var statusExpected: (UInt8, UInt8)?
    private var statusDeadline: TimeInterval = 0
    private var statusTimeouts = 0
    private var cardIsRecording = false
    private var recordingTransitionUntil: TimeInterval = 0
    private var completionTask: UIBackgroundTaskIdentifier = .invalid
    private var completionDeadline: TimeInterval = 0
    private var completionWindowUsed = false

    // Finite work triggered by an observed card recording event, never an indefinite keepalive.
    private func beginCompletionWindow() {
        guard completionTask == .invalid, !completionWindowUsed else { return }
        completionWindowUsed = true
        completionDeadline = clock + 25
        completionTask = UIApplication.shared.beginBackgroundTask(withName: "Finish card recording") { [weak self] in
            guard let self else { return }
            self.store.log("后台完成窗口到期；等待蓝牙事件或回前台恢复")
            self.endCompletionWindow()
        }
        store.log("开始有限录音完成窗口（最多25秒，系统可提前结束）")
    }
    private func endCompletionWindow() {
        guard completionTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(completionTask)
        completionTask = .invalid
    }
    private var clock: TimeInterval { ProcessInfo.processInfo.systemUptime }

    init(store: RelayStore) {
        self.store = store
        self.state = store.state
        self.uploader = BackgroundUploader(store: store)
        self.bluetooth = CardBluetooth(boundID: store.state.binding?.peripheralID)
        store.onChange = { [weak self] in self?.refresh() }
        uploader.onError = { [weak self] text in self?.notice = text }
        bluetooth.onChange = { [weak self] in
            guard let self = self else { return }
            self.connection = self.bluetooth.status
            self.cards = self.bluetooth.discovered
            self.store.log("蓝牙状态 · " + self.connection + " · 可见卡数 " + String(self.cards.count))
        }
        bluetooth.onDiagnostic = { [weak self] text in self?.store.log(text) }
        bluetooth.onReady = { [weak self] in self?.connected() }
        bluetooth.onDisconnect = { [weak self] in self?.disconnected() }
        bluetooth.onFrame = { [weak self] frame, isEvent in self?.receive(frame, isEvent: isEvent) }
        refresh()
    }

    func start() {
        guard !started else { return }
        started = true
        if store.state.retentionSettings == nil {
            // User selected keep-five; protect every pre-existing record. Execution remains preview-only.
            try? store.commit { $0.retentionSettings = RetentionSettings(keepLatestFive: true,
                protectedThroughOrder: $0.recordings.count - 1, configuredAt: Date()) }
        }
        if ProcessInfo.processInfo.arguments.contains("--activate-verified-cleanup") {
            // User explicitly requested cleanup of already delivered phone/card originals.
            try? store.commit {
                $0.retentionSettings = RetentionSettings(executionEnabled: true, keepLatestFive: true,
                    protectedThroughOrder: -1, configuredAt: Date())
            }
        }
        if ProcessInfo.processInfo.arguments.contains("--prefer-native-opus") { try? store.commit { $0.preferNativeOpus = true } }
        recoverFiles()
        uploader.start()
        if ProcessInfo.processInfo.arguments.contains("--verify-existing-wav") { importRegressionSample() }
        bluetooth.start()
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.tick() }
    }

    private func importRegressionSample() {
        do {
            let source = documents.appendingPathComponent("A-card.wav")
            let metadata = try RelayStore.inspectWAV(source)
            let key = "native-" + metadata.sha256
            if let existing = store.state.recordings.first(where: { $0.uploadLocalID == key }) { retry(existing.id); return }
            var record = Recording(bindingID: UUID(), sourceName: "manual-regression", filename: "A-card.wav")
            record.uploadLocalID = key
            try store.commit { $0.recordings.append(record) }
            let destination = store.destinationURL(record)
            try RelayStore.prepareDirectory(destination.deletingLastPathComponent())
            try FileManager.default.copyItem(at: source, to: destination)
            try store.adoptFile(destination, id: record.id)
            store.log("显式现有 WAV 回归 · 与 BLE 新录音分开记录")
            uploader.pump()
        } catch { notice = "现有 WAV 回归导入失败，原件保留" }
    }

    private func refresh() { state = store.state; logText = store.readLog() }

    func scan() { bluetooth.scan() }

    func setRetentionPreference(_ keepFive: Bool) {
        do {
            try store.commit { state in
                state.retentionSettings = RetentionSettings(executionEnabled: state.retentionSettings?.executionEnabled, keepLatestFive: keepFive,
                    protectedThroughOrder: state.retentionSettings?.protectedThroughOrder ?? state.recordings.count - 1,
                    configuredAt: Date())
            }
        } catch { notice = "保留策略保存失败，未启用清理" }
    }

    var retentionPreview: [String: AudioRetentionReason] {
        guard let binding = state.binding else { return [:] }
        let items = state.recordings.enumerated().filter { $0.element.bindingID == binding.id }.map { index, record in
            AudioRetentionItem(id: record.id.uuidString, importOrder: index,
                completeAudio: record.relativePath != nil && record.bytes > 0,
                documentDeliveryVerified: record.documentVerification?.matches(record.delivery?.document) == true && record.documentAllowsCleanup == true,
                // Preliminary ownership only; the executor re-reads exact card bytes before deletion.
                sourceIdentityVerified: record.receipt != nil && record.sourceName != "manual-regression" && record.audioPrunedAt == nil)
        }
        let setting = state.retentionSettings
        return AudioRetentionPlanner.plan(items,
            activatedAfterOrder: setting?.keepLatestFive == true ? setting?.protectedThroughOrder : nil)
    }

    func bind(_ card: DiscoveredCard) {
        guard store.state.binding == nil else { notice = "当前已绑定一张卡"; return }
        do {
            try store.commit { $0.binding = CardBinding(peripheralID: card.id, name: card.name) }
            store.log("绑定已保存，首次文件列表将作为基线")
            bluetooth.bind(card.id)
        } catch { notice = "绑定保存失败，未开始连接" }
    }

    func saveSettings(endpoint: String, token: String) throws {
        let url = try UploadEndpoint.validate(endpoint.trimmingCharacters(in: .whitespacesAndNewlines))
        if !token.isEmpty { try KeychainToken.save(token) }
        try store.commit { $0.endpoint = url.absoluteString }
        uploader.settingsChanged()
        notice = "设置已保存；凭证仅存钥匙串。已有上传任务继续使用原请求。"
    }

    func retry(_ id: UUID) {
        recoverFiles()
        guard let record = store.recording(id), record.audioPrunedAt == nil, cleanupOperation == nil, !cleanupFinishing, record.status != .uploading,
              downloadID != id else { return }
        do {
            try store.update(id) {
                $0.status = $0.relativePath == nil ? .pendingDownload : .downloaded
                $0.requiresAttention = false
                $0.authenticationBlocked = false
                $0.nextAttempt = nil
                $0.message = $0.receipt == nil ? "等待重试" : "用相同本地 ID 重发，检查重复回执"
            }
            uploader.pump()
            advance()
        } catch { notice = "重试状态无法保存" }
    }

    func requestSync() {
        listRequested = true
        nextListAttempt = nil
        advance()
        uploader.pump()
    }

    func becameActive() {
        // 回到前台时立即推进过期超时，补偿应用被系统挂起期间不运行的计时器。
        tick()
        requestSync()
    }

    private func connected() {
        store.log("蓝牙连接及两路通知就绪")
        battery = "正在读取"; firmware = "正在读取"; recordingState = "正在读取"
        notice = ""
        statusQueue = [CardCommand.battery, CardCommand.firmware, CardCommand.recordingState]
        lastBatteryCheck = clock; lastForegroundCheck = clock
        listRequested = true
        nextListAttempt = nil
        sendNextStatus()
    }

    private func sendNextStatus() {
        guard cleanupOperation == nil, !cleanupFinishing, bluetooth.ready, clock >= recordingTransitionUntil, statusExpected == nil, list == nil, download == nil else { return }
        guard !statusQueue.isEmpty else { advance(); return }
        let command = statusQueue.removeFirst()
        statusExpected = (command[0], command[1] + 1)
        statusDeadline = clock + 3
        bluetooth.send(command) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.statusDeadline = self.clock + 3
                self.store.log("状态请求写出 · \(command[0])-\(command[1])")
            case .failure:
                self.statusExpected = nil; self.notice = "读取状态失败，稍后重试"
            }
        }
    }

    private func disconnected() {
        meetingStream.end(reason: "蓝牙断开，卡内原录音保留")
        streamRequested = false
        readProbe?.disconnected()
        cleanupOperation?.disconnected()
        operationID = UUID()
        statusExpected = nil; statusQueue = []
        recordingState = "连接中断，状态待刷新"
        awaitingWrite = false
        list = nil
        if downloadID != nil { failDownload("蓝牙断开，保留临时文件，重连后完整重取") }
        listRequested = true
    }

    private func receive(_ frame: Frame, isEvent: Bool) {
        if let cleanupOperation { cleanupOperation.receive(frame); return }
        if let readProbe { readProbe.receive(frame); return }
        if meetingStreamEnabled, frame.type == 1, frame.command == 0 {
            store.log("[DEBUG-meeting] 实时通道返回文件身份 · " + String(decoding: frame.parameters.prefix(64).prefix(while: { $0 != 0 }), as: UTF8.self))
        }
        if meetingStreamEnabled, frame.type == 1, frame.command == 1 {
            meetingStream.receive(frame.parameters)
            if clock - lastStreamStateCheck >= 2, statusExpected == nil, statusQueue.isEmpty {
                lastStreamStateCheck = clock
                statusQueue.append(CardCommand.recordingState); sendNextStatus()
            }
            return
        }
        if meetingStreamEnabled, frame.type == 1, frame.command == 4, frame.parameters.first == 2 {
            meetingStream.end(reason: "卡发出实时音频停止状态")
            streamRequested = false
            if statusExpected == nil { statusQueue.append(CardCommand.recordingState); sendNextStatus() }
        }
        if frame.usesZeroCRCCompatibility { store.log("收到零 CRC 兼容帧") }
        if frame.type == 3 || (frame.type == 0 && [UInt8(4),11].contains(frame.command)) {
            let channel = isEvent ? "AE23" : "AE22"
            let values = frame.parameters.prefix(16).map { String(format: "%02x", $0) }.joined()
            store.log("状态帧 · \(channel) · \(frame.type)-\(frame.command) · 参数 \(values)")
        }
        // Actual V1.0.0 card returns battery on AE23. Route by command as well as channel.
        if CardFrameRoute.isButtonEvent(frame, eventChannel: isEvent) {
            if frame.type == 3 {
                switch frame.command {
                case 1:
                    streamAttempts = 0
                    if immediateStream, bluetooth.ready {
                        beginLiveStream()
                    }
                    cardIsRecording = true
                    recordingTransitionUntil = clock + 3
                    recordingState = "录音中"; completionWindowUsed = false; beginCompletionWindow()
                    store.log("机身开始录音，等待状态稳定；录音期间不列文件或下载")
                case 3:
                    if immediateStream, streamRequested {
                        streamRequested = false
                        meetingStream.end(reason: "机身已保存，关闭实时通道")
                        bluetooth.send(CardCommand.stopAudioStream) { _ in }
                    }
                    cardIsRecording = false
                    recordingTransitionUntil = 0
                    completionWindowUsed = false
                    beginCompletionWindow()
                    recordingState = "已保存，等待取回"
                    store.log("保存事件 · 机身按键")
                    listRequested = true; nextListAttempt = nil; advance()
                case 5: cardIsRecording = true; recordingState = "暂停"
                case 7: cardIsRecording = true; recordingState = "录音中"
                default: break
                }
            }
            return
        }
        if frame.type == 0, frame.command == 4, let value = frame.parameters.first {
            battery = value == 110 ? "充电中" : "\(value)%"
        } else if frame.type == 0, frame.command == 11 {
            firmware = String(decoding: frame.parameters.prefix(128).prefix(while: { $0 != 0 }), as: UTF8.self)
        } else if frame.type == 3, frame.command == 20, let value = frame.parameters.first {
            if clock >= recordingTransitionUntil { cardIsRecording = value == 1 || value == 3 }
            recordingState = [1: "录音中", 2: "未录音", 3: "暂停"][Int(value)] ?? "未知状态 \(value)"
            if value == 1 || value == 3 { beginCompletionWindow() }
            if value == 2 {
                listRequested = true; completionWindowUsed = false
                if streamRequested {
                    streamRequested = false
                    meetingStream.end(reason: "已确认卡停止录音，等待取回完整文件")
                    bluetooth.send(CardCommand.stopAudioStream) { _ in }
                }
            }
        }
        if let expected = statusExpected, frame.type == expected.0, frame.command == expected.1 {
            statusExpected = nil
            statusTimeouts = 0
            if notice == "读取状态失败，稍后重试" { notice = "" }
            sendNextStatus()
        }
        // Never switch an already-running offline recording into a new stream after reconnect/launch.
        // The normal path opens the channel only in the physical start-event callback.
        if meetingStreamEnabled, !immediateStream, cardIsRecording, !streamRequested, streamAttempts < 3,
           bluetooth.ready, statusExpected == nil, statusQueue.isEmpty, list == nil, download == nil {
            do {
                try meetingStream.begin(); streamRequested = true; streamAttempts += 1
                bluetooth.send(CardCommand.startAudioStream) { [weak self] result in
                    if case .failure = result {
                        self?.streamRequested = false; self?.meetingStream.end(reason: "实时接收请求写入失败")
                    }
                }
                store.log("[DEBUG-meeting] 录音中请求真实音频通知 · 第 \(streamAttempts) 次")
            } catch { store.log("[DEBUG-meeting] 录音备份初始化失败，卡内原件保留") }
        }
        guard bluetooth.ready, !awaitingWrite else { return }
        if var collector = list {
            do {
                let result = try collector.receive(frame, at: clock)
                list = collector
                if let entries = result { finishList(entries) }
            } catch { failList("文件列表格式无效或接收失败") }
        } else if var machine = download {
            let actions = machine.receive(frame, at: clock)
            download = machine
            apply(actions)
        }
    }

    private func beginLiveStream() {
        guard !streamRequested else { return }
        do {
            try meetingStream.begin(); streamRequested = true; streamAttempts += 1
            bluetooth.send(CardCommand.startAudioStream) { [weak self] result in
                if case .failure = result {
                    self?.streamRequested = false; self?.meetingStream.end(reason: "实时接收请求写入失败")
                }
            }
            store.log("[DEBUG-meeting] 机身开始事件内立即请求真实音频通道")
        } catch { store.log("[DEBUG-meeting] 录音备份初始化失败，卡内原件保留") }
    }

    private func advance() {
        guard readProbe == nil, cleanupOperation == nil, !cleanupFinishing else { return }
        guard bluetooth.ready, !cardIsRecording, clock >= recordingTransitionUntil, list == nil, download == nil, statusExpected == nil, statusQueue.isEmpty else { return }
        if listRequested, nextListAttempt == nil || nextListAttempt! <= Date() {
            startList(); return
        }
        if readProbeRequested {
            readProbeRequested = false
            let target = "note20261114-145415"
            guard store.state.recordings.contains(where: { $0.filename == target + ".wav" && $0.receipt != nil }) else {
                store.log("[DEBUG-meeting] 基准目标不是已验证录音，拒绝开始"); return
            }
            readProbe = CardReadProbe(root: store.root.appendingPathComponent("format-benchmark"),
                filenames: [target + ".opus", target + ".wav"],
                send: { [weak self] payload, completion in self?.bluetooth.send(payload, completion: completion) },
                log: { [weak self] in self?.store.log($0) }, finished: { [weak self] in
                    self?.readProbe = nil; self?.bluetooth.restartLink()
                })
            readProbe?.start(); return
        }
        guard store.state.binding?.baselineReady == true,
              let binding = store.state.binding,
              let next = store.state.recordings.first(where: {
                  $0.bindingID == binding.id && $0.relativePath == nil && !$0.requiresAttention
                    && ($0.status == .pendingDownload || $0.status == .failed)
                    && ($0.nextAttempt == nil || $0.nextAttempt! <= Date())
              }) else { startNextCleanup(); return }
        startDownload(next)
    }

    private func startList() {
        listRequested = false
        operationID = UUID()
        let current = operationID
        list = FileListCollector(now: clock)
        awaitingWrite = true
        writeQueuedAt = clock
        bluetooth.send(CardCommand.listFiles) { [weak self] result in
            guard let self = self, self.operationID == current else { return }
            self.awaitingWrite = false
            switch result {
            case .success: self.list?.requestWasSent(at: self.clock)
            case .failure(let error): self.failList(self.safeError(error))
            }
        }
    }

    private func finishList(_ entries: [FileEntry]) {
        list = nil
        awaitingWrite = false
        nextListAttempt = nil
        do {
            guard let binding = store.state.binding else { return }
            if !binding.baselineReady {
                let names = Set(entries.map(\.name).filter { !$0.isEmpty })
                try store.commit { state in
                    state.binding?.baseline = names
                    state.binding?.baselineReady = true
                }
                store.log("首次基线已保存 · \(names.count) 个文件，不下载")
            } else {
                let known = binding.baseline.union(store.state.recordings
                    .filter { $0.bindingID == binding.id }.map(\.sourceName))
                let added = CardFileList.newEntries(known: known, entries: entries)
                try store.commit { state in
                    for entry in added {
                        state.recordings.append(Recording(bindingID: binding.id,
                            sourceName: entry.name, filename: SafeFilename.sanitize(entry.name)))
                    }
                }
                store.log("列表新增 · \(added.count) 条录音")
            }
        } catch {
            notice = "列表状态无法保存；已暂停本轮处理"
            listRequested = true
            nextListAttempt = Date().addingTimeInterval(10)
        }
        advance()
    }

    private func failList(_ message: String) {
        list = nil
        awaitingWrite = false
        operationID = UUID()
        listRequested = true
        nextListAttempt = Date().addingTimeInterval(10)
        notice = message
        store.log("列文件失败 · \(message)")
        // 列表没有可验证的请求关联号，失败后隔离迟到列表帧，避免污染首次基线。
        if bluetooth.ready { bluetooth.restartLink() }
    }

    private func startDownload(_ record: Recording) {
        operationID = UUID()
        do {
            let temporary = store.temporaryURL(record.id)
            if FileManager.default.fileExists(atPath: temporary.path) {
                let preserved = temporary.deletingLastPathComponent()
                    .appendingPathComponent(record.id.uuidString + "-" + UUID().uuidString + ".part")
                try FileManager.default.moveItem(at: temporary, to: preserved)
            }
            try Data().write(to: temporary, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            output = try FileHandle(forWritingTo: temporary)
            try store.update(record.id) {
                $0.status = .pendingDownload
                $0.attempts += 1
                $0.message = "正在取回，临时文件尚未验收"
            }
            downloadID = record.id
            writtenBytes = 0
            var machine = DownloadMachine(listName: record.sourceName, preferNativeOpus: store.state.preferNativeOpus == true)
            let actions = machine.start(at: clock)
            download = machine
            apply(actions)
        } catch {
            try? output?.close(); output = nil
            downloadID = record.id
            failDownload("无法建立下载临时文件或保存状态", attention: true)
        }
    }

    private func apply(_ actions: [DownloadAction]) {
        for action in actions {
            switch action {
            case .send(let payload):
                let isRequest = payload.count >= 2 && payload[payload.startIndex] == 2
                    && payload[payload.startIndex + 1] == 2
                if isRequest { awaitingWrite = true; writeQueuedAt = clock }
                let current = operationID
                bluetooth.send(payload) { [weak self] result in
                    guard let self = self, self.operationID == current else { return }
                    if isRequest { self.awaitingWrite = false }
                    switch result {
                    case .success: if isRequest { self.download?.requestWasSent(at: self.clock) }
                    case .failure(let error): self.failDownload(self.safeError(error))
                    }
                }
            case .started(let name):
                guard let id = downloadID else { return }
                do { try store.update(id) {
                    $0.filename = SafeFilename.sanitize(name)
                    $0.audioFormat = name.lowercased().hasSuffix(".opus") ? .qs668RawOpus40 : .wav
                } }
                catch { failDownload("无法保存下载文件名", attention: true); return }
            case .append(let data):
                guard let output = output else { failDownload("下载临时文件未打开", attention: true); return }
                guard writtenBytes + data.count <= 64 * 1024 * 1024 else {
                    abortDownload(); failDownload("文件超过当前后台 64 MiB 限制，临时文件保留", attention: true); return
                }
                do {
                    try output.write(contentsOf: data); writtenBytes += data.count
                    if interruptDownloadOnce && writtenBytes >= 65536 {
                        interruptDownloadOnce = false
                        try output.synchronize()
                        store.log("联调注入一次真实 BLE 断连 · 已落盘临时字节 \(writtenBytes)")
                        bluetooth.restartLink()
                        return
                    }
                }
                catch { abortDownload(); failDownload("写入临时文件失败，已有数据保留", attention: true); return }
            case .completed(let name, let bytes):
                finishDownload(name: name, bytes: bytes)
            case .failed(let message): failDownload(message)
            }
        }
    }

    private func abortDownload() {
        bluetooth.send(CardCommand.abortDownload) { _ in }
    }

    private func finishDownload(name: String, bytes: Int) {
        guard let id = downloadID else { return }
        do {
            guard bytes > 0, bytes == writtenBytes else { throw RelayFailure.message("写入字节数与下载统计不符") }
            try output?.synchronize()
            try output?.close()
            output = nil
            store.log("下载结束 · 本地ID \(id.uuidString) · \(bytes) 字节")
            try store.update(id) {
                    $0.filename = SafeFilename.sanitize(name)
                    $0.audioFormat = name.lowercased().hasSuffix(".opus") ? .qs668RawOpus40 : .wav
                }
            guard let record = store.recording(id) else { throw RelayFailure.message("录音记录丢失") }
            let temporary = store.temporaryURL(id)
            _ = try RelayStore.inspectAudio(temporary, format: record.audioFormat ?? .wav)
            let destination = store.destinationURL(record)
            try RelayStore.prepareDirectory(destination.deletingLastPathComponent())
            // 同一文件系统中移入正式位置；崩溃后 recoverFiles 可补回尚未保存的元数据。
            try FileManager.default.moveItem(at: temporary, to: destination)
            try store.adoptFile(destination, id: id)
            store.log("本地落盘 · 本地ID \(id.uuidString) · 已校验文件格式与 SHA-256")
            download = nil; downloadID = nil; awaitingWrite = false
            uploader.pump()
            advance()
            if downloadID == nil { endCompletionWindow() }
        } catch {
            failDownload("文件验收或落盘失败；原件与临时文件保留", attention: true)
        }
    }

    private func failDownload(_ message: String, attention: Bool = false) {
        try? output?.close(); output = nil
        let id = downloadID
        download = nil; downloadID = nil; awaitingWrite = false
        operationID = UUID()
        guard let id = id else { return }
        do {
            try store.update(id) {
                $0.status = .failed
                $0.message = message
                $0.requiresAttention = attention
                $0.nextAttempt = Date().addingTimeInterval(min(300, pow(2, Double(min($0.attempts, 6))) * 5))
            }
            store.log("下载失败 · 本地ID \(id.uuidString) · \(message)")
        } catch { notice = "下载失败状态无法保存；临时文件保留" }
        // 协议没有为下载分片标注文件身份。失败后必须清空连接，避免旧分片串入下一条。
        if bluetooth.ready { bluetooth.restartLink() }
    }

    private func recoverFiles() {
        for record in store.state.recordings where record.status != .receipted && record.audioPrunedAt == nil {
            if record.relativePath == nil {
                let destination = store.destinationURL(record)
                if FileManager.default.fileExists(atPath: destination.path) {
                    do {
                        try store.adoptFile(destination, id: record.id)
                        store.log("恢复已落盘文件 · 本地ID \(record.id.uuidString)")
                    } catch {
                        try? store.update(record.id) {
                            $0.status = .failed; $0.requiresAttention = true
                            $0.message = "正式文件恢复校验失败，文件已保留"
                        }
                    }
                }
            } else if store.fileURL(record).map({ FileManager.default.fileExists(atPath: $0.path) }) != true {
                try? store.update(record.id) {
                    $0.status = .failed; $0.requiresAttention = true
                    $0.message = "已落盘文件缺失，停止自动处理，请人工核查"
                }
            }
        }
    }

    private func tick() {
        if let cleanupOperation { cleanupOperation.tick(); uploader.pump(); return }
        if cleanupFinishing { uploader.pump(); return }
        if let readProbe { readProbe.tick(); uploader.pump(); return }
        if statusExpected != nil && clock >= statusDeadline {
            statusTimeouts += 1
            store.log("状态读取超时 · 连续 \(statusTimeouts) 次")
            statusExpected = nil
            if statusTimeouts >= 3 {
                statusTimeouts = 0
                store.log("状态响应连续超时，重连恢复；不重下已落盘录音")
                bluetooth.restartLink()
            } else { sendNextStatus() }
        }
        if completionTask != .invalid && clock >= completionDeadline { endCompletionWindow() }
        if bluetooth.ready, statusExpected == nil, !statusQueue.isEmpty { sendNextStatus() }
        // A bounded background completion window can finish a short recording; no unlimited timer wakeups.
        if (UIApplication.shared.applicationState == .active || completionTask != .invalid), bluetooth.ready,
           list == nil, download == nil, statusExpected == nil, statusQueue.isEmpty,
           clock - lastForegroundCheck >= 2 {
            lastForegroundCheck = clock
            if clock - lastBatteryCheck >= 30 {
                lastBatteryCheck = clock
                statusQueue.append(CardCommand.battery)
            }
            statusQueue.append(CardCommand.recordingState)
            sendNextStatus()
        }
        if awaitingWrite {
            if clock - writeQueuedAt > 30 {
                // 排队请求不能在超时后迟到发出；断开使发送队列一起失效。
                notice = "蓝牙超过 30 秒不可写，请等待重连或重新打开蓝牙"
                writeQueuedAt = clock
                bluetooth.restartLink()
            }
        } else if var collector = list {
            do {
                let result = try collector.tick(at: clock)
                list = collector
                if let entries = result { finishList(entries) }
            } catch { failList("等待文件列表超时，将重试") }
        } else if var machine = download {
            let actions = machine.tick(at: clock)
            download = machine
            apply(actions)
        }
        advance()
        uploader.pump()
    }

    private func cleanupEligible(_ id: UUID) -> Bool {
        guard store.state.retentionSettings?.executionEnabled == true,
              let record = store.recording(id), record.audioPrunedAt == nil,
              record.receipt != nil, record.status == .receipted,
              record.bindingID == store.state.binding?.id,
              !record.sourceName.isEmpty, record.sourceName != "manual-regression" else { return false }
        return retentionPreview[id.uuidString] == .eligible
    }

    private func authorizeCleanup(_ id: UUID, completion: @escaping (Bool) -> Void) {
        guard cleanupEligible(id) else { completion(false); return }
        uploader.refreshCleanupDocument(id) { [weak self] proof in
            guard let self, let proof, self.cleanupEligible(id) else { completion(false); return }
            self.uploader.cleanupPreflight(id, proof: proof) { [weak self] value in
                guard let self, let value, self.cleanupEligible(id) else { completion(false); return }
                self.cleanupAuthorization = (id, proof, value)
                completion(true)
            }
        }
    }

    private func startNextCleanup() {
        guard cleanupOperation == nil, !cleanupFinishing, !streamRequested, !meetingStreamEnabled,
              store.state.retentionSettings?.executionEnabled == true else { return }
        guard let record = store.state.recordings.first(where: {
            cleanupEligible($0.id) && (cleanupRetryAfter[$0.id] ?? .distantPast) <= Date()
                && (($0.cleanup?.deleteAttempts ?? 0) < 3 || ["delete_requested", "reconciling", "card_absent", "phone_removal_requested"].contains($0.cleanup?.phase ?? ""))
        }) else { return }
        cleanupAuthorization = nil
        cleanupRetryAfter[record.id] = Date().addingTimeInterval(30)
        let recovery = ["delete_requested", "reconciling", "card_absent", "phone_removal_requested"].contains(record.cleanup?.phase ?? "")
        if recovery && record.cleanup?.rawRecord == nil { return }
        store.log("清理校验开始 · 本地ID \(record.id.uuidString) · \(record.filename)")
        cleanupOperation = CardCleanupOperation(record: record, root: store.root.appendingPathComponent("temporary"),
            recoveryRaw: recovery ? record.cleanup?.rawRecord : nil,
            send: { [weak self] data, done in self?.bluetooth.send(data, completion: done) },
            authorize: { [weak self] done in self?.authorizeCleanup(record.id, completion: done) },
            journal: { [weak self] phase, raw in
                guard let self else { throw RelayFailure.message("cleanup unavailable") }
                if phase == "delete_requested" {
                    guard (self.store.recording(record.id)?.cleanup?.deleteAttempts ?? 0) < 3, self.cleanupEligible(record.id), let authorization = self.cleanupAuthorization,
                          authorization.0 == record.id else { throw RelayFailure.message("policy changed") }
                    try authorization.2.validate(proof: authorization.1, bytes: record.bytes)
                }
                try self.store.update(record.id) {
                    let storedPhase = $0.cleanup?.phase == "phone_removal_requested" && ["reconciling", "card_absent"].contains(phase) ? "phone_removal_requested" : phase
                    let attempts = ($0.cleanup?.deleteAttempts ?? ($0.cleanup?.phase == "reconciling" ? 1 : 0)) + (phase == "delete_requested" ? 1 : 0)
                    $0.cleanup = AudioCleanupJournal(deleteAttempts: attempts, phase: storedPhase, rawRecord: raw,
                        proof: self.cleanupAuthorization?.1 ?? $0.cleanup?.proof, updatedAt: Date(), message: nil)
                }
                self.store.log("清理审计 · 本地ID \(record.id.uuidString) · \(phase)")
            }, finished: { [weak self] outcome in
                guard let self else { return }
                self.cleanupOperation = nil
                switch outcome {
                case .cardAbsent:
                    self.cleanupFinishing = true
                    self.authorizeCleanup(record.id) { [weak self] allowed in
                        guard let self else { return }
                        defer { self.cleanupFinishing = false; self.bluetooth.restartLink() }
                        guard allowed, self.cleanupEligible(record.id), let current = self.store.recording(record.id),
                              let authorization = self.cleanupAuthorization, authorization.0 == record.id,
                              let file = self.store.fileURL(current) else { return }
                        do {
                            try authorization.2.validate(proof: authorization.1, bytes: current.bytes)
                            if FileManager.default.fileExists(atPath: file.path) {
                                let actual = try RelayStore.inspectAudio(file, format: current.audioFormat ?? .wav)
                                guard actual.sha256 == current.sha256, actual.bytes == current.bytes else {
                                    throw RelayFailure.message("local identity changed")
                                }
                                try self.store.update(record.id) { $0.cleanup?.phase = "phone_removal_requested"; $0.cleanup?.updatedAt = Date() }
                                try FileManager.default.removeItem(at: file)
                            } else {
                                guard current.cleanup?.phase == "phone_removal_requested" else { throw RelayFailure.message("missing local file") }
                            }
                            try self.store.update(record.id) {
                                $0.audioPrunedAt = Date(); $0.cleanup?.phase = "complete"; $0.cleanup?.updatedAt = Date()
                                $0.message = "已按保留策略清理手机与卡内音频；文档、索引及后台原音保留"
                            }
                            self.store.log("清理完成 · 本地ID \(record.id.uuidString) · 卡目录确认不存在，手机副本已移除")
                        } catch { self.store.log("手机副本清理未完成，已保存审计，等待恢复") }
                    }
                case .retained(let reason):
                    try? self.store.update(record.id) { $0.cleanup?.message = reason }
                    self.store.log("清理保留 · 本地ID \(record.id.uuidString) · \(reason)")
                    // Drain any late uncorrelated file frames before returning to normal sync.
                    if self.bluetooth.ready { self.bluetooth.restartLink() }
                }
            })
        cleanupOperation?.start()
    }

    private func safeError(_ error: Error) -> String {
        (error as? RelayFailure)?.errorDescription ?? "蓝牙请求被拒绝或发送失败"
    }
}

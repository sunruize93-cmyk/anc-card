import Foundation

struct CleanupPermit {
    let value: CleanupPreflight
    let serverDate: Date
    let receivedUptime: TimeInterval
    let requestDuration: TimeInterval
    func validate(proof: DocumentVerification, bytes: Int64) throws {
        let elapsed = ProcessInfo.processInfo.systemUptime - receivedUptime
        guard elapsed >= 0, Date().timeIntervalSince(proof.verifiedAt) >= 0,
              Date().timeIntervalSince(proof.verifiedAt) < 60 else { throw UploadValidationError.invalidReceipt }
        // HTTP Date anchors server-issued TTL without depending on iPhone clock skew.
        try value.validate(proof: proof, bytes: bytes,
            now: serverDate.addingTimeInterval(elapsed + requestDuration + 1))
    }
}

final class BackgroundUploader: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
    static let identifier = "ANCRelay.BackgroundUpload.v1"
    private let store: RelayStore
    private var transport: SecureTransport?
    private var polling: Set<UUID> = []
    private var verifyingDocuments: Set<UUID> = []
    private var queryAfter: [UUID: Date] = [:]
    private lazy var resultSession: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 30
        return URLSession(configuration: c, delegate: self, delegateQueue: .main)
    }()
    private var active: [UUID: Int] = [:]
    private var responseData: [Int: Data] = [:]
    private var oversizedResponses: Set<Int> = []
    private var ignoredTasks: Set<Int> = []
    private var reconciled = false
    private var reconciling = false
    private var backgroundCompletion: (() -> Void)?
    private var finishedBackgroundEvents = false
    var onError: ((String) -> Void)?
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.identifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 7 * 24 * 60 * 60
        configuration.httpMaximumConnectionsPerHost = 1
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        return URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
    }()

    init(store: RelayStore) { self.store = store; super.init() }

    func start() {
        do {
            let c = try configuration()
            let endpoint = try V1Upload.endpoint(c.baseURL)
            transport = try SecureTransport(host: endpoint.host!, certificate: Data(contentsOf: documents.appendingPathComponent("test-ca.der")))
            try store.commit { $0.endpoint = endpoint.absoluteString }
            store.log("本机 CA 与钥匙串配置已恢复")
            reconcile()
        } catch { onError?("无法读取本机 CA 或钥匙串配置，请解锁后重开；未开始上传") }
    }

    func handleBackgroundEvents(completion: @escaping () -> Void) {
        backgroundCompletion = completion
        _ = session
        reconcile()
        if finishedBackgroundEvents { finishBackgroundCallback() }
    }

    // 先向系统查询现有任务，再允许创建新任务，覆盖创建任务前后被杀的窗口。
    func reconcile() {
        guard !reconciling else { return }
        reconciling = true
        session.getAllTasks { [weak self] tasks in
            DispatchQueue.main.async {
                guard let self = self else { return }
                let pending = Set(self.store.state.recordings.filter { $0.status != .receipted }.map(\.id))
                let plan = UploadRecovery.plan(pendingRecordingIDs: pending, tasks: tasks.map {
                    UploadTaskSnapshot(taskID: $0.taskIdentifier,
                        recordingID: $0.taskDescription.flatMap(UUID.init(uuidString:)),
                        isActive: $0.state != .completed && $0.state != .canceling)
                })
                self.active = plan.retained
                for task in tasks {
                    if plan.cancelTaskIDs.contains(task.taskIdentifier) {
                        self.ignoredTasks.insert(task.taskIdentifier)
                        task.cancel()
                        continue
                    }
                    if plan.retained.values.contains(task.taskIdentifier), task.state == .suspended { task.resume() }
                }
                do {
                    try self.store.commit { state in
                        for index in state.recordings.indices {
                            let id = state.recordings[index].id
                            if self.active[id] != nil {
                                state.recordings[index].status = .uploading
                                state.recordings[index].message = "已恢复系统后台上传任务"
                            } else if state.recordings[index].status == .uploading {
                                state.recordings[index].status = .downloaded
                                state.recordings[index].message = "系统任务已结束或丢失，将用同一本地 ID 重试"
                            }
                        }
                    }
                    self.reconciled = true
                } catch {
                    self.reconciled = false
                    self.onError?("无法保存后台任务恢复状态；已暂停新上传")
                }
                self.reconciling = false
                self.pump()
            }
        }
    }

    func settingsChanged() {
        // 已有任务保留其原请求，新设置用于后续任务；不为同一录音另建并行任务。
        do {
            try store.commit { state in
                for index in state.recordings.indices where state.recordings[index].status != .receipted
                    && state.recordings[index].relativePath != nil {
                    state.recordings[index].authenticationBlocked = false
                    state.recordings[index].requiresAttention = false
                    state.recordings[index].nextAttempt = nil
                }
            }
            pump()
        } catch { onError?("无法保存重试状态") }
    }

    func pump() {
        pollResults()
        guard transport != nil, reconciled, !reconciling, active.isEmpty else { return }
        let now = Date()
        guard let record = store.state.recordings.filter({
            ($0.status == .downloaded || $0.status == .failed) && $0.relativePath != nil
                && !$0.authenticationBlocked && !$0.requiresAttention
        }).sorted(by: { ($0.nextAttempt ?? .distantPast) < ($1.nextAttempt ?? .distantPast) }).first else { return }
        do {
            guard let file = store.fileURL(record) else { throw RelayFailure.message("本地文件路径无效") }
            let c = try configuration()
            guard Date().timeIntervalSince1970 * 1000 < c.expiresAt else { throw RelayFailure.message("设备凭证已过期，请由 Mac 更新") }
            let endpoint = try V1Upload.endpoint(c.baseURL)
            let token = c.token
            // 重传前再次核对磁盘原件，绝不上传半文件或已被修改的内容。
            let actual = try RelayStore.inspectAudio(file, format: record.audioFormat ?? .wav)
            guard actual.bytes == record.bytes, actual.sha256 == record.sha256 else {
                throw RelayFailure.message("本地文件大小或哈希改变，已停止上传并保留文件")
            }
            let metadata = UploadMetadata(filename: record.filename, bytes: record.bytes,
                sha256: record.sha256, binding: record.bindingID.uuidString,
                localID: record.uploadLocalID ?? record.id.uuidString, recordedAt: nil)
            let headers = try V1Upload.headers(metadata, token: token, audioFormat: record.audioFormat ?? .wav)
            var request = URLRequest(url: endpoint)
            request.httpMethod = "POST"
            headers.forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
            try store.update(record.id) {
                $0.status = .uploading
                $0.attempts += 1
                $0.message = "后台上传中，等待回执"
                $0.nextAttempt = nil
            }
            let task = session.uploadTask(with: request, fromFile: file)
            task.taskDescription = record.id.uuidString
            // 系统负责延后调度；锁屏挂起后也不依赖应用 Timer 唤醒。
            if let retryDate = record.nextAttempt, retryDate > now {
                task.earliestBeginDate = retryDate
            }
            active[record.id] = task.taskIdentifier
            store.log("上传开始 · 本地ID \(record.id.uuidString)")
            task.resume()
        } catch {
            // 不记录 NSError 的描述，它可能包含地址或请求信息。
            let message = (error as? RelayFailure)?.errorDescription ?? "上传设置或本地校验失败，请核对地址、凭证与文件"
            markFailure(record.id, message: message, attention: true)
            DispatchQueue.main.async { [weak self] in self?.pump() }
        }
    }

    private func markFailure(_ id: UUID, message: String, authentication: Bool = false, attention: Bool = false) {
        do {
            try store.update(id) {
                $0.status = .failed
                $0.message = message
                $0.authenticationBlocked = authentication
                $0.requiresAttention = attention
                $0.nextAttempt = Date().addingTimeInterval(min(300, pow(2, Double(min($0.attempts, 6))) * 5))
            }
            store.log("上传未完成，文件保留 · 本地ID \(id.uuidString) · \(message)")
        } catch {
            reconciled = false
            onError?("保存上传失败状态出错，已暂停新上传；文件仍保留，请重开应用恢复")
        }
    }

    func urlSession(_ session: URLSession, taskIsWaitingForConnectivity task: URLSessionTask) {
        guard let text = task.taskDescription, let id = UUID(uuidString: text), store.recording(id) != nil else { return }
        do {
            try store.update(id) { $0.message = "原音已保存在手机，等待网络恢复后自动上传" }
            store.log("等待网络恢复 · 本地ID \(id.uuidString)")
        } catch { onError?("无法保存等待网络状态；原音仍保留") }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        finishedBackgroundEvents = false
        guard !ignoredTasks.contains(dataTask.taskIdentifier), !oversizedResponses.contains(dataTask.taskIdentifier) else { return }
        var bytes = responseData[dataTask.taskIdentifier] ?? Data()
        guard bytes.count + data.count <= 65_536 else {
            oversizedResponses.insert(dataTask.taskIdentifier)
            responseData.removeValue(forKey: dataTask.taskIdentifier)
            dataTask.cancel()
            return
        }
        bytes.append(data)
        responseData[dataTask.taskIdentifier] = bytes
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finishedBackgroundEvents = false
        let body = responseData.removeValue(forKey: task.taskIdentifier) ?? Data()
        let oversized = oversizedResponses.remove(task.taskIdentifier) != nil
        if ignoredTasks.remove(task.taskIdentifier) != nil { return }
        guard let text = task.taskDescription, let id = UUID(uuidString: text),
              let record = store.recording(id), record.status != .receipted else { return }
        // 被取消的重复任务不能覆盖仍在运行的那一份任务。
        if let current = active[id], current != task.taskIdentifier { return }
        active.removeValue(forKey: id)
        if oversized {
            markFailure(id, message: "后台回执超过 64 KiB，已拒绝", attention: true)
        } else if let response = task.response as? HTTPURLResponse,
                  response.statusCode == 401 || response.statusCode == 403 {
            markFailure(id, message: "凭证失效（HTTP \(response.statusCode)），请更新设置后重试", authentication: true)
        } else if error != nil {
            markFailure(id, message: "网络传输中断，等待重试")
        } else if let response = task.response as? HTTPURLResponse {
            let status = response.statusCode
            if [200, 201].contains(status) {
                let receipt: V1UploadReceipt
                do {
                    receipt = try V1UploadReceipt.parse(data: body, status: status)
                } catch {
                    // 崩溃恢复可能丢失内存中的响应正文；用相同本地 ID 重发取回回执。
                    markFailure(id, message: "未收到可解析回执，文件保留", attention: !body.isEmpty)
                    pump()
                    return
                }
                do {
                    try receipt.validate(expectedBytes: record.bytes, expectedSHA256: record.sha256,
                                         expectedDevice: try configuration().device,
                                         expectedLocalID: record.uploadLocalID ?? record.id.uuidString, previous: record.receipt)
                } catch {
                    markFailure(id, message: "回执字节数、哈希或重发一致性校验失败", attention: true)
                    pump()
                    return
                }
                do {
                    try store.update(id) {
                        $0.receipt = receipt
                        $0.status = .receipted
                        $0.message = $0.delivery?.complete == true ? "转写完成 · 飞书结果卡已就绪（重复回执已核对）" : receipt.integrityMessage
                        $0.nextAttempt = nil
                        $0.authenticationBlocked = false
                        $0.requiresAttention = false
                    }
                    store.log("回执已保存 · 本地ID \(id.uuidString) · \(receipt.integrityMessage)")
                } catch {
                    reconciled = false
                    onError?("回执有效但本地保存失败；文件保留，请重开应用恢复")
                }
            } else {
                let transient = status == 408 || status == 429 || status >= 500
                markFailure(id, message: "后台拒绝上传（HTTP \(status)），文件保留", attention: !transient)
            }
        } else {
            markFailure(id, message: "未收到 HTTP 回执，等待重试")
        }
        pump()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // 未验证：后台 URLSession 可能由系统直接处理重定向，不调用此代理。
        // 部署必须提供不重定向的最终 HTTPS 地址；不能把此回调当作后台跨域安全保证。
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard let transport else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        transport.urlSession(session, didReceive: challenge, completionHandler: completionHandler)
    }

    func pollResults() {
        guard transport != nil else { return }
        for record in store.state.recordings where record.receipt != nil && (record.delivery?.complete != true || record.documentVerification?.matches(record.delivery?.document) != true || record.documentAllowsCleanup == nil) {
            guard !polling.contains(record.id), (queryAfter[record.id] ?? .distantPast) <= Date() else { continue }
            do {
                let c = try configuration()
                guard Date().timeIntervalSince1970 * 1000 < c.expiresAt else { continue }
                let receipt = record.receipt!
                let url = try V1Upload.endpoint(c.baseURL).appendingPathComponent(receipt.recordingID)
                var request = URLRequest(url: url)
                request.setValue("Bearer " + c.token, forHTTPHeaderField: "Authorization")
                polling.insert(record.id)
                queryAfter[record.id] = Date().addingTimeInterval(5)
                resultSession.dataTask(with: request) { [weak self] data, response, error in
                    DispatchQueue.main.async {
                        guard let self else { return }
                        self.polling.remove(record.id)
                        guard error == nil, (response as? HTTPURLResponse)?.statusCode == 200,
                              let data, data.count <= 65536,
                              let result = try? JSONDecoder().decode(V1Delivery.self, from: data),
                              result.recordingId == receipt.recordingID else {
                            self.queryAfter[record.id] = Date().addingTimeInterval(15); return
                        }
                        do {
                            try self.store.update(record.id) {
                                $0.delivery = result
                                if $0.documentVerification?.matches(result.document) != true { $0.documentVerification = nil; $0.documentAllowsCleanup = nil }
                                $0.documentMessage = result.document == nil ? "结构化文档：后台尚未提供，原音保留" : "结构化文档：等待回读核对"
                                $0.message = result.complete ? "转写完成 · 飞书结果卡已就绪" : "后台：\(result.status) · 飞书：\(result.feishu.state)"
                                if result.error != nil || result.feishu.error != nil { $0.message = "后台或飞书处理失败，保留回执等待核查" }
                            }
                            self.queryAfter[record.id] = Date().addingTimeInterval(result.complete ? 30 : 5)
                            if let document = result.document, result.complete {
                                self.verifyDocument(recordID: record.id, document: document, delivery: result)
                            }
                            if result.complete && record.delivery?.complete != true { self.store.log("飞书结果卡已就绪 · 本地ID \(record.id.uuidString)") }
                        } catch { self.onError?("无法保存结果查询状态") }
                    }
                }.resume()
            } catch { onError?("结果查询配置不可用") }
        }
    }

    private func verifyDocument(recordID: UUID, document: DocumentReceipt, delivery: V1Delivery) {
        guard !verifyingDocuments.contains(recordID), let record = store.recording(recordID),
              record.documentVerification?.matches(document) != true || record.documentAllowsCleanup == nil else { return }
        do {
            let paths = try DocumentReceiptVerifier.paths(document, recordingID: record.sha256,
                                                          messageID: delivery.feishu.messageId ?? "")
            let c = try configuration()
            let base = try UploadEndpoint.validate(c.baseURL)
            verifyingDocuments.insert(recordID)
            func fetch(_ index: Int, _ parts: [Data]) {
                if index == paths.count {
                    defer { self.verifyingDocuments.remove(recordID) }
                    do {
                        let verification = try DocumentReceiptVerifier.verify(document, recordingID: record.sha256,
                            audioBytes: record.bytes, messageID: delivery.feishu.messageId ?? "",
                            manifest: parts[0], json: parts[1], markdown: parts[2])
                        guard let current = self.store.recording(recordID),
                              current.delivery?.document?.receiptId == document.receiptId,
                              current.delivery?.document?.manifestSha256 == document.manifestSha256,
                              current.delivery?.document?.revision == document.revision,
                              current.delivery?.feishu.messageId == delivery.feishu.messageId else { return }
                        let directory = self.store.root.appendingPathComponent("documents")
                            .appendingPathComponent(recordID.uuidString).appendingPathComponent(String(verification.revision))
                        try RelayStore.prepareDirectory(directory)
                        for (name, data) in zip(["manifest.json", "document.json", "document.md"], parts) {
                            try data.write(to: directory.appendingPathComponent(name),
                                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                        }
                        try self.store.update(recordID) {
                            $0.documentVerification = verification
                            let object = (try? JSONSerialization.jsonObject(with: parts[1])) as? [String: Any]
                            $0.documentAllowsCleanup = (object?["uncertainties"] as? [Any])?.isEmpty == true
                            $0.documentMessage = "结构化文档 v\(verification.revision) 已交付并回读校验；原音保留"
                        }
                    } catch {
                        try? self.store.update(recordID) { $0.documentMessage = "结构化文档校验失败，原音保留" }
                    }
                    return
                }
                // All paths were checked against this recording's exact canonical route.
                let url = base.appendingPathComponent(String(paths[index].dropFirst()))
                var request = URLRequest(url: url)
                request.setValue("Bearer " + c.token, forHTTPHeaderField: "Authorization")
                self.resultSession.dataTask(with: request) { data, response, error in
                    DispatchQueue.main.async {
                        guard error == nil, (response as? HTTPURLResponse)?.statusCode == 200,
                              let data, data.count <= (index == 0 ? 65536 : 4 * 1024 * 1024) else {
                            self.verifyingDocuments.remove(recordID)
                            try? self.store.update(recordID) { $0.documentMessage = "结构化文档暂不可回读，原音保留" }
                            return
                        }
                        fetch(index + 1, parts + [data])
                    }
                }.resume()
            }
            fetch(0, [])
        } catch {
            try? store.update(recordID) { $0.documentMessage = "结构化文档或飞书交付未完成，原音保留" }
        }
    }

    func cleanupPreflight(_ id: UUID, proof: DocumentVerification, completion: @escaping (CleanupPermit?) -> Void) {
        guard transport != nil, let record = store.recording(id), record.sha256 == proof.recordingId else { completion(nil); return }
        do {
            let config = try configuration()
            guard Date().timeIntervalSince1970 * 1000 < config.expiresAt else { completion(nil); return }
            let url = try V1Upload.endpoint(config.baseURL).appendingPathComponent(record.sha256).appendingPathComponent("cleanup-preflight")
            var request = URLRequest(url: url); request.cachePolicy = .reloadIgnoringLocalCacheData
            request.setValue("Bearer " + config.token, forHTTPHeaderField: "Authorization")
            let sentAt = ProcessInfo.processInfo.systemUptime
            resultSession.dataTask(with: request) { data, response, error in
                DispatchQueue.main.async {
                    guard error == nil, let response = response as? HTTPURLResponse, response.statusCode == 200,
                          let data, data.count <= 8192, let value = try? JSONDecoder().decode(CleanupPreflight.self, from: data),
                          let dateString = response.value(forHTTPHeaderField: "Date") else { completion(nil); return }
                    let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
                    formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss z"
                    guard let date = formatter.date(from: dateString) else { completion(nil); return }
                    let now = ProcessInfo.processInfo.systemUptime
                    let permit = CleanupPermit(value: value, serverDate: date, receivedUptime: now, requestDuration: now - sentAt)
                    guard (try? permit.validate(proof: proof, bytes: record.bytes)) != nil else { completion(nil); return }
                    completion(permit)
                }
            }.resume()
        } catch { completion(nil) }
    }

    /// Refresh every artifact immediately before cleanup. Cached success is never deletion authority.
    func refreshCleanupDocument(_ id: UUID, completion: @escaping (DocumentVerification?) -> Void) {
        guard transport != nil, let record = store.recording(id), let receipt = record.receipt else { completion(nil); return }
        do {
            let config = try configuration()
            guard Date().timeIntervalSince1970 * 1000 < config.expiresAt else { completion(nil); return }
            let base = try UploadEndpoint.validate(config.baseURL)
            func fetch(_ path: String, limit: Int, done: @escaping (Data?) -> Void) {
                var request = URLRequest(url: base.appendingPathComponent(String(path.dropFirst())))
                request.cachePolicy = .reloadIgnoringLocalCacheData
                request.setValue("Bearer " + config.token, forHTTPHeaderField: "Authorization")
                self.resultSession.dataTask(with: request) { data, response, error in
                    DispatchQueue.main.async {
                        guard error == nil, (response as? HTTPURLResponse)?.statusCode == 200,
                              let data, data.count <= limit else { done(nil); return }
                        done(data)
                    }
                }.resume()
            }
            fetch(receipt.resultPath, limit: 65536) { data in
                guard let data, let delivery = try? JSONDecoder().decode(V1Delivery.self, from: data),
                      delivery.recordingId == record.sha256, delivery.complete,
                      delivery.error == nil, delivery.feishu.error == nil, let document = delivery.document,
                      let paths = try? DocumentReceiptVerifier.paths(document, recordingID: record.sha256,
                          messageID: delivery.feishu.messageId ?? "") else { completion(nil); return }
                func parts(_ index: Int, _ values: [Data]) {
                    if index < paths.count {
                        fetch(paths[index], limit: index == 0 ? 65536 : 4 * 1024 * 1024) { data in
                            guard let data else { completion(nil); return }
                            parts(index + 1, values + [data])
                        }
                        return
                    }
                    do {
                        let proof = try DocumentReceiptVerifier.verify(document, recordingID: record.sha256,
                            audioBytes: record.bytes, messageID: delivery.feishu.messageId ?? "",
                            manifest: values[0], json: values[1], markdown: values[2])
                        // Missing uncertainty information fails closed; no schema guesses authorize deletion.
                        guard let json = try JSONSerialization.jsonObject(with: values[1]) as? [String: Any],
                              let uncertainties = json["uncertainties"] as? [Any], uncertainties.isEmpty,
                              let current = self.store.recording(id), current.sha256 == record.sha256,
                              current.bytes == record.bytes, current.receipt == receipt else { completion(nil); return }
                        let directory = self.store.root.appendingPathComponent("documents")
                            .appendingPathComponent(id.uuidString).appendingPathComponent(String(proof.revision))
                        try RelayStore.prepareDirectory(directory)
                        for (name, value) in zip(["manifest.json", "document.json", "document.md"], values) {
                            try value.write(to: directory.appendingPathComponent(name),
                                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                        }
                        try self.store.update(id) {
                            $0.delivery = delivery; $0.documentVerification = proof; $0.documentAllowsCleanup = true
                            $0.documentMessage = "文档与飞书交付已重新核对，等待清理预检"
                        }
                        completion(proof)
                    } catch { completion(nil) }
                }
                parts(0, [])
            }
        } catch { completion(nil) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        // delegateQueue 为主队列；状态已在前面的回调同步落盘后才通知系统。
        finishedBackgroundEvents = true
        finishBackgroundCallback()
    }

    private func finishBackgroundCallback() {
        guard let completion = backgroundCompletion else { return }
        backgroundCompletion = nil
        finishedBackgroundEvents = false
        completion()
    }
}

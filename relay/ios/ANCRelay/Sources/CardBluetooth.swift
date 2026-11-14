import Foundation
import CoreBluetooth

struct DiscoveredCard: Identifiable {
    let id: UUID
    let name: String
    let rssi: Int
}

final class CardBluetooth: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private static let service = CBUUID(string: "AE20")
    private static let writeID = CBUUID(string: "AE21")
    private static let replyID = CBUUID(string: "AE22")
    private static let eventID = CBUUID(string: "AE23")
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var writeCharacteristic: CBCharacteristic?
    private var replyCharacteristic: CBCharacteristic?
    private var eventCharacteristic: CBCharacteristic?
    private var replyParser = FrameParser()
    private var eventParser = FrameParser()
    private var sequence: UInt8 = 0
    private var found: [UUID: CBPeripheral] = [:]
    private var reconnectWork: DispatchWorkItem?
    private struct PendingWrite {
        let frame: Data
        let completion: (Result<Void, Error>) -> Void
    }
    private var writes: [PendingWrite] = []
    private(set) var boundID: UUID?
    private(set) var ready = false
    private(set) var status = "等待蓝牙"
    private(set) var discovered: [DiscoveredCard] = []
    var onChange: (() -> Void)?
    var onReady: (() -> Void)?
    var onDisconnect: (() -> Void)?
    var onFrame: ((Frame, Bool) -> Void)?
    var onDiagnostic: ((String) -> Void)?

    init(boundID: UUID?) {
        self.boundID = boundID
        super.init()
    }

    func start() {
        guard central == nil else { return }
        central = CBCentralManager(delegate: self, queue: .main,
            options: [CBCentralManagerOptionRestoreIdentifierKey: "ANCRelay.CardCentral.v1",
                      CBCentralManagerOptionShowPowerAlertKey: true])
    }

    func scan() {
        guard central?.state == .poweredOn else { setStatus("请开启蓝牙并授权") ; return }
        guard boundID == nil else { reconnect(); return }
        discovered = []
        found = [:]
        central.scanForPeripherals(withServices: [Self.service],
                                  options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        setStatus("扫描 AE20 录音卡；请核对卡片后绑定")
    }

    func bind(_ id: UUID) {
        boundID = id
        central.stopScan()
        connect(found[id] ?? central.retrievePeripherals(withIdentifiers: [id]).first)
    }

    func restartLink() {
        let oldPeripheral = peripheral
        // 先同步阻止迟到的可写回调，随后才请求系统断开连接。
        resetLink()
        setStatus("清理中断传输，正在重新连接")
        if let oldPeripheral = oldPeripheral {
            central.cancelPeripheralConnection(oldPeripheral)
        } else { reconnect() }
    }

    private func setStatus(_ text: String) { status = text; onChange?() }

    private func connect(_ candidate: CBPeripheral?) {
        guard central.state == .poweredOn, let candidate = candidate else {
            reconnect(); return
        }
        peripheral = candidate
        candidate.delegate = self
        if candidate.state == .connected {
            candidate.discoverServices([Self.service])
        } else if candidate.state != .connecting {
            setStatus("正在连接已绑定的卡")
            central.connect(candidate, options: nil)
        }
    }

    private func reconnect() {
        guard let id = boundID, central?.state == .poweredOn else { return }
        if let candidate = central.retrievePeripherals(withIdentifiers: [id]).first {
            connect(candidate)
        } else {
            central.scanForPeripherals(withServices: [Self.service], options: nil)
            setStatus("寻找已绑定的卡")
        }
    }

    private func scheduleReconnect() {
        reconnectWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.reconnect() }
        reconnectWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
    }

    func send(_ payload: Data, completion: @escaping (Result<Void, Error>) -> Void) {
        do {
            // 所有发送均经过这里：先验证允许清单，再构造帧。
            try CardCommand.validate(payload)
            guard ready, let peripheral = peripheral, writeCharacteristic != nil else {
                throw RelayFailure.message("蓝牙未就绪")
            }
            let frame = try CardCommand.frame(payload: payload, sequence: sequence)
            sequence &+= 1
            let limit = peripheral.maximumWriteValueLength(for: .withoutResponse)
            guard limit >= frame.count else {
                throw RelayFailure.message("蓝牙单次写入上限 \(limit) 字节，小于请求 \(frame.count) 字节；禁止拆帧")
            }
            guard writes.count < 32 else { throw RelayFailure.message("蓝牙发送队列已满") }
            writes.append(PendingWrite(frame: frame, completion: completion))
            drainWrites()
        } catch { completion(.failure(error)) }
    }

    private func drainWrites() {
        guard ready, let peripheral = peripheral, let characteristic = writeCharacteristic else { return }
        while !writes.isEmpty, peripheral.canSendWriteWithoutResponse {
            let next = writes.removeFirst()
            // 不拆帧；连接恢复后仍重新检查实际协商的写入上限。
            guard next.frame.count <= peripheral.maximumWriteValueLength(for: .withoutResponse) else {
                next.completion(.failure(RelayFailure.message("蓝牙写入上限不足，无法完整发送")))
                continue
            }
            peripheral.writeValue(next.frame, for: characteristic, type: .withoutResponse)
            next.completion(.success(()))
        }
    }

    private func resetLink() {
        ready = false
        writeCharacteristic = nil
        replyCharacteristic = nil
        eventCharacteristic = nil
        replyParser.reset()
        eventParser.reset()
        let pending = writes
        writes.removeAll()
        pending.forEach { $0.completion(.failure(RelayFailure.message("蓝牙连接中断"))) }
        onDisconnect?()
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn { boundID == nil ? scan() : reconnect() }
        else {
            resetLink()
            switch central.state {
            case .unauthorized: setStatus("蓝牙未授权，请在系统设置中允许")
            case .poweredOff: setStatus("蓝牙已关闭")
            case .unsupported: setStatus("此设备不支持蓝牙")
            default: setStatus("蓝牙暂时不可用")
            }
        }
    }

    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        guard let id = boundID,
              let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral],
              let target = restored.first(where: { $0.identifier == id }) else { return }
        peripheral = target
        target.delegate = self
        setStatus("正在恢复蓝牙状态")
        if central.state == .poweredOn { connect(target) }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        if let boundID = boundID {
            if peripheral.identifier == boundID { central.stopScan(); connect(peripheral) }
            return
        }
        found[peripheral.identifier] = peripheral
        let name = peripheral.name ?? (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? "录音卡"
        discovered.removeAll { $0.id == peripheral.identifier }
        discovered.append(DiscoveredCard(id: peripheral.identifier, name: name, rssi: RSSI.intValue))
        onChange?()
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard peripheral.identifier == boundID else { return }
        reconnectWork?.cancel()
        self.peripheral = peripheral
        peripheral.delegate = self
        peripheral.discoverServices([Self.service])
        setStatus("已连接，正在订阅通知")
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard peripheral.identifier == boundID else { return }
        resetLink(); setStatus("连接失败，正在重试"); scheduleReconnect()
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard peripheral.identifier == boundID else { return }
        resetLink(); setStatus("连接断开，等待重连"); scheduleReconnect()
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil, let service = peripheral.services?.first(where: { $0.uuid == Self.service }) else {
            setStatus("未找到 AE20 服务，重新连接")
            central.cancelPeripheralConnection(peripheral)
            return
        }
        peripheral.discoverCharacteristics([Self.writeID, Self.replyID, Self.eventID], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard error == nil else { central.cancelPeripheralConnection(peripheral); return }
        for characteristic in service.characteristics ?? [] {
            switch characteristic.uuid {
            case Self.writeID: writeCharacteristic = characteristic
            case Self.replyID: replyCharacteristic = characteristic
            case Self.eventID: eventCharacteristic = characteristic
            default: break
            }
        }
        guard let write = writeCharacteristic, write.properties.contains(.writeWithoutResponse),
              let reply = replyCharacteristic, let event = eventCharacteristic else {
            setStatus("卡缺少必要的写入或通知特征")
            central.cancelPeripheralConnection(peripheral)
            return
        }
        peripheral.setNotifyValue(true, for: reply)
        peripheral.setNotifyValue(true, for: event)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, characteristic.isNotifying else {
            setStatus("通知订阅失败，重新连接")
            central.cancelPeripheralConnection(peripheral)
            return
        }
        if !ready, replyCharacteristic?.isNotifying == true, eventCharacteristic?.isNotifying == true {
            ready = true
            setStatus("已连接，AE22 / AE23 通知已就绪")
            onReady?()
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if error != nil {
            onDiagnostic?("BLE 通知读取失败 · " + characteristic.uuid.uuidString)
            return
        }
        guard let data = characteristic.value else { return }
        guard ready else {
            onDiagnostic?("BLE 通知到达但订阅尚未全部就绪 · " + characteristic.uuid.uuidString + " · 字节 " + String(data.count))
            return
        }
        let isEvent = characteristic.uuid == Self.eventID
        let frames: [Frame]
        if isEvent { frames = eventParser.push(data) }
        else if characteristic.uuid == Self.replyID { frames = replyParser.push(data) }
        else { return }
        if isEvent || frames.contains(where: { !(($0.type == 2 && $0.command == 4) || ($0.type == 1 && $0.command == 1)) }) || frames.isEmpty && data.count < 32 {
            let commands = frames.map { "\($0.type)-\($0.command)" }.joined(separator: ",")
            onDiagnostic?("[DEBUG-meeting] \(isEvent ? "AE23" : "AE22") 通知 · 字节 \(data.count) · 解析帧 \(frames.count) · \(commands)")
        }
        for frame in frames { onFrame?(frame, isEvent) }
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) { drainWrites() }
}

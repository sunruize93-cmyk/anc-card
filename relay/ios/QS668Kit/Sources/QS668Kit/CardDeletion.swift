import Foundation

public enum CardDeletionAction: Equatable {
    case send(Data)
    case reconcileRequired
    case confirmedAbsent
    case retained(String)
}

/// One exact target, at most one delete write per operation. Recovery only re-lists.
public struct CardDeletionMachine {
    private enum Phase { case idle, waitingAck, listing, finished }
    private var phase: Phase = .idle
    private let raw: Data
    private let name: String
    private var deadline: TimeInterval = 0
    private var collector: FileListCollector?
    public private(set) var targetUnchangedAfterReconcile = false
    public var isFinished: Bool { phase == .finished }
    public init(rawRecord: Data) throws {
        let payload = try CardCommand.deleteSingleFile(rawRecord: rawRecord)
        self.raw = Data(payload.dropFirst(2))
        self.name = try CardFileList.parse(Data([0,0,0,1]) + rawRecord)[0].name
    }
    public mutating func start(at now: TimeInterval, recoveryOnly: Bool = false) throws -> [CardDeletionAction] {
        guard phase == .idle else { return [] }
        if recoveryOnly { return beginList(at: now) }
        phase = .waitingAck; deadline = now + 3
        return [.send(try CardCommand.deleteSingleFile(rawRecord: raw))]
    }
    public mutating func receive(_ frame: Frame, at now: TimeInterval) -> [CardDeletionAction] {
        guard phase != .finished else { return [] }
        if phase == .waitingAck, frame.type == 2, frame.command == 13 {
            // Even a successful ACK is not proof of absence; do not remove local audio yet.
            return beginList(at: now)
        }
        if phase == .listing, var value = collector {
            do {
                let entries = try value.receive(frame, at: now); collector = value
                if let entries { return finish(entries) }
            } catch { return fail("无法获得完整删除后列表，原音保留") }
        }
        return []
    }
    public mutating func tick(at now: TimeInterval) -> [CardDeletionAction] {
        if phase == .waitingAck && now >= deadline { return beginList(at: now) }
        if phase == .listing, var value = collector {
            do { _ = try value.tick(at: now); collector = value }
            catch { return fail("删除后列表未明确结束，原音保留") }
        }
        return []
    }
    private mutating func beginList(at now: TimeInterval) -> [CardDeletionAction] {
        phase = .listing; collector = FileListCollector(now: now, requireExplicitEnd: true)
        return [.reconcileRequired, .send(CardCommand.listFiles)]
    }
    private mutating func finish(_ entries: [FileEntry]) -> [CardDeletionAction] {
        phase = .finished
        targetUnchangedAfterReconcile = entries.filter { $0.name == name }.count == 1 && entries.contains { $0.rawRecord == raw }
        if entries.contains(where: { $0.rawRecord == raw || $0.name == name }) {
            return [.retained("目标仍在卡内或同名身份已变化；未删除手机副本")]
        }
        return [.confirmedAbsent]
    }
    private mutating func fail(_ reason: String) -> [CardDeletionAction] { phase = .finished; return [.retained(reason)] }
}

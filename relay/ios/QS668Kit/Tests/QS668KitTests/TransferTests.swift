import Foundation
import XCTest
@testable import QS668Kit

final class TransferTests: XCTestCase {
    private func entryBytes(_ name: String, duration: UInt32 = 17, size: UInt32 = 1024) -> Data {
        func bigEndian(_ value: UInt32) -> [UInt8] {
            [UInt8(truncatingIfNeeded: value >> 24), UInt8(truncatingIfNeeded: value >> 16),
             UInt8(truncatingIfNeeded: value >> 8), UInt8(truncatingIfNeeded: value)]
        }
        let nameBytes = Array(name.utf8.prefix(20))
        return Data(bigEndian(duration) + bigEndian(size) + nameBytes + Array(repeating: 0, count: 20 - nameBytes.count))
    }

    private func listFrame(_ names: [String]) -> Frame {
        var parameters = Data([0, 0, 0, UInt8(names.count)])
        names.forEach { parameters.append(entryBytes($0)) }
        return Frame(type: 2, command: 1, parameters: parameters)
    }

    private func began() -> Frame { Frame(type: 2, command: 3, parameters: Data("a.wav".utf8)) }
    private func chunk(_ bytes: [UInt8] = [1, 2, 3]) -> Frame { Frame(type: 2, command: 4, parameters: Data(bytes)) }
    private func ended(_ code: UInt8) -> Frame { Frame(type: 2, command: 5, parameters: Data([code])) }

    func testListUsesBigEndianAndCountIsPerFrame() throws {
        var collector = FileListCollector(now: 0)
        XCTAssertNil(try collector.receive(listFrame(["a.", "b."]), at: 0.5))
        XCTAssertNil(try collector.receive(listFrame(["c."]), at: 1))
        let result = try XCTUnwrap(collector.receive(Frame(type: 2, command: 18, parameters: Data([0])), at: 1.1))
        XCTAssertEqual(result.map(\.name), ["a.", "b.", "c."])
        XCTAssertEqual(result[0].durationOrTime, 17)
        XCTAssertEqual(result[0].size, 1024)
        XCTAssertTrue(collector.isFinished)
    }

    func testListLegacyIdleRequiresAtLeastOneListFrame() throws {
        var collector = FileListCollector(now: 0)
        XCTAssertNil(try collector.tick(at: 1.3))
        XCTAssertNil(try collector.receive(listFrame(["a."]), at: 2))
        XCTAssertNil(try collector.tick(at: 3.1))
        XCTAssertEqual(try collector.tick(at: 3.21)?.map(\.name), ["a."])
        var empty = FileListCollector(now: 0)
        XCTAssertThrowsError(try empty.tick(at: 4.1))
        XCTAssertTrue(empty.isFinished)
    }

    func testListEmptyBaselineAndMalformedLists() throws {
        var collector = FileListCollector(now: 0)
        XCTAssertEqual(try collector.receive(Frame(type: 2, command: 18, parameters: Data([0])), at: 1), [])
        XCTAssertThrowsError(try CardFileList.parse(Data([0, 0, 0, 1])))
        XCTAssertThrowsError(try CardFileList.parse(Data([0, 0, 0])))
        var rejected = FileListCollector(now: 0)
        XCTAssertThrowsError(try rejected.receive(Frame(type: 2, command: 18, parameters: Data([1])), at: 1))
    }

    func testUnrelatedFramesDoNotExtendListDeadline() throws {
        var collector = FileListCollector(now: 0)
        XCTAssertNil(try collector.receive(listFrame(["a."]), at: 0.5))
        XCTAssertNil(try collector.receive(Frame(type: 0, command: 4), at: 1.5))
        XCTAssertNotNil(try collector.tick(at: 1.71))
    }

    func testFilenameCandidatesFollowVendorOrder() {
        let stem = "note20260710-162938"
        XCTAssertEqual(importNameCandidates(stem + "."), [stem + ".wav", stem + ".opus", stem + "."])
        XCTAssertEqual(importNameCandidates("a.wav"), ["a.wav", "a.opus"])
        XCTAssertEqual(importNameCandidates("a.opus"), ["a.wav", "a.opus"])
        XCTAssertEqual(importNameCandidates(" a "), ["a.wav", "a.opus", "a"])
        XCTAssertEqual(importNameCandidates(""), [])
    }

    func testNewEntriesAreOrderedUniqueAndIgnoreEmptyNames() {
        let entries = ["old", "new2", "new1", "new2", "", "old"].map {
            FileEntry(durationOrTime: 0, size: 1, name: $0)
        }
        XCTAssertEqual(CardFileList.newEntries(known: ["old"], entries: entries).map(\.name), ["new2", "new1"])
    }

    func testDownloadStreamsAndCompletesWithoutRetainingData() throws {
        var machine = DownloadMachine(listName: "a.")
        XCTAssertEqual(machine.start(at: 0), [.send(try CardCommand.download(filename: "a.wav"))])
        XCTAssertEqual(machine.receive(began(), at: 1), [.started("a.wav")])
        XCTAssertEqual(machine.receive(chunk(), at: 2), [.append(Data([1, 2, 3]))])
        XCTAssertEqual(machine.receive(chunk([4]), at: 3), [.append(Data([4]))])
        XCTAssertEqual(machine.receive(ended(0), at: 4), [.completed(name: "a.wav", bytes: 4)])
        XCTAssertTrue(machine.isFinished)
        XCTAssertTrue(machine.receive(chunk(), at: 5).isEmpty)
    }

    func testOnlyMissingWithoutDataAdvancesCandidate() throws {
        var machine = DownloadMachine(listName: "a.")
        _ = machine.start(at: 0)
        XCTAssertEqual(machine.receive(ended(1), at: 1), [.send(try CardCommand.download(filename: "a.opus"))])
        XCTAssertEqual(machine.receive(ended(1), at: 2), [.send(try CardCommand.download(filename: "a."))])
        let actions = machine.receive(ended(1), at: 3)
        XCTAssertTrue(machine.isFinished)
        guard case .failed? = actions.last else { return XCTFail("所有候选不存在必须报错") }
    }

    func testMissingAfterDataDoesNotChangeCandidate() {
        var machine = DownloadMachine(listName: "a.")
        _ = machine.start(at: 0)
        _ = machine.receive(began(), at: 1)
        _ = machine.receive(chunk(), at: 2)
        let actions = machine.receive(ended(1), at: 3)
        XCTAssertTrue(machine.isFinished)
        XCTAssertFalse(actions.contains { if case .send = $0 { return true }; return false })
        guard case .failed? = actions.last else { return XCTFail("收到数据后不存在不能重试") }
    }

    func testEmptySuccessAndDataBeforeStartFail() {
        var empty = DownloadMachine(listName: "a.")
        _ = empty.start(at: 0)
        _ = empty.receive(began(), at: 1)
        guard case .failed? = empty.receive(ended(0), at: 2).last else { return XCTFail("空成功应失败") }
        var premature = DownloadMachine(listName: "a.")
        _ = premature.start(at: 0)
        guard case .failed? = premature.receive(chunk(), at: 1).last else { return XCTFail("未开始不能接收数据") }
    }

    func testTimeoutAbortsWithoutTryingAnotherNameAndResetsOnData() {
        var machine = DownloadMachine(listName: "a.")
        _ = machine.start(at: 0)
        _ = machine.receive(began(), at: 1)
        _ = machine.receive(chunk(), at: 10)
        XCTAssertTrue(machine.tick(at: 21.9).isEmpty)
        let actions = machine.tick(at: 22)
        XCTAssertEqual(actions.first, .send(CardCommand.abortDownload))
        guard case .failed? = actions.last else { return XCTFail("超时应失败") }
        XCTAssertTrue(machine.isFinished)
        var unanswered = DownloadMachine(listName: "a.")
        _ = unanswered.start(at: 0)
        guard case .failed? = unanswered.tick(at: 12).last else { return XCTFail("无回应超时应失败") }
        XCTAssertTrue(unanswered.isFinished)
    }

    func testOtherEndCodesNeverAdvanceCandidate() {
        for code in [UInt8(2), UInt8(3), UInt8(99)] {
            var machine = DownloadMachine(listName: "a.")
            _ = machine.start(at: 0)
            let actions = machine.receive(ended(code), at: 1)
            XCTAssertEqual(actions.count, 1)
            guard case .failed? = actions.first else { return XCTFail("结束错误应失败") }
        }
    }

    func testActualWriteTimeStartsRequestTimeout() throws {
        var list = FileListCollector(now: 0)
        list.requestWasSent(at: 10)
        XCTAssertNil(try list.tick(at: 13.9))
        XCTAssertThrowsError(try list.tick(at: 14))
        var machine = DownloadMachine(listName: "a.")
        _ = machine.start(at: 0)
        machine.requestWasSent(at: 10)
        XCTAssertTrue(machine.tick(at: 21.9).isEmpty)
        XCTAssertFalse(machine.tick(at: 22).isEmpty)
    }

    func testWriteNotificationCannotEraseAnActiveTransfer() {
        var machine = DownloadMachine(listName: "a.")
        _ = machine.start(at: 0)
        _ = machine.receive(began(), at: 1)
        _ = machine.receive(chunk(), at: 2)
        machine.requestWasSent(at: 13)
        XCTAssertFalse(machine.tick(at: 14).isEmpty)
    }

    func testRepeatedStartAndUnrelatedFramesDoNotResetDownload() {
        var machine = DownloadMachine(listName: "a.")
        _ = machine.start(at: 0)
        XCTAssertTrue(machine.start(at: 11).isEmpty)
        XCTAssertTrue(machine.receive(Frame(type: 0, command: 4), at: 11).isEmpty)
        XCTAssertFalse(machine.tick(at: 12).isEmpty)
    }
}

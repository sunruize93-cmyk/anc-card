import XCTest
@testable import QS668Kit
final class CardDeletionTests: XCTestCase {
    func raw(_ name: String = "record.") -> Data {
        let bytes = Array(name.utf8)
        return Data([0,0,0,10,0,0,1,0] + bytes + Array(repeating: 0, count: 20 - bytes.count))
    }
    func end() -> Frame { Frame(type: 2, command: 18, parameters: Data([0])) }
    func testExactEntryOnlyNeverClearAll() throws {
        let payload = try CardCommand.deleteSingleFile(rawRecord: raw())
        XCTAssertEqual(payload, Data([2,8]) + raw())
        XCTAssertEqual(try CardCommand.frame(payload: payload, sequence: 0).count, 36)
        for bytes in [Data(), Data(repeating: 0, count: 28), raw().dropLast()] {
            XCTAssertThrowsError(try CardCommand.deleteSingleFile(rawRecord: Data(bytes)))
        }
        XCTAssertThrowsError(try CardCommand.validate(Data([2,9])))
    }
    func testLostAckOnlyListsNeverResendsDelete() throws {
        var m = try CardDeletionMachine(rawRecord: raw())
        XCTAssertEqual(try m.start(at: 0), [.send(Data([2,8]) + raw())])
        XCTAssertEqual(m.tick(at: 3.1), [.reconcileRequired, .send(CardCommand.listFiles)])
        XCTAssertEqual(m.receive(end(), at: 3.2), [.confirmedAbsent])
        XCTAssertTrue(m.isFinished); XCTAssertEqual(try m.start(at: 10), [])
    }
    func testAckCannotDeletePhoneBeforeExplicitListEnd() throws {
        var m = try CardDeletionMachine(rawRecord: raw()); _ = try m.start(at: 0)
        XCTAssertEqual(m.receive(Frame(type: 2, command: 13, parameters: Data([0])), at: 1), [.reconcileRequired, .send(CardCommand.listFiles)])
        XCTAssertEqual(m.receive(Frame(type: 2, command: 1, parameters: Data([0,0,0,0])), at: 1.1), [])
        XCTAssertEqual(m.tick(at: 2.5), [])
        XCTAssertEqual(m.receive(end(), at: 3), [.confirmedAbsent])
    }
    func testRetainedOrReplacedTargetNeverConfirmsAbsent() throws {
        for entry in [raw(), Data([0,0,0,11]) + raw().dropFirst(4)] {
            var m = try CardDeletionMachine(rawRecord: raw()); _ = try m.start(at: 0, recoveryOnly: true)
            _ = m.receive(Frame(type: 2, command: 1, parameters: Data([0,0,0,1]) + entry), at: 0.2)
            guard case .retained = m.receive(end(), at: 0.3).first else { return XCTFail("Must preserve") }
        }
    }
    func testRecoveryDoesNotRepeatDestructiveCommand() throws {
        var m = try CardDeletionMachine(rawRecord: raw())
        XCTAssertEqual(try m.start(at: 0, recoveryOnly: true), [.reconcileRequired, .send(CardCommand.listFiles)])
        guard case .retained = m.tick(at: 5).first else { return XCTFail("No absence proof on timeout") }
    }
    func testExactOpusRequestHasNoWAVFallback() throws {
        var m = DownloadMachine(exactFilename: "a.opus")
        XCTAssertEqual(m.start(at: 0), [.send(try CardCommand.download(filename: "a.opus"))])
        guard case .failed = m.receive(Frame(type: 2, command: 5, parameters: Data([1])), at: 1).last else { return XCTFail("No fallback") }
    }
}

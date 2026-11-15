import XCTest
@testable import QS668Kit

final class AudioTransferLimitsTests: XCTestCase {
    func testOneHourWAVAndOverflowBoundaries() {
        XCTAssertTrue(AudioTransferLimits.canAppend(received: 64 * 1024 * 1024, next: 115_200_044 - 64 * 1024 * 1024))
        XCTAssertTrue(AudioTransferLimits.canAppend(received: AudioTransferLimits.maxBytes - 1, next: 1))
        XCTAssertFalse(AudioTransferLimits.canAppend(received: AudioTransferLimits.maxBytes, next: 1))
        XCTAssertFalse(AudioTransferLimits.canAppend(received: Int.max, next: 1))
        XCTAssertFalse(AudioTransferLimits.canAppend(received: 1, next: Int.max))
        XCTAssertFalse(AudioTransferLimits.canAppend(received: -1, next: 1))
        XCTAssertFalse(AudioTransferLimits.canAppend(received: 0, next: -1))
    }

    func testOptionalProgressIsCompatibleWithOlderServer() throws {
        let old = Data(#"{"recordingId":"r","status":"processing","feishu":{"state":"pending"}}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(V1Delivery.self, from: old).progressText)
        let current = Data(#"{"recordingId":"r","status":"processing","progressText":"已完成 37/120 段","feishu":{"state":"updating"}}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(V1Delivery.self, from: current).progressText, "已完成 37/120 段")
    }
}

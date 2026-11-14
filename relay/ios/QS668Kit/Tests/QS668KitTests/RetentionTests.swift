import XCTest
@testable import QS668Kit

final class RetentionTests: XCTestCase {
    func item(_ n: Int, audio: Bool = true, document: Bool = true, source: Bool = true) -> AudioRetentionItem {
        AudioRetentionItem(id: String(n), importOrder: n,
                           completeAudio: audio, documentDeliveryVerified: document, sourceIdentityVerified: source)
    }
    func testKeepLatestFiveIndependentOfInputOrder() {
        let items = (1...8).reversed().map { item($0) }
        let plan = AudioRetentionPlanner.plan(items, activatedAfterOrder: 0)
        XCTAssertEqual(plan.filter { $0.value == .eligible }.keys.sorted(), ["1", "2", "3"])
        XCTAssertEqual(plan.filter { $0.value == .latestFive }.count, 5)
    }
    func testFailuresUnknownAndOldFilesStay() {
        let items = [item(1), item(2, audio: false), item(3, document: false), item(4, source: false)] + (5...9).map { item($0) }
        let plan = AudioRetentionPlanner.plan(items, activatedAfterOrder: 1)
        XCTAssertEqual(plan["1"], .beforeActivation)
        XCTAssertEqual(plan["2"], .incompleteAudio)
        XCTAssertEqual(plan["3"], .unverifiedDocument)
        XCTAssertEqual(plan["4"], .unknownSource)
        XCTAssertFalse(plan.values.contains(.eligible))
    }
    func testDisabledAndDuplicateIDsNeverDelete() {
        XCTAssertTrue(AudioRetentionPlanner.plan((1...8).map { item($0) }, activatedAfterOrder: nil).values.allSatisfy { $0 == .disabled })
        XCTAssertTrue(AudioRetentionPlanner.plan([item(1), item(1)], activatedAfterOrder: -1).values.allSatisfy { $0 == .disabled })
    }
    func testPendingNewFilesDoNotEvictFiveCompleteFiles() {
        let items = (1...5).map { item($0) } + (6...12).map { item($0, audio: false) }
        let plan = AudioRetentionPlanner.plan(items, activatedAfterOrder: 0)
        XCTAssertEqual(plan.filter { $0.value == .latestFive }.count, 5)
        XCTAssertFalse(plan.values.contains(.eligible))
    }
    func testFiveOrFewerAlwaysRetained() {
        for count in 0...5 {
            let items = (0..<count).map { item($0) }
            XCTAssertFalse(AudioRetentionPlanner.plan(items, activatedAfterOrder: -1).values.contains(.eligible))
        }
    }
}

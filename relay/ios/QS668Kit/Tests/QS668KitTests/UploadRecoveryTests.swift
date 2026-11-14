import Foundation
import XCTest
@testable import QS668Kit

final class UploadRecoveryTests: XCTestCase {
    private let first = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
    private let second = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!

    func testExistingActiveTaskIsRetainedForPendingRecording() {
        let result = UploadRecovery.plan(pendingRecordingIDs: [first], tasks: [
            UploadTaskSnapshot(taskID: 17, recordingID: first, isActive: true)
        ])
        XCTAssertEqual(result.retained, [first: 17])
        XCTAssertTrue(result.cancelTaskIDs.isEmpty)
        // 调用方通过 retained 排除已有任务，不能再创建同一录音的上传。
        XCTAssertTrue(Set([first]).subtracting(result.retained.keys).isEmpty)
    }

    func testOrphanAndUnknownActiveTasksAreCancelled() {
        let result = UploadRecovery.plan(pendingRecordingIDs: [first], tasks: [
            UploadTaskSnapshot(taskID: 1, recordingID: nil, isActive: true),
            UploadTaskSnapshot(taskID: 2, recordingID: second, isActive: true)
        ])
        XCTAssertTrue(result.retained.isEmpty)
        XCTAssertEqual(result.cancelTaskIDs, [1, 2])
    }

    func testAlreadyReceiptedRecordingIsNotRetained() {
        let result = UploadRecovery.plan(pendingRecordingIDs: [], tasks: [
            UploadTaskSnapshot(taskID: 3, recordingID: first, isActive: true)
        ])
        XCTAssertTrue(result.retained.isEmpty)
        XCTAssertEqual(result.cancelTaskIDs, [3])
    }

    func testDuplicateActiveTasksKeepLowestTaskIdentifier() {
        let result = UploadRecovery.plan(pendingRecordingIDs: [first, second], tasks: [
            UploadTaskSnapshot(taskID: 9, recordingID: first, isActive: true),
            UploadTaskSnapshot(taskID: 2, recordingID: first, isActive: true),
            UploadTaskSnapshot(taskID: 5, recordingID: second, isActive: true)
        ])
        XCTAssertEqual(result.retained, [first: 2, second: 5])
        XCTAssertEqual(result.cancelTaskIDs, [9])
    }

    func testInactiveTasksNeitherBlockNewUploadNorNeedCancellation() {
        let result = UploadRecovery.plan(pendingRecordingIDs: [first], tasks: [
            UploadTaskSnapshot(taskID: 1, recordingID: first, isActive: false),
            UploadTaskSnapshot(taskID: 2, recordingID: nil, isActive: false),
            UploadTaskSnapshot(taskID: 3, recordingID: second, isActive: false)
        ])
        XCTAssertTrue(result.retained.isEmpty)
        XCTAssertTrue(result.cancelTaskIDs.isEmpty)
        XCTAssertEqual(Set([first]).subtracting(result.retained.keys), [first])
    }

    func testTaskEnumerationOrderDoesNotChangeRecoveryDecision() {
        let tasks = [
            UploadTaskSnapshot(taskID: 8, recordingID: first, isActive: true),
            UploadTaskSnapshot(taskID: 4, recordingID: first, isActive: true),
            UploadTaskSnapshot(taskID: 3, recordingID: second, isActive: true),
            UploadTaskSnapshot(taskID: 1, recordingID: first, isActive: false)
        ]
        let original = UploadRecovery.plan(pendingRecordingIDs: [first, second], tasks: tasks)
        let reversed = UploadRecovery.plan(pendingRecordingIDs: [first, second], tasks: Array(tasks.reversed()))
        XCTAssertEqual(original.retained, reversed.retained)
        XCTAssertEqual(original.cancelTaskIDs, reversed.cancelTaskIDs)
        XCTAssertEqual(original.retained, [first: 4, second: 3])
        XCTAssertEqual(original.cancelTaskIDs, [8])
    }
}

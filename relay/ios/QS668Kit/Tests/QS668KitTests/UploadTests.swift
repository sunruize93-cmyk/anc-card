import Foundation
import XCTest
@testable import QS668Kit

final class UploadTests: XCTestCase {
    private let digest = String(repeating: "a", count: 64)

    private func receipt(_ object: [String: Any], status: Int = 201) throws -> UploadReceipt {
        try UploadReceipt.parse(data: JSONSerialization.data(withJSONObject: object), status: status)
    }

    private func metadata(filename: String = "a b.wav", binding: String = "test-binding", recordedAt: String? = nil) -> UploadMetadata {
        UploadMetadata(filename: filename, bytes: 44, sha256: digest, binding: binding, localID: "test-local", recordedAt: recordedAt)
    }

    func testCompleteReceiptValidatesAndConfirmsIntegrity() throws {
        let value = try receipt(["recordingId": "record-1", "bytes": 44, "sha256": digest.uppercased(), "duplicate": false])
        try value.validate(expectedBytes: 44, expectedSHA256: digest)
        XCTAssertTrue(value.integrityConfirmed)
        XCTAssertEqual(value.recordingID, "record-1")
        XCTAssertEqual(value.sha256, digest)
        XCTAssertEqual(try JSONDecoder().decode(UploadReceipt.self, from: JSONEncoder().encode(value)), value)
    }

    func testLegacyReceiptAcceptedWithExplicitWarning() throws {
        let value = try receipt(["recording": ["id": "record-1"], "duplicate": true])
        try value.validate(expectedBytes: 44, expectedSHA256: digest)
        XCTAssertFalse(value.integrityConfirmed)
        XCTAssertEqual(value.integrityMessage, "完整性未获服务端确认")
    }

    func testOneMissingFieldStillWarnsAndPresentFieldIsChecked() throws {
        let value = try receipt(["recordingId": "record-1", "bytes": 44, "duplicate": false])
        try value.validate(expectedBytes: 44, expectedSHA256: digest)
        XCTAssertFalse(value.integrityConfirmed)
        XCTAssertThrowsError(try value.validate(expectedBytes: 45, expectedSHA256: digest))
        let hashOnly = try receipt(["recordingId": "record-1", "sha256": digest, "duplicate": false])
        try hashOnly.validate(expectedBytes: 44, expectedSHA256: digest)
        XCTAssertFalse(hashOnly.integrityConfirmed)
    }

    func testByteAndHashMismatchesRejected() throws {
        let size = try receipt(["recordingId": "record-1", "bytes": 43, "duplicate": false])
        XCTAssertThrowsError(try size.validate(expectedBytes: 44, expectedSHA256: digest))
        let hash = try receipt(["recordingId": "record-1", "sha256": String(repeating: "b", count: 64), "duplicate": false])
        XCTAssertThrowsError(try hash.validate(expectedBytes: 44, expectedSHA256: digest))
    }

    func testHashLikeLegacyIDMustMatch() throws {
        let matching = try receipt(["recording": ["id": digest], "duplicate": false])
        try matching.validate(expectedBytes: 44, expectedSHA256: digest)
        XCTAssertFalse(matching.integrityConfirmed)
        let wrong = try receipt(["recording": ["id": String(repeating: "b", count: 64)], "duplicate": false])
        XCTAssertThrowsError(try wrong.validate(expectedBytes: 44, expectedSHA256: digest))
    }

    func testResendRequiresSameIDAndDuplicate() throws {
        let first = try receipt(["recordingId": "record-1", "duplicate": false])
        let repeatOK = try receipt(["recordingId": "record-1", "duplicate": true])
        try repeatOK.validate(expectedBytes: 44, expectedSHA256: digest, previous: first)
        XCTAssertThrowsError(try first.validate(expectedBytes: 44, expectedSHA256: digest, previous: first))
        let different = try receipt(["recordingId": "record-2", "duplicate": true])
        XCTAssertThrowsError(try different.validate(expectedBytes: 44, expectedSHA256: digest, previous: first))
    }

    func testMalformedOrRejectedReceiptsFail() {
        let invalid: [[String: Any]] = [
            ["duplicate": false], ["recordingId": "", "duplicate": false],
            ["recordingId": "r", "duplicate": "false"],
            ["recordingId": "r", "duplicate": false, "bytes": "44"],
            ["recordingId": "r", "duplicate": false, "bytes": true],
            ["recordingId": "r", "duplicate": false, "bytes": -1],
            ["recordingId": "r", "duplicate": false, "sha256": "bad"],
            ["recordingId": "r", "duplicate": false, "sha256": 1]
        ]
        for object in invalid { XCTAssertThrowsError(try receipt(object)) }
        for status in [204, 301, 400, 401, 403, 500] {
            XCTAssertThrowsError(try receipt(["recordingId": "r", "duplicate": false], status: status))
        }
        XCTAssertThrowsError(try UploadReceipt.parse(data: Data("[]".utf8), status: 200))
    }

    func testHeaderNamesEncodingAndOptionalTime() throws {
        let headers = try UploadHeaders.build(metadata: metadata(filename: "录音 / a.wav"), token: "test-token")
        XCTAssertEqual(headers[UploadHeaderName.filename], "%E5%BD%95%E9%9F%B3%20%2F%20a.wav")
        XCTAssertEqual(headers[UploadHeaderName.contentType], "application/octet-stream")
        XCTAssertEqual(headers[UploadHeaderName.bytes], "44")
        XCTAssertEqual(headers[UploadHeaderName.sha256], digest)
        XCTAssertEqual(headers[UploadHeaderName.source], "ios")
        XCTAssertEqual(headers[UploadHeaderName.authorization], "Bearer test-token")
        XCTAssertEqual(headers[UploadHeaderName.binding], "test-binding")
        XCTAssertEqual(headers[UploadHeaderName.localID], "test-local")
        XCTAssertNil(headers[UploadHeaderName.recordedAt])
        let dated = try UploadHeaders.build(metadata: metadata(recordedAt: "2026-11-14T12:00:00+09:00"), token: "test-token")
        XCTAssertEqual(dated[UploadHeaderName.recordedAt], "2026-11-14T12:00:00+09:00")
    }

    func testHeaderInjectionAndInvalidMetadataRejectedWithoutSecretInError() {
        XCTAssertThrowsError(try UploadHeaders.build(metadata: metadata(binding: "x\r\ny: z"), token: "test-token"))
        XCTAssertThrowsError(try UploadHeaders.build(metadata: metadata(), token: "private-secret\r\nx: z")) { error in
            XCTAssertFalse(error.localizedDescription.contains("private-secret"))
        }
        XCTAssertThrowsError(try UploadHeaders.build(metadata: metadata(), token: ""))
        let bad = UploadMetadata(filename: "a.wav", bytes: -1, sha256: digest, binding: "binding", localID: "id")
        XCTAssertThrowsError(try UploadHeaders.build(metadata: bad, token: "test-token"))
    }

    func testEndpointMustBeHTTPSWithoutEmbeddedSecrets() throws {
        XCTAssertEqual(try UploadEndpoint.validate("https://relay.example.test/api/recordings").path, "/api/recordings")
        for url in ["http://relay.example.test", "https://u:p@relay.example.test", "https://relay.example.test?token=x", "https://relay.example.test#x", "not-a-url"] {
            XCTAssertThrowsError(try UploadEndpoint.validate(url))
        }
    }
}

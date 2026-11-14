import XCTest
@testable import QS668Kit

final class DocumentReceiptTests: XCTestCase {
    let id = String(repeating: "a", count: 64)
    func bytes(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    func fixture() throws -> (receipt: [String: Any], manifest: Data, json: Data, markdown: Data) {
        let prefix = "/v1/recordings/\(id)/documents/1/"
        let source: [String: Any] = ["audioSha256": id, "audioBytes": 44, "durationMs": 1000, "transcriptSha256": id]
        let json = try bytes(["schemaVersion": DocumentReceiptVerifier.schema, "recordingId": id, "revision": 1,
                              "source": source, "executionAuthorized": false])
        let md = Data("# Fixture\n".utf8)
        let artifacts: [String: Any] = [
            "json": ["path": prefix + "document.json", "sha256": DocumentReceiptVerifier.digest(json), "bytes": json.count],
            "markdown": ["path": prefix + "document.md", "sha256": DocumentReceiptVerifier.digest(md), "bytes": md.count]]
        let manifest = try bytes(["schemaVersion": DocumentReceiptVerifier.schema, "recordingId": id, "revision": 1,
                                  "source": source, "artifacts": artifacts])
        let hash = DocumentReceiptVerifier.digest(manifest)
        let date = "2026-11-14T06:00:00.123Z"
        let receipt: [String: Any] = ["schemaVersion": DocumentReceiptVerifier.schema, "recordingId": id,
            "revision": 1, "state": "ready", "receiptId": "r1", "manifestSha256": hash,
            "manifestPath": prefix + "manifest.json", "artifacts": artifacts, "persistedAt": date,
            "readbackVerifiedAt": date, "delivery": ["state": "delivered", "revision": 1,
            "manifestSha256": hash, "messageId": "m1", "cardPayloadSha256": id, "deliveredAt": date]]
        return (receipt, manifest, json, md)
    }
    func parse(_ value: [String: Any]) throws -> DocumentReceipt { try JSONDecoder().decode(DocumentReceipt.self, from: bytes(value)) }
    func testValidReadbackAndLegacyWithoutDocument() throws {
        let f = try fixture(); let r = try parse(f.receipt)
        let result = try DocumentReceiptVerifier.verify(r, recordingID: id, audioBytes: 44, messageID: "m1",
            manifest: f.manifest, json: f.json, markdown: f.markdown)
        XCTAssertTrue(result.matches(r))
        let legacy = try JSONDecoder().decode(V1Delivery.self, from: bytes(["recordingId": id, "status": "complete",
            "feishu": ["state": "complete", "messageId": "m1"]]))
        XCTAssertTrue(legacy.complete); XCTAssertNil(legacy.document)
    }
    func testCrossOriginWrongRecordingAndRevisionRejectedBeforeFetch() throws {
        let f = try fixture()
        for (key, value) in [("manifestPath", "https://evil.test/token"), ("recordingId", String(repeating: "b", count: 64)),
                             ("schemaVersion", "future"), ("state", "failed"), ("persistedAt", "invalid")] {
            var r = f.receipt; r[key] = value
            XCTAssertThrowsError(try DocumentReceiptVerifier.paths(parse(r), recordingID: id, messageID: "m1"))
        }
        var r = f.receipt; var delivery = r["delivery"] as! [String: Any]; delivery["revision"] = 2; r["delivery"] = delivery
        XCTAssertThrowsError(try DocumentReceiptVerifier.paths(parse(r), recordingID: id, messageID: "m1"))
        XCTAssertThrowsError(try DocumentReceiptVerifier.paths(parse(f.receipt), recordingID: id, messageID: "other"))
    }
    func testEveryArtifactAndSourceIdentityMustMatch() throws {
        let f = try fixture(); let r = try parse(f.receipt)
        for index in 0..<3 {
            var parts = [f.manifest, f.json, f.markdown]; parts[index].append(0)
            XCTAssertThrowsError(try DocumentReceiptVerifier.verify(r, recordingID: id, audioBytes: 44, messageID: "m1",
                manifest: parts[0], json: parts[1], markdown: parts[2]))
        }
        XCTAssertThrowsError(try DocumentReceiptVerifier.verify(r, recordingID: id, audioBytes: 45, messageID: "m1",
            manifest: f.manifest, json: f.json, markdown: f.markdown))
    }
    func testQueuedDocumentDoesNotHideOriginalUploadStatus() throws {
        let pending: [String: Any] = ["schemaVersion": DocumentReceiptVerifier.schema, "recordingId": id,
            "state": "generating", "revision": NSNull(), "receiptId": NSNull()]
        let value = try JSONDecoder().decode(V1Delivery.self, from: bytes(["recordingId": id, "status": "complete",
            "feishu": ["state": "complete", "messageId": "m1"], "document": pending]))
        XCTAssertTrue(value.complete)
        XCTAssertNil(value.document?.revision)
        XCTAssertThrowsError(try DocumentReceiptVerifier.paths(value.document!, recordingID: id, messageID: "m1"))
    }
    func testMissingReadbackOrDeliveryCannotAuthorizeCleanup() throws {
        let f = try fixture()
        for key in ["readbackVerifiedAt", "delivery", "receiptId", "artifacts"] {
            var r = f.receipt; r.removeValue(forKey: key)
            XCTAssertThrowsError(try DocumentReceiptVerifier.paths(parse(r), recordingID: id, messageID: "m1"))
        }
    }
}

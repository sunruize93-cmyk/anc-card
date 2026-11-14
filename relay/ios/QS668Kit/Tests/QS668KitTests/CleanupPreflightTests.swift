import XCTest
@testable import QS668Kit
final class CleanupPreflightTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    var proof: DocumentVerification { DocumentVerification(recordingId: String(repeating:"a",count:64), messageId:"m1", receiptId:"r1", revision:1, manifestSha256:String(repeating:"b",count:64), verifiedAt:now) }
    func fixture() -> [String:Any] {
        ["schemaVersion":"anc.cleanup-preflight.v1","scope":"iphone_and_card","recordingId":proof.recordingId,
         "sourceSha256":proof.recordingId,"sourceBytes":100,"audioStored":true,"documentRevision":1,
         "manifestSha256":proof.manifestSha256,"messageId":"m1","checkedAt":ISO8601DateFormatter().string(from:now),
         "validForMs":15000,"allowed":true,"reasons":[],"serverAudioRetained":true,
         "requiresDeviceChecks":["latest_five","historical_protection","card_binding","file_identity","fresh_receipt"]]
    }
    func parse(_ v:[String:Any]) throws -> CleanupPreflight { try JSONDecoder().decode(CleanupPreflight.self,from:JSONSerialization.data(withJSONObject:v)) }
    func testFreshExactProofAllowed() throws { XCTAssertNoThrow(try parse(fixture()).validate(proof:proof,bytes:100,now:now)) }
    func testDenialMismatchExpiredFutureAndUnexpectedChecksRejected() throws {
        for (key,value) in [("allowed",false as Any),("sourceBytes",101),("sourceSha256","bad"),("recordingId","bad"),
             ("documentRevision",2),("manifestSha256","bad"),("messageId","other"),("audioStored",false),
             ("serverAudioRetained",false),("scope","server"),("schemaVersion","future"),("validForMs",16000),
             ("reasons",["STATE_CHANGED"]),("requiresDeviceChecks",["new_unknown_check"])] {
            var v=fixture();v[key]=value
            XCTAssertThrowsError(try parse(v).validate(proof:proof,bytes:100,now:now),key)
        }
        XCTAssertThrowsError(try parse(fixture()).validate(proof:proof,bytes:100,now:now.addingTimeInterval(16)))
        XCTAssertThrowsError(try parse(fixture()).validate(proof:proof,bytes:100,now:now.addingTimeInterval(-2)))
    }
}

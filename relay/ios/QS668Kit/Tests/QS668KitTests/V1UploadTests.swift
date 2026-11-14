import Foundation
import XCTest
@testable import QS668Kit

final class V1UploadTests: XCTestCase {
    let digest = String(repeating: "a", count: 64)
    func object(duplicate: Bool = false) -> [String:Any] {
        ["device":"test-device", "localId":"stable-id", "recordingId":digest,
         "sha256":digest, "bytes":44, "duplicate":duplicate, "resultPath":"/v1/recordings/"+digest]
    }
    func parse(_ value: [String:Any], status: Int = 201) throws -> V1UploadReceipt {
        try V1UploadReceipt.parse(data: JSONSerialization.data(withJSONObject:value), status:status)
    }
    func validate(_ receipt: V1UploadReceipt) throws {
        try receipt.validate(expectedBytes:44, expectedSHA256:digest, expectedDevice:"test-device", expectedLocalID:"stable-id")
    }
    func testFirstAndDuplicateReceipt() throws {
        let first = try parse(object()); try validate(first)
        let duplicate = try parse(object(duplicate:true), status:200); try validate(duplicate)
        try duplicate.validate(expectedBytes:44, expectedSHA256:digest, expectedDevice:"test-device", expectedLocalID:"stable-id", previous:first)
        XCTAssertThrowsError(try first.validate(expectedBytes:44, expectedSHA256:digest, expectedDevice:"test-device", expectedLocalID:"stable-id", previous:first))
    }
    func testAllReceiptFieldsRequired() {
        for key in object().keys { var value=object(); value.removeValue(forKey:key); XCTAssertThrowsError(try parse(value),key) }
    }
    func testTamperedReceiptFieldsRejected() throws {
        for (key,value) in ["device":"other", "localId":"other", "recordingId":String(repeating:"b",count:64), "sha256":String(repeating:"b",count:64), "resultPath":"https://other.test/leak"] {
            var body=object(); body[key]=value; XCTAssertThrowsError(try validate(parse(body)),key)
        }
        var body=object();body["bytes"]=45;XCTAssertThrowsError(try validate(parse(body)))
    }
    func testStatusAndDuplicateMustAgree() {
        for status in [200,202,204,301,401,500] { XCTAssertThrowsError(try parse(object(),status:status)) }
        XCTAssertThrowsError(try parse(object(duplicate:true),status:201))
    }
    func testHeadersAndEndpoint() throws {
        let headers=try V1Upload.headers(UploadMetadata(filename:"a b.wav",bytes:44,sha256:digest,binding:"binding",localID:"stable-id"),token:"test-token")
        XCTAssertEqual(headers["X-Recording-ID"],"stable-id")
        XCTAssertEqual(headers["X-Content-SHA256"],digest)
        XCTAssertEqual(headers["Content-Length"],"44")
        XCTAssertEqual(headers["X-ANC-Filename"],"a%20b.wav")
        XCTAssertEqual(headers["X-ANC-Client"],"ios-ble")
        XCTAssertEqual(try V1Upload.endpoint("https://localhost:4787").path,"/v1/recordings")
        for base in ["http://localhost", "https://u:p@localhost", "https://localhost?token=x", "https://localhost/v1/recordings"] { XCTAssertThrowsError(try V1Upload.endpoint(base)) }
    }
    func testDeliveryNeedsMessageAndBothComplete() throws {
        for (status,state,message,expected) in [("complete","complete","message",true),("processing","complete","message",false),("complete","pending","message",false),("complete","complete","",false)] {
            let body:[String:Any]=["recordingId":digest,"status":status,"feishu":["state":state,"messageId":message]]
            let result=try JSONDecoder().decode(V1Delivery.self,from:JSONSerialization.data(withJSONObject:body))
            XCTAssertEqual(result.complete,expected)
        }
    }
}

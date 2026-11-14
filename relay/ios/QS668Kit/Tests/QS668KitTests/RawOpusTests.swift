import XCTest
@testable import QS668Kit
final class RawOpusTests: XCTestCase {
    func testPacketShapesAndInvalidPadding() throws {
        XCTAssertEqual(try RawOpusValidator.validate(Data([0x48] + Array(repeating:0,count:39))),1)
        for control: UInt8 in [0x01,0x41,0x81,0xc1] {
            XCTAssertEqual(try RawOpusValidator.validate(Data([0x4b,control,0] + Array(repeating:0,count:37))),1)
        }
        for bytes in [[], [0x48], [0x4b,0x02] + Array(repeating:0,count:38), [0x4b,0x41,255] + Array(repeating:0,count:37), Array(repeating:UInt8(0),count:40)] {
            XCTAssertThrowsError(try RawOpusValidator.validate(Data(bytes)))
        }
    }
    func testNativeFormatNeedsExplicitHeaderAndName() throws {
        let m = UploadMetadata(filename:"sample.opus",bytes:40,sha256:String(repeating:"a",count:64),binding:"card",localID:"local",recordedAt:nil)
        let h = try V1Upload.headers(m,token:"token",audioFormat:.qs668RawOpus40)
        XCTAssertEqual(h["X-ANC-Audio-Format"],"qs668-raw-opus-40-v1")
        XCTAssertEqual(h["Content-Type"],"application/octet-stream")
        XCTAssertThrowsError(try V1Upload.headers(m,token:"token"))
    }
    func testPreferNativeFallsBackOnlyBeforeAnyData() throws {
        var m = DownloadMachine(listName:"note20261114-120000.",preferNativeOpus:true)
        let actions=m.start(at:0)
        XCTAssertTrue(actions.contains(.send(try CardCommand.download(filename:"note20261114-120000.opus"))))
        let fallback=m.receive(Frame(type:2,command:5,parameters:Data([1])),at:1)
        XCTAssertTrue(fallback.contains(.send(try CardCommand.download(filename:"note20261114-120000.wav"))))
    }
}

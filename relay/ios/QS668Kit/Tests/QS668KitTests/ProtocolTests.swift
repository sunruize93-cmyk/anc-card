import Foundation
import XCTest
@testable import QS668Kit

final class ProtocolTests: XCTestCase {
    func testStandardCRCVector() {
        XCTAssertEqual(CRC16.xmodem(Data("123456789".utf8)), 0x31C3)
    }

    func testVendorDownloadFrameIsExactly36Bytes() throws {
        let payload = try CardCommand.download(filename: "note20260710-162938.wav")
        let frame = try CardCommand.frame(payload: payload, sequence: 3)
        let expected = "5a 03 9e 20 1e 00 02 02 00 00 00 00 6e 6f 74 65 32 30 32 36 30 37 31 30 2d 31 36 32 39 33 38 2e 77 61 76 00"
        XCTAssertEqual(frame, Data(expected.split(separator: " ").map { UInt8($0, radix: 16)! }))
        XCTAssertEqual(frame.count, 36)
    }

    func testDownloadOffsetIsLittleEndian() throws {
        let payload = try CardCommand.download(filename: "a.wav", offset: 0x12345678)
        XCTAssertEqual(Array(payload.dropFirst(2).prefix(4)), [0x78, 0x56, 0x34, 0x12])
        XCTAssertThrowsError(try CardCommand.download(filename: String(repeating: "x", count: 25)))
        XCTAssertThrowsError(try CardCommand.download(filename: "a\0b"))
    }

    func testSplitNotificationAndConcatenatedFrames() throws {
        let bytes = try CardCommand.frame(payload: CardCommand.battery, sequence: 4)
        var parser = FrameParser()
        XCTAssertTrue(parser.push(Data(bytes.prefix(3))).isEmpty)
        XCTAssertEqual(parser.push(Data(bytes.dropFirst(3))), [Frame(sequence: 4, type: 0, command: 3)])
        XCTAssertEqual(parser.push(bytes + bytes).count, 2)
    }

    func testZeroCRCListFrameIsMarkedCompatible() {
        var parser = FrameParser()
        let bytes = Data([0x5A, 1, 0, 0, 6, 0, 2, 1, 0, 0, 0, 0])
        let frames = parser.push(bytes)
        XCTAssertEqual(frames.count, 1)
        XCTAssertTrue(frames[0].usesZeroCRCCompatibility)
        XCTAssertEqual(frames[0].parameters, Data([0, 0, 0, 0]))
    }

    func testBadCRCResynchronizesInsideDiscardedFrame() throws {
        let good = try CardCommand.frame(payload: CardCommand.battery, sequence: 8)
        // 外层长度把有效帧包在其中；校验失败后须从下一个字节重同步。
        let corrupt = Data([0x5A, 0, 1, 1, UInt8(good.count), 0]) + good
        var parser = FrameParser()
        XCTAssertEqual(parser.push(corrupt), [Frame(sequence: 8, type: 0, command: 3)])
    }

    func testOversizedAndTooShortPayloadsAreSkipped() throws {
        let good = try CardCommand.frame(payload: CardCommand.firmware, sequence: 2)
        var parser = FrameParser()
        let noise = Data([1, 2, 3, 0x5A, 0, 0, 0, 1, 32, 0x5A, 0, 0, 0, 1, 0, 0])
        XCTAssertEqual(parser.push(noise + good), [Frame(sequence: 2, type: 0, command: 10)])
    }

    func testSeparateNotificationParsersDoNotMixFragments() throws {
        let bytes = try CardCommand.frame(payload: CardCommand.listFiles, sequence: 7)
        var commandParser = FrameParser()
        var eventParser = FrameParser()
        XCTAssertTrue(commandParser.push(Data(bytes.prefix(4))).isEmpty)
        XCTAssertEqual(eventParser.push(bytes).count, 1)
        XCTAssertEqual(commandParser.push(Data(bytes.dropFirst(4))).count, 1)
    }

    func testAllowlistRejectsBothDestructiveCommandsAndUnknownCommands() {
        for payload in [Data([2, 8]), Data([2, 9]), Data([1, 3]), Data([3, 3]), Data(), Data([0])] {
            XCTAssertThrowsError(try CardCommand.frame(payload: payload, sequence: 0))
        }
    }

    func testAllowlistAcceptsExactlyDeclaredCommandsWithCorrectLengths() throws {
        for payload in [CardCommand.capacity, CardCommand.battery, CardCommand.firmware,
                        CardCommand.listFiles, CardCommand.abortDownload, CardCommand.recordingState,
                        try CardCommand.download(filename: "a.wav")] {
            XCTAssertNoThrow(try CardCommand.validate(payload))
        }
        XCTAssertThrowsError(try CardCommand.validate(Data([2, 2])))
        XCTAssertThrowsError(try CardCommand.validate(Data([0, 3, 1])))
    }
}

extension ProtocolTests {
    func testAE23BatteryReplyIsNotDiscardedAsButtonEvent() {
        let battery = Frame(type:0, command:4, parameters:Data([0x62]))
        XCTAssertFalse(CardFrameRoute.isButtonEvent(battery, eventChannel:true))
        XCTAssertFalse(CardFrameRoute.isButtonEvent(battery, eventChannel:false))
        XCTAssertFalse(CardFrameRoute.isButtonEvent(Frame(type:3,command:20,parameters:Data([2])),eventChannel:true))
        XCTAssertTrue(CardFrameRoute.isButtonEvent(Frame(type:3,command:3),eventChannel:true))
        XCTAssertFalse(CardFrameRoute.isButtonEvent(Frame(type:3,command:3),eventChannel:false))
    }
}

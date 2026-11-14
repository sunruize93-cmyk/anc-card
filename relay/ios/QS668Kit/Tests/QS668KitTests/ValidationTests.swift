import Foundation
import XCTest
@testable import QS668Kit

final class ValidationTests: XCTestCase {
    private func le16(_ value: UInt16) -> [UInt8] {
        [UInt8(truncatingIfNeeded: value), UInt8(truncatingIfNeeded: value >> 8)]
    }

    private func le32(_ value: UInt32) -> [UInt8] {
        (0..<4).map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) }
    }

    private func chunk(_ name: String, _ body: [UInt8]) -> [UInt8] {
        Array(name.utf8) + le32(UInt32(body.count)) + body + (body.count % 2 == 0 ? [] : [0])
    }

    private func format(rate: UInt32 = 16_000, align: UInt16 = 2, bytesPerSecond: UInt32 = 32_000) -> [UInt8] {
        var bytes = le16(1)
        bytes += le16(1)
        bytes += le32(rate)
        bytes += le32(bytesPerSecond)
        bytes += le16(align)
        bytes += le16(16)
        return bytes
    }

    private func riff(_ chunks: [[UInt8]]) -> Data {
        let body = Array("WAVE".utf8) + chunks.flatMap { $0 }
        return Data(Array("RIFF".utf8) + le32(UInt32(body.count)) + body)
    }

    private func valid() -> Data {
        riff([chunk("fmt ", format()), chunk("data", [0, 0, 0, 0])])
    }

    func testPCMMetadataAndDuration() throws {
        let info = try WAVValidator.validate(valid())
        XCTAssertEqual(info.audioFormat, 1)
        XCTAssertEqual(info.channels, 1)
        XCTAssertEqual(info.sampleRate, 16_000)
        XCTAssertEqual(info.bitsPerSample, 16)
        XCTAssertEqual(info.dataBytes, 4)
        XCTAssertEqual(info.duration, 4.0 / 32_000, accuracy: 0.0000001)
    }

    func testFileAndMemoryValidationAgree() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let data = valid()
        try data.write(to: url)
        XCTAssertEqual(try WAVValidator.validate(fileURL: url), try WAVValidator.validate(data))
    }

    func testOddUnknownChunkPaddingIsConsumed() throws {
        let data = riff([chunk("JUNK", [7]), chunk("fmt ", format()), chunk("data", [0, 0])])
        XCTAssertEqual(try WAVValidator.validate(data).dataBytes, 2)
    }

    func testWrongRIFFLengthAndHeaderRejected() {
        var badLength = valid()
        badLength[4] = 1
        XCTAssertThrowsError(try WAVValidator.validate(badLength))
        var badHeader = valid()
        badHeader[0] = 0
        XCTAssertThrowsError(try WAVValidator.validate(badHeader))
        XCTAssertThrowsError(try WAVValidator.validate(Data("RIFF".utf8)))
    }

    func testMissingAndDuplicateChunksRejected() {
        XCTAssertThrowsError(try WAVValidator.validate(riff([chunk("fmt ", format())])))
        XCTAssertThrowsError(try WAVValidator.validate(riff([chunk("data", [0, 0])])))
        XCTAssertThrowsError(try WAVValidator.validate(riff([
            chunk("fmt ", format()), chunk("fmt ", format()), chunk("data", [0, 0])
        ])))
        XCTAssertThrowsError(try WAVValidator.validate(riff([
            chunk("fmt ", format()), chunk("data", [0, 0]), chunk("data", [0, 0])
        ])))
    }

    func testTruncatedChunkAndPaddingRejected() {
        var data = valid()
        data[40] = 100
        XCTAssertThrowsError(try WAVValidator.validate(data))
        let noPadding = Array("JUNK".utf8) + le32(1) + [UInt8(0)]
        XCTAssertThrowsError(try WAVValidator.validate(riff([noPadding])))
        XCTAssertThrowsError(try WAVValidator.validate(riff([[1, 2, 3]])))
    }

    func testInvalidFormatOrEmptyMisalignedDataRejected() {
        for fmt in [format(rate: 0), format(align: 1), format(bytesPerSecond: 1), [UInt8](repeating: 0, count: 15)] {
            XCTAssertThrowsError(try WAVValidator.validate(riff([chunk("fmt ", fmt), chunk("data", [0, 0])])))
        }
        XCTAssertThrowsError(try WAVValidator.validate(riff([chunk("fmt ", format()), chunk("data", [])])))
        XCTAssertThrowsError(try WAVValidator.validate(riff([chunk("fmt ", format()), chunk("data", [0])])))
    }

    func testFilenameDropsPathAndUnsafeCharacters() {
        XCTAssertEqual(SafeFilename.sanitize("../../test.wav"), "test.wav")
        XCTAssertEqual(SafeFilename.sanitize("C:\\record\\test.wav"), "test.wav")
        XCTAssertEqual(SafeFilename.sanitize("a\r\nb:*?\"<>|.wav"), "a__b_______.wav")
        XCTAssertEqual(SafeFilename.sanitize("..."), "recording")
        XCTAssertEqual(SafeFilename.sanitize(""), "recording")
        XCTAssertEqual(SafeFilename.sanitize("CON.wav"), "_CON.wav")
        XCTAssertEqual(SafeFilename.sanitize("录音.wav"), "录音.wav")
        XCTAssertLessThanOrEqual(SafeFilename.sanitize(String(repeating: "音", count: 200)).utf8.count, 120)
    }
}

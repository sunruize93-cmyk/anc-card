import Foundation

public enum CardProtocolError: Error, Equatable, LocalizedError {
    case invalidCommand
    case invalidFilename
    case malformedList
    case listTimeout
    case listRejected
    case listTooLarge

    public var errorDescription: String? {
        switch self {
        case .invalidCommand: return "命令不在允许清单内，或负载长度错误"
        case .invalidFilename: return "下载文件名为空、含零字节或超过 24 字节"
        case .malformedList: return "文件列表长度与条目数不一致"
        case .listTimeout: return "没有收到文件列表"
        case .listRejected: return "录音卡未确认文件列表完成"
        case .listTooLarge: return "文件列表超过本客户端的安全上限"
        }
    }
}

public enum CRC16 {
    public static func xmodem(_ data: Data) -> UInt16 {
        var crc: UInt16 = 0
        for byte in data {
            crc ^= UInt16(byte) << 8
            for _ in 0..<8 {
                crc = (crc & 0x8000) == 0 ? crc << 1 : (crc << 1) ^ 0x1021
            }
        }
        return crc
    }
}

public struct Frame: Equatable, Sendable {
    public let sequence: UInt8
    public let type: UInt8
    public let command: UInt8
    public let parameters: Data
    public let usesZeroCRCCompatibility: Bool

    public init(sequence: UInt8 = 0, type: UInt8, command: UInt8,
                parameters: Data = Data(), usesZeroCRCCompatibility: Bool = false) {
        self.sequence = sequence
        self.type = type
        self.command = command
        self.parameters = parameters
        self.usesZeroCRCCompatibility = usesZeroCRCCompatibility
    }
}

/// AE22 与 AE23 必须各持有一个实例，断连时清空各自未完成的帧。
public struct FrameParser {
    private var buffer: [UInt8] = []
    public init() {}

    public mutating func reset() { buffer.removeAll(keepingCapacity: true) }

    public mutating func push(_ chunk: Data) -> [Frame] {
        buffer.append(contentsOf: chunk)
        var result: [Frame] = []
        while !buffer.isEmpty {
            guard let header = buffer.firstIndex(of: 0x5A) else {
                reset()
                break
            }
            if header > 0 { buffer.removeFirst(header) }
            guard buffer.count >= 6 else { break }
            let length = Int(buffer[4]) | (Int(buffer[5]) << 8)
            guard (2...8192).contains(length) else {
                buffer.removeFirst()
                continue
            }
            let total = 6 + length
            guard buffer.count >= total else { break }
            let expected = UInt16(buffer[2]) | (UInt16(buffer[3]) << 8)
            let actual = CRC16.xmodem(Data(buffer[4..<total]))
            guard expected == actual || expected == 0 else {
                // 不整帧跳过：损坏长度可能覆盖其后的有效帧。
                buffer.removeFirst()
                continue
            }
            result.append(Frame(sequence: buffer[1], type: buffer[6], command: buffer[7],
                                parameters: Data(buffer[8..<total]),
                                usesZeroCRCCompatibility: expected == 0))
            buffer.removeFirst(total)
        }
        return result
    }
}

/// 应用发送的所有负载都必须经过 validate 和 frame；此处不提供任意帧编码器。
public enum CardCommand {
    public static let startAudioStream = Data([1, 0])
    public static let stopAudioStream = Data([1, 2])
    public static let capacity = Data([0, 1])
    public static let battery = Data([0, 3])
    public static let firmware = Data([0, 10])
    public static let listFiles = Data([2, 0])
    public static let abortDownload = Data([2, 7])
    public static let recordingState = Data([3, 19])

    // 这是唯一发送允许清单；值为负载必须具有的字节数。
    private static let allowedPayloadLengths: [UInt16: Int] = [
        0x0001: 2, 0x0003: 2, 0x000A: 2, 0x0100: 2, 0x0102: 2,
        0x0200: 2, 0x0202: 30, 0x0207: 2, 0x0208: 30, 0x0313: 2
    ]

    public static func deleteSingleFile(rawRecord: Data) throws -> Data {
        guard rawRecord.count == 28,
              let entry = try CardFileList.parse(Data([0,0,0,1]) + rawRecord).first,
              !entry.name.isEmpty, entry.size > 0,
              !entry.name.contains("/"), !entry.name.contains("\\"), !entry.name.contains("..") else {
            throw CardProtocolError.invalidCommand
        }
        return Data([2,8]) + rawRecord
    }

    public static func download(filename: String, offset: UInt32 = 0) throws -> Data {
        let name = Array(filename.utf8)
        guard !name.isEmpty, !name.contains(0), name.count <= 24 else {
            throw CardProtocolError.invalidFilename
        }
        var payload = Data([2, 2,
                            UInt8(truncatingIfNeeded: offset),
                            UInt8(truncatingIfNeeded: offset >> 8),
                            UInt8(truncatingIfNeeded: offset >> 16),
                            UInt8(truncatingIfNeeded: offset >> 24)])
        payload.append(contentsOf: name)
        payload.append(contentsOf: repeatElement(UInt8(0), count: 24 - name.count))
        return payload
    }

    public static func validate(_ payload: Data) throws {
        let bytes = Array(payload)
        guard bytes.count >= 2 else { throw CardProtocolError.invalidCommand }
        let key = UInt16(bytes[0]) << 8 | UInt16(bytes[1])
        guard allowedPayloadLengths[key] == bytes.count else {
            throw CardProtocolError.invalidCommand
        }
    }

    public static func frame(payload: Data, sequence: UInt8) throws -> Data {
        try validate(payload)
        let length = UInt16(payload.count)
        var body = Data([UInt8(truncatingIfNeeded: length), UInt8(length >> 8)])
        body.append(payload)
        let crc = CRC16.xmodem(body)
        var frame = Data([0x5A, sequence, UInt8(truncatingIfNeeded: crc), UInt8(crc >> 8)])
        frame.append(body)
        return frame
    }
}

func decodeCardText(_ data: Data) -> String {
    String(decoding: data.prefix { $0 != 0 }, as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

// V1.0.0 field evidence: battery replies also arrive on AE23, so channel alone is insufficient.
public enum CardFrameRoute {
    public static func isButtonEvent(_ frame: Frame, eventChannel: Bool) -> Bool {
        eventChannel && frame.type == 3 && [UInt8(1),3,5,7].contains(frame.command)
    }
}

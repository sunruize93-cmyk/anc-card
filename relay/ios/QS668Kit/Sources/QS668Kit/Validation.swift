import Foundation

public enum FileValidationError: Error, LocalizedError, Equatable {
    case invalidWAV(String)

    public var errorDescription: String? {
        switch self {
        case .invalidWAV(let reason): return "WAV 校验失败：\(reason)"
        }
    }
}

public struct WAVInfo: Equatable {
    public let audioFormat: UInt16
    public let channels: UInt16
    public let sampleRate: UInt32
    public let bitsPerSample: UInt16
    public let dataBytes: UInt64
    public let duration: TimeInterval
}

public enum WAVValidator {
    public static func validate(_ data: Data) throws -> WAVInfo {
        try inspect(length: UInt64(data.count)) { offset, count in
            guard offset <= UInt64(data.count), UInt64(count) <= UInt64(data.count) - offset else {
                throw FileValidationError.invalidWAV("块超出文件边界")
            }
            let start = data.index(data.startIndex, offsetBy: Int(offset))
            let end = data.index(start, offsetBy: count)
            return Array(data[start..<end])
        }
    }

    // 只读取 RIFF 与块头；录音正文不整块装入内存。
    public static func validate(fileURL: URL) throws -> WAVInfo {
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        let length = try handle.seekToEnd()
        return try inspect(length: length) { offset, count in
            try handle.seek(toOffset: offset)
            guard let data = try handle.read(upToCount: count), data.count == count else {
                throw FileValidationError.invalidWAV("文件读取不完整")
            }
            return Array(data)
        }
    }

    private static func inspect(length: UInt64, read: (UInt64, Int) throws -> [UInt8]) throws -> WAVInfo {
        guard length >= 12 else { throw FileValidationError.invalidWAV("缺少 RIFF/WAVE 头") }
        let header = try read(0, 12)
        guard text(header, 0, 4) == "RIFF", text(header, 8, 4) == "WAVE" else {
            throw FileValidationError.invalidWAV("不是 RIFF/WAVE 文件")
        }
        guard UInt64(le32(header, 4)) + 8 == length else {
            throw FileValidationError.invalidWAV("声明长度与实际长度不同")
        }
        var offset: UInt64 = 12
        var format: [UInt8]?
        var audioBytes: UInt64?
        while offset < length {
            guard length - offset >= 8 else { throw FileValidationError.invalidWAV("块头被截断") }
            let chunk = try read(offset, 8)
            let tag = text(chunk, 0, 4)
            let size = UInt64(le32(chunk, 4))
            let bodyStart = offset + 8
            guard size <= length - bodyStart else { throw FileValidationError.invalidWAV("块正文被截断") }
            let paddedSize = size + size % 2
            guard paddedSize <= length - bodyStart else { throw FileValidationError.invalidWAV("缺少奇数块填充字节") }
            if tag == "fmt " {
                guard format == nil, size >= 16 else {
                    throw FileValidationError.invalidWAV("fmt 块重复或不足 16 字节")
                }
                format = try read(bodyStart, 16)
            } else if tag == "data" {
                guard audioBytes == nil else { throw FileValidationError.invalidWAV("data 块重复") }
                audioBytes = size
            }
            offset = bodyStart + paddedSize
        }
        guard let fmt = format, let bytes = audioBytes else {
            throw FileValidationError.invalidWAV("缺少 fmt 或 data 块")
        }
        let encoding = le16(fmt, 0)
        let channels = le16(fmt, 2)
        let rate = le32(fmt, 4)
        let byteRate = le32(fmt, 8)
        let alignment = le16(fmt, 12)
        let bits = le16(fmt, 14)
        guard encoding == 1 || encoding == 3 else {
            throw FileValidationError.invalidWAV("当前只校验 PCM 或 IEEE float WAV")
        }
        guard channels > 0, rate > 0, bits > 0, bits % 8 == 0 else {
            throw FileValidationError.invalidWAV("声道、采样率或位深无效")
        }
        guard (encoding == 1 && [UInt16(8), 16, 24, 32].contains(bits)) ||
                (encoding == 3 && [UInt16(32), 64].contains(bits)) else {
            throw FileValidationError.invalidWAV("不支持的采样位深")
        }
        let expectedAlignment = UInt64(channels) * UInt64(bits / 8)
        guard UInt64(alignment) == expectedAlignment,
              UInt64(byteRate) == UInt64(rate) * expectedAlignment else {
            throw FileValidationError.invalidWAV("块对齐或字节率与 fmt 不一致")
        }
        guard bytes > 0, bytes % expectedAlignment == 0 else {
            throw FileValidationError.invalidWAV("音频为空或不是完整采样帧")
        }
        return WAVInfo(audioFormat: encoding, channels: channels, sampleRate: rate,
                       bitsPerSample: bits, dataBytes: bytes, duration: Double(bytes) / Double(byteRate))
    }

    private static func le16(_ data: [UInt8], _ offset: Int) -> UInt16 {
        UInt16(data[offset]) | UInt16(data[offset + 1]) << 8
    }

    private static func le32(_ data: [UInt8], _ offset: Int) -> UInt32 {
        (0..<4).reduce(UInt32(0)) { $0 | UInt32(data[offset + $1]) << ($1 * 8) }
    }

    private static func text(_ data: [UInt8], _ offset: Int, _ count: Int) -> String {
        String(decoding: data[offset..<(offset + count)], as: UTF8.self)
    }
}

public enum SafeFilename {
    // 仅生成展示/落盘名称，不改发给卡的原始名字；调用方应另加稳定 ID 避免净化后重名。
    public static func sanitize(_ name: String) -> String {
        let leaf = name.replacingOccurrences(of: "\\", with: "/")
            .components(separatedBy: "/").last ?? ""
        let forbidden = CharacterSet(charactersIn: ":*?\"<>|/")
            .union(.controlCharacters).union(.illegalCharacters)
        var value = ""
        for scalar in leaf.precomposedStringWithCanonicalMapping.unicodeScalars {
            if forbidden.contains(scalar) || scalar.properties.generalCategory == .format {
                value.append("_")
            } else {
                value.unicodeScalars.append(scalar)
            }
        }
        value = value.trimmingCharacters(in: CharacterSet(charactersIn: ". ").union(.whitespacesAndNewlines))
        if value.isEmpty { return "recording" }
        let stem = value.components(separatedBy: ".")[0].uppercased()
        let reserved = ["CON", "PRN", "AUX", "NUL"] + (1...9).flatMap { ["COM\($0)", "LPT\($0)"] }
        if reserved.contains(stem) { value = "_" + value }
        var limited = ""
        for character in value {
            let next = String(character)
            if limited.utf8.count + next.utf8.count > 120 { break }
            limited += next
        }
        return limited.isEmpty ? "recording" : limited
    }
}

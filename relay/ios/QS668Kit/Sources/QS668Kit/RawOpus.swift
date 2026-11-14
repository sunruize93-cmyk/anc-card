import Foundation

public enum RecordingAudioFormat: String, Codable {
    case wav
    case qs668RawOpus40 = "qs668-raw-opus-40-v1"
}

/// Validates fixed card framing. The backend still performs actual codec decoding.
public enum RawOpusValidator {
    public static let maxBytes = 2 * 60 * 60 * 50 * 40
    @discardableResult public static func validate(_ data: Data) throws -> Int {
        guard !data.isEmpty, data.count % 40 == 0, data.count <= maxBytes else { throw UploadValidationError.invalidMetadata }
        let bytes = Array(data)
        for offset in stride(from: 0, to: bytes.count, by: 40) {
            if bytes[offset] == 0x48 { continue }
            guard bytes[offset] == 0x4b, bytes[offset + 1] & 63 == 1 else { throw UploadValidationError.invalidMetadata }
            var index = 2, padding = 0
            if bytes[offset + 1] & 64 != 0 {
                var value: UInt8
                repeat {
                    guard index < 40 else { throw UploadValidationError.invalidMetadata }
                    value = bytes[offset + index]; index += 1
                    padding += value == 255 ? 254 : Int(value)
                } while value == 255
            }
            guard index + padding <= 40 else { throw UploadValidationError.invalidMetadata }
        }
        return data.count / 40
    }
    @discardableResult public static func validate(fileURL: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        guard let size = attributes[.size] as? NSNumber, size.intValue <= maxBytes else { throw UploadValidationError.invalidMetadata }
        return try validate(Data(contentsOf: fileURL, options: .mappedIfSafe))
    }
}

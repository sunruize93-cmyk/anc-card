import Foundation

public enum UploadValidationError: Error, LocalizedError, Equatable {
    case invalidEndpoint
    case invalidMetadata
    case invalidCredential
    case invalidHeader
    case rejectedStatus(Int)
    case invalidReceipt
    case byteMismatch
    case hashMismatch
    case resendMismatch

    public var errorDescription: String? {
        switch self {
        case .invalidEndpoint: return "请填写完整 HTTPS 上传地址，不含账号、口令、查询参数或片段"
        case .invalidMetadata: return "上传元数据无效"
        case .invalidCredential: return "上传凭证为空或含非法字符，请在设置中更新"
        case .invalidHeader: return "上传请求头含非法字符"
        case .rejectedStatus(let status): return "后台拒绝了上传：HTTP \(status)"
        case .invalidReceipt: return "后台回执缺少必要字段或字段格式无效"
        case .byteMismatch: return "回执字节数与本地文件不一致"
        case .hashMismatch: return "回执 SHA-256 与本地文件不一致"
        case .resendMismatch: return "重发回执必须返回相同录音 ID 并标记重复"
        }
    }
}

public enum UploadEndpoint {
    public static func validate(_ text: String) throws -> URL {
        guard text == text.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let parts = URLComponents(string: text), parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              let url = parts.url else { throw UploadValidationError.invalidEndpoint }
        return url
    }
}

// 除 filename 外的约定仍待后台负责人最终确认；修改字段名只改这一处。
public enum UploadHeaderName {
    public static let contentType = "content-type"
    public static let filename = "x-anc-filename"
    public static let sha256 = "x-anc-sha256"
    public static let bytes = "x-anc-bytes"
    public static let binding = "x-anc-binding"
    public static let localID = "x-anc-local-id"
    public static let recordedAt = "x-anc-recorded-at"
    public static let source = "x-anc-source"
    public static let authorization = "authorization"
}

public struct UploadMetadata {
    public let filename: String
    public let bytes: Int64
    public let sha256: String
    public let binding: String
    public let localID: String
    public let recordedAt: String?

    public init(filename: String, bytes: Int64, sha256: String, binding: String, localID: String, recordedAt: String? = nil) {
        self.filename = filename
        self.bytes = bytes
        self.sha256 = sha256.lowercased()
        self.binding = binding
        self.localID = localID
        self.recordedAt = recordedAt
    }
}

public enum UploadHeaders {
    public static func build(metadata: UploadMetadata, token: String) throws -> [String: String] {
        guard metadata.bytes >= 0, isSHA256(metadata.sha256), !metadata.filename.isEmpty,
              !metadata.binding.isEmpty, !metadata.localID.isEmpty else {
            throw UploadValidationError.invalidMetadata
        }
        guard !token.isEmpty, token.utf8.allSatisfy({ $0 > 0x20 && $0 <= 0x7e }) else {
            throw UploadValidationError.invalidCredential
        }
        var result = [
            UploadHeaderName.contentType: "application/octet-stream",
            UploadHeaderName.filename: percentEncode(metadata.filename),
            UploadHeaderName.sha256: metadata.sha256,
            UploadHeaderName.bytes: String(metadata.bytes),
            UploadHeaderName.binding: metadata.binding,
            UploadHeaderName.localID: metadata.localID,
            UploadHeaderName.source: "ios",
            UploadHeaderName.authorization: "Bearer " + token
        ]
        // 卡内文件名没有时区信息；调用方不能把它猜成 UTC。只有可靠的时间才传入。
        if let recordedAt = metadata.recordedAt, !recordedAt.isEmpty {
            result[UploadHeaderName.recordedAt] = recordedAt
        }
        guard result.values.allSatisfy({ $0.utf8.allSatisfy { $0 >= 0x20 && $0 <= 0x7e } }) else {
            throw UploadValidationError.invalidHeader
        }
        return result
    }

    private static func percentEncode(_ value: String) -> String {
        let hex = Array("0123456789ABCDEF".utf8)
        var output: [UInt8] = []
        for byte in value.utf8 {
            if (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte) || [45, 46, 95, 126].contains(byte) {
                output.append(byte)
            } else {
                output += [37, hex[Int(byte >> 4)], hex[Int(byte & 15)]]
            }
        }
        return String(decoding: output, as: UTF8.self)
    }
}

public struct UploadReceipt: Codable, Equatable {
    public let recordingID: String
    public let duplicate: Bool
    public let bytes: Int64?
    public let sha256: String?
    public let httpStatus: Int

    public var integrityConfirmed: Bool { bytes != nil && sha256 != nil }
    public var integrityMessage: String {
        integrityConfirmed ? "字节数和 SHA-256 已核对" : "完整性未获服务端确认"
    }

    public static func parse(data: Data, status: Int) throws -> UploadReceipt {
        guard [200, 201, 202].contains(status) else { throw UploadValidationError.rejectedStatus(status) }
        let body: ReceiptBody
        do { body = try JSONDecoder().decode(ReceiptBody.self, from: data) }
        catch { throw UploadValidationError.invalidReceipt }
        guard let id = body.recordingId ?? body.recording?.id,
              !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !id.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              body.bytes.map({ $0 >= 0 }) ?? true,
              body.sha256.map({ isSHA256($0) }) ?? true else {
            throw UploadValidationError.invalidReceipt
        }
        return UploadReceipt(recordingID: id, duplicate: body.duplicate, bytes: body.bytes,
                             sha256: body.sha256?.lowercased(), httpStatus: status)
    }

    public func validate(expectedBytes: Int64, expectedSHA256: String, previous: UploadReceipt? = nil) throws {
        guard expectedBytes >= 0, isSHA256(expectedSHA256) else { throw UploadValidationError.invalidMetadata }
        if let bytes = bytes, bytes != expectedBytes { throw UploadValidationError.byteMismatch }
        if let hash = sha256, hash.lowercased() != expectedSHA256.lowercased() {
            throw UploadValidationError.hashMismatch
        }
        // 沿用 Windows 的旧后台兼容检查：没有哈希字段时，哈希形状的 ID 也必须匹配。
        if sha256 == nil, isSHA256(recordingID), recordingID.lowercased() != expectedSHA256.lowercased() {
            throw UploadValidationError.hashMismatch
        }
        if let previous = previous, previous.recordingID != recordingID || !duplicate {
            throw UploadValidationError.resendMismatch
        }
    }
}

private struct ReceiptBody: Decodable {
    struct Recording: Decodable { let id: String }
    let recordingId: String?
    let recording: Recording?
    let duplicate: Bool
    let bytes: Int64?
    let sha256: String?
}

private func isSHA256(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy {
        (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0)
    }
}

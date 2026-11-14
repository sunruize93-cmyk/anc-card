import Foundation

public struct V1UploadReceipt: Codable, Equatable {
    public let device: String
    public let localId: String
    public let recordingId: String
    public let sha256: String
    public let bytes: Int64
    public let duplicate: Bool
    public let resultPath: String
    public var recordingID: String { recordingId }
    public var integrityConfirmed: Bool { true }
    public var integrityMessage: String { "字节数、SHA-256、设备与本地 ID 已核对" }
    public static func parse(data: Data, status: Int) throws -> Self {
        guard [200,201].contains(status) else { throw UploadValidationError.rejectedStatus(status) }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.duplicate == (status == 200) else { throw UploadValidationError.invalidReceipt }
        return value
    }
    public func validate(expectedBytes: Int64, expectedSHA256: String, expectedDevice: String,
                         expectedLocalID: String, previous: Self? = nil) throws {
        guard bytes == expectedBytes, bytes > 0, sha256 == expectedSHA256,
              recordingId == expectedSHA256, device == expectedDevice, localId == expectedLocalID,
              resultPath == "/v1/recordings/" + expectedSHA256 else { throw UploadValidationError.invalidReceipt }
        if let previous, previous.recordingId != recordingId || !duplicate { throw UploadValidationError.resendMismatch }
    }
}
public struct V1Delivery: Codable {
    public struct Feishu: Codable { public let state: String; public let messageId: String?; public let error: String? }
    public let recordingId: String
    public let status: String
    public let error: String?
    public let feishu: Feishu
    public let document: DocumentReceipt?
    public var complete: Bool { status == "complete" && feishu.state == "complete" && !(feishu.messageId ?? "").isEmpty }
}
public enum V1Upload {
    public static func endpoint(_ base: String) throws -> URL {
        let url = try UploadEndpoint.validate(base)
        guard url.path.isEmpty || url.path == "/" else { throw UploadValidationError.invalidEndpoint }
        return url.appendingPathComponent("v1/recordings")
    }
    public static func headers(_ metadata: UploadMetadata, token: String, audioFormat: RecordingAudioFormat = .wav) throws -> [String:String] {
        let legacy = try UploadHeaders.build(metadata: metadata, token: token)
        guard audioFormat == .wav ? metadata.filename.lowercased().hasSuffix(".wav") : metadata.filename.lowercased().hasSuffix(".opus") else { throw UploadValidationError.invalidMetadata }
        var result = ["Content-Type":audioFormat == .wav ? "audio/wav" : "application/octet-stream", "Content-Length":String(metadata.bytes),
                "X-Recording-ID":metadata.localID, "X-Content-SHA256":metadata.sha256,
                "X-ANC-Filename":legacy[UploadHeaderName.filename]!,
                "X-ANC-Client":"ios-ble", "Authorization":legacy[UploadHeaderName.authorization]!]
        if audioFormat != .wav { result["X-ANC-Audio-Format"] = audioFormat.rawValue }
        return result
    }
}

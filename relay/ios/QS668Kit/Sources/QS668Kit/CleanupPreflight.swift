import Foundation

public struct CleanupPreflight: Codable {
    public let schemaVersion: String
    public let scope: String
    public let recordingId: String
    public let sourceSha256: String
    public let sourceBytes: Int64?
    public let audioStored: Bool
    public let documentRevision: Int?
    public let manifestSha256: String?
    public let messageId: String?
    public let checkedAt: String?
    public let validForMs: Int
    public let allowed: Bool
    public let reasons: [String]
    public let serverAudioRetained: Bool
    public let requiresDeviceChecks: [String]
    public func validate(proof: DocumentVerification, bytes: Int64, now: Date = Date()) throws {
        let expected: Set<String> = ["latest_five", "historical_protection", "card_binding", "file_identity", "fresh_receipt"]
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions.insert(.withFractionalSeconds)
        let checked = checkedAt.flatMap { formatter.date(from: $0) } ?? checkedAt.flatMap { ISO8601DateFormatter().date(from: $0) }
        guard schemaVersion == "anc.cleanup-preflight.v1", scope == "iphone_and_card", allowed, reasons.isEmpty,
              audioStored, serverAudioRetained, bytes > 0, sourceBytes == bytes,
              recordingId == proof.recordingId, sourceSha256 == proof.recordingId,
              documentRevision == proof.revision, manifestSha256 == proof.manifestSha256, messageId == proof.messageId,
              Set(requiresDeviceChecks) == expected, requiresDeviceChecks.count == expected.count,
              validForMs > 0, validForMs <= 15000, let checked,
              now.timeIntervalSince(checked) >= -1,
              now.timeIntervalSince(checked) * 1000 < Double(validForMs) else {
            throw UploadValidationError.invalidReceipt
        }
    }
}

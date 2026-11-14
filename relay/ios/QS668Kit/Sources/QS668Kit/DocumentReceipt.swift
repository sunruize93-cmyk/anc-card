import Foundation
import CryptoKit

public struct DocumentArtifact: Codable, Equatable {
    public let path: String
    public let sha256: String
    public let bytes: Int
}
public struct DocumentArtifacts: Codable, Equatable {
    public let json: DocumentArtifact
    public let markdown: DocumentArtifact
}
public struct DocumentSource: Codable, Equatable {
    public let audioSha256: String
    public let audioBytes: Int64
    public let durationMs: Int
    public let transcriptSha256: String
}
public struct DocumentManifest: Codable {
    public let schemaVersion: String
    public let recordingId: String
    public let revision: Int
    public let source: DocumentSource
    public let artifacts: DocumentArtifacts
}
public struct DocumentReceipt: Codable {
    public struct Delivery: Codable {
        public let state: String
        public let revision: Int?
        public let manifestSha256: String?
        public let messageId: String?
        public let cardPayloadSha256: String?
        public let deliveredAt: String?
    }
    public let schemaVersion: String
    public let recordingId: String
    public let revision: Int?
    public let state: String
    public let receiptId: String?
    public let manifestSha256: String?
    public let manifestPath: String?
    public let artifacts: DocumentArtifacts?
    public let persistedAt: String?
    public let readbackVerifiedAt: String?
    public let delivery: Delivery?
    public let errorCode: String?
}
public struct DocumentVerification: Codable {
    public let recordingId: String
    public let messageId: String
    public let receiptId: String
    public let revision: Int
    public let manifestSha256: String
    public let verifiedAt: Date
    public func matches(_ receipt: DocumentReceipt?) -> Bool {
        guard let receipt, (try? DocumentReceiptVerifier.paths(receipt, recordingID: recordingId, messageID: messageId)) != nil else { return false }
        return receipt.receiptId == receiptId && receipt.revision == revision && receipt.manifestSha256 == manifestSha256
            && receipt.state == "ready" && receipt.delivery?.state == "delivered" && receipt.errorCode == nil
    }
}
public enum DocumentReceiptVerifier {
    public static let schema = "anc.recording-document.v1"
    public static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func validHash(_ value: String?) -> Bool {
        guard let value, value.count == 64 else { return false }
        return value.allSatisfy { "0123456789abcdef".contains($0) }
    }
    private static func validDate(_ value: String?) -> Bool {
        guard let value else { return false }
        let formatter = ISO8601DateFormatter()
        if formatter.date(from: value) != nil { return true }
        formatter.formatOptions.insert(.withFractionalSeconds)
        return formatter.date(from: value) != nil
    }
    /// Returns only canonical relative paths. No server-provided URL can select another origin.
    public static func paths(_ receipt: DocumentReceipt, recordingID: String, messageID: String) throws -> [String] {
        guard let revision = receipt.revision, revision > 0 else { throw UploadValidationError.invalidReceipt }
        let prefix = "/v1/recordings/\(recordingID)/documents/\(revision)/"
        guard validHash(recordingID), receipt.schemaVersion == schema, receipt.recordingId == recordingID,
              receipt.state == "ready", receipt.errorCode == nil,
              !(receipt.receiptId ?? "").isEmpty, validHash(receipt.manifestSha256),
              receipt.manifestPath == prefix + "manifest.json", let artifacts = receipt.artifacts,
              artifacts.json.path == prefix + "document.json", artifacts.markdown.path == prefix + "document.md",
              [artifacts.json, artifacts.markdown].allSatisfy({ validHash($0.sha256) && $0.bytes > 0 && $0.bytes <= 4 * 1024 * 1024 }),
              validDate(receipt.persistedAt), validDate(receipt.readbackVerifiedAt),
              let delivery = receipt.delivery, delivery.state == "delivered", delivery.revision == receipt.revision,
              delivery.manifestSha256 == receipt.manifestSha256, !messageID.isEmpty, delivery.messageId == messageID,
              validHash(delivery.cardPayloadSha256), validDate(delivery.deliveredAt) else {
            throw UploadValidationError.invalidReceipt
        }
        return [prefix + "manifest.json", prefix + "document.json", prefix + "document.md"]
    }
    public static func verify(_ receipt: DocumentReceipt, recordingID: String, audioBytes: Int64,
                              messageID: String, manifest: Data, json: Data, markdown: Data) throws -> DocumentVerification {
        _ = try paths(receipt, recordingID: recordingID, messageID: messageID)
        guard manifest.count <= 65536, digest(manifest) == receipt.manifestSha256,
              let artifacts = receipt.artifacts,
              json.count == artifacts.json.bytes, digest(json) == artifacts.json.sha256,
              markdown.count == artifacts.markdown.bytes, digest(markdown) == artifacts.markdown.sha256,
              String(data: markdown, encoding: .utf8) != nil else { throw UploadValidationError.invalidReceipt }
        let value = try JSONDecoder().decode(DocumentManifest.self, from: manifest)
        guard value.schemaVersion == schema, value.recordingId == recordingID, value.revision == receipt.revision,
              value.artifacts == artifacts, value.source.audioSha256 == recordingID,
              value.source.audioBytes == audioBytes, audioBytes > 0, value.source.durationMs > 0,
              validHash(value.source.transcriptSha256) else { throw UploadValidationError.invalidReceipt }
        struct Identity: Decodable {
            let schemaVersion: String; let recordingId: String; let revision: Int
            let source: DocumentSource; let executionAuthorized: Bool
        }
        let document = try JSONDecoder().decode(Identity.self, from: json)
        guard document.schemaVersion == schema, document.recordingId == recordingID,
              document.revision == receipt.revision, document.source == value.source,
              !document.executionAuthorized else { throw UploadValidationError.invalidReceipt }
        return DocumentVerification(recordingId: recordingID, messageId: messageID, receiptId: receipt.receiptId!, revision: receipt.revision!,
                                    manifestSha256: receipt.manifestSha256!, verifiedAt: Date())
    }
}

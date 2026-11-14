import Foundation

struct UploadReceipt: Codable {
    let device: String
    let localId: String
    let recordingId: String
    let sha256: String
    let bytes: Int
    let duplicate: Bool
    let resultPath: String
    func validate(status: Int, digest: String, size: Int, expectedDevice: String) throws {
        guard [200, 201].contains(status), sha256 == digest, recordingId == digest,
              bytes == size, localId == "native-" + digest, device == expectedDevice,
              duplicate == (status == 200), resultPath == "/v1/recordings/" + digest
        else { throw UploadFailure.message("后台回执与本机文件不一致，停止处理。") }
    }
}
struct DeliveryResult: Codable {
    struct Feishu: Codable { let state: String; let messageId: String?; let error: String? }
    let recordingId: String
    let status: String
    let error: String?
    let feishu: Feishu
}
enum UploadFailure: LocalizedError {
    case message(String)
    var errorDescription: String? { if case let .message(s) = self { return s }; return nil }
}
func uploadEndpoint(_ base: String) throws -> URL {
    guard let u = URL(string: base), u.scheme == "https", u.host != nil,
          u.user == nil, u.password == nil, u.query == nil, u.fragment == nil,
          u.path.isEmpty || u.path == "/" else { throw UploadFailure.message("需要有效的 HTTPS 后台地址。") }
    return u
}

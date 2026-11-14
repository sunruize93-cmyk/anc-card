import Foundation
import Security
struct DeviceConfiguration: Codable {
    let baseURL: String
    let token: String
    let device: String
    let expiresAt: Double
}
let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]

func protect(_ url: URL) throws {
    var u = url; var values = URLResourceValues(); values.isExcludedFromBackup = true
    try u.setResourceValues(values)
    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: u.path)
}
func configuration() throws -> DeviceConfiguration {
    let url = documents.appendingPathComponent("device-import.json")
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "ANCUploadSmoke", kSecAttrAccount as String: "upload-device"]
    if FileManager.default.fileExists(atPath: url.path) {
        try protect(url)
        let data = try Data(contentsOf: url)
        let config = try JSONDecoder().decode(DeviceConfiguration.self, from: data)
        _ = try V1Upload.endpoint(config.baseURL)
        guard config.token.count == 64 else { throw RelayFailure.message("设备配置无效") }
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        let status = updated == errSecItemNotFound ? SecItemAdd(query.merging(attributes) { _, b in b } as CFDictionary, nil) : updated
        guard status == errSecSuccess else { throw RelayFailure.message("无法保存设备钥匙串") }
        try FileManager.default.removeItem(at: url) // Only this one-time credential import; never an audio original.
    }
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query.merging([kSecReturnData as String: true]) { _, b in b } as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else { throw RelayFailure.message("请先通过 Mac 配置本机上传凭证。") }
    return try JSONDecoder().decode(DeviceConfiguration.self, from: data)
}

final class SecureTransport: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    let host: String
    let certificate: SecCertificate
    init(host: String, certificate: Data) throws {
        self.host = host
        guard let c = SecCertificateCreateWithData(nil, certificate as CFData) else { throw RelayFailure.message("测试 CA 无效") }
        self.certificate = c
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == host, let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        // Keep hostname, expiry and chain validation; trust only the explicitly provisioned test CA.
        let policy = SecPolicyCreateSSL(true, host as CFString)
        guard SecTrustSetPolicies(trust, policy) == errSecSuccess,
              SecTrustSetAnchorCertificates(trust, [certificate] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil) else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil) // Never forward an upload token to a redirect destination.
    }
}

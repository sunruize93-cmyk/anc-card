import Foundation
import Security

enum KeychainToken {
    private static let service = "ANCRelay.UploadCredential"
    private static let account = "upload"
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    static func read() throws -> String? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else {
            throw RelayFailure.message("钥匙串暂时不可读，请解锁手机后重试")
        }
        return token
    }

    static func save(_ token: String) throws {
        guard !token.isEmpty, token.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7e }) else {
            throw RelayFailure.message("凭证不能为空或包含空白/控制字符")
        }
        let attributes: [String: Any] = [
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var request = query
            attributes.forEach { request[$0.key] = $0.value }
            guard SecItemAdd(request as CFDictionary, nil) == errSecSuccess else {
                throw RelayFailure.message("无法保存凭证到钥匙串")
            }
        } else if status != errSecSuccess {
            throw RelayFailure.message("无法更新钥匙串凭证")
        }
    }
}

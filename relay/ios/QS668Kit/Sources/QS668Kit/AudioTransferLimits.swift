import Foundation

/// A bounded file pilot, aligned with the Mac gateway. Not a BLE background guarantee.
public enum AudioTransferLimits {
    public static let maxBytes = 256 * 1024 * 1024
    public static func canAppend(received: Int, next: Int) -> Bool {
        received >= 0 && next >= 0 && received <= maxBytes && next <= maxBytes - received
    }
}

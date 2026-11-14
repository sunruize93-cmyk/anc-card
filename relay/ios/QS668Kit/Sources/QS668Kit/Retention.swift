import Foundation

/// Planning only: callers must revalidate delivery and the current card list before deleting.
/// Historical files predating activation are deliberately excluded from automatic cleanup.
public struct AudioRetentionItem: Equatable {
    public let id: String
    public let importOrder: Int
    public let completeAudio: Bool
    public let documentDeliveryVerified: Bool
    public let sourceIdentityVerified: Bool
    public init(id: String, importOrder: Int, completeAudio: Bool,
                documentDeliveryVerified: Bool, sourceIdentityVerified: Bool) {
        self.id = id; self.importOrder = importOrder; self.completeAudio = completeAudio
        self.documentDeliveryVerified = documentDeliveryVerified
        self.sourceIdentityVerified = sourceIdentityVerified
    }
}

public enum AudioRetentionReason: String, Equatable {
    case disabled, latestFive, beforeActivation, incompleteAudio, unverifiedDocument, unknownSource, eligible
}

public enum AudioRetentionPlanner {
    public static func plan(_ items: [AudioRetentionItem], activatedAfterOrder: Int?) -> [String: AudioRetentionReason] {
        // Ambiguous duplicate IDs protect the entire snapshot.
        guard let activatedAfterOrder, Set(items.map(\.id)).count == items.count, Set(items.map(\.importOrder)).count == items.count else {
            return Dictionary(items.map { ($0.id, .disabled) }, uniquingKeysWith: { first, _ in first })
        }
        let latest = Set(items.filter(\.completeAudio).sorted { $0.importOrder > $1.importOrder }.prefix(5).map(\.id))
        return Dictionary(uniqueKeysWithValues: items.map { item in
            let reason: AudioRetentionReason
            if latest.contains(item.id) { reason = .latestFive }
            else if item.importOrder <= activatedAfterOrder { reason = .beforeActivation }
            else if !item.completeAudio { reason = .incompleteAudio }
            else if !item.documentDeliveryVerified { reason = .unverifiedDocument }
            else if !item.sourceIdentityVerified { reason = .unknownSource }
            else { reason = .eligible }
            return (item.id, reason)
        })
    }
}

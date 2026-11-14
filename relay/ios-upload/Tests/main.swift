import Foundation
let digest = String(repeating: "a", count: 64)
func receipt(_ changes: [String: Any] = [:]) throws -> UploadReceipt {
    var body: [String:Any] = ["device":"Eric-iPhone", "localId":"native-"+digest,
        "recordingId":digest,"sha256":digest,"bytes":409644,"duplicate":true,"resultPath":"/v1/recordings/"+digest]
    body.merge(changes) { _, b in b }
    return try JSONDecoder().decode(UploadReceipt.self, from: JSONSerialization.data(withJSONObject: body))
}
var checks = 0
func rejects(_ name: String, _ action: () throws -> Void) {
    do { try action(); fatalError("Expected rejection: " + name) } catch { checks += 1 }
}
try receipt().validate(status:200,digest:digest,size:409644,expectedDevice:"Eric-iPhone"); checks += 1
try receipt(["duplicate":false]).validate(status:201,digest:digest,size:409644,expectedDevice:"Eric-iPhone"); checks += 1
for changes in [["device":"wrong"],["localId":"wrong"],["bytes":1],["sha256":"wrong"],["recordingId":"wrong"],["duplicate":false],["resultPath":"https://example.org/steal"]] as [[String:Any]] {
    rejects("tampered receipt") { try receipt(changes).validate(status:200,digest:digest,size:409644,expectedDevice:"Eric-iPhone") }
}
rejects("invalid status") { try receipt().validate(status:202,digest:digest,size:409644,expectedDevice:"Eric-iPhone") }
for base in ["http://example.com", "https://user:password@example.com", "https://example.com/?token=secret", "https://example.com/#fragment", "https://example.com/path"] {
    rejects("invalid endpoint") { _ = try uploadEndpoint(base) }
}
_ = try uploadEndpoint("https://192.168.0.11:4787"); checks += 1
print("Upload contract: \(checks) checks passed")

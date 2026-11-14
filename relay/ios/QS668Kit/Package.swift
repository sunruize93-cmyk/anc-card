// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "QS668Kit",
    platforms: [.iOS(.v16), .macOS(.v12)],
    products: [.library(name: "QS668Kit", targets: ["QS668Kit"])],
    targets: [
        .target(name: "QS668Kit"),
        .testTarget(name: "QS668KitTests", dependencies: ["QS668Kit"])
    ]
)

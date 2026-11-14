// swift-tools-version: 6.4
// Module layout and dependency graph: docs/native-port/PLAN.md section 2.
import PackageDescription

let modules: [(name: String, deps: [String])] = [
    ("IronvaleCore", []),
    ("IronvaleContract", ["IronvaleCore"]),
    ("IronvaleWire", ["IronvaleCore", "IronvaleContract"]),
    ("IronvaleWorld", ["IronvaleCore"]),
    ("IronvaleMapData", ["IronvaleCore", "IronvaleWorld"]),
    ("IronvalePlatform", ["IronvaleCore"]),
    ("IronvaleAssets", ["IronvaleCore"]),
    ("IronvaleSim", ["IronvaleCore", "IronvaleContract", "IronvaleWorld", "IronvaleMapData"]),
    ("IronvaleAI", ["IronvaleSim", "IronvaleWorld", "IronvaleContract"]),
    ("IronvaleNet", ["IronvaleWire", "IronvaleSim"]),
    // Links WebRTC.xcframework (stasel/WebRTC); the only target that does (PLAN.md 3.11).
    ("IronvaleTransportWebRTC", ["IronvaleNet"]),
    ("IronvaleRender", ["IronvaleCore", "IronvaleAssets", "ShaderTypes"]),
    ("IronvaleMapRender", ["IronvaleRender", "IronvaleSim", "IronvaleMapData"]),
    ("IronvaleFX", ["IronvaleRender", "IronvaleSim"]),
    ("IronvaleCharacters", ["IronvaleRender", "IronvaleSim"]),
    ("IronvaleViewModel", ["IronvaleRender", "IronvaleSim"]),
    ("IronvaleAudio", ["IronvaleSim", "IronvaleAssets", "IronvaleWorld"]),
    ("IronvaleUI", ["IronvaleRender", "IronvaleSim", "IronvaleNet", "IronvaleAssets", "IronvalePlatform"]),
]

/// Third-party products, per target. Pinned to exact versions.
let externalDeps: [String: [Target.Dependency]] = [
    "IronvaleTransportWebRTC": [.product(name: "WebRTC", package: "WebRTC")],
]

let swiftSettings: [SwiftSetting] = [.swiftLanguageMode(.v6)]

let moduleTargets: [Target] = modules.map { module in
    .target(
        name: module.name,
        dependencies: module.deps.map { .target(name: $0) } + (externalDeps[module.name] ?? []),
        swiftSettings: swiftSettings
    )
}

let testedTargets = modules.map(\.name) + ["ShaderTypes"]
let testTargets: [Target] = testedTargets.map { name in
    .testTarget(
        name: "\(name)Tests",
        dependencies: [.target(name: name)],
        swiftSettings: swiftSettings
    )
}

let package = Package(
    name: "IronvaleKit",
    platforms: [.macOS(.v26)],
    products: [
        // One product carrying every library target; the app links this.
        .library(name: "IronvaleKit", targets: modules.map(\.name) + ["ShaderTypes"]),
        .executable(name: "ivpeer", targets: ["ivpeer"]),
    ],
    dependencies: [
        // Google libwebrtc as a binary xcframework with a macOS slice (PLAN.md 3.11).
        .package(url: "https://github.com/stasel/WebRTC.git", exact: "157.0.0"),
    ],
    targets: moduleTargets + [
        .target(name: "ShaderTypes"),
        .executableTarget(
            name: "ivpeer",
            dependencies: ["IronvaleNet", "IronvaleTransportWebRTC", "IronvaleSim", "IronvaleAI", "IronvaleMapData"],
            swiftSettings: swiftSettings
        ),
    ] + testTargets
)

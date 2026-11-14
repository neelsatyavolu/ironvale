import Foundation
import IronvaleContract

/// native/, found from this file: native/IronvaleKit/Tests/IronvaleAITests/.
let nativeRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
let packagesRoot = nativeRoot.appending(path: "MapPackages")
let navFixturesRoot = nativeRoot.appending(path: "Contract/nav")

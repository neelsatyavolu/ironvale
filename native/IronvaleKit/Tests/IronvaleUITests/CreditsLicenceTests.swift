// M12 prep: the licence gate's credit side. Every CC-BY 4.0 entry of the asset manifests (assets/*.json) is
// credited on the Credits screen, every manifest licence is one the gate allows, and every licence text the
// screen shows exists in the app's resources (native/ci/stage-runtime.py and Resources/Fonts ship them).
import Foundation
import Testing
@testable import IronvaleUI

@Suite struct CreditsLicences {
    static let repo = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()

    static func manifestEntries() throws -> [[String: Any]] {
        let dir = repo.appending(path: "assets")
        return try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".json") }.sorted().flatMap { name in
            let root = try JSONSerialization.jsonObject(with: Data(contentsOf: dir.appending(path: name))) as? [String: Any]
            return root?["assets"] as? [[String: Any]] ?? []
        }
    }

    @Test func everyManifestLicenceIsAllowed() throws {
        let entries = try Self.manifestEntries()
        #expect(!entries.isEmpty)
        for entry in entries {
            let licence = entry["license"] as? String ?? ""
            #expect(["CC0", "CC-BY 4.0"].contains(licence), "\(entry["id"] ?? "?") is \(licence)")
        }
    }

    @Test func everyCCBYEntryIsOnTheCreditsScreen() throws {
        let ccBy = try Self.manifestEntries().filter { $0["license"] as? String == "CC-BY 4.0" }
        #expect(!ccBy.isEmpty)
        let shipped = Dictionary(CreditsModel.manifest.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let shown = CreditsModel.screenGroups.flatMap(\.credited).map(\.sentence)
        for entry in ccBy {
            let id = entry["id"] as? String ?? ""
            guard let asset = shipped[id] else {
                Issue.record("\(id) is CC-BY 4.0 but missing from the generated credits manifest")
                continue
            }
            #expect(asset.license == "CC-BY 4.0", "\(id)")
            let text = asset.credit ?? "\(asset.id), \(asset.license), \(asset.source)"
            #expect(shown.contains { $0.hasPrefix(text) }, "\(id) is not credited on screen")
        }
    }

    @Test func everyLicenceTextIsInTheAppResources() throws {
        let resources = Self.repo.appending(path: "native/IronvaleApp/Resources")
        for licence in CreditsModel.licenceTexts {
            // The stage step flattens Licenses/ as is; fonts sit in Resources/Fonts and are copied flat.
            let candidates = [resources.appending(path: licence.resource), resources.appending(path: "Fonts/\(licence.resource)")]
            let text = candidates.compactMap { try? String(contentsOf: $0, encoding: .utf8) }.first ?? ""
            #expect(text.count > 500, "\(licence.resource) is missing or empty")
        }
    }
}

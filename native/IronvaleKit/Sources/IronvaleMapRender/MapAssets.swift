// Locates a map's render inputs on disk for the M3 bring-up: the map package
// (native/MapPackages/<id>) and the web asset tree (public/, with the git-ignored assets/dl
// downloads). Bundling these into the app is M4 (PLAN.md 3.5 asset bundle step).
import Foundation
import IronvaleMapData

public struct MapAssets: Sendable {
    public let package: URL
    /// The web's `public/` directory: texture URIs in scene.json are relative to it.
    public let publicRoot: URL
    /// The repository's `assets/` manifests (assets/map-*.json).
    public let manifestRoot: URL
    public let meta: MapMeta

    public enum LookupError: Error, CustomStringConvertible {
        case notFound(String)

        public var description: String {
            switch self {
            case .notFound(let what): what
            }
        }
    }

    public init(package: URL, repositoryRoot: URL) throws {
        self.package = package
        publicRoot = repositoryRoot.appending(path: "public")
        manifestRoot = repositoryRoot.appending(path: "assets")
        let metaURL = package.appending(path: "meta.json")
        guard let data = try? Data(contentsOf: metaURL) else { throw LookupError.notFound("missing \(metaURL.path)") }
        meta = try JSONDecoder().decode(MapMeta.self, from: data)
    }

    /// Walks up from `start` to the directory holding `native/MapPackages` (the repository root).
    public static func findRepositoryRoot(from start: URL) -> URL? {
        var dir = start.standardizedFileURL
        while dir.path != "/" {
            if FileManager.default.fileExists(atPath: dir.appending(path: "native/MapPackages").path) { return dir }
            dir = dir.deletingLastPathComponent()
        }
        return nil
    }

    /// The file for `key` (such as "hdr@2k" or "sky") of manifest entry `id`, under public/assets/dl.
    /// The web picks hdr@2k and the sky panorama on the 2k texture tier (src/core/assets.ts), which
    /// the High preset uses.
    public func assetFile(id: String, key: String) throws -> URL {
        let manifests = (try? FileManager.default.contentsOfDirectory(atPath: manifestRoot.path)) ?? []
        for name in manifests.sorted() where name.hasSuffix(".json") {
            guard let data = try? Data(contentsOf: manifestRoot.appending(path: name)),
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let entries = root["assets"] as? [[String: Any]]
            else { continue }
            for entry in entries where entry["id"] as? String == id {
                guard let files = entry["files"] as? [String: Any], let file = files[key] as? [String: Any],
                      let path = file["path"] as? String
                else { throw LookupError.notFound("asset \(id) has no \(key) file") }
                let url = publicRoot.appending(path: "assets/dl/\(path)")
                guard FileManager.default.fileExists(atPath: url.path) else {
                    throw LookupError.notFound("\(url.path) is missing (download the web assets first)")
                }
                return url
            }
        }
        throw LookupError.notFound("asset \(id) is not in \(manifestRoot.path)")
    }
}

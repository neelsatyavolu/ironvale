// Ported from src/ui/credits-model.ts at cbe0add: turns the asset manifests (assets/*.json, carried in
// Generated/WebHUDData.swift) into the credits the Credits screen shows and CREDITS.md holds.
// IronvaleUITests/CreditsTests runs the cases of tests/ui/credits-model.test.ts against it.
import Foundation

public enum CreditsModel {
    /// The part of a manifest entry the credits need (`CreditAsset`).
    public struct Asset: Equatable, Sendable {
        public let id: String
        public let kind: String
        public let license: String
        public let source: String
        public let credit: String?

        public init(id: String, kind: String, license: String, source: String, credit: String? = nil) {
            self.id = id
            self.kind = kind
            self.license = license
            self.source = source
            self.credit = credit
        }
    }

    /// An attribution a licence requires (`CreditLine`): the text, its URL, how many entries carry it.
    public struct Line: Equatable, Sendable {
        public let text: String
        public let url: String
        public let count: Int
    }

    public struct Group: Equatable, Sendable {
        public let id: String
        public let title: String
        public let count: Int
        public let credited: [Line]
        public let thanks: [CreditThanks]
    }

    public static let ccByURL = "https://creativecommons.org/licenses/by/4.0/"
    static let freeLicence = "CC0"

    struct AssetGroup {
        let id: String, title: String, kinds: [String], one: String, many: String, cut: Bool
    }

    static let assetGroups = [
        AssetGroup(id: "models", title: "Models", kinds: ["model"], one: "model", many: "models", cut: false),
        AssetGroup(id: "sounds", title: "Sounds", kinds: ["sound"], one: "sound", many: "sounds", cut: true),
        AssetGroup(id: "textures", title: "Textures and skies", kinds: ["pbr", "texture", "hdri"], one: "texture set or sky",
                   many: "texture sets and skies", cut: false),
    ]

    static let siteNames = ["polyhaven.com": "Poly Haven", "freesound.org": "Freesound", "opengameart.org": "OpenGameArt", "ambientcg.com": "ambientCG"]

    static let namedPages = [
        "https://opengameart.org/content/the-free-firearm-sound-library": (
            name: "The Free Firearm Sound Library",
            by: "recorded by Ben Jaszczak, Brian Nelson, Kevin Heras and Matthew Nanney"
        ),
    ]

    public static let fonts = [
        CreditThanks(name: "Newsreader", url: "https://github.com/productiontype/Newsreader", licence: "OFL 1.1", note: "Production Type"),
        CreditThanks(name: "Geist", url: "https://github.com/vercel/geist-font", licence: "OFL 1.1", note: "The Geist Project Authors"),
        CreditThanks(name: "Geist Mono", url: "https://github.com/vercel/geist-font", licence: "OFL 1.1", note: "The Geist Project Authors"),
    ]

    /// The web build's libraries (`LIBRARIES`); the native screen lists `nativeLibraries` instead.
    public static let webLibraries = [
        CreditThanks(name: "three.js", url: "https://threejs.org", licence: "MIT", note: "Rendering, on WebGPU and WebGL 2"),
        CreditThanks(name: "three-mesh-bvh", url: "https://github.com/gkjohnson/three-mesh-bvh", licence: "MIT", note: "Collision and bullet ray casts"),
    ]

    /// Third-party code the native app links (Package.swift).
    public static let nativeLibraries = [
        CreditThanks(name: "WebRTC", url: "https://webrtc.googlesource.com/src", licence: "BSD 3-Clause",
                     note: "The connection to a friend, built by github.com/stasel/WebRTC"),
    ]

    static func creditedLines(_ entries: [Asset]) -> [Line] {
        var order: [String] = []
        var lines: [String: Line] = [:]
        for entry in entries {
            let text = entry.credit ?? "\(entry.id), \(entry.license), \(entry.source)"
            if lines[text] == nil { order.append(text) }
            // Map.set on an existing key keeps its place and takes the latest entry's URL.
            lines[text] = Line(text: text, url: entry.source, count: (lines[text]?.count ?? 0) + 1)
        }
        return order.compactMap { lines[$0] }
    }

    /// `new URL(source).host` without a leading `www.`; nil when the source is not an absolute URL.
    static func hostOf(_ source: String) -> String? {
        guard let url = URLComponents(string: source), let scheme = url.scheme, !scheme.isEmpty, let host = url.host, !host.isEmpty else { return nil }
        var name = host.lowercased()
        if let port = url.port, !(scheme == "https" && port == 443) && !(scheme == "http" && port == 80) { name += ":\(port)" }
        return name.hasPrefix("www.") ? String(name.dropFirst(4)) : name
    }

    static func thanksRows(_ entries: [Asset], one: String, many: String, countOriginals: Bool) -> [CreditThanks] {
        var order: [String] = []
        var buckets: [String: [Asset]] = [:]
        for entry in entries {
            let key = namedPages[entry.source] != nil ? entry.source : (hostOf(entry.source) ?? "")
            if buckets[key] == nil { order.append(key) }
            buckets[key, default: []].append(entry)
        }
        return order.map { key in
            let bucket = buckets[key]!
            let amount = "\(bucket.count) \(bucket.count == 1 ? one : many)"
            if let page = namedPages[key] { return CreditThanks(name: page.name, url: key, licence: freeLicence, note: "\(amount), \(page.by)") }
            if key.isEmpty { return CreditThanks(name: "Ironvale", url: "", licence: freeLicence, note: "\(amount) synthesised for the game") }
            let originals = Set(bucket.map(\.source)).count
            let cut = countOriginals && originals < bucket.count ? " cut from \(originals) \(originals == 1 ? "recording" : "recordings")" : ""
            return CreditThanks(name: siteNames[key] ?? key, url: "https://\(key)", licence: freeLicence, note: amount + cut)
        }
    }

    /// The five groups, always in the same order (`buildCredits`).
    public static func build(_ manifest: [Asset], libraries: [CreditThanks] = webLibraries) -> [Group] {
        let assets = assetGroups.map { group in
            let entries = manifest.filter { group.kinds.contains($0.kind) }
            return Group(id: group.id, title: group.title, count: entries.count,
                         credited: creditedLines(entries.filter { $0.license != freeLicence }),
                         thanks: thanksRows(entries.filter { $0.license == freeLicence }, one: group.one, many: group.many, countOriginals: group.cut))
        }
        return assets + [
            Group(id: "fonts", title: "Fonts", count: fonts.count, credited: [], thanks: fonts),
            Group(id: "libraries", title: "Libraries", count: libraries.count, credited: [], thanks: libraries),
        ]
    }

    /// A credit line as a sentence (`creditSentence`).
    public static func sentence(_ line: Line) -> String {
        let text = line.text.hasSuffix(".") || line.text.hasSuffix("!") || line.text.hasSuffix("?") ? line.text : "\(line.text)."
        return line.count > 1 ? "\(text) Used for \(line.count) files." : text
    }

    /// The same credits as Markdown (`creditsMarkdown`).
    public static func markdown(_ groups: [Group]) -> String {
        var out = [
            "# Credits",
            "",
            "Generated from `assets/*.json` by `node scripts/credits.mjs`. Do not edit by hand: change the manifest and run the script again. The Credits screen in the game shows the same list.",
            "",
            "Ironvale is built from work other people gave away. Entries under CC BY 4.0 (\(ccByURL)) are credited in full, with the changes made to each. CC0 sources ask for no credit and are thanked by site.",
        ]
        for group in groups {
            out += ["", "## \(group.title)", ""]
            for line in group.credited { out.append("- \(sentence(line))") }
            if !group.credited.isEmpty && !group.thanks.isEmpty { out.append("") }
            for row in group.thanks {
                let where_ = row.url.isEmpty ? "" : " (\(row.url))"
                out.append("- \(row.name)\(where_), \(row.licence): \(row.note)")
            }
        }
        return out.joined(separator: "\n") + "\n"
    }

    /// The shipped manifest, from the generated web data.
    public static let manifest: [Asset] = {
        guard let root = JSValue.parse(WebHUDData.json), case let .array(items)? = root["creditAssets"] else {
            fatalError("Generated/WebHUDData.swift has no creditAssets")
        }
        return items.map { item in
            func text(_ key: String) -> String { if case let .string(s)? = item[key] { s } else { "" } }
            let credit: String? = if case let .string(s)? = item["credit"] { s } else { nil }
            return Asset(id: text("id"), kind: text("kind"), license: text("license"), source: text("source"), credit: credit)
        }
    }()

    /// What the native Credits screen shows: the shipped manifest with the native app's libraries.
    public static var screenGroups: [CreditGroup] {
        build(manifest, libraries: nativeLibraries).map { group in
            CreditGroup(id: group.id, title: group.title, count: group.count,
                        credited: group.credited.map { CreditLine(sentence: sentence($0), url: $0.url) }, thanks: group.thanks)
        }
    }
}

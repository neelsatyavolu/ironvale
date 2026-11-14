// Checks the Swift ports against answers the web code gave (native/Tools/ui-fixtures writes the fixture file
// from src/; native/ci/check-m10a.sh regenerates it first).
import CoreGraphics
import Foundation
import Testing
@testable import IronvaleUI

enum Fixtures {
    static let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Tools/ui-fixtures/fixtures/web-ui-fixtures.json")

    static let root: JSValue = {
        guard let text = try? String(contentsOf: url, encoding: .utf8), let value = JSValue.parse(text) else {
            fatalError("Missing or unreadable \(url.path). Run: npx vitest run --config native/Tools/ui-fixtures/vitest.config.ts")
        }
        return value
    }()

    static func list(_ key: String) -> [JSValue] {
        guard case let .array(items)? = root[key] else { fatalError("fixture \(key) missing") }
        return items
    }
}

extension JSValue {
    var text: String? { if case let .string(s) = self { return s } else { return nil } }
    var double: Double? { if case let .number(n) = self { return n } else { return nil } }
}

@Suite struct SettingsRoundTrip {
    @Test func defaultsMatchTheWeb() {
        #expect(Settings.defaults.stringify() == Fixtures.root["defaults"]?.text)
    }

    @Test(arguments: Fixtures.list("parse").indices)
    func parseMatchesWebAndRoundTrips(_ index: Int) throws {
        let item = Fixtures.list("parse")[index]
        let raw = item["raw"]?.text
        let expected = try #require(item["stored"]?.text)
        let parsed = Settings.parse(raw)
        // Byte for byte what the web would store for this input...
        #expect(parsed.stringify() == expected, "raw: \(raw ?? "null")")
        // ...and what the web stored reads back unchanged in both builds.
        #expect(Settings.parse(expected).stringify() == expected)
        #expect(Settings.parse(expected) == parsed)
    }

    @Test func storageKeyIsTheWebKey() {
        #expect(Settings.storageKey == Fixtures.root["storageKey"]?.text)
    }

    @Test(arguments: Fixtures.list("tiers").indices)
    func tierMatchingFollowsTheWeb(_ index: Int) throws {
        let item = Fixtures.list("tiers")[index]
        let baseText = try #require(item["base"]?.text)
        let patchText = try #require(item["patch"]?.text)
        let base = try GraphicsSettings(json: JSValue.parse(baseText))
        let patch = try #require(JSValue.parse(patchText))
        let patched = SettingsModel.patchGraphics(base) { graphics in
            guard case let .object(pairs) = graphics.json, case let .object(changes) = patch else { return }
            let merged = JSValue.object(pairs.map { key, value in (key, changes.last { $0.0 == key }?.1 ?? value) })
            graphics = (try? GraphicsSettings(json: merged)) ?? graphics
        }
        #expect(patched.json.stringify() == item["patched"]?.text)
        #expect(SettingsModel.matchTier(patched)?.rawValue == item["matchTier"]?.text)
        #expect(SettingsModel.presetLabel(patched) == item["presetLabel"]?.text)
        for tier in QualityTier.allCases {
            #expect(SettingsModel.applyTier(patched, tier).json.stringify() == item["applied"]?[tier.rawValue]?.text)
        }
    }

    @Test func gpuTiersFollowTheWeb() {
        for item in Fixtures.list("gpu") {
            let name = item["name"]?.text ?? ""
            #expect(SettingsModel.tierForGpu(name)?.rawValue == item["tier"]?.text, "\(name)")
        }
    }
}

@Suite struct JSNumberFormat {
    @Test func matchesJavaScript() {
        let cases: [(Double, String)] = [
            (0, "0"), (1, "1"), (0.9, "0.9"), (130, "130"), (0.35, "0.35"), (1e-7, "1e-7"), (0.00001, "0.00001"),
            (0.000001, "0.000001"), (123.45, "123.45"), (1e21, "1e+21"), (1e20, "100000000000000000000"),
            (-2.5, "-2.5"), (0.1 + 0.2, "0.30000000000000004"), (4096, "4096"), (1.5e-10, "1.5e-10"),
        ]
        for (value, text) in cases { #expect(JSNumber.string(value) == text) }
    }
}

@Suite struct SmallPorts {
    @Test func focusNavigationMatchesTheWeb() {
        for item in Fixtures.list("focus") {
            guard case let .array(boxes)? = item["boxes"] else { Issue.record("bad focus case"); continue }
            let rects = boxes.map {
                CGRect(x: $0["left"]?.double ?? 0, y: $0["top"]?.double ?? 0, width: $0["width"]?.double ?? 0, height: $0["height"]?.double ?? 0)
            }
            let direction: NavDirection = switch item["direction"]?.text {
            case "up": .up
            case "down": .down
            case "left": .left
            default: .right
            }
            let current = Int(item["current"]?.double ?? -1)
            #expect(FocusNav.pickNeighbour(rects, current: current, direction: direction) == Int(item["expected"]?.double ?? -2))
        }
    }

    @Test func clockAndAccuracyMatchTheWeb() {
        for item in Fixtures.list("clock") {
            let seconds = item["seconds"]?.double ?? .nan
            #expect(Format.clock(seconds) == item["text"]?.text)
        }
        for item in Fixtures.list("accuracy") {
            let percent = Format.accuracyPercent(hits: Int(item["hits"]?.double ?? 0), projectiles: Int(item["shots"]?.double ?? 0))
            #expect(percent.map(Double.init) == item["percent"]?.double)
        }
    }

    @Test func generatedDataDecodes() {
        let data = WebData.shared
        #expect(data.maps.map(\.id) == ["railyard", "harbor", "headworks"])
        #expect(data.credits.map(\.id) == ["models", "sounds", "textures", "fonts", "libraries"])
        #expect(data.bindingRows[.trackpad]?.first?.label == "Move")
        #expect(data.controlTips[.mouse]?.count == 6)
        #expect(data.firstRunRows.count == 9)
        #expect(data.controlPresets[.mouse]?.rawInput == true)
    }
}

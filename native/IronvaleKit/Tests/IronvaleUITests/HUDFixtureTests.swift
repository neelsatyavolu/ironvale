// The HUD's ported logic against the answers src/ gave (native/Tools/ui-fixtures/hud-fixtures.test.ts
// writes web-hud-fixtures.json; native/ci/check-m10.sh regenerates it first and fails on drift).
import Foundation
import IronvaleSim
import Testing
@testable import IronvaleUI

enum HUDFixtures {
    static let native = Fixtures.url.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static let url = native.appending(path: "Tools/ui-fixtures/fixtures/web-hud-fixtures.json")
    static let resources = native.appending(path: "IronvaleApp/Resources/HUD")

    static let root: JSValue = {
        guard let text = try? String(contentsOf: url, encoding: .utf8), let value = JSValue.parse(text) else {
            fatalError("Missing \(url.path). Run: npx vitest run --config native/Tools/ui-fixtures/vitest.config.ts")
        }
        return value
    }()

    static func list(_ key: String, in value: JSValue = root) -> [JSValue] {
        guard case let .array(items)? = value[key] else { fatalError("fixture \(key) missing") }
        return items
    }

    static func numbers(_ value: JSValue?) -> [Double] {
        guard case let .array(items)? = value else { return [] }
        return items.compactMap(\.double)
    }

    static func strings(_ value: JSValue?) -> [String] {
        guard case let .array(items)? = value else { return [] }
        return items.compactMap(\.text)
    }
}

extension JSValue {
    var bool: Bool? { if case let .bool(b) = self { return b } else { return nil } }
}

private func close(_ a: Double, _ b: Double, _ tolerance: Double = 1e-12) -> Bool { abs(a - b) <= tolerance * max(1, abs(b)) }

@Suite struct HUDMathFixtures {
    @Test func damageDirection() throws {
        for item in HUDFixtures.list("damageAngle") {
            let got = HUDMath.damageAngle(dx: item["dx"]!.double!, dz: item["dz"]!.double!, yaw: item["yaw"]!.double!)
            #expect(close(got, item["angle"]!.double!), "\(item.stringify()) -> \(got)")
        }
        for item in HUDFixtures.list("unwrapAngle") {
            let got = HUDMath.unwrapAngle(previous: item["previous"]!.double!, target: item["target"]!.double!)
            #expect(close(got, item["angle"]!.double!), "\(item.stringify()) -> \(got)")
        }
        for item in HUDFixtures.list("healthEffects") {
            let got = HUDMath.healthEffects(item["health"]!.double!)
            #expect(close(got.vignette, item["vignette"]!.double!) && close(got.saturation, item["saturation"]!.double!), "\(item.stringify())")
        }
    }

    @Test func killFeed() {
        for item in HUDFixtures.list("feed") {
            let entries = HUDFixtures.list("entries", in: item).map {
                KillFeedEntry(killer: $0["killer"]!.text!, victim: $0["victim"]!.text!, weapon: $0["weapon"]!.text!, headshot: $0["headshot"]!.bool!,
                              time: $0["time"]!.double!)
            }
            #expect(entries.map(HUDMath.feedKey) == HUDFixtures.strings(item["keys"]))
            let kept = HUDMath.trimKillFeed(entries, now: item["now"]!.double!, maxAge: item["maxAge"]!.double!, maxRows: Int(item["maxRows"]!.double!))
            #expect(kept.map(HUDMath.feedKey) == HUDFixtures.strings(item["kept"]))
        }
    }

    @Test func textAndCountdowns() {
        for item in HUDFixtures.list("respawnCountdown") {
            #expect(HUDMath.respawnCountdown(diedAt: item["diedAt"]!.double!, now: item["now"]!.double!, delay: item["delay"]!.double!)
                == Int(item["seconds"]!.double!))
        }
        for item in HUDFixtures.list("rulesOf") {
            let config = item["config"]
            #expect(HUDMath.rulesOf(mode: config?["mode"]?.text, rules: config?["rules"]?.text) == item["rules"]!.text!)
        }
        for item in HUDFixtures.list("killNote") {
            #expect(HUDMath.killNote(headshot: item["headshot"]!.bool!, streak: Int(item["streak"]!.double!), distance: item["distance"]!.double!)
                == item["text"]!.text!)
        }
        for item in HUDFixtures.list("grenadeHint") {
            #expect(HUDMath.grenadeHint(count: Int(item["count"]!.double!), aiming: item["aiming"]!.bool!, key: item["key"]!.text!) == item["text"]!.text!)
        }
    }

    @Test func grenadeKeyNamesFollowTheBindings() {
        for preset in ["trackpad", "mouse"] {
            let code = SimData.shared.constants.input.bindings[preset]?["grenade"]?.first ?? ""
            #expect(HUDMath.keyName(code, preset: preset) == HUDFixtures.root["grenadeKey"]?[preset]?.text)
        }
    }

    @Test func minimapModel() {
        for item in HUDFixtures.list("layouts") {
            let cells = HUDMath.buildLayout(nx: Int(item["nx"]!.double!), nz: Int(item["nz"]!.double!),
                                            colStart: HUDFixtures.numbers(item["colStart"]).map { Int($0) },
                                            edges: HUDFixtures.numbers(item["edges"]).map { Int($0) }, rim: Int(item["rim"]!.double!))
            #expect(cells.map(Double.init) == HUDFixtures.numbers(item["cells"]))
        }
        let minimap = HUDFixtures.root["minimap"]!
        for item in HUDFixtures.list("toMap", in: minimap) {
            let p = HUDMath.toMap(dx: item["dx"]!.double!, dz: item["dz"]!.double!, yaw: item["yaw"]!.double!, scale: item["scale"]!.double!,
                                  limit: item["limit"]!.double!)
            #expect(close(p.x, item["x"]!.double!, 1e-9) && close(p.y, item["y"]!.double!, 1e-9) && p.outside == item["outside"]!.bool!,
                    "\(item.stringify())")
        }
        for item in HUDFixtures.list("fov", in: minimap) {
            #expect(close(HUDMath.horizontalHalfFov(verticalDegrees: item["degrees"]!.double!, aspect: item["aspect"]!.double!), item["half"]!.double!))
        }
        for item in HUDFixtures.list("shots", in: minimap) {
            let got = HUDMath.shotAge(firedAt: item["firedAt"]?.double, now: item["now"]!.double!)
            if let age = item["age"]?.double { #expect(close(got, age)) } else { #expect(got == .infinity) }
        }
        let c = HUDConstants.shared
        for item in HUDFixtures.list("reveals", in: minimap) {
            let got = HUDMath.revealAge(now: item["now"]!.double!, every: c.revealEvery, hold: c.revealSeconds)
            if let age = item["age"]?.double { #expect(close(got, age)) } else { #expect(got == .infinity) }
        }
        #expect(HUDMath.revealAge(now: .nan, every: c.revealEvery, hold: c.revealSeconds) == .infinity)
        #expect(minimap["nanReveal"]?.text == "infinite")
    }

    @Test func shippedMinimapLayoutsDecode() throws {
        for summary in HUDFixtures.list("mapLayouts") {
            let layout = try MinimapLayout.load(directory: HUDFixtures.resources, mapId: summary["map"]!.text!)
            #expect(Double(layout.nx) == summary["nx"]!.double! && Double(layout.nz) == summary["nz"]!.double!)
            #expect(layout.originX == summary["originX"]!.double! && layout.originZ == summary["originZ"]!.double! && layout.cell == summary["cell"]!.double!)
            let counts = (0..<3).map { kind in Double(layout.cells.count { $0 == UInt8(kind) }) }
            #expect(counts == HUDFixtures.numbers(summary["counts"]))
            let painted = layout.paint()
            #expect(painted.width == layout.nx * 3 && painted.pixels.count == painted.width * painted.height * 4)
        }
    }

    @Test func weaponStatsMatchThePicker() {
        for item in HUDFixtures.list("weaponStats") {
            let def = try! #require(SimData.shared.contract.weapons.def(item["id"]!.text!))
            let stats = HUDMath.weaponStats(def)
            let expected = HUDFixtures.list("stats", in: item)
            #expect(stats.map(\.label) == expected.map { $0["label"]!.text! })
            for (got, want) in zip(stats, expected) { #expect(close(got.value, want["value"]!.double!, 1e-9)) }
        }
    }

    @Test func atlasHoldsEveryFaceAndTheHUDCharacters() throws {
        let font = try MSDFFont.load(directory: HUDFixtures.resources)
        for face in MSDFFont.Face.allCases {
            let line = font.layout("Enemies 12 · You were hit — “ok”…", face: face, size: 16)
            #expect(line.width > 100, "\(face)")
            #expect(line.glyphs.count == 26, "\(face): \(line.glyphs.count) glyphs")
        }
        // Geist Mono is monospaced: tabular figures for every count.
        #expect(font.layout("0000", face: .mono, size: 10).width == font.layout("1111", face: .mono, size: 10).width)
    }
}

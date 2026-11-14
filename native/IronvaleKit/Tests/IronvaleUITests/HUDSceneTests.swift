// Every HUD element of the inventory (maps/audio-ui.md 5.4) appears when the state calls for it and only
// then, driven by a real `Game` where the sim can produce the state; and the Metal pass draws it.
import AppKit
import Foundation
import IronvaleMapData
@testable import IronvaleSim
import IronvaleWorld
import Metal
import Testing
@testable import IronvaleUI

enum HUDTestSupport {
    static let font = try! MSDFFont.load(directory: HUDFixtures.resources)
    static let layout = try! MinimapLayout.load(directory: HUDFixtures.resources, mapId: "railyard")

    /// A busy frame: every element that can show at once.
    static func busyState() -> HUDState {
        var s = HUDState()
        s.visible = true
        s.width = 1440
        s.height = 900
        s.now = 30
        s.health = 22
        s.magazine = 0
        s.reserve = 90
        s.weaponName = "M4A1"
        s.fireMode = "auto"
        s.reloading = true
        s.grenades = 1
        s.enemiesRemaining = 6
        s.livesRemaining = 2
        s.wave = 3
        s.rules = .survival
        s.coop = true
        s.net = HUDState.Net(localName: "Ada", peerName: "Sam", countdown: 2, notice: "Sam has switched away from the game")
        s.chatEnabled = true
        s.chatLines = [.init(name: "Sam", text: "left side, two of them by the crane", mine: false), .init(name: "Ada", text: "on it", mine: true)]
        s.enemies = [.init(id: 5, position: SIMD3(10, 0, -12)), .init(id: 6, position: SIMD3(-80, 4, 3))]
        s.partner = .init(id: 2, position: SIMD3(-3, 0, 6))
        s.position = SIMD3(0, 0, 0)
        s.perfVisible = true
        s.perfText = "8.3 ms  120 fps  scale 1.00  Metal"
        s.enemyBars = [(700, 380, 64)]
        return s
    }

    static func busyTracker(wall: Double) -> HUDTracker {
        let t = HUDTracker()
        t.playerHit(targetId: 5, fatal: false, showMarker: true, wall: wall - 0.05, match: 29.9)
        t.hurt(dx: 1, dz: 0, yaw: 0, wall: wall - 0.2)
        t.weaponSwitched(name: "M4A1", weaponClass: "rifle", wall: wall - 0.3)
        t.died(victimId: 9, killerId: 1, playerId: 1, killer: "You", victim: "Bot 3", weaponName: "M4A1", headshot: true, distance: 72, match: 29.5,
               wall: wall - 0.4)
        t.shot(shooterId: 5, muzzle: SIMD3(10, 1.5, -12), match: 29.8)
        return t
    }
}

@MainActor
@Suite struct HUDLayoutChecks {
    @Test func aBusyFrameDrawsEveryElement() {
        let wall = 100.0
        let tracker = HUDTestSupport.busyTracker(wall: wall)
        // Feed rows fade in over 200 ms from when they first show.
        _ = HUDScene.build(state: HUDTestSupport.busyState(), tracker: tracker, font: HUDTestSupport.font, layout: HUDTestSupport.layout, wall: wall - 0.3)
        let scene = HUDScene.build(state: HUDTestSupport.busyState(), tracker: tracker, font: HUDTestSupport.font,
                                   layout: HUDTestSupport.layout, wall: wall)
        let c = scene.canvas
        for element: HUDElement in [.status, .net, .minimap, .chat, .feed, .health, .ammo, .grenade, .hitMarker, .damageArcs, .reload, .toast,
                                    .vignette, .perf, .killNote, .enemyBars] {
            #expect(c.has(element), "\(element) missing")
        }
        #expect(c.text(of: .status) == ["Enemies", "6", "Wave", "3"])
        #expect(c.text(of: .net) == ["Starting in", "2", "Sam has switched away from the game"])
        #expect(c.text(of: .feed) == ["Bot 3", "M4A1, headshot", "You"])
        #expect(c.text(of: .health) == ["Health", "22"])
        #expect(c.text(of: .ammo) == ["M4A1 · Auto", "90", "/", "0"])
        #expect(c.text(of: .grenade) == ["Hold G", "1", "Grenade"])
        #expect(c.text(of: .toast) == ["M4A1", "Rifle"])
        #expect(c.text(of: .killNote) == ["Enemy down · Headshot · 72 m"])
        #expect(c.text(of: .reload) == ["Reloading"])
        #expect(c.text(of: .chat).contains("T  Chat") && c.text(of: .chat).contains("Sam"))
        #expect(scene.saturation < 1 && scene.saturation > 0.3)
        // Low health and an empty magazine take the warning colour.
        #expect(!c.has(.death) && !c.has(.scope))
    }

    @Test func crosshairFollowsAimScopeDeathAndTheSetting() {
        func crosshair(_ change: (inout HUDState, HUDTracker) -> Void) -> Bool {
            var s = HUDState()
            s.visible = true
            s.health = 100
            let t = HUDTracker()
            change(&s, t)
            return HUDScene.build(state: s, tracker: t, font: HUDTestSupport.font, layout: nil, wall: 1).canvas.has(.crosshair)
        }
        #expect(crosshair { _, _ in })
        #expect(!crosshair { _, t in t.aimChanged(true) })
        #expect(!crosshair { s, _ in s.scopedIn = true })
        #expect(!crosshair { s, _ in s.health = 0 })
        #expect(!crosshair { s, _ in s.crosshairSetting = false })
    }

    @Test func scopeDeathAndTheFiguresFollowTheRules() {
        var s = HUDState()
        s.visible = true
        s.scopedIn = true
        let t = HUDTracker()
        var scene = HUDScene.build(state: s, tracker: t, font: HUDTestSupport.font, layout: HUDTestSupport.layout, wall: 1)
        #expect(scene.canvas.has(.scope))
        s.minimapSetting = false
        scene = HUDScene.build(state: s, tracker: t, font: HUDTestSupport.font, layout: HUDTestSupport.layout, wall: 1)
        #expect(!scene.canvas.has(.minimap) && !scene.minimapVisible)

        // Dead in Skirmish: the panel, the dim, no scope.
        s.health = 0
        s.livesRemaining = 2
        s.now = 10
        t.died(victimId: 1, killerId: 4, playerId: 1, killer: "Bot 4", victim: "You", weaponName: "MP5", headshot: false, distance: 0, match: 10, wall: 1)
        _ = HUDScene.build(state: s, tracker: t, font: HUDTestSupport.font, layout: nil, wall: 1)
        scene = HUDScene.build(state: s, tracker: t, font: HUDTestSupport.font, layout: nil, wall: 1.3)
        #expect(scene.canvas.text(of: .death) == ["You were hit", "Bot 4, MP5", "2 lives left · back in 3"])
        #expect(!scene.canvas.has(.scope))
        s.now = 12.2
        scene = HUDScene.build(state: s, tracker: t, font: HUDTestSupport.font, layout: nil, wall: 2)
        #expect(scene.canvas.text(of: .death).last == "2 lives left · back in 1")
        #expect(scene.dim > 0.45)

        var duel = HUDState()
        duel.rules = .duel
        duel.duel = true
        duel.net = HUDState.Net(localName: "Ada", peerName: "Sam", peerKills: 4, killTarget: 10)
        duel.kills = 7
        #expect(HUDScene.deathNext(duel, diedAt: 0, delay: 3) == "Back in 3")
        duel.visible = true
        scene = HUDScene.build(state: duel, tracker: HUDTracker(), font: HUDTestSupport.font, layout: nil, wall: 1)
        #expect(scene.canvas.text(of: .status) == ["Ada", "7", "Sam", "4", "First to", "10"])
        var skirmish = HUDState()
        skirmish.livesRemaining = 0
        #expect(HUDScene.deathNext(skirmish, diedAt: 0, delay: 3) == "No lives left")
        skirmish.rules = .survival
        #expect(HUDScene.deathNext(skirmish, diedAt: 0, delay: 3) == "")
        skirmish.coop = true
        skirmish.net = HUDState.Net(localName: "Ada", peerName: "Sam")
        #expect(HUDScene.deathNext(skirmish, diedAt: 0, delay: 3) == "Back when the next wave starts")
    }

    @Test func damageArcsMergeAndExpire() {
        let t = HUDTracker()
        t.hurt(dx: 1, dz: 0, yaw: 0, wall: 0)
        t.hurt(dx: 1, dz: 0.1, yaw: 0, wall: 0.1)
        #expect(t.arcs.filter { $0.until > 0.2 }.count == 1)
        t.hurt(dx: -1, dz: 0, yaw: 0, wall: 0.2)
        t.hurt(dx: 0, dz: 1, yaw: 0, wall: 0.3)
        t.hurt(dx: 0, dz: -1, yaw: 0, wall: 0.4)
        #expect(t.arcs.filter { $0.until > 0.5 }.count == 3)
        var s = HUDState()
        s.visible = true
        #expect(!HUDScene.build(state: s, tracker: t, font: HUDTestSupport.font, layout: nil, wall: 3).canvas.has(.damageArcs))
    }

    @Test func hudFollowsTheBreakpoints() {
        #expect(HUDScene.em(width: 1280, height: 800) == 16)
        #expect(HUDScene.em(width: 1600, height: 900) == 18)
        #expect(HUDScene.em(width: 2560, height: 1440) == 20)
        #expect(HUDScene.em(width: 3008, height: 1692) == 24)
        #expect(HUDScene.em(width: 700, height: 1000) == 14)
        #expect(HUDScene.minimapSize(height: 500) == 120 && HUDScene.minimapSize(height: 700) == 148)
        #expect(HUDScene.minimapSize(height: 900) == 180 && HUDScene.minimapSize(height: 1300) == 216)
    }

    @Test func hiddenHudDrawsNothing() {
        let scene = HUDScene.build(state: HUDState(), tracker: HUDTracker(), font: HUDTestSupport.font, layout: nil, wall: 0)
        #expect(scene.canvas.items.isEmpty)
    }
}

/// The HUD driven by a real match: the sim's state and events reach every element they feed.
@MainActor
@Suite struct GameDrivenHUD {
    @Test func aMatchFeedsTheHUD() throws {
        let data = SimData.shared
        let packages = data.contract.directory.deletingLastPathComponent().appending(path: "MapPackages")
        let package = try MapPackage.load(directory: packages.appending(path: "range"))
        let settings = PlayerSettings.defaults("mouse")
        let input = BoundInput(settings: settings)
        let game = Game(input: input, settings: settings)
        let hud = GameHUD(game: game)
        var wall = 50.0
        hud.clock = { wall }
        func frame(advance: Double) -> HUDScene {
            wall += advance
            game.frame(1.0 / 60)
            return HUDScene.build(state: hud.state(settings: Settings.defaults, width: 1280, height: 800, pointScale: 2), tracker: hud.tracker,
                                  font: HUDTestSupport.font, layout: nil, wall: wall)
        }
        game.start(map: package, config: MatchConfig(mapId: "range", mode: .skirmish, difficulty: "regular", botCount: 0))
        hud.matchStarted()
        game.frame(1.0 / 60)
        let ui = Settings.defaults
        var state = hud.state(settings: ui, width: 1280, height: 800, pointScale: 2)
        #expect(state.visible && state.health == 100)
        #expect(state.weaponName == game.weapons.current.def.name && state.magazine == game.weapons.current.def.magazineSize)
        #expect(state.livesRemaining == game.snapshot.livesRemaining && state.grenades == game.snapshot.grenades)
        #expect(state.grenadeKey == "G")
        var scene = HUDScene.build(state: state, tracker: hud.tracker, font: HUDTestSupport.font, layout: nil, wall: wall)
        #expect(scene.canvas.has(.crosshair) && scene.canvas.has(.health) && scene.canvas.has(.ammo) && scene.canvas.has(.status))

        // Hurt from the right: health, the arc, the vignette (it fades in over 300 ms).
        let player = game.player
        player.applyDamage(DamageInfo(amount: 70, zone: .torso, attackerId: 999, weaponId: "m4a1", point: player.position,
                                      direction: Vec3(-1, 0, 0)))
        _ = frame(advance: 0)
        scene = frame(advance: 0.4)
        #expect(hud.state(settings: ui, width: 1280, height: 800, pointScale: 2).health == 30)
        #expect(scene.canvas.has(.damageArcs) && scene.canvas.has(.vignette))
        #expect(scene.canvas.text(of: .health) == ["Health", "30"])

        // A kill by the player reaches the feed and the kill note.
        game.events.emit(.died(victimId: 4242, killerId: player.id, weaponId: "m4a1", headshot: false))
        _ = frame(advance: 0)
        scene = frame(advance: 0.3)
        #expect(scene.canvas.text(of: .feed) == ["Unknown", "M4A1", "You"])
        #expect(scene.canvas.text(of: .killNote) == ["Enemy down"])

        // Killed: the death panel with its countdown.
        player.applyDamage(DamageInfo(amount: 100, zone: .torso, attackerId: 999, weaponId: "m4a1", point: player.position, direction: Vec3(0, 0, 1)))
        _ = frame(advance: 0)
        scene = frame(advance: 0.3)
        #expect(scene.canvas.text(of: .death).first == "You were hit")
        #expect(scene.canvas.text(of: .death).last?.hasSuffix("back in 3") == true, "\(scene.canvas.text(of: .death))")
        #expect(!scene.canvas.has(.crosshair))
    }
}

/// The Metal pass, compiled from IronvaleApp/Shaders/Hud.metal, drawing a busy frame over a grey scene.
@MainActor
@Suite struct HUDRendering {
    static let shaderURL = HUDFixtures.native.appending(path: "IronvaleApp/Shaders/Hud.metal")

    @Test func drawsOverTheFrame() throws {
        let device = try #require(MTLCreateSystemDefaultDevice())
        let library = try device.makeLibrary(source: String(contentsOf: Self.shaderURL, encoding: .utf8), options: nil)
        let renderer = try HUDRenderer(device: device, library: library, colorFormat: .bgra8Unorm, resources: HUDFixtures.resources)
        renderer.setMap("railyard")
        #expect(renderer.layout != nil)
        let w = 1440, h = 900, scale = 2.0
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: Int(Double(w) * scale), height: Int(Double(h) * scale),
                                                                  mipmapped: false)
        descriptor.usage = [.renderTarget, .shaderRead]
        descriptor.storageMode = .shared
        let target = try #require(device.makeTexture(descriptor: descriptor))
        let queue = try #require(device.makeCommandQueue())

        func render(_ state: HUDState, _ tracker: HUDTracker, wall: Double) throws -> [UInt8] {
            let commands = try #require(queue.makeCommandBuffer())
            let clear = MTLRenderPassDescriptor()
            clear.colorAttachments[0].texture = target
            clear.colorAttachments[0].loadAction = .clear
            clear.colorAttachments[0].clearColor = MTLClearColor(red: 0.45, green: 0.5, blue: 0.4, alpha: 1)
            clear.colorAttachments[0].storeAction = .store
            commands.makeRenderCommandEncoder(descriptor: clear)?.endEncoding()
            let scene = HUDScene.build(state: state, tracker: tracker, font: renderer.font, layout: renderer.layout, wall: wall)
            renderer.encode(commandBuffer: commands, target: target, scene: scene, viewport: (Double(w), Double(h)))
            commands.commit()
            commands.waitUntilCompleted()
            if let error = commands.error { throw error }
            var pixels = [UInt8](repeating: 0, count: target.width * target.height * 4)
            target.getBytes(&pixels, bytesPerRow: target.width * 4, from: MTLRegionMake2D(0, 0, target.width, target.height), mipmapLevel: 0)
            return pixels
        }
        func pixel(_ p: [UInt8], _ x: Double, _ y: Double) -> (r: Int, g: Int, b: Int) {
            let i = (Int(y * scale) * target.width + Int(x * scale)) * 4
            return (Int(p[i + 2]), Int(p[i + 1]), Int(p[i]))
        }

        var state = HUDTestSupport.busyState()
        state.pointScale = scale
        let tracker = HUDTestSupport.busyTracker(wall: 100)
        _ = HUDScene.build(state: state, tracker: tracker, font: renderer.font, layout: renderer.layout, wall: 99.7)
        let busy = try render(state, tracker, wall: 100)
        // Desaturated and vignetted edges are darker and redder than the grey; the centre keeps its grey but loses saturation.
        let corner = pixel(busy, 2, 2)
        #expect(corner.r > corner.g && corner.g < 100, "corner \(corner)")
        let centreish = pixel(busy, 400, 300)
        #expect(abs(centreish.r - centreish.g) < 20, "grade \(centreish)")
        // Bright ink in the health figure's digits, and the minimap's dark disc in the top right.
        let lit = (0..<60).flatMap { dx in (0..<40).map { dy in pixel(busy, 24 + Double(dx), 900 - 70 + Double(dy)) } }.filter { $0.r > 200 }
        #expect(lit.count > 20, "health digits")
        let map = pixel(busy, 1440 - 24 - 90 - 60, 24 + 90 + 50)
        #expect(map.r < 120, "minimap \(map)")

        // Scoped in: the corners go to the tube's black and the wire crosses the centre.
        var scoped = HUDState()
        scoped.visible = true
        scoped.scopedIn = true
        scoped.pointScale = scale
        scoped.width = Double(w)
        scoped.height = Double(h)
        scoped.minimapSetting = false
        let lens = try render(scoped, HUDTracker(), wall: 1)
        #expect(pixel(lens, 10, 10).r < 8)
        let wire = pixel(lens, 720 + 60, 450)
        #expect(wire.r < 20, "wire \(wire)")
        #expect(pixel(lens, 720 + 60, 450 - 60).g > 100)

        if let dir = ProcessInfo.processInfo.environment["IV_HUD_SNAPSHOTS"] {
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            for (name, pixels) in [("hud-busy", busy), ("hud-scope", lens)] {
                try writePNG(pixels, width: target.width, height: target.height, to: URL(fileURLWithPath: dir).appending(path: "\(name).png"))
            }
        }
    }

    private func writePNG(_ bgra: [UInt8], width: Int, height: Int, to url: URL) throws {
        var rgba = bgra
        for i in stride(from: 0, to: rgba.count, by: 4) { rgba.swapAt(i, i + 2) }
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                   isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: width * 4, bitsPerPixel: 32)!
        rgba.withUnsafeBytes { rep.bitmapData!.update(from: $0.bindMemory(to: UInt8.self).baseAddress!, count: rgba.count) }
        try rep.representation(using: .png, properties: [:])!.write(to: url)
    }
}

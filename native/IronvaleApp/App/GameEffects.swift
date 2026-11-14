// M9 effects in a match (src/game/game.ts: createEffects, effects.enterMap / update / leaveMap): the
// IronvaleFX Effects listen to the game's EventBus, step once a frame while the match simulates, and
// draw through an FXLayer inside the map renderer's passes. The muzzle-flash lights join the scene's
// lights, and the blast shake is added to the camera pose the frame renders with.
import Foundation
import IronvaleContract
import IronvaleFX
import IronvaleMapData
import IronvaleMapRender
import IronvaleRender
import IronvaleSim
import Metal
import ShaderTypes
import os

@MainActor
final class GameEffects {
    private static let logger = Logger(subsystem: "dev.n3el.ironvale", category: "fx")
    let effects: Effects
    let layer: FXLayer
    private var flights: [GrenadeView] = []
    private var lights: [IVLight] = []
    private var unsubscribe: (() -> Void)?

    /// nil (logged) when the effect atlases are missing: the match plays without effects.
    static func make(game: Game, renderer: MapRenderer, device: any MTLDevice, library: any MTLLibrary,
                     repositoryRoot: URL, contract: Contract) -> GameEffects? {
        guard let map = game.map else { return nil }
        do {
            return try GameEffects(game: game, map: map, renderer: renderer, device: device, library: library,
                                   repositoryRoot: repositoryRoot, contract: contract)
        } catch {
            logger.error("Effects unavailable: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    private init(game: Game, map: MapPackage, renderer: MapRenderer, device: any MTLDevice, library: any MTLLibrary,
                 repositoryRoot: URL, contract: Contract) throws {
        effects = Effects(weapons: Effects.weapons(from: contract.weapons), grenades: GrenadeMath(),
                          particleDensity: FXQuality.high.particleDensity, detailDensity: FXQuality.high.detailDensity,
                          random: FXRandom(seed: UInt32.random(in: 1...UInt32.max)))
        layer = try FXLayer(effects: effects, device: device, library: library,
                            atlasDirectory: repositoryRoot.appending(path: "native/BakedAssets/fx"),
                            colorFormats: renderer.postChain != nil ? MapRenderer.sceneColorFormats : [.rgba16Float])
        flights.reserveCapacity(GrenadeFx.bodyCount)
        lights.reserveCapacity(4)
        let meta = map.meta
        let l = meta.lighting
        effects.env.player.id = game.player.id
        sync(game)
        effects.enterMap(lighting: FXLighting(sunDirection: D3(l.sunDirection), sunColor: l.sunColor, sunIntensity: l.sunIntensity,
                                              skyIntensity: l.skyIntensity, fogColor: l.fog.color),
                         weather: Weather(rawValue: meta.weather) ?? .clear,
                         interiors: meta.interiors.map { FXBox(min: D3($0.min), max: D3($0.max)) }, world: map.world)
        let effects = self.effects
        unsubscribe = game.events.on { event in effects.handle(event) }
        renderer.layers.append(layer)
    }

    func stop() {
        unsubscribe?()
        unsubscribe = nil
        effects.leaveMap()
    }

    private func sync(_ game: Game) {
        let camera = game.player.camera
        effects.env.camera = FXCamera(position: D3(camera.position), yaw: camera.yaw, pitch: camera.pitch, roll: camera.roll)
        let p = game.player
        effects.env.player.position = D3(p.position)
        effects.env.player.yaw = p.yaw
        effects.env.player.indoors = p.indoors
        effects.env.player.alive = p.alive
    }

    /// One frame (game.ts: effects.update while the match simulates); returns `pose` with the blast shake.
    func frame(_ dt: Double, game: Game, renderer: MapRenderer, pose: CameraPose) -> CameraPose {
        sync(game)
        if game.phase == .playing {
            flights.removeAll(keepingCapacity: true)
            for f in game.grenades.flights.prefix(GrenadeFx.bodyCount) {
                flights.append(GrenadeView(active: f.active, position: D3(f.drawPosition), speed: f.body.velocity.length, resting: f.body.resting))
            }
            let hand = game.weapons.grenade
            let aim = hand.aiming ? (origin: D3(hand.origin), velocity: D3(hand.velocity)) : nil
            flights.withUnsafeBufferPointer { effects.update(dt, flights: $0, aim: aim) }
        }
        layer.flashLights(into: &lights)
        renderer.transientLights = lights
        let s = effects.grenade.shakeOffset
        var out = pose
        out.pitch += Float(s.x)
        out.yaw += Float(s.y)
        out.roll += Float(s.z)
        out.eye.y -= Float(s.drop)
        return out
    }
}

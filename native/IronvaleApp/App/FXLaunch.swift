// M9 effects launch switches for the map renderer's capture and benchmark modes (check-m9fx.sh):
//   --fx                draw the effects layer (IronvaleFX): the map's weather (rain, mist, motes)
//   --fx-events PATH    with --fx: replay the combat events the web capture resolved and emitted
//                       (native/Tools/fx-parity/capture-web.mjs, <map>-<pose>.events.json) with the same
//                       effect random seed; the capture fails when the draws differ from the web's
//   --fx-bench FRAMES   with --map and --pose: a 16-bot scripted firefight (IronvaleFX Firefight) in front
//                       of the pose, FRAMES frame pairs offscreen at --internal size, one with the effects
//                       drawn and one without, alternating; prints the GPU time of each
//   --bench-json PATH   with --fx-bench: write the result as JSON
//   --bench-png PATH    with --fx-bench: also write the last frame with the effects as PNG (to look at)
// --q TIER picks the particle and detail densities, as the web's ?q= does (default high).
import Foundation
import IronvaleContract
import IronvaleFX
import IronvaleSim
import IronvaleMapData
import IronvaleMapRender
import IronvaleRender
import IronvaleWorld
import Metal
import ShaderTypes

@MainActor
struct FXLaunch {
    var eventsPath: String?
    var benchFrames: Int?
    var benchJSON: String?
    var benchPNG: String?
    var quality = FXQuality.high

    static func parse(_ arguments: some Sequence<String>) -> FXLaunch? {
        var on = false
        var launch = FXLaunch()
        var it = arguments.makeIterator()
        while let arg = it.next() {
            switch arg {
            case "--fx": on = true
            case "--fx-events": on = true; launch.eventsPath = it.next()
            case "--fx-bench": on = true; launch.benchFrames = it.next().flatMap(Int.init)
            case "--bench-json": launch.benchJSON = it.next()
            case "--bench-png": launch.benchPNG = it.next()
            case "--q": launch.quality = it.next().flatMap(FXQuality.init(rawValue:)) ?? .high
            default: continue
            }
        }
        return on ? launch : nil
    }

    enum LaunchError: Error, CustomStringConvertible {
        case badEvents(String)
        case drawsDiffer(web: Int, native: Int)
        var description: String {
            switch self {
            case .badEvents(let why): "--fx-events: \(why)"
            case .drawsDiffer(let web, let native): "--fx-events: the web drew \(web) effect random numbers, native \(native)"
            }
        }
    }

    /// Builds the effects for `renderer`'s map at `pose`, replays the events file if given, and adds the layer.
    func attach(to renderer: MapRenderer, pose: CameraPose, repositoryRoot: URL, device: any MTLDevice,
                library: any MTLLibrary) throws -> FXLayer {
        let contract = try Contract.load()
        let package = try MapPackage.load(directory: renderer.assets.package)
        let meta = package.meta
        let effects = Effects(weapons: Effects.weapons(from: contract.weapons), grenades: GrenadeMath(),
                              particleDensity: quality.particleDensity, detailDensity: quality.detailDensity)
        effects.frozen = renderer.visualsFrozen
        let eye = D3(Double(pose.eye.x), Double(pose.eye.y), Double(pose.eye.z))
        effects.env.camera = FXCamera(position: eye, yaw: Double(pose.yaw), pitch: Double(pose.pitch))
        let interiors = meta.interiors.map { FXBox(min: D3($0.min), max: D3($0.max)) }
        effects.env.player = FXPlayer(id: 0, position: D3(eye.x, eye.y - Double(CameraPose.standEye), eye.z), yaw: Double(pose.yaw),
                                      indoors: interiors.contains { eye.x >= $0.min.x && eye.x <= $0.max.x && eye.y >= $0.min.y
                                          && eye.y <= $0.max.y && eye.z >= $0.min.z && eye.z <= $0.max.z })
        let l = meta.lighting
        effects.enterMap(lighting: FXLighting(sunDirection: D3(l.sunDirection), sunColor: l.sunColor, sunIntensity: l.sunIntensity,
                                              skyIntensity: l.skyIntensity, fogColor: l.fog.color),
                         weather: Weather(rawValue: meta.weather) ?? .clear, interiors: interiors, world: package.world)
        if let eventsPath { try replay(eventsPath, into: effects) }
        // The web runs a few frames before its screenshot; under --freeze they step the effects by 0.
        for _ in 0..<3 { effects.update(1.0 / 60) }
        let layer = try FXLayer(effects: effects, device: device, library: library,
                                atlasDirectory: repositoryRoot.appending(path: "native/BakedAssets/fx"),
                                colorFormats: renderer.postChain != nil ? MapRenderer.sceneColorFormats : [.rgba16Float])
        layer.flashLights(into: &renderer.transientLights)
        renderer.layers.append(layer)
        return layer
    }

    /// The pose with this frame's blast shake added (grenade.ts applyShake: the camera's YXZ Euler
    /// angles += (x, y, z), its height -= drop), as the web renders it.
    static func shaken(_ pose: CameraPose, by layer: FXLayer) -> CameraPose {
        let s = layer.effects.grenade.shakeOffset
        var out = pose
        out.pitch += Float(s.x)
        out.yaw += Float(s.y)
        out.roll += Float(s.z)
        out.eye.y -= Float(s.drop)
        return out
    }

    private func replay(_ path: String, into effects: Effects) throws {
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any] ?? [:]
        guard let seed = json["seed"] as? NSNumber, let draws = json["draws"] as? NSNumber, let events = json["events"] as? [[String: Any]] else {
            throw LaunchError.badEvents("expected {seed, draws, events}")
        }
        let weapons = Effects.weapons(from: try Contract.load().weapons)
        func v(_ any: Any?) throws -> D3 {
            guard let a = any as? [NSNumber], a.count == 3 else { throw LaunchError.badEvents("bad vector \(String(describing: any))") }
            return D3(a[0].doubleValue, a[1].doubleValue, a[2].doubleValue)
        }
        effects.env.random.reseed(seed.uint32Value)
        for e in events {
            let weapon = (e["weapon"] as? [String: Any])?["id"] as? String
            let w = weapon.flatMap { weapons[$0] }
            switch e["type"] as? String {
            case "shotFired": effects.shotFired(weapon: w!, muzzle: try v(e["a"]), direction: try v(e["b"]), local: false)
            case "bulletTrace": effects.bulletTrace(weapon: w!, from: try v(e["a"]), to: try v(e["b"]), local: false)
            case "bulletImpact":
                guard let surface = Surface.allCases.first(where: { $0.name == e["surface"] as? String }) else {
                    throw LaunchError.badEvents("unknown surface \(String(describing: e["surface"]))")
                }
                effects.bulletImpact(weapon: w!, point: try v(e["a"]), normal: try v(e["normal"]), surface: surface)
            case "casingEjected":
                effects.casingEjected(kind: CasingKind(rawValue: e["kind"] as? String ?? "rifle") ?? .rifle, position: try v(e["a"]), velocity: try v(e["b"]))
            case "grenadeExploded": effects.grenadeExploded(position: try v(e["a"]))
            default: throw LaunchError.badEvents("unknown event \(e)")
            }
        }
        guard effects.env.random.draws == draws.intValue else { throw LaunchError.drawsDiffer(web: draws.intValue, native: effects.env.random.draws) }
    }

    /// Alternating frames with and without the effects drawn, during a 16-bot firefight; GPU ms of each.
    func bench(renderer: MapRenderer, layer: FXLayer, pose: CameraPose, device: any MTLDevice) throws {
        let frames = max(1, benchFrames ?? 600)
        let effects = layer.effects
        effects.frozen = false
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: renderer.settings.internalWidth,
                                                                  height: renderer.settings.internalHeight, mipmapped: false)
        descriptor.usage = [.renderTarget, .shaderWrite]
        descriptor.storageMode = .private
        guard let output = device.makeTexture(descriptor: descriptor), let queue = device.makeCommandQueue() else {
            throw AppError.noMetalDevice
        }
        // The fight is centred on the ground 9 m in front of the eye, in view, so its effects fill the screen.
        let forward = pose.forward
        var centre = D3(Double(pose.eye.x + forward.x * 9), Double(pose.eye.y) - Double(CameraPose.standEye), Double(pose.eye.z + forward.z * 9))
        if let world = effects.env.world, let g = world.groundHeight(x: centre.x, z: centre.z, fromY: centre.y + 4, maxDrop: 12) { centre.y = g }
        let weapons = Effects.weapons(from: try Contract.load().weapons).sorted { $0.key < $1.key }.map(\.value)
        let fight = Firefight(centre: centre, bots: 16, radius: 7, weapons: weapons, world: effects.env.world)
        let dt = 1.0 / 120
        var time = 0.0
        var lights: [IVLight] = []
        lights.reserveCapacity(4)
        func run(_ visible: Bool) throws -> Double {
            fight.step(dt, effects)
            effects.update(dt)
            layer.hidden = !visible
            if visible { layer.flashLights(into: &lights) } else { lights.removeAll(keepingCapacity: true) }
            renderer.transientLights = lights
            guard let commands = queue.makeCommandBuffer() else { throw AppError.noMetalDevice }
            renderer.encode(commandBuffer: commands, pose: pose, time: time, output: output)
            commands.commit()
            commands.waitUntilCompleted()
            if let error = commands.error { throw error }
            time += dt
            return (commands.gpuEndTime - commands.gpuStartTime) * 1000
        }
        // Two seconds of fighting first, so the pools, decals and casings are in their steady state.
        for _ in 0..<120 { _ = try run(true); _ = try run(false) }
        var with: [Double] = [], without: [Double] = [], pairs: [Double] = []
        for i in 0..<frames {
            let a: Double, b: Double
            if i % 2 == 0 { a = try run(true); b = try run(false) } else { b = try run(false); a = try run(true) }
            with.append(a)
            without.append(b)
            pairs.append(a - b)
        }
        layer.hidden = false
        if let path = benchPNG {
            let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: output.width, height: output.height, mipmapped: false)
            d.usage = [.renderTarget, .shaderWrite]
            d.storageMode = .shared
            guard let shot = device.makeTexture(descriptor: d), let commands = queue.makeCommandBuffer() else { throw AppError.noMetalDevice }
            fight.step(dt, effects)
            effects.update(dt)
            layer.flashLights(into: &lights)
            renderer.transientLights = lights
            renderer.encode(commandBuffer: commands, pose: pose, time: time, output: shot)
            commands.commit()
            commands.waitUntilCompleted()
            try TextureCapture.writePNG(shot, to: URL(fileURLWithPath: path))
        }
        func quantile(_ v: [Double], _ q: Double) -> Double { let s = v.sorted(); return s[Int(Double(s.count - 1) * q)] }
        func mean(_ v: [Double]) -> Double { v.reduce(0, +) / Double(v.count) }
        let result: [String: Any] = [
            "frames": frames, "bots": 16, "width": renderer.settings.internalWidth, "height": renderer.settings.internalHeight,
            "quality": quality.rawValue,
            "withMedianMs": quantile(with, 0.5), "withoutMedianMs": quantile(without, 0.5),
            "withMeanMs": mean(with), "withoutMeanMs": mean(without),
            "pairDifferenceMedianMs": quantile(pairs, 0.5), "pairDifferenceMeanMs": mean(pairs),
            "pairDifferenceP10Ms": quantile(pairs, 0.1), "pairDifferenceP90Ms": quantile(pairs, 0.9),
            "medianDifferenceMs": quantile(with, 0.5) - quantile(without, 0.5),
            "randomDraws": effects.env.random.draws,
        ]
        print(String(format: "fx bench 16 bots at %dx%d: GPU median with %.3f ms, without %.3f ms; paired difference median %.3f ms, mean %.3f ms (p10 %.3f, p90 %.3f)",
                     renderer.settings.internalWidth, renderer.settings.internalHeight, quantile(with, 0.5), quantile(without, 0.5),
                     quantile(pairs, 0.5), mean(pairs), quantile(pairs, 0.1), quantile(pairs, 0.9)))
        if let path = benchJSON {
            let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: URL(fileURLWithPath: path))
        }
    }
}

// M7a exit measurement (PLAN.md 7): "32 soldiers on screen cost under 2 ms GPU". Renders a crowd of
// animated soldiers (walking, running, crouching, aiming, firing, reloading, flinching, dying and
// getting up) offscreen at the M3 internal size (2560x1600) with a 4096 sun shadow map and the
// map's real lighting (environment from its HDR, sun, fog). Each frame is one command buffer holding
// only the soldier work: the shadow pass and the scene pass, so its GPU time is what the soldiers
// cost (attachment clears included, which makes it an upper bound). CPU posing time is logged too.
//
// Launch: Ironvale --soldier-bench SECONDS [--soldiers 32] [--map railyard] [--bench-json PATH]
//                  [--gpu-log PATH] [--capture PATH]
import Foundation
import IronvaleMapData
import IronvaleRender
import Metal
import QuartzCore
import ShaderTypes
import Synchronization
import simd

@MainActor
public enum SoldierBenchmark {
    public struct Options: Sendable, Equatable {
        public var seconds: Double
        public var soldiers = 32
        public var mapId = "railyard"
        public var jsonPath: String?
        public var gpuLogPath: String?
        public var capturePath: String?
        public var width = 2560
        public var height = 1600
        public var shadowMapSize = 4096

        /// nil unless `--soldier-bench` is present.
        public static func parse(_ arguments: some Sequence<String>) -> Options? {
            var options: Options?
            var it = arguments.makeIterator()
            var pending: [(String, String)] = []
            while let arg = it.next() {
                switch arg {
                case "--soldier-bench": options = Options(seconds: it.next().flatMap(Double.init) ?? 10)
                case "--soldiers", "--map", "--bench-json", "--gpu-log", "--capture":
                    if let value = it.next() { pending.append((arg, value)) }
                default: continue
                }
            }
            guard var o = options else { return nil }
            for (key, value) in pending {
                switch key {
                case "--soldiers": o.soldiers = max(1, Int(value) ?? o.soldiers)
                case "--map": o.mapId = value
                case "--bench-json": o.jsonPath = value
                case "--gpu-log": o.gpuLogPath = value
                case "--capture": o.capturePath = value
                default: break
                }
            }
            return o
        }
    }

    public struct Result: Sendable, Codable {
        public var soldiers: Int
        public var frames: Int
        public var seconds: Double
        public var width: Int
        public var height: Int
        public var shadowMapSize: Int
        public var drawnPerFrameMin: Int
        public var gpuMs: Percentiles
        public var cpuMs: Percentiles
        public var posesPerFrame: Double
        public var device: String
    }

    public struct Percentiles: Sendable, Codable {
        public var mean: Double
        public var p50: Double
        public var p95: Double
        public var p99: Double
        public var max: Double

        init(_ values: [Double]) {
            let s = values.sorted()
            func at(_ q: Double) -> Double { s.isEmpty ? .nan : s[min(s.count - 1, Int((Double(s.count - 1) * q).rounded()))] }
            mean = s.isEmpty ? .nan : s.reduce(0, +) / Double(s.count)
            p50 = at(0.5)
            p95 = at(0.95)
            p99 = at(0.99)
            max = s.last ?? .nan
        }
    }

    /// Scripted crowd: four rows in front of the camera, all inside the view.
    static func makeCrowd(rig: SoldierRig, count: Int) -> [Soldier] {
        (0..<count).map { i in
            let soldier = Soldier(rig: rig, team: i % 2 == 0 ? .alpha : .bravo)
            soldier.position = crowdAnchor(i, count: count)
            soldier.yaw = Double(i) * 0.7
            return soldier
        }
    }

    static func crowdAnchor(_ i: Int, count: Int) -> Vec3 {
        let perRow = max(1, Int((Double(count) / 4).rounded(.up)))
        let row = i / perRow, column = i % perRow
        let depth = [5.0, 9.0, 14.0, 21.0][min(row, 3)]
        // Horizontal half-extent of the 78 degree, 16:10 view at this depth, kept inside by 30 percent.
        let half = tan(39 * Double.pi / 180) * 1.6 * depth * 0.7
        let x = perRow == 1 ? 0 : -half + 2 * half * Double(column) / Double(perRow - 1)
        return Vec3(x, 0, -depth)
    }

    /// Drives soldier `i` at time `t`: varied gaits, stances and actions, a death every few seconds.
    static func drive(_ soldier: Soldier, index i: Int, count: Int, time t: Double, dt: Double) {
        let anchor = crowdAnchor(i, count: count)
        let mode = i % 6
        let speeds = [0.0, 1.7, 2.6, 3.4, 5.6, 1.8]
        let speed = speeds[mode]
        let radius = 0.8
        let angle = t * (speed / radius) * (i % 2 == 0 ? 1 : -1) + Double(i)
        let previous = soldier.position
        soldier.position = speed == 0 ? anchor : anchor + Vec3(cos(angle) * radius, 0, sin(angle) * radius)
        let moved = soldier.position - previous
        // Face along the motion for runners, toward the camera for the others (strafing and backpedalling).
        soldier.yaw = mode == 4 && moved.length > 1e-6 ? atan2(-moved.x, -moved.z) : atan2(anchor.x, anchor.z - 2) + 0.4 * sin(t + Double(i))
        let cycle = (t + Double(i) * 0.37).truncatingRemainder(dividingBy: 6)
        soldier.setState(SoldierState(speed: speed, crouching: mode == 5 || (mode == 0 && i % 4 == 0),
                                      aimPitch: 0.3 * sin(t * 0.9 + Double(i)), aiming: mode != 4,
                                      firing: cycle > 2 && cycle < 2.6, reloading: cycle > 3.5 && cycle < 4.8))
        if i % 8 == 7 {
            let life = (t + Double(i)).truncatingRemainder(dividingBy: 7)
            if life < 4.5, soldier.dead { soldier.revive() }
            if life >= 4.5, !soldier.dead { soldier.die(direction: Vec3(sin(t), 0, cos(t))) }
        } else if Int(t * 2 + Double(i)) % 9 == 0, Int((t - dt) * 2 + Double(i)) % 9 != 0 {
            soldier.flinch([HitZone.head, .torso, .limb][i % 3])
        }
        soldier.update(dt)
    }

    public static func run(options: Options, repositoryRoot: URL, lighting: LightingSetup, environmentHDR: URL,
                           device: any MTLDevice, library: any MTLLibrary) throws -> Result {
        guard let queue = device.makeCommandQueue() else { throw RenderError.allocation("benchmark queue") }
        let baked = SoldierRig.bakedDirectory(repositoryRoot: repositoryRoot)
        let rig = try SoldierRig(directory: baked)
        let renderer = try SoldierRenderer(rig: rig, bakedDirectory: baked, device: device, library: library,
                                           maxSoldiers: max(64, options.soldiers))
        let environment = try EnvironmentMap(hdr: RadianceHDR.load(environmentHDR), device: device, library: library, queue: queue)
        let soldiers = makeCrowd(rig: rig, count: options.soldiers)

        func target(_ format: MTLPixelFormat, _ w: Int, _ h: Int, _ label: String, storage: MTLStorageMode = .private) throws -> any MTLTexture {
            let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: w, height: h, mipmapped: false)
            d.usage = [.renderTarget, .shaderRead]
            d.storageMode = storage
            guard let t = device.makeTexture(descriptor: d) else { throw RenderError.allocation(label) }
            t.label = label
            return t
        }
        // One set of targets per frame in flight, so frames do not wait on each other's attachments.
        let sets = try (0..<3).map { _ in
            (color: try target(.rgba16Float, options.width, options.height, "soldier bench colour"),
             depth: try target(.depth32Float, options.width, options.height, "soldier bench depth"),
             shadow: try target(.depth32Float, options.shadowMapSize, options.shadowMapSize, "soldier bench shadow"))
        }

        let sun = simd_normalize(SIMD3<Float>(lighting.sunDirection.map(Float.init)))
        let shadow = SunShadow(sunDirection: sun, mapSize: options.shadowMapSize)
        let pose = CameraPose(eye: SIMD3(0, 1.64, 0), yaw: 0, pitch: -0.08)
        let aspect = Float(options.width) / Float(options.height)
        let projection = RenderMath.perspectiveReverseZ(fovYRadians: 78 * .pi / 180, aspect: aspect, near: 0.04, far: 900)
        let viewProjection = projection * pose.view
        var frameUniforms = IVFrameUniforms(
            viewProjection: viewProjection, view: pose.view, inverseViewProjection: viewProjection.inverse,
            shadowViewProjection: shadow.viewProjection(cameraPosition: pose.eye, forward: pose.forward),
            cameraPosition: pose.eye, time: 0, sunDirection: sun, environmentIntensity: Float(lighting.skyIntensity),
            sunColor: RenderMath.linearFromSRGBHex(lighting.sunColor) * Float(lighting.sunIntensity),
            backgroundIntensity: Float(lighting.skyIntensity), fogColor: RenderMath.linearFromSRGBHex(lighting.fog.color),
            fogDensity: Float(lighting.fog.density), fogSunTint: lighting.fog.sunTint.map(RenderMath.linearFromSRGBHex) ?? .zero,
            fogSunTintStrength: lighting.fog.sunTint == nil ? 0 : Float(lighting.fog.sunTintStrength ?? 0),
            hemiSkyColor: .zero, fogHeightFalloff: Float(lighting.fog.heightFalloff ?? 0), hemiGroundColor: .zero,
            fogBaseHeight: Float(lighting.fog.baseHeight ?? 0), environmentRotation: Float(lighting.hdriRotation),
            environmentMaxLod: environment.maxLod, shadowBias: SunShadow.bias, shadowNormalBias: SunShadow.normalBias,
            shadowTexelWorld: shadow.texelWorld, shadowEnabled: 1, lightCount: 0, _pad0: 0)
        var noLight = IVLight()

        func encode(_ commands: any MTLCommandBuffer, set: Int) {
            let s = sets[set]
            let shadowPass = MTLRenderPassDescriptor()
            shadowPass.depthAttachment.texture = s.shadow
            shadowPass.depthAttachment.loadAction = .clear
            shadowPass.depthAttachment.clearDepth = 1
            shadowPass.depthAttachment.storeAction = .store
            if let e = commands.makeRenderCommandEncoder(descriptor: shadowPass) {
                e.label = "soldier bench shadow"
                e.setDepthClipMode(.clamp)
                e.setVertexBytes(&frameUniforms, length: MemoryLayout<IVFrameUniforms>.stride, index: Int(IV_BUFFER_FRAME))
                renderer.encodeShadow(e)
                e.endEncoding()
            }
            let scene = MTLRenderPassDescriptor()
            scene.colorAttachments[0].texture = s.color
            scene.colorAttachments[0].loadAction = .clear
            scene.colorAttachments[0].clearColor = MTLClearColor(red: 0.05, green: 0.06, blue: 0.07, alpha: 1)
            scene.colorAttachments[0].storeAction = .store
            scene.depthAttachment.texture = s.depth
            scene.depthAttachment.loadAction = .clear
            scene.depthAttachment.clearDepth = 0
            scene.depthAttachment.storeAction = .dontCare
            if let e = commands.makeRenderCommandEncoder(descriptor: scene) {
                e.label = "soldier bench scene"
                e.setVertexBytes(&frameUniforms, length: MemoryLayout<IVFrameUniforms>.stride, index: Int(IV_BUFFER_FRAME))
                e.setFragmentBytes(&frameUniforms, length: MemoryLayout<IVFrameUniforms>.stride, index: Int(IV_BUFFER_FRAME))
                e.setFragmentBytes(&noLight, length: MemoryLayout<IVLight>.stride, index: Int(IV_BUFFER_LIGHTS))
                e.setFragmentTexture(environment.texture, index: Int(IV_TEXTURE_ENVIRONMENT))
                e.setFragmentTexture(s.shadow, index: Int(IV_TEXTURE_SHADOW))
                renderer.encodeScene(e)
                e.endEncoding()
            }
        }

        let inFlight = DispatchSemaphore(value: sets.count)
        let gpu = GPUFrameLog()
        let gpuSamples = Mutex<[Double]>([])
        var cpu: [Double] = []
        var drawnMin = Int.max
        let posesBefore = soldiers.map(\.poseCount).reduce(0, +)
        let start = CACurrentMediaTime()
        var last = start
        var frame = 0
        while CACurrentMediaTime() - start < options.seconds {
            inFlight.wait()
            let now = CACurrentMediaTime()
            let dt = min(0.05, now - last)
            last = now
            let cpuStart = CACurrentMediaTime()
            for (i, soldier) in soldiers.enumerated() { drive(soldier, index: i, count: soldiers.count, time: now - start, dt: dt) }
            renderer.prepare(soldiers: soldiers, viewProjection: viewProjection, eye: pose.eye)
            cpu.append((CACurrentMediaTime() - cpuStart) * 1000)
            drawnMin = min(drawnMin, renderer.stats.drawnBodies)
            frameUniforms.time = Float(now - start)
            guard let commands = queue.makeCommandBuffer() else { inFlight.signal(); throw RenderError.allocation("command buffer") }
            encode(commands, set: frame % sets.count)
            let index = frame
            commands.addCompletedHandler { buffer in
                gpu.record(frame: index, gpuStart: buffer.gpuStartTime, gpuEnd: buffer.gpuEndTime)
                if buffer.gpuEndTime > buffer.gpuStartTime {
                    gpuSamples.withLock { $0.append((buffer.gpuEndTime - buffer.gpuStartTime) * 1000) }
                }
                inFlight.signal()
            }
            commands.commit()
            frame += 1
        }
        for _ in sets { inFlight.wait() }
        for _ in sets { inFlight.signal() }
        let elapsed = CACurrentMediaTime() - start
        let poses = soldiers.map(\.poseCount).reduce(0, +) - posesBefore

        if let path = options.capturePath {
            try capture(path: path, encode: encode, sets: sets, queue: queue, device: device, library: library,
                        exposure: Float(lighting.exposure), width: options.width, height: options.height)
        }
        if let path = options.gpuLogPath { try gpu.write(to: URL(fileURLWithPath: path)) }
        // Skip the first half second: pipeline and texture residency warm-up.
        let warm = max(0, Int(0.5 / max(elapsed / Double(max(frame, 1)), 1e-6)))
        let samples = gpuSamples.withLock { $0 }
        let result = Result(
            soldiers: options.soldiers, frames: frame, seconds: elapsed, width: options.width, height: options.height,
            shadowMapSize: options.shadowMapSize, drawnPerFrameMin: drawnMin == .max ? 0 : drawnMin,
            gpuMs: Percentiles(Array(samples.dropFirst(min(warm, samples.count / 2)))),
            cpuMs: Percentiles(Array(cpu.dropFirst(min(warm, cpu.count / 2)))),
            posesPerFrame: Double(poses) / Double(max(frame, 1)), device: device.name)
        if let path = options.jsonPath {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(result).write(to: URL(fileURLWithPath: path))
        }
        return result
    }

    private static func capture(path: String, encode: (any MTLCommandBuffer, Int) -> Void,
                                sets: [(color: any MTLTexture, depth: any MTLTexture, shadow: any MTLTexture)],
                                queue: any MTLCommandQueue, device: any MTLDevice, library: any MTLLibrary,
                                exposure: Float, width: Int, height: Int) throws {
        let post = try PostPass(device: device, library: library, outputFormat: .bgra8Unorm, exposure: exposure)
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false)
        d.usage = [.renderTarget]
        d.storageMode = .shared
        guard let output = device.makeTexture(descriptor: d), let commands = queue.makeCommandBuffer() else {
            throw RenderError.allocation("capture target")
        }
        encode(commands, 0)
        post.encode(commandBuffer: commands, source: sets[0].color, target: output)
        commands.commit()
        commands.waitUntilCompleted()
        if let error = commands.error { throw error }
        try TextureCapture.writePNG(output, to: URL(fileURLWithPath: path))
    }
}

// M9 view-model launch switches for the map renderer's capture and benchmark modes (check-m9vm.sh):
//   --vm-weapon ID      draw the first-person view model holding weapon ID (m4a1, mp5, m24, m249, m7, scarh)
//   --vm-aim BLEND      aim blend 0 (hip) to 1 (sights); the camera lens zooms as PlayerController does
//   --vm-bench FRAMES   with --map and --pose: render FRAMES frame pairs offscreen at --internal size, one
//                       with the view model and one without, alternating, and print the GPU time of each
//   --bench-json PATH   with --vm-bench: write the result as JSON
// The rig settles for two seconds at the requested aim before the first frame, as the web capture waits
// for the gun to come up (with --freeze the breathing clock holds, like the web's ?freeze).
import Foundation
import IronvaleContract
import IronvaleMapRender
import IronvaleRender
import IronvaleSim
import IronvaleViewModel
import Metal
import QuartzCore

@MainActor
struct ViewModelLaunch {
    var weaponId: String
    var aim = 0.0
    var benchFrames: Int?
    var benchJSON: String?

    static func parse(_ arguments: some Sequence<String>) -> ViewModelLaunch? {
        var launch: ViewModelLaunch?
        var aim = 0.0, frames: Int?, json: String?
        var it = arguments.makeIterator()
        while let arg = it.next() {
            switch arg {
            case "--vm-weapon": launch = it.next().map { ViewModelLaunch(weaponId: $0) }
            case "--vm-aim": aim = it.next().flatMap(Double.init) ?? 0
            case "--vm-bench": frames = it.next().flatMap(Int.init)
            case "--bench-json": json = it.next()
            default: continue
            }
        }
        launch?.aim = min(1, max(0, aim))
        launch?.benchFrames = frames
        launch?.benchJSON = json
        return launch
    }

    /// PlayerController.applyCamera: fovForZoom(fov, lerp(1, zoom, smooth(aimBlend))).
    func fovDegrees(base: Float) throws -> Float {
        let tables = try ViewModelTables.load(contractDirectory: ContractLocation.directory())
        guard let def = tables.weapons[weaponId] else { throw LaunchError.unknownWeapon(weaponId) }
        let smooth = aim * aim * (3 - 2 * aim)
        return Float(fovForZoom(Double(base), 1 + (def.aimZoom - 1) * smooth))
    }

    enum LaunchError: Error, CustomStringConvertible {
        case unknownWeapon(String)
        var description: String {
            switch self { case .unknownWeapon(let id): "--vm-weapon: unknown weapon \(id)" }
        }
    }

    /// Builds the view model, settles it at the requested aim and adds it to `renderer`'s layers.
    func attach(to renderer: MapRenderer, pose: CameraPose, repositoryRoot: URL, device: any MTLDevice,
                library: any MTLLibrary) throws -> ViewModelLayer {
        let tables = try ViewModelTables.load(contractDirectory: ContractLocation.directory())
        guard let def = tables.weapons[weaponId] else { throw LaunchError.unknownWeapon(weaponId) }
        let layer = try ViewModelLayer(device: device, library: library, tables: tables,
                                       bakedDirectory: ViewModelAssets.bakedDirectory(repositoryRoot: repositoryRoot),
                                       gunsMeta: repositoryRoot.appending(path: "native/MapPackages/guns"))
        layer.show(weaponId: weaponId)
        layer.rig.frozen = renderer.visualsFrozen
        // makeRenderer already zoomed the lens for the aim (fovDegrees(base:)); the rig compresses depth for it.
        layer.rig.fovDegrees = Double(renderer.settings.fovDegrees)
        layer.mrt = renderer.postChain != nil
        layer.cameraPose = pose
        let idle = MachineView(action: nil, actionTime: 0, chambered: true, magazine: 30)
        // PlayerWeapons: a scoped rifle's view model is hidden once the scope is up.
        let hidden = def.scoped && aim >= SimData.shared.constants.playerWeapons.SCOPED_AT
        for _ in 0..<120 { layer.rig.update(ViewFrame(dt: 1.0 / 60, machine: idle, aim: aim, hidden: hidden), wall: nil) }
        renderer.layers.append(layer)
        return layer
    }

    /// Alternating frames with and without the view model; GPU milliseconds of each.
    func bench(renderer: MapRenderer, layer: ViewModelLayer, pose: CameraPose, device: any MTLDevice) throws {
        let frames = max(1, benchFrames ?? 300)
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: renderer.settings.internalWidth,
                                                                  height: renderer.settings.internalHeight, mipmapped: false)
        descriptor.usage = [.renderTarget, .shaderWrite]
        descriptor.storageMode = .private
        guard let output = device.makeTexture(descriptor: descriptor), let queue = device.makeCommandQueue() else {
            throw AppError.noMetalDevice
        }
        var with: [Double] = [], without: [Double] = [], pairs: [Double] = []
        var time = 0.0
        func run(_ visible: Bool) throws -> Double {
            layer.visible = visible
            guard let commands = queue.makeCommandBuffer() else { throw AppError.noMetalDevice }
            renderer.encode(commandBuffer: commands, pose: pose, time: time, output: output)
            commands.commit()
            commands.waitUntilCompleted()
            if let error = commands.error { throw error }
            time += 1.0 / 120
            return (commands.gpuEndTime - commands.gpuStartTime) * 1000
        }
        for _ in 0..<20 { _ = try run(true); _ = try run(false) }
        for i in 0..<frames {
            // Alternate which goes first so drift in GPU clocks or contention does not favour one side.
            let a: Double, b: Double
            if i % 2 == 0 { a = try run(true); b = try run(false) } else { b = try run(false); a = try run(true) }
            with.append(a)
            without.append(b)
            pairs.append(a - b)
        }
        layer.visible = true
        func median(_ v: [Double]) -> Double { let s = v.sorted(); return s[s.count / 2] }
        func mean(_ v: [Double]) -> Double { v.reduce(0, +) / Double(v.count) }
        let result: [String: Any] = [
            "weapon": weaponId, "aim": aim, "frames": frames,
            "width": renderer.settings.internalWidth, "height": renderer.settings.internalHeight,
            "triangles": layer.triangleCount,
            "withMedianMs": median(with), "withoutMedianMs": median(without),
            "withMeanMs": mean(with), "withoutMeanMs": mean(without),
            "pairDifferenceMedianMs": median(pairs), "pairDifferenceMeanMs": mean(pairs),
            "medianDifferenceMs": median(with) - median(without),
        ]
        print(String(format: "view model bench %@ aim %.1f at %dx%d: %d triangles; GPU median with %.3f ms, without %.3f ms; paired difference median %.3f ms, mean %.3f ms",
                     weaponId, aim, renderer.settings.internalWidth, renderer.settings.internalHeight, layer.triangleCount,
                     median(with), median(without), median(pairs), mean(pairs)))
        if let path = benchJSON {
            let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: URL(fileURLWithPath: path))
        }
    }
}

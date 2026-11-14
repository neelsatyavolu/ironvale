// Composition root: parses launch options, opens the window and starts the frame loop.
// Everything beyond wiring lives in the IronvaleKit package (PLAN.md section 2).
import AppKit
import IronvaleCharacters
import IronvaleCore
import IronvaleMapRender
import IronvaleRender
import Metal
import os

@main
@MainActor
enum IronvaleMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(Presentation.activationPolicy)
        withExtendedLifetime(delegate) { app.run() }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private static let logger = Logger(subsystem: "dev.n3el.ironvale", category: "app")

    private var window: NSWindow?
    private var frameLoop: FrameLoop?

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let arguments = CommandLine.arguments.dropFirst()
            try launch(options: LaunchOptions.parse(arguments), map: MapRenderOptions.parse(arguments))
        } catch {
            fail("Launch failed: \(error)")
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// M10: `ironvale://join?code=CODE` invites (CFBundleURLTypes in Info.plist).
    func application(_ application: NSApplication, open urls: [URL]) { GameLauncher.open(urls) }

    func applicationWillTerminate(_ notification: Notification) {
        frameLoop?.stop()
        GameLauncher.stop()
    }

    private func launch(options: LaunchOptions, map: MapRenderOptions) throws {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw AppError.noMetalDevice
        }
        guard let library = device.makeDefaultLibrary() else {
            throw AppError.noDefaultLibrary
        }
        // M7a: offscreen soldier benchmark (IronvaleCharacters/Render/SoldierBenchmark.swift).
        if let bench = SoldierBenchmark.Options.parse(CommandLine.arguments.dropFirst()) {
            guard let repo = map.repositoryRoot.map({ URL(fileURLWithPath: $0) })
                ?? MapAssets.findRepositoryRoot(from: Bundle.main.bundleURL) else { throw AppError.noRepository }
            let assets = try MapAssets(package: repo.appending(path: "native/MapPackages/\(bench.mapId)"), repositoryRoot: repo)
            let result = try SoldierBenchmark.run(options: bench, repositoryRoot: repo, lighting: assets.meta.lighting,
                                                  environmentHDR: assets.assetFile(id: assets.meta.lighting.hdri, key: "hdr@2k"),
                                                  device: device, library: library)
            print("soldier bench: \(result.soldiers) soldiers, \(result.frames) frames, GPU mean \(result.gpuMs.mean) ms, p95 \(result.gpuMs.p95) ms")
            exit(0)
        }
        // M4: the game itself (menu, --play, --autopilot); see GameSession.swift.
        if try GameLauncher.launchIfRequested(arguments: CommandLine.arguments.dropFirst(), launch: options,
                                              repositoryRoot: map.repositoryRoot, device: device, library: library) {
            return
        }
        var encoder: MapFrameEncoder?
        let gpuLog = map.gpuLogPath.map { _ in GPUFrameLog() }
        if let mapId = map.mapId {
            let renderer = try makeRenderer(mapId: mapId, options: map, device: device, library: library)
            if let path = map.capturePath {
                try capture(renderer: renderer, pose: map.pose ?? Self.defaultPose, device: device, to: path)
                exit(0)
            }
            if map.offscreen, let seconds = map.flythroughSeconds {
                let flight = Flythrough()
                let result = try OffscreenBenchmark.run(renderer: renderer, device: device, duration: seconds) { flight.pose(at: $0) }
                if let path = map.gpuLogPath { write(result.gpu, to: path) }
                if let path = options.frameLogPath { try result.frames.write(to: URL(fileURLWithPath: path)) }
                exit(0)
            }
            let fixed = map.pose ?? Self.defaultPose
            let flight = map.flythroughSeconds.map { _ in Flythrough() }
            encoder = MapFrameEncoder(renderer: renderer) { time in flight?.pose(at: time) ?? fixed }
        }
        let frame = NSRect(x: 0, y: 0, width: 1280, height: 800)
        let view = MetalView(frame: frame, device: device, pixelFormat: encoder == nil ? .bgra8Unorm_srgb : .bgra8Unorm)
        let window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Ironvale"
        window.contentView = view
        window.center()
        if map.flythroughSeconds != nil {
            // A benchmark run: keep the window above others, since macOS stops the display link
            // for a fully covered window and the stall would be logged as one huge frame.
            window.level = .floating
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        }
        Presentation.present(window)
        self.window = window

        let configuration = FrameLoop.Configuration(
            uncapped: options.uncapped,
            frameLimit: options.frameLimit,
            collectFrameTimes: options.frameLogPath != nil,
            duration: map.flythroughSeconds
        )
        let loop = try FrameLoop(view: view, library: library, configuration: configuration, encoder: encoder,
                                 gpuLog: gpuLog) { [weak self] log in
            if let gpuLog, let path = map.gpuLogPath { self?.write(gpuLog, to: path) }
            self?.finish(log: log, path: options.frameLogPath)
        }
        loop.start()
        frameLoop = loop
        Self.logger.info("Ironvale started on \(device.name, privacy: .public)")
    }

    /// Railyard's first player spawn, the web's `?pose=-3,0,45.5,0,0`.
    private static let defaultPose = CameraPose(webPose: "-3,0,45.5,0,0")!

    private func makeRenderer(mapId: String, options: MapRenderOptions, device: any MTLDevice,
                              library: any MTLLibrary) throws -> MapRenderer {
        let repo = options.repositoryRoot.map { URL(fileURLWithPath: $0) }
            ?? MapAssets.findRepositoryRoot(from: Bundle.main.bundleURL)
            ?? MapAssets.findRepositoryRoot(from: URL(fileURLWithPath: FileManager.default.currentDirectoryPath))
        guard let repo else { throw AppError.noRepository }
        let assets = try MapAssets(package: repo.appending(path: "native/MapPackages/\(mapId)"), repositoryRoot: repo)
        var settings = MapRenderer.Settings.high
        settings.internalWidth = options.internalWidth
        settings.internalHeight = options.internalHeight
        let started = Date()
        // M9: --q TIER / --no LIST (the web's ?q= / ?no=) turn on the post chain at that preset.
        let post = PostSettings.parse(CommandLine.arguments.dropFirst())
        let renderer = try MapRenderer(assets: assets, device: device, library: library, settings: settings, post: post)
        let skipped = renderer.skipped.map { "\($0.path) (\($0.reason.rawValue))" }.joined(separator: ", ")
        Self.logger.info("Loaded \(mapId, privacy: .public) in \(Date().timeIntervalSince(started), format: .fixed(precision: 2)) s: \(renderer.drawCount) draws, \(renderer.triangleCount) triangles; skipped: \(skipped, privacy: .public)")
        return renderer
    }

    /// Renders `pose` offscreen at the internal size (a few frames, so nothing is half-initialised)
    /// and writes the tone-mapped result as PNG.
    private func capture(renderer: MapRenderer, pose: CameraPose, device: any MTLDevice, to path: String) throws {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .bgra8Unorm, width: renderer.settings.internalWidth, height: renderer.settings.internalHeight, mipmapped: false)
        descriptor.usage = [.renderTarget]
        descriptor.storageMode = .shared
        guard let output = device.makeTexture(descriptor: descriptor), let queue = device.makeCommandQueue() else {
            throw AppError.noMetalDevice
        }
        // With the post chain, enough frames for MetalFX Temporal to converge (two jitter cycles), as
        // the web capture lets TRAA settle.
        let frames = renderer.postChain == nil ? 3 : 2 * PostChain.jitterPhases
        for frame in 0..<frames {
            guard let commands = queue.makeCommandBuffer() else { throw AppError.noMetalDevice }
            renderer.encode(commandBuffer: commands, pose: pose, time: Double(frame) / 60, output: output)
            commands.commit()
            commands.waitUntilCompleted()
            if let error = commands.error { throw error }
        }
        try TextureCapture.writePNG(output, to: URL(fileURLWithPath: path))
        Self.logger.info("Captured \(path, privacy: .public)")
    }

    private func write(_ gpuLog: GPUFrameLog, to path: String) {
        do {
            try gpuLog.write(to: URL(fileURLWithPath: path))
        } catch {
            fail("Could not write GPU log to \(path): \(error)")
        }
    }

    private func finish(log: FrameTimeLog, path: String?) {
        if let path {
            do {
                try log.write(to: URL(fileURLWithPath: path))
                Self.logger.info("Wrote \(log.samples.count) frame times to \(path, privacy: .public)")
            } catch {
                fail("Could not write frame log to \(path): \(error)")
            }
        }
        NSApp.terminate(nil)
    }

    private func fail(_ message: String) -> Never {
        Self.logger.fault("\(message, privacy: .public)")
        FileHandle.standardError.write(Data((message + "\n").utf8))
        exit(1)
    }
}

enum AppError: Error, CustomStringConvertible {
    case noMetalDevice
    case noDefaultLibrary
    case noRepository

    var description: String {
        switch self {
        case .noMetalDevice: "No Metal device available"
        case .noDefaultLibrary: "default.metallib is missing from the app bundle"
        case .noRepository: "Could not find the repository root (native/MapPackages); pass --repo PATH"
        }
    }
}

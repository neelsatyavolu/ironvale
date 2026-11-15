// M4 composition: the offline sim (IronvaleSim), device input and pointer capture (IronvalePlatform),
// the map renderer (IronvaleMapRender), the stand-in gun (IronvaleViewModel) and the interface
// (IronvaleUI RootView) and the Metal HUD (HUDView.swift), in an NSHostingView over the Metal view.
// M8: the match's sound (GameAudio.swift).
import AppKit
import IronvaleAI
import IronvaleContract
import IronvaleCharacters
import IronvaleCore
import IronvaleMapData
import IronvaleMapRender
import IronvalePlatform
import IronvaleRender
import IronvaleSim
import IronvaleUI
import IronvaleViewModel
import IronvaleWorld
import Metal
import os
import simd
import SwiftUI

@MainActor
final class GameSession {
    private static let logger = Logger(subsystem: "dev.n3el.ironvale", category: "game")

    let data: SimData
    let device: any MTLDevice
    let library: any MTLLibrary
    let repositoryRoot: URL
    let options: GameOptions
    let window: NSWindow
    let metalView: MetalView
    let deviceInput: DeviceInput
    let input: BoundInput
    let game: Game
    /// M7b: the bots of every match (IronvaleAI), drawn through `actorSources`.
    let bots: BotManager
    /// The stand-in gun (M4), drawn only when the baked view model is missing.
    let viewModel: FallbackViewModelRenderer
    /// M9: the first-person view model (guns, arms, rig), drawn inside the map's passes.
    let viewModelLayer: ViewModelLayer?
    let hud = HUDModel()
    let interface: InterfaceModel
    let lobbyLaunch: LobbyLaunch
    private var renderer: MapRenderer?
    private var frameLoop: FrameLoop?
    private var runner: AutopilotRunner?
    private var eventLog: EventLog?
    private var recorder: GameRecorder?
    private var lastConfig: MatchConfig?
    /// M7a: the third-person soldiers, drawn inside the map's passes; nil when the baked soldier is missing.
    private var soldiers: SoldierLayer?
    /// M9: the match's effects and weather (GameEffects.swift); nil without a renderer or atlases.
    private var effects: GameEffects?
    /// M8: the match's sound; nil in automated runs (GameAudio.make).
    private var audio: GameAudio?
    /// Everything that contributes soldiers to draw each frame (the two-player match, bots).
    var actorSources: [any ActorSource] = []
    /// M6: a scripted duel against another machine (NetDuel.swift).
    private var netDuel: NetDuel?
    /// M7b: `--autopilot --bots N` checks the bot scenario instead of the M4 event sequence.
    private var botMonitor: BotScenarioMonitor?

    init(options: GameOptions, launch: LaunchOptions, device: any MTLDevice, library: any MTLLibrary, repositoryRoot: URL) throws {
        self.options = options
        self.device = device
        self.library = library
        self.repositoryRoot = repositoryRoot
        data = try SimData.load()
        let simInput = data.constants.input
        deviceInput = DeviceInput(options: .init(lookSpike: simInput.LOOK_SPIKE_PX, wheelThreshold: simInput.WHEEL_THRESHOLD,
                                                 wheelQuietSeconds: simInput.WHEEL_QUIET_MS / 1000))
        // M10: the friend screen and invite links run on the real session (LobbyLaunch.swift).
        lobbyLaunch = LobbyLaunch(arguments: CommandLine.arguments.dropFirst(),
                                  knownMaps: Set(data.contract.maps.playable + data.contract.maps.developer))
        interface = InterfaceModel(settings: SettingsStore(storage: DefaultsStringStore()), lobby: lobbyLaunch.lobby, storage: DefaultsStringStore())
        let settings = Self.playerSettings(interface.settings.value)
        input = BoundInput(settings: settings, data: data)
        game = Game(input: input, settings: settings, data: data)
        bots = BotManager(game: game)
        game.bots = bots
        viewModel = try FallbackViewModelRenderer(device: device, library: library, colorFormat: .bgra8Unorm,
                                                  guns: FallbackGunData.loadAll(contractDirectory: data.contract.directory))
        viewModelLayer = Self.makeViewModel(device: device, library: library, contract: data.contract.directory, repositoryRoot: repositoryRoot)

        let frame = NSRect(x: 0, y: 0, width: 1280, height: 800)
        metalView = MetalView(frame: frame, device: device, pixelFormat: .bgra8Unorm)
        metalView.autoresizingMask = [.width, .height]
        window = GameWindow(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Ironvale"
        let container = NSView(frame: frame)
        container.addSubview(metalView)
        let overlay = NSHostingView(rootView: ZStack {
            HUDView(model: hud)
            RootView(model: interface, thumbnail: MapThumbnails(repositoryRoot: repositoryRoot).image)
        })
        overlay.frame = frame
        overlay.autoresizingMask = [.width, .height]
        container.addSubview(overlay)
        window.contentView = container
        window.center()

        wire()
        audio = GameAudio.make(game: game, bots: bots, repositoryRoot: repositoryRoot, reportEvery: options.audioReportSeconds)
        hud.attach(game: game, device: device, library: library, settings: interface.settings, view: metalView, repositoryRoot: repositoryRoot)
        actorSources.append(bots)
        soldiers = Self.makeSoldiers(device: device, library: library, repositoryRoot: repositoryRoot)
        let configuration = FrameLoop.Configuration(uncapped: launch.uncapped, frameLimit: launch.frameLimit,
                                                    collectFrameTimes: launch.frameLogPath != nil)
        let encoder = GameFrameEncoder()
        encoder.session = self
        frameLoop = try FrameLoop(view: metalView, library: library, configuration: configuration, encoder: encoder) { log in
            if let path = launch.frameLogPath { try? log.write(to: URL(fileURLWithPath: path)) }
            NSApp.terminate(nil)
        }
    }

    static func playerSettings(_ settings: IronvaleUI.Settings) -> PlayerSettings {
        let c = settings.controls
        return PlayerSettings(preset: c.preset.rawValue, sensitivity: c.sensitivity, adsSensitivity: c.adsSensitivity,
                              invertY: c.invertY, adsToggle: c.adsToggle, lookSmoothing: c.lookSmoothing, rawInput: c.rawInput,
                              fov: settings.gameplay.fov, headBob: settings.gameplay.headBob)
    }

    private func wire() {
        let viewModel = viewModel, game = game
        if let layer = viewModelLayer {
            // rig.ts muzzleWorld / ejectionWorld: the rig's camera space onto the player's camera.
            game.weapons.muzzle = {
                let m = layer.rig.muzzleWorld
                return game.player.camera.position + game.player.camera.rotate(IronvaleWorld.Vec3(m.x, m.y, m.z))
            }
            game.weapons.ejectionPort = {
                let e = layer.rig.ejectionWorld
                let camera = game.player.camera
                return (camera.position + camera.rotate(IronvaleWorld.Vec3(e.position.x, e.position.y, e.position.z)),
                        camera.rotate(IronvaleWorld.Vec3(e.direction.x, e.direction.y, e.direction.z)).normalized())
            }
        } else {
            game.weapons.muzzle = { viewModel.muzzleWorld(camera: game.player.camera) ?? game.player.camera.position }
            game.weapons.ejectionPort = { viewModel.ejectionWorld(camera: game.player.camera) }
        }
        game.events.on { [weak self] event in
            guard let self else { return }
            switch event {
            case let .shotFired(_, _, _, _, local) where local:
                if let layer = viewModelLayer {
                    // player-weapons.ts passes recoil.kickYaw / horizontal: a random -1 to 1 the native recoil keeps private.
                    layer.rig.fired(aim: game.weapons.aimBlend, side: Double.random(in: -1...1))
                } else {
                    viewModel.fired(aimBlend: Float(game.weapons.aimBlend))
                }
            case let .weaponAction(_, _, stage, _, local) where local:
                viewModelLayer?.rig.stage(stage)
            case let .landed(_, _, _, speed, local) where local:
                viewModelLayer?.rig.landed(speed: speed)
            default:
                break
            }
        }
        game.onPhase = { [weak self] phase in self?.phaseChanged(phase) }
        deviceInput.onLockChange = { [weak self] locked in
            guard let self, !locked, self.game.phase == .playing, self.runner == nil else { return }
            self.game.pause()
        }
        interface.commands = InterfaceCommands(
            startMatch: { [weak self] request in self?.start(request) },
            restart: { [weak self] in
                guard let self, let config = lastConfig else { return }
                startMatch(config)
            },
            resume: { [weak self] in
                guard let self else { return }
                game.resume()
                deviceInput.capture()
            },
            quitToMenu: { [weak self] in
                guard let self else { return }
                game.quitToMenu()
                renderer = nil
                deviceInput.release()
                interface.showMenu()
            }
        )
    }

    func start() throws {
        let headless = options.autopilotPath != nil && options.offscreen
        if let duel = NetDuelOptions.parse(CommandLine.arguments.dropFirst()) {
            let created = try NetDuel(options: duel, game: game, input: input) { [weak self] config in self?.startMatch(config) ?? false }
            netDuel = created
            actorSources.append(created.match)
            // Keep the window above others: macOS stops the display link for a covered window.
            window.level = .floating
            Presentation.present(window, activate: false)
            created.start(window: window) { [weak self] on in on ? self?.frameLoop?.start() : self?.frameLoop?.stop() }
            frameLoop?.start()
            return
        }
        if !headless {
            Presentation.present(window)
            deviceInput.attach(to: window)
        }
        if let path = options.autopilotPath {
            let script = try AutopilotScript.load(URL(fileURLWithPath: path))
            let log = try EventLog(path: options.eventLogPath)
            eventLog = log
            // Keep the window above others: macOS stops the display link for a covered window.
            window.level = .floating
            let mapId = options.mapId ?? script.map ?? "range"
            let settings = PlayerSettings.defaults(script.preset ?? "mouse", data: data)
            input.setPreset(settings)
            game.applySettings(settings)
            runner = AutopilotRunner(script: script, game: game, input: input, log: log)
            if options.botCount > 0 { botMonitor = BotScenarioMonitor(game: game, bots: bots) }
            startMatch(MatchConfig(mapId: mapId, mode: .skirmish, difficulty: script.difficulty ?? "veteran", botCount: options.botCount))
            if options.offscreen {
                try runOffscreen()
                return
            }
        } else if options.play {
            if let path = options.eventLogPath {
                let log = try EventLog(path: path)
                eventLog = log
                recorder = GameRecorder(game: game, log: log)
            }
            startMatch(MatchConfig(mapId: options.mapId ?? "range", mode: .skirmish,
                                   difficulty: interface.settings.value.gameplay.difficulty.rawValue, botCount: options.botCount))
        }
        frameLoop?.start()
    }

    /// `--offscreen`: no window and no display link (which macOS pauses for a covered window or a
    /// sleeping display). Fixed 1/120 s frames, each rendered into an offscreen texture and waited on.
    private func runOffscreen() throws {
        let size = (width: 1280, height: 800)
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: size.width,
                                                                  height: size.height, mipmapped: false)
        descriptor.usage = [.renderTarget]
        descriptor.storageMode = .private
        guard let target = device.makeTexture(descriptor: descriptor), let queue = device.makeCommandQueue() else {
            throw AppError.noMetalDevice
        }
        while runner != nil {
            try autoreleasepool {
                guard let commands = queue.makeCommandBuffer() else { throw AppError.noMetalDevice }
                frame(commandBuffer: commands, target: target, dt: 1.0 / 120)
                commands.commit()
                commands.waitUntilCompleted()
                if let error = commands.error { throw error }
            }
        }
    }

    func stop() {
        frameLoop?.stop()
        eventLog?.close()
        audio?.stop()
    }

    private func start(_ request: MatchRequest) {
        let mode: MatchConfig.Mode = request.mode == .survival ? .survival : .skirmish
        startMatch(MatchConfig(mapId: request.mapId, mode: mode, difficulty: request.difficulty.rawValue, botCount: request.botCount))
    }

    @discardableResult
    private func startMatch(_ config: MatchConfig) -> Bool {
        // The developer map (range) is not in the menu's list; it loads without a loading screen.
        let info = interface.maps.first { $0.id == config.mapId }
        let mapName = info?.name ?? config.mapId.capitalized
        if let info { interface.showLoading(map: info, detail: "Solo · offline sandbox (M4)") }
        do {
            let settings = Self.playerSettings(interface.settings.value)
            if runner == nil {
                input.setPreset(settings)
                game.applySettings(settings)
                deviceInput.rawInput = settings.rawInput
            }
            let packageURL = repositoryRoot.appending(path: "native/MapPackages/\(config.mapId)")
            let package = try MapPackage.load(directory: packageURL)
            renderer = loadRenderer(packageURL: packageURL)
            configureLighting(package.meta.lighting)
            hud.mapName = mapName
            lastConfig = config
            game.start(map: package, config: config)
            audio?.enterMap(package.meta)
            effects?.stop()
            effects = renderer.flatMap { GameEffects.make(game: game, renderer: $0, device: device, library: library,
                                                          repositoryRoot: repositoryRoot, contract: data.contract) }
            if let effects { audio?.attach(effects) }
            interface.showPlaying()
            if runner == nil, netDuel == nil { deviceInput.capture() }
            Self.logger.info("Match started on \(config.mapId, privacy: .public)")
            return true
        } catch {
            Self.logger.error("Could not start the match: \(error, privacy: .public)")
            interface.menuError = "Could not load \(mapName): \(error)"
            interface.showMenu()
            if runner != nil { finishAutopilot(failure: "load failed: \(error)") }
            return false
        }
    }

    /// The map renderer, or nil when this map's render export is not drawable yet: the match still
    /// runs (collision and the sim do not depend on it) over a cleared background, and the event log says so.
    private func loadRenderer(packageURL: URL) -> MapRenderer? {
        do {
            let assets = try MapAssets(package: packageURL, repositoryRoot: repositoryRoot)
            var renderSettings = MapRenderer.Settings.high
            let size = metalView.metalLayer.drawableSize
            renderSettings.internalWidth = options.offscreen ? 1280 : max(640, Int(size.width))
            renderSettings.internalHeight = options.offscreen ? 800 : max(400, Int(size.height))
            renderSettings.fovDegrees = Float(game.settings.fov)
            let renderer = try MapRenderer(assets: assets, device: device, library: library, settings: renderSettings)
            if let soldiers { renderer.layers.append(soldiers) }
            if let viewModelLayer {
                viewModelLayer.mrt = renderer.postChain != nil
                renderer.layers.append(viewModelLayer)
            }
            return renderer
        } catch {
            Self.logger.error("Map renderer unavailable: \(error, privacy: .public)")
            FileHandle.standardError.write(Data("warning: map renderer unavailable, playing without map geometry: \(error)\n".utf8))
            (runner?.recorder.log ?? eventLog)?.write(time: 0, kind: "renderUnavailable", fields: ["reason": "\(error)".replacingOccurrences(of: "\"", with: "'")])
            return nil
        }
    }

    private func configureLighting(_ lighting: LightingSetup) {
        let d = lighting.sunDirection
        viewModel.sunDirection = simd_normalize(SIMD3(Float(d[0]), Float(d[1]), Float(d[2])))
        viewModel.sunColor = RenderMath.linearFromSRGBHex(lighting.sunColor) * Float(lighting.sunIntensity) * Float(lighting.exposure)
        viewModel.skyColor = RenderMath.linearFromSRGBHex(lighting.fog.color) * Float(lighting.skyIntensity) * Float(lighting.exposure)
    }

    private func phaseChanged(_ phase: GamePhase) {
        switch phase {
        case .paused:
            // A match with a friend goes on behind the pause menu, and so does its sound.
            if game.net?.inMatch != true { audio?.setPaused(true) }
            deviceInput.release()
            interface.showPause(detail: "Solo · offline", live: false)
        case .playing:
            audio?.setPaused(false)
            interface.showPlaying()
        case .won, .lost:
            audio?.setPaused(true)
            deviceInput.release()
            interface.showEnd(MatchResult(won: phase == .won, mode: lastConfig?.mode == .survival ? .survival : .skirmish,
                                          mapName: hud.mapName, kills: game.kills, deaths: game.deaths, elapsed: game.time,
                                          wave: 0, accuracy: game.shotsFired > 0 ? game.shotsHit * 100 / game.shotsFired : nil))
        case .menu:
            audio?.leaveMap()
        case .loading:
            break
        }
    }

    // MARK: Frame

    func frame(commandBuffer: any MTLCommandBuffer, target: any MTLTexture, dt: Double) {
        if let runner {
            runner.frame(dt)
            botMonitor?.frame(dt)
            if runner.finished { finishAutopilot(failure: nil) }
        } else if let netDuel {
            netDuel.tick(dt)
        } else {
            deviceInput.gameHasKeyboard = game.phase == .playing && !hud.takesKeyboard
            let device = deviceInput.takeFrame()
            input.frame = InputFrame(held: device.held, pressed: device.pressed, lookX: device.lookX, lookY: device.lookY, locked: device.locked)
            game.frame(dt)
            recorder?.frame()
        }
        updateViewModel(dt)
        updateHUD(dt)
        soldiers?.update(SoldierDrawList.build(from: actorSources), dt: dt)
        audio?.frame(dt, settings: interface.settings.value)
        guard let renderer, game.map != nil else {
            clear(commandBuffer: commandBuffer, target: target)
            return
        }
        let camera = game.player.camera
        let pose = CameraPose(eye: SIMD3(Float(camera.position.x), Float(camera.position.y), Float(camera.position.z)),
                              yaw: Float(camera.yaw), pitch: Float(camera.pitch))
        viewModelLayer?.cameraPose = pose
        renderer.fovDegrees = Float(camera.fov)
        let shaken = effects?.frame(dt, game: game, renderer: renderer, pose: pose) ?? pose
        renderer.encode(commandBuffer: commandBuffer, pose: shaken, time: game.time, output: target)
        if game.player.alive, viewModelLayer == nil { viewModel.encode(commandBuffer: commandBuffer, target: target, camera: camera) }
        hud.encode(commandBuffer: commandBuffer, target: target)
        if let path = netDuel?.takeShotRequest() { NetDuel.capture(renderer: renderer, pose: pose, time: game.time, device: device, to: path) }
    }

    /// The soldier renderer for every match, or nil (logged) when the baked soldier cannot be loaded.
    private static func makeSoldiers(device: any MTLDevice, library: any MTLLibrary, repositoryRoot: URL) -> SoldierLayer? {
        do {
            let baked = SoldierRig.bakedDirectory(repositoryRoot: repositoryRoot)
            let rig = try SoldierRig(directory: baked)
            return SoldierLayer(renderer: try SoldierRenderer(rig: rig, bakedDirectory: baked, device: device, library: library))
        } catch {
            logger.error("Soldier renderer unavailable: \(error, privacy: .public)")
            return nil
        }
    }

    /// M9 view model, or nil (logged) when its bake is missing: the stand-in gun is drawn instead.
    private static func makeViewModel(device: any MTLDevice, library: any MTLLibrary, contract: URL, repositoryRoot: URL) -> ViewModelLayer? {
        do {
            return try ViewModelLayer(device: device, library: library, tables: ViewModelTables.load(contractDirectory: contract),
                                      bakedDirectory: ViewModelAssets.bakedDirectory(repositoryRoot: repositoryRoot),
                                      gunsMeta: repositoryRoot.appending(path: "native/MapPackages/guns"))
        } catch {
            logger.error("View model unavailable, using the stand-in gun: \(error, privacy: .public)")
            return nil
        }
    }

    private func updateViewModel(_ dt: Double) {
        let weapons = game.weapons
        if let layer = viewModelLayer {
            let player = game.player
            layer.show(weaponId: weapons.current.def.id)
            layer.visible = player.alive
            layer.rig.fovDegrees = player.camera.fov
            let frame = ViewFrame(dt: dt, machine: MachineView(weapons.current), aim: weapons.aimBlend, sprint: weapons.sprintCarry,
                                  lowered: weapons.lowered, speed: player.speed, verticalSpeed: player.velocity.y,
                                  onGround: player.onGround, lookYaw: player.lookYaw, lookPitch: player.lookPitch,
                                  hidden: weapons.scopedIn)
            let camera = player.camera, world = game.map?.world
            layer.rig.update(frame, wall: { _, _, far in
                world?.raycast(origin: camera.position, direction: camera.direction, maxDistance: far)?.distance
            })
            return
        }
        let def = weapons.current.def
        let handling = data.constants.handling.classes[def.weaponClass]
        let hip = handling?.hip ?? [0.125, -0.2, -0.3]
        let tilt = handling?.hipTilt ?? [0.08, 0.066, -0.04]
        viewModel.update(ViewModelState(weaponId: def.id, hip: SIMD3(Float(hip[0]), Float(hip[1]), Float(hip[2])),
                                        hipTilt: SIMD3(Float(tilt[0]), Float(tilt[1]), Float(tilt[2])),
                                        aimBlend: Float(weapons.aimBlend), lowered: Float(weapons.lowered),
                                        sprint: Float(weapons.sprintCarry), hidden: weapons.scopedIn), dt: Float(dt))
    }

    private func updateHUD(_ dt: Double) {
        hud.frame(dt, game: game, pressed: input.frame.pressed)
    }

    private func clear(commandBuffer: any MTLCommandBuffer, target: any MTLTexture) {
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = target
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].storeAction = .store
        // The Ledger canvas, #0E0E0D.
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0.055, green: 0.055, blue: 0.051, alpha: 1)
        commandBuffer.makeRenderCommandEncoder(descriptor: pass)?.endEncoding()
    }

    /// Writes the result, then quits: exit 0 when the M4 sequence is complete, 1 otherwise.
    private func finishAutopilot(failure: String?) {
        guard let runner else { return }
        self.runner = nil
        var missing = failure.map { [$0] } ?? AutopilotRunner.missing(in: runner.recorder.log.lines, weapons: data.contract.weapons.weaponIds)
        if let botMonitor, failure == nil {
            let report = botMonitor.report
            // The web's own range of bots that fire on this map (native/Contract/nav/skirmish.json).
            let reference = try? SkirmishReference.load(contractRoot: ContractLocation.directory())
            let webFired = game.config.flatMap { reference?.firedRange(mapId: $0.mapId, bots: options.botCount) }
            missing = report.failures(expectEnemies: options.botCount, webFired: webFired)
            runner.recorder.log.write(time: game.time, kind: "botScenario", fields: [
                "spawned": "\(report.spawned)", "botShots": "\(report.botShots)", "botsThatFired": "\(report.botsThatFired)",
                "hitsOnPlayer": "\(report.hitsOnPlayer)", "playerDeaths": "\(report.playerDeaths)", "botKills": "\(report.botKills)",
                "leastTravel": String(format: "%.2f", report.leastTravel), "botFootsteps": "\(report.botFootsteps)",
                "outOfWorld": "\(report.outOfWorld)", "rateViolations": "\(report.rateViolations)",
                "navNodes": "\(bots.stats.navNodes)", "botUpdateMeanMs": String(format: "%.3f", bots.stats.updateMs),
                "botUpdateMaxMs": String(format: "%.3f", bots.stats.updateMaxMs),
            ])
        }
        runner.recorder.log.write(time: game.time, kind: missing.isEmpty ? "autopilotPassed" : "autopilotFailed",
                                  fields: ["missing": missing.joined(separator: "; ")])
        stop()
        let passed = botMonitor == nil ? "autopilot: every M4 event in order" : "autopilot: the \(options.botCount)-bot skirmish passed"
        let message = missing.isEmpty ? passed : "autopilot: missing \(missing.joined(separator: ", "))"
        FileHandle.standardError.write(Data((message + "\n").utf8))
        Self.logger.info("\(message, privacy: .public)")
        exit(missing.isEmpty ? 0 : 1)
    }
}

/// Hands each display-link frame to the session.
@MainActor
final class GameFrameEncoder: FrameEncoder {
    weak var session: GameSession?

    func encode(commandBuffer: any MTLCommandBuffer, drawable: any CAMetalDrawable, time _: Double, dt: Double) {
        session?.frame(commandBuffer: commandBuffer, target: drawable.texture, dt: dt)
    }
}

/// Entry point used by the app delegate.
@MainActor
enum GameLauncher {
    private static var session: GameSession?
    /// URLs opened before the session exists (a launch by `ironvale://join`).
    private static var pendingURLs: [URL] = []

    /// Starts the game when the arguments ask for it; returns false to leave the launch to the M3 paths.
    static func launchIfRequested(arguments: some Sequence<String>, launch: LaunchOptions, repositoryRoot: String?,
                                  device: any MTLDevice, library: any MTLLibrary) throws -> Bool {
        let options = GameOptions.parse(arguments)
        guard options.wantsGame else { return false }
        guard let repo = RuntimeRoot.resolve(explicit: repositoryRoot) else { throw AppError.noRepository }
        let created = try GameSession(options: options, launch: launch, device: device, library: library, repositoryRoot: repo)
        session = created
        try created.start()
        created.lobbyLaunch.attach(created.interface)
        // An invite URL that launched the app arrives before the session exists.
        let early = pendingURLs
        pendingURLs = []
        open(early)
        return true
    }

    static func stop() { session?.stop() }

    /// `ironvale://join?code=` (or a web invite link) opened by macOS: show the invite in the menu.
    static func open(_ urls: [URL]) {
        guard let session else {
            pendingURLs += urls
            return
        }
        for url in urls where session.interface.openInviteURL(url) {
            session.lobbyLaunch.inviteOpened(url)
            return
        }
    }
}

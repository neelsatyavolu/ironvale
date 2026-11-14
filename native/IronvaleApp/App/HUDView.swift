// M10b: the in-match HUD. The Metal pass (IronvaleUI HUDRenderer, Shaders/Hud.metal) draws every element
// over the finished frame from the running Game; SwiftUI shows only the weapon picker and the chat box,
// and only while they are open (PLAN.md 3.9). Replaces M4's placeholder SwiftUI HUD.
import AppKit
import IronvaleAI
import IronvaleSim
import IronvaleUI
import Metal
import Observation
import os
import SwiftUI

extension Bot: HUDHealthSource {}

@MainActor
@Observable
final class HUDModel {
    private static let logger = Logger(subsystem: "dev.n3el.ironvale", category: "hud")

    /// The map's display name, for the end screen.
    var mapName = ""
    let chat = HUDChat()
    private(set) var picker: WeaponPicker?
    @ObservationIgnored private(set) var pictures: URL?
    @ObservationIgnored private var gameHUD: GameHUD?
    @ObservationIgnored private var renderer: HUDRenderer?
    @ObservationIgnored private var settings: SettingsStore?
    @ObservationIgnored private weak var view: NSView?
    @ObservationIgnored private var matchKey: String?
    @ObservationIgnored private var lastTime = 0.0
    @ObservationIgnored private var frameMs = 0.0
    @ObservationIgnored private var perfAge = 0.0
    /// Two-player state and round trip, set by the net session when a friend is connected.
    @ObservationIgnored var net: () -> HUDState.Net? = { nil }
    @ObservationIgnored var roundTripMs: () -> Int = { -1 }

    /// Connects the HUD to the game; a missing shader or atlas is logged and the match plays without a HUD.
    func attach(game: Game, device: any MTLDevice, library: any MTLLibrary, settings: SettingsStore, view: NSView, repositoryRoot: URL) {
        self.settings = settings
        self.view = view
        let hud = GameHUD(game: game)
        hud.net = { [weak self] in self?.net() }
        hud.chatLines = { [weak self] in self?.chat.visible(now: GameHUD.wallClock()) ?? [] }
        gameHUD = hud
        picker = WeaponPicker(defs: game.data.weapons)
        pictures = repositoryRoot.appending(path: "public/assets/weapons")
        guard let atlas = Bundle.main.url(forResource: "hud-atlas", withExtension: "json") else {
            Self.logger.error("hud-atlas.json is missing from the app bundle")
            return
        }
        let resources = atlas.deletingLastPathComponent()
        let failed = BundledFonts.register(in: resources)
        if !failed.isEmpty { Self.logger.error("Could not register fonts: \(failed.joined(separator: ", "), privacy: .public)") }
        do {
            renderer = try HUDRenderer(device: device, library: library, colorFormat: .bgra8Unorm, resources: resources)
        } catch {
            Self.logger.error("HUD unavailable: \(String(describing: error), privacy: .public)")
        }
    }

    /// Before the frame's input reaches the game: true while the chat box has the keyboard.
    var takesKeyboard: Bool { chat.inputOpen }

    /// After the game's frame: perf toggle (Backquote), chat key (T), the picker, and a new match's reset.
    func frame(_ dt: Double, game: Game, pressed: Set<String>) {
        guard let gameHUD else { return }
        // A new match: another map, or the match clock started again.
        let key = game.map == nil ? nil : game.config?.mapId
        if key != matchKey || game.time < lastTime {
            matchKey = key
            gameHUD.matchStarted()
            chat.clear()
            renderer?.setMap(game.config?.mapId)
        }
        lastTime = game.time
        let playing = game.phase == .playing
        if playing, pressed.contains("Backquote") { gameHUD.perfVisible.toggle() }
        if playing, !chat.inputOpen, net()?.peerConnected == true, pressed.contains(HUDConstants.shared.chatOpenKey) { chat.openInput() }
        if !playing && chat.inputOpen { chat.close() }
        gameHUD.chatInputOpen = chat.inputOpen
        frameMs = frameMs == 0 ? dt * 1000 : frameMs * 0.9 + dt * 100
        perfAge += dt
        if gameHUD.perfVisible, perfAge >= HUDConstants.shared.perfRefreshSeconds || gameHUD.perfText.isEmpty {
            perfAge = 0
            let fps = frameMs > 0 ? Int((1000 / frameMs).rounded()) : 0
            let rtt = roundTripMs()
            gameHUD.perfText = "\(HUDMath.toFixed(frameMs, 1)) ms  \(fps) fps  scale 1.00  Metal\(rtt >= 0 ? "  rtt \(rtt) ms" : "")"
        }
        let weapons = game.weapons
        picker?.frame(held: playing && game.net?.inMatch != true && game.input.isDown(.scores), alive: game.player.alive,
                      pressed: { game.input.wasPressed($0) }, currentId: weapons.current.def.id, carries: { weapons.carries($0) },
                      ammo: { id in weapons.machines.first { $0.def.id == id }.map { ($0.magazine, $0.reserve) } },
                      equip: { weapons.equip(slot: $0) })
    }

    /// The Metal HUD over the finished frame.
    func encode(commandBuffer: any MTLCommandBuffer, target: any MTLTexture) {
        guard let gameHUD, let renderer, let settings, let view else { return }
        let scale = Double(target.width) / max(1, Double(view.bounds.width))
        let width = Double(target.width) / scale, height = Double(target.height) / scale
        let state = gameHUD.state(settings: settings.value, width: width, height: height, pointScale: scale)
        let scene = HUDScene.build(state: state, tracker: gameHUD.tracker, font: renderer.font, layout: renderer.layout, wall: GameHUD.wallClock())
        renderer.encode(commandBuffer: commandBuffer, target: target, scene: scene, viewport: (width, height))
    }
}

/// SwiftUI over the Metal view during a match: the picker and the chat box, each only while open.
struct HUDView: View {
    let model: HUDModel

    var body: some View {
        ZStack {
            if let picker = model.picker { WeaponPickerView(picker: picker, pictures: model.pictures) }
            ChatInputView(chat: model.chat)
        }
    }
}

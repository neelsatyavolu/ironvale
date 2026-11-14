// Ported from src/ui/screens/settings.ts at cbe0add: four tabs, every change applied and saved at once.
import SwiftUI

struct SettingsView: View {
    @Bindable var model: InterfaceModel

    private var store: SettingsStore { model.settings }
    private var s: Settings { store.value }

    var body: some View {
        SheetPanel(solid: model.sheetIsSolid, backID: "settings.back", onBack: { model.open(nil) }) {
            Text("Settings").ledger(.headline)
            Text("Changes apply as you make them").ledger(.label)
            Spacer(minLength: 0)
        } tabs: {
            HStack(spacing: 24) {
                ForEach(SettingsTab.allCases, id: \.self) { tab in
                    TabButton(title: tab.rawValue.capitalized, selected: model.settingsTab == tab, id: "settings.tab.\(tab.rawValue)") {
                        model.settingsTab = tab
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 24)
            .padding(.top, 16)
            .overlay(alignment: .bottom) { Rectangle().fill(Ledger.line2).frame(height: 1) }
        } content: {
            switch model.settingsTab {
            case .graphics: TwoColumns { quality } right: { effects }
            case .controls: TwoColumns { look } right: { aim }
            case .audio: TwoColumns { volumes } right: { output }
            case .gameplay: TwoColumns { view } right: { hud }
            }
        }
    }

    // MARK: Graphics

    private func graphics(_ patch: @escaping (inout GraphicsSettings) -> Void) {
        store.update { $0.graphics = SettingsModel.patchGraphics($0.graphics, patch) }
    }

    private func percent(_ value: Double) -> String { "\(Int(value.rounded()))%" }

    private func switchRow(_ label: String, _ key: WritableKeyPath<GraphicsSettings, Bool>, note: String? = nil) -> some View {
        SettingRow(label: label, note: note) {
            LedgerToggle(id: "settings.\(label)", label: label, isOn: s.graphics[keyPath: key]) { on in graphics { $0[keyPath: key] = on } }
        }
    }

    private var quality: some View {
        LedgerSection(label: "Quality", inSheet: true) {
            SettingRow(label: "Preset") {
                HStack(spacing: 12) {
                    if SettingsModel.matchTier(s.graphics) == nil { Text("Custom").font(Ledger.mono(12)).foregroundStyle(Ledger.ink) }
                    Segmented(id: "settings.preset", options: QualityTier.allCases.map { SegmentOption(value: $0, label: SettingsModel.tierName($0)) },
                              selection: SettingsModel.matchTier(s.graphics)) { tier in
                        store.update { $0.graphics = SettingsModel.applyTier($0.graphics, tier) }
                    }
                }
            }
            SettingRow(label: "Render scale") {
                LedgerSlider(id: "settings.renderScale", label: "Render scale", range: 50...100, step: 5,
                             value: (s.graphics.renderScale * 100).rounded(), format: percent) { v in graphics { $0.renderScale = v / 100 } }
            }
            switchRow("Dynamic resolution", \.dynamicResolution, note: "Lowers the render scale when frames run long.")
            SettingRow(label: "Target frame rate") {
                Segmented(id: "settings.fps", options: [30, 60, 120].map { SegmentOption(value: $0, label: String($0)) },
                          selection: s.graphics.targetFps) { fps in graphics { $0.targetFps = fps } }
            }
            SettingRow(label: "Shadows") {
                Segmented(id: "settings.shadows", options: [
                    SegmentOption(value: 0, label: "Off"), SegmentOption(value: 1024, label: "Low"),
                    SegmentOption(value: 2048, label: "Medium"), SegmentOption(value: 4096, label: "High"),
                ], selection: s.graphics.shadowMapSize) { size in graphics { $0.shadowMapSize = size } }
            }
            SettingRow(label: "Textures", note: "From the next map you load.") {
                Segmented(id: "settings.textures", options: [SegmentOption(value: TextureTier.k1, label: "1K"), SegmentOption(value: TextureTier.k2, label: "2K")],
                          selection: s.graphics.textures) { tier in graphics { $0.textures = tier } }
            }
            SettingRow(label: "Anti-aliasing") {
                Segmented(id: "settings.aa", options: [
                    SegmentOption(value: AntiAliasing.none, label: "Off"), SegmentOption(value: AntiAliasing.fxaa, label: "FXAA"),
                    SegmentOption(value: AntiAliasing.traa, label: "TRAA"),
                ], selection: s.graphics.antiAliasing) { aa in graphics { $0.antiAliasing = aa } }
            }
        }
    }

    private var effects: some View {
        LedgerSection(label: "Effects", inSheet: true) {
            switchRow("Reflections", \.reflections)
            switchRow("Ambient occlusion", \.ambientOcclusion)
            switchRow("Light shafts", \.volumetricLight)
            switchRow("Bloom", \.bloom)
            switchRow("Film grain", \.filmGrain)
            SettingRow(label: "Detail density", note: "Grass, debris and rain. From the next map.") {
                LedgerSlider(id: "settings.detail", label: "Detail density", range: 10...100, step: 5,
                             value: (s.graphics.detailDensity * 100).rounded(), format: percent) { v in graphics { $0.detailDensity = v / 100 } }
            }
            SettingRow(label: "Particle density") {
                LedgerSlider(id: "settings.particles", label: "Particle density", range: 10...100, step: 5,
                             value: (s.graphics.particleDensity * 100).rounded(), format: percent) { v in graphics { $0.particleDensity = v / 100 } }
            }
        }
    }

    // MARK: Controls

    private var look: some View {
        LedgerSection(label: "Look", inSheet: true) {
            SettingRow(label: "Preset", note: "Resets the values below.") {
                Segmented(id: "settings.controlPreset", options: [
                    SegmentOption(value: ControlPreset.trackpad, label: "Trackpad"), SegmentOption(value: ControlPreset.mouse, label: "Mouse"),
                ], selection: s.controls.preset) { preset in store.update { $0.controls = WebData.shared.controlPresets[preset]! } }
            }
            SettingRow(label: "Sensitivity") {
                LedgerSlider(id: "settings.sensitivity", label: "Sensitivity", range: 10...300, step: 5, value: s.controls.sensitivity,
                             format: { String(Int($0.rounded())) }) { v in store.update { $0.controls.sensitivity = v } }
            }
            SettingRow(label: "Aimed sensitivity") {
                LedgerSlider(id: "settings.ads", label: "Aimed sensitivity", range: 30...150, step: 5,
                             value: (s.controls.adsSensitivity * 100).rounded(), format: percent) { v in store.update { $0.controls.adsSensitivity = v / 100 } }
            }
            SettingRow(label: "Look smoothing", note: "Evens out trackpad movement.") {
                LedgerSlider(id: "settings.smoothing", label: "Look smoothing", range: 0...100, step: 5,
                             value: (s.controls.lookSmoothing * 100).rounded(), format: percent) { v in store.update { $0.controls.lookSmoothing = v / 100 } }
            }
            SettingRow(label: "Invert Y") {
                LedgerToggle(id: "settings.invertY", label: "Invert Y", isOn: s.controls.invertY) { on in store.update { $0.controls.invertY = on } }
            }
            SettingRow(label: "Raw input", note: "No pointer acceleration. Best with a mouse.") {
                LedgerToggle(id: "settings.rawInput", label: "Raw input", isOn: s.controls.rawInput) { on in store.update { $0.controls.rawInput = on } }
            }
        }
    }

    private var aim: some View {
        LedgerSection(label: "Aim", inSheet: true) {
            SettingRow(label: "Aim button") {
                Segmented(id: "settings.aimButton", options: [SegmentOption(value: true, label: "Toggle"), SegmentOption(value: false, label: "Hold")],
                          selection: s.controls.adsToggle) { toggle in store.update { $0.controls.adsToggle = toggle } }
            }
            SettingRow(label: "Aim assist", note: "Slows the view over a target and pulls toward it.") {
                LedgerSlider(id: "settings.aimAssist", label: "Aim assist", range: 0...100, step: 5,
                             value: (s.controls.aimAssist * 100).rounded(), format: percent) { v in store.update { $0.controls.aimAssist = v / 100 } }
            }
            SettingRow(label: "Key bindings") {
                LedgerButton("View controls", id: "settings.viewControls") { model.openControlsFromSettings() }
            }
        }
    }

    // MARK: Audio

    private func volume(_ label: String, _ key: WritableKeyPath<AudioSettings, Double>) -> some View {
        SettingRow(label: label) {
            LedgerSlider(id: "settings.volume.\(label)", label: label, range: 0...100, step: 5,
                         value: (s.audio[keyPath: key] * 100).rounded(), format: percent) { v in store.update { $0.audio[keyPath: key] = v / 100 } }
        }
    }

    private var volumes: some View {
        LedgerSection(label: "Volume", inSheet: true) {
            volume("Master", \.master)
            volume("Effects", \.effects)
            volume("Ambience", \.ambience)
            volume("Interface", \.interface)
        }
    }

    private var output: some View {
        LedgerSection(label: "Output", inSheet: true) {
            SettingRow(label: "HRTF positioning", note: "Places sounds around you. Best on headphones.") {
                LedgerToggle(id: "settings.hrtf", label: "HRTF positioning", isOn: s.audio.hrtf) { on in store.update { $0.audio.hrtf = on } }
            }
        }
    }

    // MARK: Gameplay

    private var view: some View {
        LedgerSection(label: "View", inSheet: true) {
            SettingRow(label: "Field of view") {
                LedgerSlider(id: "settings.fov", label: "Field of view", range: 60...100, step: 1, value: s.gameplay.fov,
                             format: { "\(Int($0.rounded()))°" }) { v in store.update { $0.gameplay.fov = v } }
            }
            SettingRow(label: "Head bob") {
                LedgerSlider(id: "settings.headBob", label: "Head bob", range: 0...100, step: 5,
                             value: (s.gameplay.headBob * 100).rounded(), format: percent) { v in store.update { $0.gameplay.headBob = v / 100 } }
            }
        }
    }

    private var hud: some View {
        LedgerSection(label: "HUD", inSheet: true) {
            SettingRow(label: "Crosshair") {
                LedgerToggle(id: "settings.crosshair", label: "Crosshair", isOn: s.gameplay.crosshair) { on in store.update { $0.gameplay.crosshair = on } }
            }
            SettingRow(label: "Hit markers") {
                LedgerToggle(id: "settings.hitMarkers", label: "Hit markers", isOn: s.gameplay.showHitMarkers) { on in store.update { $0.gameplay.showHitMarkers = on } }
            }
            SettingRow(label: "Minimap", note: "Shows the layout around you and where the enemies are.") {
                LedgerToggle(id: "settings.minimap", label: "Minimap", isOn: s.gameplay.minimap) { on in store.update { $0.gameplay.minimap = on } }
            }
            SettingRow(label: "Performance readout") {
                Text("Press ` during a match").font(Ledger.mono(12)).foregroundStyle(Ledger.mute)
            }
        }
    }
}

private struct TabButton: View {
    let title: String
    let selected: Bool
    let id: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Text(title)
            .font(Ledger.sans(14, .medium))
            .foregroundStyle(selected || hovering ? Ledger.ink : Ledger.mute)
            .frame(height: 40)
            .overlay(alignment: .bottom) { Rectangle().fill(selected ? Ledger.ink : .clear).frame(height: 1) }
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
            .onTapGesture(perform: action)
            .navItem(id, activate: action)
            .accessibilityElement()
            .accessibilityLabel(title)
            .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

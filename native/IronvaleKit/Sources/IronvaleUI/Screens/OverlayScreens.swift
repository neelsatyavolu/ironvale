// Ported from src/ui/screens/loading.ts, pause.ts, end.ts, first-run.ts and src/ui/styles/overlay.css at cbe0add.
import SwiftUI

struct LoadingView: View {
    let info: LoadingInfo
    @Environment(\.layoutMetrics) private var metrics
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var tipIndex = 0
    static let tipSeconds: Double = 6

    var body: some View {
        ScreenFrame(solid: true) {
            Page {
                HStack(spacing: 24) {
                    Text("Loading").ledger(.label)
                    Text(info.detail).ledger(.label)
                }
                Spacer(minLength: 48)
                VStack(alignment: .leading, spacing: 0) {
                    Text(info.mapName).font(Ledger.serif(metrics.display)).tracking(-metrics.display * 0.015).foregroundStyle(Ledger.ink)
                    Text(info.tagline).font(Ledger.serif(20)).foregroundStyle(Ledger.mute).padding(.top, 12)
                    GeometryReader { proxy in
                        ZStack(alignment: .leading) {
                            Rectangle().fill(Ledger.line2)
                            Rectangle().fill(Ledger.accent).frame(width: proxy.size.width * info.progress)
                        }
                    }
                    .frame(height: 2)
                    .padding(.top, 48)
                    HStack(spacing: 24) {
                        Text(info.label).foregroundStyle(Ledger.mute)
                        Spacer()
                        Text("\(Int((info.progress * 100).rounded()))%").foregroundStyle(Ledger.ink)
                    }
                    .font(Ledger.mono(12))
                    .padding(.top, 12)
                }
                VStack(alignment: .leading, spacing: 0) {
                    LedgerSection(label: "Controls") {
                        Text(currentTip)
                            .font(Ledger.serif(18)).lineSpacing(18 * 0.6 - 18 * 0.25).foregroundStyle(Ledger.body)
                            .frame(maxWidth: 640, alignment: .leading)
                            .padding(.top, 12)
                            .id(tipIndex)
                            .transition(.opacity.animation(reduceMotion ? nil : .linear(duration: 0.2)))
                    }
                }
                .frame(minHeight: 96, alignment: .top)
                .padding(.top, 48)
            }
            .frame(maxHeight: .infinity)
        }
        .task(id: info.mapName) {
            // Start somewhere new each load so a player sees them all over a few matches.
            tipIndex = info.tips.isEmpty ? 0 : Int.random(in: 0..<info.tips.count)
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.tipSeconds))
                guard !info.tips.isEmpty else { continue }
                tipIndex = (tipIndex + 1) % info.tips.count
            }
        }
    }

    private var currentTip: String { info.tips.isEmpty ? "" : info.tips[tipIndex % info.tips.count] }
}

struct PauseView: View {
    let model: InterfaceModel

    var body: some View {
        ScreenFrame(solid: false) {
            VStack(alignment: .leading, spacing: 0) {
                Text(model.pause.live ? "Match menu" : "Paused").ledger(.title)
                Text(model.pause.detail).font(Ledger.mono(12)).foregroundStyle(Ledger.body).padding(.top, 8)
                VStack(spacing: 8) {
                    LedgerButton("Resume", .primary, id: "pause.resume", wide: true) { model.resume() }
                    LedgerButton("Settings", id: "pause.settings", wide: true) { model.open(.settings) }
                    if !model.pause.live {
                        LedgerButton("Restart", id: "pause.restart", wide: true) { model.restart() }
                    }
                    LedgerButton(model.pause.live ? "Leave the match" : "Quit to menu", id: "pause.quit", wide: true) { model.leaveMatch() }
                }
                .padding(.top, 32)
                Text(model.pause.note).font(Ledger.mono(12)).foregroundStyle(Ledger.warn)
                    .frame(minHeight: 17, alignment: .topLeading).padding(.top, 16)
            }
            .frame(maxWidth: 304, alignment: .leading)
            .padding(.bottom, 96)
        }
    }
}

struct EndView: View {
    let model: InterfaceModel
    @Environment(\.layoutMetrics) private var metrics

    var body: some View {
        ScreenFrame(solid: false) {
            if let result = model.result {
                content(result).frame(maxWidth: 640, alignment: .leading).padding(.horizontal, metrics.gutter).padding(.bottom, 96)
            }
        }
    }

    private func content(_ result: MatchResult) -> some View {
        let duel = result.mode == .duel
        return VStack(alignment: .leading, spacing: 0) {
            Text(result.headline).ledger(.title)
            Text("\(result.mapName) · \(result.modeLine)").font(Ledger.mono(12)).foregroundStyle(Ledger.body).padding(.top, 8)
            FlowRow(spacing: 48) {
                Stat(label: duel ? "You" : "Kills", value: String(result.kills), lead: true)
                if !duel { Stat(label: "Deaths", value: String(result.deaths)) }
                if let friend = result.friend {
                    Stat(label: duel ? friend.name : "Kills, \(friend.name)", value: String(friend.kills))
                }
                Stat(label: "Time", value: Format.clock(result.elapsed))
                if let accuracy = result.accuracy { Stat(label: "Accuracy", value: String(accuracy), unit: "%") }
            }
            .padding(.top, 16)
            .overlay(alignment: .top) { Rectangle().fill(Ledger.line2).frame(height: 1) }
            .padding(.top, 32)
            HStack(spacing: 12) {
                // A duel cannot be replayed alone.
                if !(duel && !result.together) {
                    LedgerButton(result.together ? "Back to lobby" : "Play again", .accent, id: "end.again") { model.endPrimary() }
                }
                LedgerButton(result.together ? "Leave" : "Menu", id: "end.menu") { model.endSecondary() }
            }
            .padding(.top, 32)
        }
    }
}

private struct Stat: View {
    let label: String
    let value: String
    var unit = ""
    var lead = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).ledger(.label)
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text(value).font(Ledger.mono(lead ? 48 : 28)).tracking(lead ? -48 * 0.04 : 0).foregroundStyle(Ledger.ink)
                if !unit.isEmpty { Text(unit).font(Ledger.mono(14)).foregroundStyle(Ledger.mute) }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct FirstRunView: View {
    let model: InterfaceModel

    var body: some View {
        ScreenFrame(solid: model.sheetIsSolid) {
            VStack(alignment: .leading, spacing: 0) {
                Text("Playing on a trackpad").ledger(.headline)
                Text("Click to fire and press Q to raise the sights, so you never have to hold a two-finger click. You can change any of this in Settings.")
                    .ledger(.note).fixedSize(horizontal: false, vertical: true).padding(.top, 8)
                VStack(spacing: 0) {
                    ForEach(WebData.shared.firstRunRows, id: \.label) { row in
                        HStack {
                            Text(row.label).font(Ledger.sans(14)).foregroundStyle(Ledger.mute)
                            Spacer()
                            Text(row.keys.joined()).font(Ledger.mono(13)).foregroundStyle(Ledger.ink)
                        }
                                .padding(.top, 8).padding(.bottom, 7)
                        .overlay(alignment: .bottom) { Rectangle().fill(Ledger.line).frame(height: 1) }
                    }
                }
                .overlay(alignment: .top) { Rectangle().fill(Ledger.line2).frame(height: 1) }
                .padding(.top, 20)
                HStack(spacing: 12) {
                    LedgerButton("Play", .accent, id: "first.play") { model.finishFirstRun(useMouse: false) }
                    LedgerButton("I use a mouse", id: "first.mouse") { model.finishFirstRun(useMouse: true) }
                }
                .padding(.top, 24)
            }
            .padding(24)
            .frame(maxWidth: 448)
            .background(Ledger.card, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Ledger.line2))
            .padding(24)
        }
    }
}

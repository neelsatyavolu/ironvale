// The two in-match pieces that stay in SwiftUI (PLAN.md 3.9): the weapon picker (src/ui/hud/picker.ts,
// styles/picker.css) and the chat box (hud/chat.ts, styles/hud-chat.css) at cbe0add. Both show only
// while open; the Metal HUD draws everything else, including the chat log.
import Foundation
import IronvaleContract
import IronvaleSim
import IronvaleWire
import Observation
import SwiftUI

/// Hold E (or Tab): a panel of the six guns; number keys, A and D, the arrows or a scroll choose; letting go equips.
@MainActor
@Observable
public final class WeaponPicker {
    public let defs: [WeaponDef]
    public private(set) var open = false
    public private(set) var chosen = 0
    public private(set) var locked: Set<String> = []
    /// "30 in the gun, 90 spare", or the locked note, for the chosen gun.
    public private(set) var ammoNote = ""

    public init(defs: [WeaponDef]) {
        self.defs = defs.sorted { $0.slot < $1.slot }
    }

    /// `picker.frame()`: call once a frame, after the input for the frame is known.
    public func frame(held: Bool, alive: Bool, pressed: (Action) -> Bool, currentId: String, carries: (String) -> Bool,
                      ammo: (String) -> (magazine: Int, reserve: Int)?, equip: (Int) -> Void) {
        let holding = held && alive
        if holding && !open {
            open = true
            locked = Set(defs.map(\.id).filter { !carries($0) })
            chosen = max(0, defs.firstIndex { $0.id == currentId } ?? 0)
        } else if !holding && open {
            open = false
            let def = defs[chosen]
            if def.id != currentId { equip(def.slot) }
        }
        guard open else { return }
        var next = chosen
        let slots: [Action] = [.slot1, .slot2, .slot3, .slot4, .slot5, .slot6]
        for (index, action) in slots.enumerated() where index < defs.count && pressed(action) { next = index }
        if pressed(.weaponNext) || pressed(.moveRight) { next = (next + 1) % defs.count }
        if pressed(.weaponPrev) || pressed(.moveLeft) { next = (next + defs.count - 1) % defs.count }
        chosen = next
        let def = defs[chosen]
        if !carries(def.id) { ammoNote = "Locked. \(HUDConstants.shared.reservedNote)" } else if let a = ammo(def.id) {
            ammoNote = "\(a.magazine) in the gun, \(a.reserve) spare"
        } else { ammoNote = "" }
    }

    public var current: WeaponDef { defs[chosen] }

    public var kind: String {
        let def = current
        let mode = def.fireMode == "auto" ? "Automatic" : def.fireMode == "semi" ? "Semi-automatic" : "Bolt action"
        return "\(mode) · \(def.magazineSize) rounds"
    }

    public var blurb: String { HUDConstants.shared.goodAt[current.id] ?? "" }
    public var hint: String { "1 to \(defs.count), A and D or scroll to choose. Let go of E to equip." }
}

/// Two-player chat: the log the HUD draws and the box T opens.
@MainActor
@Observable
public final class HUDChat {
    public private(set) var inputOpen = false
    public var draft = ""
    @ObservationIgnored private var lines: [(line: HUDState.ChatLine, at: Double)] = []
    @ObservationIgnored public var send: (String) -> Void = { _ in }

    public init() {}

    /// A line arrived (or was sent); `now` in seconds of any steady clock.
    public func add(name: String, text: String, mine: Bool, now: Double) {
        lines.append((HUDState.ChatLine(name: name, text: text, mine: mine), now))
        if lines.count > HUDConstants.shared.chatLines { lines.removeFirst(lines.count - HUDConstants.shared.chatLines) }
    }

    /// Lines younger than LINE_SECONDS, oldest first.
    public func visible(now: Double) -> [HUDState.ChatLine] {
        lines.removeAll { now - $0.at >= HUDConstants.shared.chatSeconds }
        return lines.map(\.line)
    }

    public func openInput() { inputOpen = true }

    public func close() {
        inputOpen = false
        draft = ""
    }

    /// Enter: send what was typed (cleaned and cut to 140 as the wire does) and close.
    public func submit() {
        let text = Sanitize.chat(draft)
        if !text.isEmpty { send(text) }
        close()
    }

    public func clear() {
        lines = []
        close()
    }
}

/// The picker panel: tabs 1-6, picture, name, kind, blurb, four bars, ammunition note, hint.
public struct WeaponPickerView: View {
    let picker: WeaponPicker
    /// Folder of `<id>.webp` side views (the web's public/assets/weapons).
    let pictures: URL?

    public init(picker: WeaponPicker, pictures: URL?) {
        self.picker = picker
        self.pictures = pictures
    }

    private static let line = Color(red: 242 / 255, green: 240 / 255, blue: 234 / 255).opacity(0.18)
    private static let mute = Color(red: 242 / 255, green: 240 / 255, blue: 234 / 255).opacity(0.55)
    private static let ink = Color(red: 242 / 255, green: 240 / 255, blue: 234 / 255)

    public var body: some View {
        if picker.open {
            GeometryReader { geo in
                let narrow = geo.size.width <= 760
                ZStack {
                    Color(red: 9 / 255, green: 9 / 255, blue: 8 / 255).opacity(0.7)
                    panel(narrow: narrow).frame(width: min(960, geo.size.width - 48))
                }
            }
            .allowsHitTesting(false)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Weapon picker: \(picker.current.name)")
        }
    }

    private func panel(narrow: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                ForEach(Array(picker.defs.enumerated()), id: \.offset) { index, def in
                    let on = index == picker.chosen
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(def.slot)").font(Ledger.mono(12))
                        if !narrow {
                            Text(def.name).font(Ledger.sans(13)).strikethrough(picker.locked.contains(def.id))
                                .opacity(picker.locked.contains(def.id) ? 0.6 : 1).lineLimit(1)
                        }
                    }
                    .foregroundStyle(on ? Self.ink : Self.mute)
                    .padding(.horizontal, 8).padding(.bottom, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(alignment: .bottom) { Rectangle().fill(on ? Color(red: 0x4C / 255, green: 0x8D / 255, blue: 1) : .clear).frame(height: 2) }
                }
            }
            .overlay(alignment: .bottom) { Rectangle().fill(Self.line).frame(height: 1) }
            let layout = narrow ? AnyLayout(VStackLayout(alignment: .leading, spacing: 16)) : AnyLayout(HStackLayout(alignment: .center, spacing: 32))
            layout {
                picture.frame(maxWidth: .infinity).frame(height: narrow ? 140 : 260).layoutPriority(7)
                text.frame(maxWidth: .infinity, alignment: .leading).layoutPriority(5)
            }
            .padding(.top, 32).padding(.bottom, 24)
            Text(picker.hint).font(Ledger.mono(12)).foregroundStyle(Self.mute)
                .padding(.top, 16).frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .top) { Rectangle().fill(Self.ink.opacity(0.08)).frame(height: 1) }
        }
        .padding(24)
        .background(Color(red: 0x14 / 255, green: 0x14 / 255, blue: 0x13 / 255), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Self.line, lineWidth: 1))
    }

    @ViewBuilder private var picture: some View {
        if let url = pictures?.appending(path: "\(picker.current.id).webp"), let image = NSImage(contentsOf: url) {
            Image(nsImage: image).resizable().scaledToFit()
        } else {
            Color.clear
        }
    }

    private var text: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(picker.current.name).font(Ledger.serif(40)).foregroundStyle(Self.ink).padding(.bottom, 4)
            Text(picker.kind).font(Ledger.mono(12)).foregroundStyle(Self.mute)
            Text(picker.blurb).font(Ledger.serif(18)).foregroundStyle(Self.ink.opacity(0.86)).lineSpacing(9)
                .frame(minHeight: 81, alignment: .topLeading).padding(.top, 16).padding(.bottom, 24)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(HUDMath.weaponStats(picker.current), id: \.label) { stat in
                HStack(spacing: 12) {
                    Text(stat.label).font(Ledger.mono(12)).foregroundStyle(Self.mute).frame(width: 96, alignment: .leading)
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Rectangle().fill(Self.line)
                            Rectangle().fill(Self.ink).frame(width: g.size.width * stat.value)
                        }
                    }
                    .frame(height: 3)
                }
                .padding(.vertical, 6)
            }
            Text(picker.ammoNote).font(Ledger.mono(12)).foregroundStyle(Self.mute).padding(.top, 16)
        }
    }
}

/// The chat box T opens: one line, Enter sends, Esc closes. The log is drawn by the Metal HUD.
public struct ChatInputView: View {
    @Bindable var chat: HUDChat
    @FocusState private var focused: Bool

    public init(chat: HUDChat) { self.chat = chat }

    public var body: some View {
        if chat.inputOpen {
            GeometryReader { geo in
                // Bottom-left, above the health readout: left 1.5em, bottom 7.5em of the chat's 0.875em type.
                let em = HUDScene.em(width: geo.size.width, height: geo.size.height) * 0.875
                TextField("", text: $chat.draft, prompt: Text("Message. Enter sends, Esc closes.").foregroundStyle(Ledger.mute))
                    .textFieldStyle(.plain)
                    .font(Ledger.sans(em))
                    .foregroundStyle(Ledger.ink)
                    .focused($focused)
                    .onSubmit { chat.submit() }
                    .onExitCommand { chat.close() }
                    .onChange(of: chat.draft) { _, text in
                        if text.utf16.count > Sanitize.chatLength { chat.draft = String(String.UnicodeScalarView(text.unicodeScalars.prefix(Sanitize.chatLength))) }
                    }
                    .padding(.vertical, 0.5 * em).padding(.horizontal, 0.75 * em)
                    .background(Color(red: 14 / 255, green: 14 / 255, blue: 13 / 255).opacity(0.82), in: RoundedRectangle(cornerRadius: 4))
                    .overlay(RoundedRectangle(cornerRadius: 4).stroke(focused ? Ledger.accent : Ledger.line2, lineWidth: focused ? 2 : 1))
                    .accessibilityLabel("Chat message")
                    .frame(width: min(26 * em, geo.size.width * 0.4))
                    .position(x: 1.5 * em / 0.875 + min(26 * em, geo.size.width * 0.4) / 2, y: geo.size.height - 7.5 * em - em)
                    .onAppear { focused = true }
            }
        }
    }
}

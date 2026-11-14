// Keyboard navigation for the screens, after src/ui/focus-nav.ts and the key handling in src/ui/index.ts:
// arrow keys move between controls by position (FocusNav.pickNeighbour over their frames), Return or Space
// activates the focused control, Escape goes back. Every control registers through `.navItem`.
import Observation
import SwiftUI

@MainActor
@Observable
public final class FocusNavigator {
    /// Frames of the controls on screen, in the root's coordinate space.
    public internal(set) var frames: [String: CGRect] = [:]
    /// The control with keyboard focus, if any.
    public internal(set) var current: String?
    /// A control asked to take focus; its `.navItem` takes it and clears this.
    var requested: String?
    /// Controls that keep the arrow keys for themselves while focused (text fields).
    var textItems: Set<String> = []

    public init() {}

    public func focus(_ id: String) { requested = id }

    /// Move focus by arrow key. Returns false when there is nowhere to go or a text field has the keys.
    @discardableResult
    public func move(_ direction: NavDirection) -> Bool {
        let ids = frames.keys.sorted()
        guard let current, let index = ids.firstIndex(of: current) else {
            if let first = ids.min(by: { frames[$0]!.minY < frames[$1]!.minY || (frames[$0]!.minY == frames[$1]!.minY && frames[$0]!.minX < frames[$1]!.minX) }) {
                requested = first
                return true
            }
            return false
        }
        if textItems.contains(current) { return false }
        let next = FocusNav.pickNeighbour(ids.map { frames[$0]! }, current: index, direction: direction)
        guard next >= 0 else { return false }
        requested = ids[next]
        return true
    }

    func blur() {
        current = nil
        requested = "__none__"
    }
}

struct NavFramesKey: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue()) { $1 }
    }
}

/// The coordinate space every control's frame is measured in.
let navSpace = "iv-root"

struct NavItemModifier: ViewModifier {
    let id: String
    let enabled: Bool
    let isText: Bool
    let activate: (() -> Void)?
    @Environment(FocusNavigator.self) private var nav
    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        Group {
            if isText {
                content.focused($focused)
            } else {
                content
                    .focusable(enabled, interactions: .activate)
                    .focused($focused)
                    .focusEffectDisabled()
                    .onKeyPress(keys: [.return, .space]) { _ in
                        guard enabled, let activate else { return .ignored }
                        activate()
                        return .handled
                    }
            }
        }
        // :focus-visible from base.css: a 2px accent ring 2px outside the control.
        .overlay {
            RoundedRectangle(cornerRadius: 6)
                .stroke(Ledger.accent, lineWidth: 2)
                .padding(-4)
                .opacity(focused && !isText ? 1 : 0)
                .allowsHitTesting(false)
        }
        .background {
            GeometryReader { proxy in
                Color.clear.preference(key: NavFramesKey.self, value: enabled ? [id: proxy.frame(in: .named(navSpace))] : [:])
            }
        }
        .onChange(of: focused) { _, now in
            if now { nav.current = id } else if nav.current == id { nav.current = nil }
        }
        .onChange(of: nav.requested, initial: true) { _, wanted in
            if wanted == id, enabled {
                focused = true
                nav.requested = nil
            } else if wanted == "__none__", focused {
                focused = false
            }
        }
        .onAppear { if isText { nav.textItems.insert(id) } }
        .onDisappear { nav.textItems.remove(id) }
    }
}

extension View {
    /// Make this view a keyboard-navigable control. `activate` runs on Return or Space.
    func navItem(_ id: String, enabled: Bool = true, activate: (() -> Void)? = nil) -> some View {
        modifier(NavItemModifier(id: id, enabled: enabled, isText: false, activate: activate))
    }

    /// A text input: it takes part in arrow navigation but keeps the arrow keys while it has focus.
    func navTextItem(_ id: String, enabled: Bool = true) -> some View {
        modifier(NavItemModifier(id: id, enabled: enabled, isText: true, activate: nil))
    }
}

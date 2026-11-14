// The interface root the app shows above the Metal view (PLAN.md 3.9). Ported from the screen switch and
// keyboard handling in src/ui/index.ts at cbe0add: one screen at a time, its default control focused when it
// appears, arrows move focus by position, Escape goes back.
import SwiftUI

public struct RootView: View {
    @Bindable var model: InterfaceModel
    let thumbnail: (String) -> Image?
    @State private var navigator = FocusNavigator()

    /// `thumbnail` returns a map's picture by id; the app supplies it from its bundle.
    public init(model: InterfaceModel, thumbnail: @escaping (String) -> Image? = { _ in nil }) {
        self.model = model
        self.thumbnail = thumbnail
    }

    public var body: some View {
        GeometryReader { proxy in
            ZStack {
                if let screen = model.activeScreen {
                    screenView(screen).id(screen)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .environment(\.layoutMetrics, LayoutMetrics(size: proxy.size))
        }
        .coordinateSpace(.named(navSpace))
        .environment(navigator)
        .onPreferenceChange(NavFramesKey.self) { frames in
            MainActor.assumeIsolated { navigator.frames = frames }
        }
        .onKeyPress(keys: [.upArrow, .downArrow, .leftArrow, .rightArrow]) { press in
            navigator.move(Self.direction(press.key)) ? .handled : .ignored
        }
        .onKeyPress(.escape) {
            // The first Escape leaves a text box; the next one goes back.
            if let current = navigator.current, navigator.textItems.contains(current) {
                navigator.blur()
            } else {
                model.back()
            }
            return .handled
        }
        .onKeyPress(.return) {
            guard navigator.current == nil, let screen = model.activeScreen,
                  let id = Self.defaultFocus(screen, model: model) else { return .ignored }
            navigator.focus(id)
            return .handled
        }
        .onChange(of: focusKey, initial: true) {
            guard let screen = model.activeScreen, let id = Self.defaultFocus(screen, model: model) else { return }
            navigator.focus(id)
        }
        .background(Color.clear)
        .preferredColorScheme(.dark)
    }

    /// Changes whenever a different screen or sub-view comes up, so its default control takes focus.
    private var focusKey: String {
        let screen = model.activeScreen?.rawValue ?? "none"
        guard model.activeScreen == .friend else { return screen }
        return "friend.\(FriendViewKind.of(model.lobby.state, invited: model.invitedCode))"
    }

    @ViewBuilder private func screenView(_ screen: ScreenID) -> some View {
        switch screen {
        case .menu: MenuView(model: model, thumbnail: thumbnail)
        case .loading: LoadingView(info: model.loading)
        case .pause: PauseView(model: model)
        case .end: EndView(model: model)
        case .settings: SettingsView(model: model)
        case .controls: ControlsRefView(model: model)
        case .firstRun: FirstRunView(model: model)
        case .friend: FriendScreen(model: model)
        case .credits: CreditsView(model: model)
        }
    }

    static func direction(_ key: KeyEquivalent) -> NavDirection {
        switch key {
        case .upArrow: .up
        case .downArrow: .down
        case .leftArrow: .left
        default: .right
        }
    }

    /// The control a screen focuses when it appears (`data-nav-default` on the web), or nil for none.
    @MainActor
    public static func defaultFocus(_ screen: ScreenID, model: InterfaceModel) -> String? {
        switch screen {
        case .menu: return "menu.play"
        case .loading: return nil
        case .pause: return "pause.resume"
        case .end:
            guard let result = model.result else { return nil }
            return result.mode == .duel && !result.together ? "end.menu" : "end.again"
        case .settings: return "settings.tab.\(model.settingsTab.rawValue)"
        case .controls: return "controls.back"
        case .firstRun: return "first.play"
        case .credits: return "credits.back"
        case .friend:
            let state = model.lobby.state
            switch FriendViewKind.of(state, invited: model.invitedCode) {
            case .invited: return "friend.invited.join"
            case .idle: return "friend.host"
            case .link: return state.code.isEmpty ? "friend.cancel" : "friend.copy"
            case .lobby: return state.role == .host ? (state.peerReady ? "friend.start" : "setup.mode.0") : "friend.ready"
            }
        }
    }
}

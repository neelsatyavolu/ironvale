// Ported from src/ui/screens/controls-ref.ts and credits.ts at cbe0add. Binding rows and credits come from
// the generated web data, so they follow the web bindings and asset manifests.
import SwiftUI

struct ControlsRefView: View {
    let model: InterfaceModel
    @Environment(\.layoutMetrics) private var metrics

    static func scheme(_ preset: ControlPreset) -> String {
        switch preset {
        case .trackpad:
            "On a trackpad a click fires and Space jumps. Aiming is a toggle on Q, because a two-finger click is hard to hold while you look around; a two-finger click still aims if you prefer it, and a two-finger scroll changes weapon."
        case .mouse:
            "The mouse preset is the usual layout: left click fires, right click aims while you hold it, and the wheel changes weapon."
        }
    }

    var body: some View {
        let preset = model.settings.value.controls.preset
        let rows = WebData.shared.bindingRows[preset] ?? []
        SheetPanel(solid: model.sheetIsSolid, backID: "controls.back", onBack: { model.back() }) {
            Text("Controls").ledger(.headline)
            Spacer(minLength: 0)
            Segmented(id: "controls.preset", options: [
                SegmentOption(value: ControlPreset.trackpad, label: "Trackpad"), SegmentOption(value: ControlPreset.mouse, label: "Mouse"),
            ], selection: preset) { next in model.settings.update { $0.controls = WebData.shared.controlPresets[next]! } }
        } content: {
            VStack(alignment: .leading, spacing: 0) {
                Text(Self.scheme(preset))
                    .font(Ledger.serif(18)).foregroundStyle(Ledger.body).lineSpacing(4)
                    .frame(maxWidth: 720, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 24)
                // Two columns filled top to bottom (`grid-auto-flow: column`).
                let half = metrics.stacked ? rows.count : (rows.count + 1) / 2
                TwoColumns {
                    bindingColumn(Array(rows.prefix(half)))
                } right: {
                    bindingColumn(Array(rows.dropFirst(half)))
                }
                .overlay(alignment: .top) { Rectangle().fill(Ledger.line2).frame(height: 1) }
            }
        }
    }

    private func bindingColumn(_ rows: [BindingRow]) -> some View {
        VStack(spacing: 0) {
            ForEach(rows, id: \.label) { row in
                HStack(alignment: .firstTextBaseline, spacing: 16) {
                    Text(row.label).font(Ledger.sans(14)).foregroundStyle(Ledger.body)
                    Spacer(minLength: 0)
                    HStack(spacing: 8) {
                        ForEach(Array(row.keys.enumerated()), id: \.offset) { index, key in
                            if index > 0 { Text("or").font(Ledger.sans(12)).foregroundStyle(Ledger.mute) }
                            Text(key).font(Ledger.mono(13)).foregroundStyle(Ledger.ink)
                        }
                    }
                }
                .frame(minHeight: 40)
                .overlay(alignment: .bottom) { Rectangle().fill(Ledger.line).frame(height: 1) }
            }
        }
    }
}

struct CreditsView: View {
    let model: InterfaceModel
    /// Distance one press of an arrow key scrolls the list.
    static let lineScroll: CGFloat = 80

    /// The groups to show: built from the shipped manifest by the credits model, with the libraries the native app links.
    static var groups: [CreditGroup] { CreditsModel.screenGroups }

    var body: some View {
        SheetPanelScroll(solid: model.sheetIsSolid, onBack: { model.open(nil) }) {
            VStack(alignment: .leading, spacing: 32) {
                (Text("Ironvale is built from work other people gave away. Models and recordings under ")
                    + Text(.init("[CC BY 4.0](\(WebData.shared.ccByURL))"))
                    + Text(" are credited in full below, with the changes made to each. Sources that ask for no credit are thanked by site."))
                    .font(Ledger.serif(18)).foregroundStyle(Ledger.body).tint(Ledger.accent).lineSpacing(4)
                    .frame(maxWidth: 720, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(Self.groups) { group in
                    LedgerSection(label: group.title, meta: String(group.count)) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(group.credited.enumerated()), id: \.offset) { _, line in
                                Text(Self.linked(line.sentence))
                                    .font(Ledger.sans(14)).foregroundStyle(Ledger.body).tint(Ledger.accent)
                                    .frame(maxWidth: 800, alignment: .leading)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .padding(.top, 10).padding(.bottom, 9)
                                    .overlay(alignment: .bottom) { Rectangle().fill(Ledger.line).frame(height: 1) }
                            }
                            if group.credited.isEmpty && group.thanks.isEmpty {
                                Text("No third-party code libraries are linked yet.").ledger(.note).padding(.vertical, 10)
                            }
                            ForEach(Array(group.thanks.enumerated()), id: \.offset) { _, row in thanksRow(row) }
                        }
                        .padding(.top, 12)
                    }
                }
                LedgerSection(label: "Licences", meta: String(CreditsModel.licenceTexts.count)) {
                    VStack(alignment: .leading, spacing: 16) {
                        ForEach(CreditsModel.licenceTexts, id: \.resource) { licence in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(licence.covers).font(Ledger.sans(14, .medium)).foregroundStyle(Ledger.ink)
                                Text(CreditsModel.licenceText(licence) ?? "Shipped with the app as \(licence.resource).")
                                    .font(Ledger.mono(11)).foregroundStyle(Ledger.mute)
                                    .frame(maxWidth: 800, alignment: .leading)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        if let version = CreditsModel.versionLine() {
                            Text(version).font(Ledger.mono(12)).foregroundStyle(Ledger.mute)
                        }
                    }
                    .padding(.top, 12)
                }
            }
        }
    }

    private func thanksRow(_ row: CreditThanks) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Group {
                if let url = URL(string: row.url), !row.url.isEmpty {
                    Text(.init("[\(row.name)](\(url.absoluteString))")).tint(Ledger.accent)
                } else {
                    Text(row.name)
                }
            }
            .font(Ledger.sans(14, .medium)).foregroundStyle(Ledger.ink)
            .frame(width: 240, alignment: .leading)
            Text(row.note).font(Ledger.sans(14)).foregroundStyle(Ledger.mute).frame(maxWidth: .infinity, alignment: .leading)
            Text(row.licence).font(Ledger.mono(12)).foregroundStyle(Ledger.mute)
        }
        .padding(.top, 10).padding(.bottom, 9)
        .overlay(alignment: .bottom) { Rectangle().fill(Ledger.line).frame(height: 1) }
    }

    /// Text with every web address in it turned into a link (credits.ts `linked`).
    static func linked(_ text: String) -> AttributedString {
        var result = AttributedString(text)
        let pattern = #"https?://[^\s),;]*[^\s),;.]"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return result }
        let ns = text as NSString
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).reversed() {
            let urlText = ns.substring(with: match.range)
            guard let range = Range(match.range, in: text),
                  let lower = AttributedString.Index(range.lowerBound, within: result),
                  let upper = AttributedString.Index(range.upperBound, within: result) else { continue }
            var label = urlText.replacingOccurrences(of: #"^https?://"#, with: "", options: .regularExpression)
            if label.hasSuffix("/") { label.removeLast() }
            var piece = AttributedString(label)
            piece.link = URL(string: urlText)
            result.replaceSubrange(lower..<upper, with: piece)
        }
        return result
    }
}

/// The sheet frame for credits: the body itself is a focusable region the arrow keys scroll.
private struct SheetPanelScroll<Content: View>: View {
    let solid: Bool
    let onBack: () -> Void
    @ViewBuilder let content: () -> Content
    @State private var position = ScrollPosition(edge: .top)
    @State private var offset: CGFloat = 0
    @State private var maxOffset: CGFloat = 0

    var body: some View {
        SheetPanel(solid: solid, backID: "credits.back", hints: [("Up and Down", "scroll"), ("Esc", "back")], onBack: onBack,
                   scroll: $position, onScroll: { offset = $0; maxOffset = $1 }) {
            Text("Credits").ledger(.headline)
            Spacer(minLength: 0)
        } content: {
            content()
                .navItem("credits.list")
                .onKeyPress(keys: [.upArrow, .downArrow]) { press in
                    let down = press.key == .downArrow
                    // At an end, let the arrow move focus on to Back.
                    if down ? offset >= maxOffset - 1 : offset <= 0 { return .ignored }
                    let next = min(maxOffset, max(0, offset + (down ? CreditsView.lineScroll : -CreditsView.lineScroll)))
                    position.scrollTo(y: next)
                    return .handled
                }
        }
    }
}

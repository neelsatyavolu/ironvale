// Ported from src/ui/screens/menu.ts and src/ui/styles/menu.css at cbe0add.
import SwiftUI

struct MenuView: View {
    @Bindable var model: InterfaceModel
    /// Map thumbnails, supplied by the app from its bundle. A missing one leaves the flat block, as on the web.
    var thumbnail: (String) -> Image?
    @Environment(\.layoutMetrics) private var metrics

    private var difficulty: Difficulty { model.settings.value.gameplay.difficulty }

    var body: some View {
        ScreenFrame(solid: true) {
            ScrollContainer {
                Page {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Ironvale").font(Ledger.serif(metrics.display)).tracking(-metrics.display * 0.015).foregroundStyle(Ledger.ink)
                        Text("A first-person shooter against bots. Choose a map and set the terms.").ledger(.lede)
                    }
                    .frame(maxWidth: 640, alignment: .leading)

                    grid.padding(.top, 48)
                    actions
                    footer
                }
            }
        }
    }

    @ViewBuilder private var grid: some View {
        if metrics.stacked {
            VStack(alignment: .leading, spacing: 32) { maps; options }
        } else {
            HStack(alignment: .top, spacing: 48) {
                maps.frame(maxWidth: .infinity).layoutPriority(7)
                options.frame(width: max(300, (min(metrics.size.width, Ledger.pageWidth) - 48 - 48) * 5 / 12))
            }
        }
    }

    private var maps: some View {
        LedgerSection(label: "Map", meta: "\(model.maps.count) to choose from") {
            VStack(spacing: 8) {
                ForEach(model.maps) { map in
                    MapCard(map: map, checked: map.id == model.menuChoices.mapId, thumbnail: thumbnail(map.id), compact: metrics.narrow) {
                        model.chooseMenu { $0.mapId = map.id }
                    }
                }
            }
            .padding(.top, 12)
        }
    }

    private var options: some View {
        VStack(alignment: .leading, spacing: 24) {
            LedgerSection(label: "Mode", meta: MenuText.lives(model.menuChoices.mode)) {
                Segmented(id: "menu.mode", options: [
                    SegmentOption(value: MenuChoices.Mode.skirmish, label: "Skirmish"),
                    SegmentOption(value: MenuChoices.Mode.survival, label: "Survival"),
                ], selection: model.menuChoices.mode, wide: true) { mode in model.chooseMenu { $0.mode = mode } }
                    .padding(.top, 12)
                note(MenuText.modeNote(model.menuChoices.mode))
            }
            LedgerSection(label: "Difficulty") {
                Segmented(id: "menu.difficulty", options: Difficulty.allCases.map {
                    SegmentOption(value: $0, label: LobbyText.difficultyName($0))
                }, selection: difficulty, wide: true) { value in model.settings.update { $0.gameplay.difficulty = value } }
                    .padding(.top, 12)
                note(MenuText.difficultyNote(difficulty))
            }
            LedgerSection(label: "Enemies") {
                LedgerSlider(
                    id: "menu.enemies", label: "Enemies",
                    range: Double(MenuChoices.botRange.lowerBound)...Double(MenuChoices.botRange.upperBound),
                    step: 1, value: Double(model.menuChoices.botCount), wide: true,
                    format: { String(Int($0)) }
                ) { value in model.chooseMenu { $0.botCount = Int(value) } }
                    .padding(.top, 12)
                note(MenuText.countNote(model.menuChoices.mode))
            }
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).ledger(.note).fixedSize(horizontal: false, vertical: true)
            .frame(minHeight: 21, alignment: .topLeading).padding(.top, 8)
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 12) {
            FlowRow(spacing: 12) {
                LedgerButton("Play", .accent, id: "menu.play", minWidth: 152) { model.play() }
                LedgerButton("Play with a friend", id: "menu.friend") { model.open(.friend) }
                LedgerButton("Settings", id: "menu.settings") { model.open(.settings) }
                LedgerButton("Controls", id: "menu.controls") { model.open(.controls) }
                LedgerButton("Credits", id: "menu.credits") { model.open(.credits) }
            }
            if !model.menuError.isEmpty {
                Text(model.menuError).font(Ledger.sans(14)).foregroundStyle(Ledger.danger).accessibilityAddTraits(.isStaticText)
            }
        }
        .padding(.top, 16)
        .overlay(alignment: .top) { Rectangle().fill(Ledger.line2).frame(height: 1) }
        .padding(.top, 32)
    }

    private var footer: some View {
        HStack {
            KeyHints(hints: [("Arrows", "move"), ("Enter", "select"), ("Esc", "back")])
            Spacer()
            Text("Metal").ledger(.label)
        }
        .padding(.top, 32)
    }
}

private struct MapCard: View {
    let map: MapInfo
    let checked: Bool
    let thumbnail: Image?
    let compact: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 20) {
            ZStack {
                RoundedRectangle(cornerRadius: 4).fill(hovering ? Ledger.thumbHover : Ledger.hover)
                thumbnail?.resizable().aspectRatio(contentMode: .fill)
            }
            .frame(width: compact ? 104 : 152, height: compact ? 64 : 86)
            .clipShape(RoundedRectangle(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Ledger.line))
            VStack(alignment: .leading, spacing: 2) {
                Text(map.name).font(Ledger.serif(24)).foregroundStyle(Ledger.ink)
                Text(map.tagline).font(Ledger.sans(14)).foregroundStyle(Ledger.mute).lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Circle()
                .fill(checked ? Ledger.ink : .clear)
                .overlay(Circle().strokeBorder(checked ? Ledger.ink : Ledger.field))
                .frame(width: 14, height: 14)
        }
        .padding(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 20))
        .background(hovering ? Ledger.hover : Ledger.card, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(checked ? Ledger.ink : Ledger.line2))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .animation(Ledger.ease, value: hovering)
        .onTapGesture(perform: action)
        .navItem("menu.map.\(map.id)", activate: action)
        .accessibilityElement()
        .accessibilityLabel("\(map.name), \(map.tagline)")
        .accessibilityAddTraits(checked ? [.isButton, .isSelected] : .isButton)
    }
}

/// Lays children left to right and wraps them, like a flex row with `flex-wrap: wrap`.
struct FlowRow: Layout {
    var spacing: CGFloat = 12

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1))
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.items {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [(items: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(items: [Int], width: CGFloat, height: CGFloat)] = []
        var current: (items: [Int], width: CGFloat, height: CGFloat) = ([], 0, 0)
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = current.items.isEmpty ? size.width : current.width + spacing + size.width
            if needed > width, !current.items.isEmpty {
                rows.append(current)
                current = ([index], size.width, size.height)
            } else {
                current = (current.items + [index], needed, max(current.height, size.height))
            }
        }
        if !current.items.isEmpty { rows.append(current) }
        return rows
    }
}

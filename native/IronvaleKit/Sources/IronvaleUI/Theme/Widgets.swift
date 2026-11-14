// Ported from src/ui/controls.ts and src/ui/styles/controls.css, base.css at cbe0add.
import SwiftUI

enum ButtonVariant { case accent, primary, ghost }

/// Ghost buttons on a scrim get a dark wash (overlay.css `.iv-screen--scrim .iv-btn--ghost`).
private struct OnScrimKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var onScrim: Bool {
        get { self[OnScrimKey.self] }
        set { self[OnScrimKey.self] = newValue }
    }
}

struct LedgerButton: View {
    let title: String
    var variant: ButtonVariant = .ghost
    var id: String
    var enabled = true
    var wide = false
    var minWidth: CGFloat?
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.onScrim) private var onScrim

    init(_ title: String, _ variant: ButtonVariant = .ghost, id: String, enabled: Bool = true, wide: Bool = false,
         minWidth: CGFloat? = nil, action: @escaping () -> Void) {
        self.title = title
        self.variant = variant
        self.id = id
        self.enabled = enabled
        self.wide = wide
        self.minWidth = minWidth
        self.action = action
    }

    private var fill: Color {
        switch variant {
        case .accent: hovering ? Ledger.accentHover : Ledger.accent
        case .primary: hovering ? Ledger.primaryHover : Ledger.primary
        case .ghost: hovering ? Ledger.hover : (onScrim ? Ledger.ghostOnScrim : .clear)
        }
    }

    var body: some View {
        Text(title)
            .font(Ledger.sans(14, .medium))
            .lineLimit(1)
            .foregroundStyle(variant == .ghost ? Ledger.ink : Ledger.accentOn)
            .padding(.horizontal, 16)
            .frame(minWidth: minWidth, maxWidth: wide ? .infinity : nil)
            .frame(height: 36)
            .background(fill, in: RoundedRectangle(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(variant == .ghost ? Ledger.line2 : .clear))
            .opacity(enabled ? 1 : 0.4)
            .contentShape(Rectangle())
            .onHover { hovering = enabled && $0 }
            .animation(Ledger.ease, value: hovering)
            .onTapGesture { if enabled { action() } }
            .navItem(id, enabled: enabled, activate: action)
            .accessibilityElement()
            .accessibilityLabel(title)
            .accessibilityAddTraits(.isButton)
    }
}

struct SegmentOption<Value: Hashable>: Identifiable {
    let value: Value
    let label: String
    var id: String { label }
}

/// A row of exclusive choices. `selection` may match none (a custom graphics preset).
struct Segmented<Value: Hashable>: View {
    let id: String
    let options: [SegmentOption<Value>]
    let selection: Value?
    var wide = false
    let onChange: (Value) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                SegmentItem(
                    label: option.label,
                    checked: option.value == selection,
                    first: index == 0,
                    last: index == options.count - 1,
                    wide: wide,
                    id: "\(id).\(index)"
                ) { onChange(option.value) }
            }
        }
        .frame(height: 36)
        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Ledger.field))
        .fixedSize(horizontal: !wide, vertical: false)
        .accessibilityElement(children: .contain)
    }
}

private struct SegmentItem: View {
    let label: String
    let checked: Bool
    let first: Bool
    let last: Bool
    let wide: Bool
    let id: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Text(label)
            .font(Ledger.sans(14, .medium))
            .lineLimit(1)
            .foregroundStyle(checked ? Ledger.canvas : (hovering ? Ledger.ink : Ledger.mute))
            .padding(.horizontal, 12)
            .frame(minWidth: 48, maxWidth: wide ? .infinity : nil, maxHeight: .infinity)
            .background(checked ? Ledger.ink : (hovering ? Ledger.hover : .clear))
            .clipShape(UnevenRoundedRectangle(
                topLeadingRadius: first ? 3 : 0, bottomLeadingRadius: first ? 3 : 0,
                bottomTrailingRadius: last ? 3 : 0, topTrailingRadius: last ? 3 : 0
            ))
            .overlay(alignment: .leading) {
                if !first { Rectangle().fill(Ledger.line2).frame(width: 1) }
            }
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
            .animation(Ledger.ease, value: checked)
            .onTapGesture(perform: action)
            .navItem(id, activate: action)
            .accessibilityElement()
            .accessibilityLabel(label)
            .accessibilityAddTraits(checked ? [.isButton, .isSelected] : .isButton)
    }
}

/// A switch: a state word and a pill whose dot slides across when on.
struct LedgerToggle: View {
    let id: String
    let label: String
    let isOn: Bool
    let onChange: (Bool) -> Void

    var body: some View {
        HStack(spacing: 12) {
            Text(isOn ? "On" : "Off")
                .font(Ledger.mono(12))
                .foregroundStyle(isOn ? Ledger.ink : Ledger.mute)
            ZStack(alignment: .leading) {
                Capsule().fill(isOn ? Ledger.ink : .clear)
                Capsule().strokeBorder(isOn ? Ledger.ink : Ledger.field)
                Circle()
                    .fill(isOn ? Ledger.canvas : Ledger.mute)
                    .frame(width: 10, height: 10)
                    .offset(x: isOn ? 18 : 4)
            }
            .frame(width: 32, height: 18)
        }
        .padding(.leading, 8)
        .frame(height: 36)
        .contentShape(Rectangle())
        .animation(Ledger.ease, value: isOn)
        .onTapGesture { onChange(!isOn) }
        .navItem(id) { onChange(!isOn) }
        .accessibilityElement()
        .accessibilityLabel(label)
        .accessibilityValue(isOn ? "On" : "Off")
        .accessibilityAddTraits(.isToggle)
    }
}

/// A hairline track, the travelled part in ink, the value in mono beside it. Left and right arrows step it.
struct LedgerSlider: View {
    let id: String
    let label: String
    let range: ClosedRange<Double>
    let step: Double
    let value: Double
    var wide = false
    let format: (Double) -> String
    let onChange: (Double) -> Void

    private func snapped(_ raw: Double) -> Double {
        let clamped = min(range.upperBound, max(range.lowerBound, raw))
        return (range.lowerBound + ((clamped - range.lowerBound) / step).rounded() * step)
    }

    var body: some View {
        HStack(spacing: 16) {
            GeometryReader { proxy in
                let share = (value - range.lowerBound) / (range.upperBound - range.lowerBound)
                let fill = proxy.size.width * min(1, max(0, share))
                ZStack(alignment: .leading) {
                    Rectangle().fill(Ledger.line2).frame(height: 2)
                    Rectangle().fill(Ledger.ink).frame(width: fill, height: 2)
                    RoundedRectangle(cornerRadius: 2).fill(Ledger.ink)
                        .frame(width: 8, height: 16)
                        .offset(x: max(0, min(proxy.size.width - 8, fill - 4)))
                }
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0).onChanged { drag in
                    let share = drag.location.x / max(1, proxy.size.width)
                    let next = snapped(range.lowerBound + share * (range.upperBound - range.lowerBound))
                    if next != value { onChange(next) }
                })
            }
            .frame(width: wide ? nil : 152, height: 36)
            .frame(maxWidth: wide ? .infinity : nil)
            .navItem(id)
            .onKeyPress(keys: [.leftArrow, .rightArrow]) { press in
                let next = snapped(value + (press.key == .rightArrow ? step : -step))
                if next != value { onChange(next) }
                return .handled
            }
            Text(format(value))
                .font(Ledger.mono(wide ? 28 : 13))
                .foregroundStyle(Ledger.ink)
                .frame(minWidth: wide ? 32 : 48, alignment: .trailing)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(format(value))
        .accessibilityAdjustableAction { direction in
            let next = snapped(value + (direction == .increment ? step : -step))
            if next != value { onChange(next) }
        }
    }
}

/// A settings row: name and optional note on the left, the control on the right, a hairline below.
struct SettingRow<Control: View>: View {
    let label: String
    var note: String?
    @ViewBuilder let control: () -> Control

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 0) {
                Text(label).font(Ledger.sans(14, .medium)).foregroundStyle(Ledger.ink)
                if let note {
                    Text(note).font(Ledger.sans(13)).foregroundStyle(Ledger.mute).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            control().fixedSize()
        }
        .frame(minHeight: 48)
        .overlay(alignment: .bottom) { Rectangle().fill(Ledger.line).frame(height: 1) }
    }
}

/// A group opened by a strong hairline carrying a label and, on the right, a live value.
struct LedgerSection<Content: View>: View {
    let label: String
    var meta: String = ""
    /// Sheets drop the rule's line and put the gap under the label instead (sheet.css `.iv-sheet__cols .iv-rule`).
    var inSheet = false
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 16) {
                Text(label).ledger(.ruleLabel)
                Spacer(minLength: 0)
                Text(meta).ledger(.ruleMeta)
            }
            .padding(.top, inSheet ? 0 : 12)
            .padding(.bottom, inSheet ? 8 : 0)
            .overlay(alignment: .top) {
                if !inSheet { Rectangle().fill(Ledger.line2).frame(height: 1) }
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Key hints along the bottom of a screen (`.iv-keys`).
struct KeyHints: View {
    let hints: [(String, String)]
    var body: some View {
        HStack(spacing: 24) {
            ForEach(Array(hints.enumerated()), id: \.offset) { _, hint in
                (Text(hint.0).foregroundStyle(Ledger.body) + Text(" \(hint.1)").foregroundStyle(Ledger.mute))
                    .font(Ledger.mono(12))
            }
        }
    }
}

/// A full-window screen: solid canvas or a scrim over the scene, content in a centred column.
struct ScreenFrame<Content: View>: View {
    let solid: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        ZStack {
            (solid ? Ledger.canvas : Ledger.scrim).ignoresSafeArea()
            content()
        }
        .environment(\.onScrim, !solid)
        .transition(.opacity.animation(.timingCurve(0.2, 0, 0, 1, duration: 0.2)))
    }
}

/// `.iv-page`: a centred column, 1168 wide at most, with the web's breakpoint paddings.
struct Page<Content: View>: View {
    @Environment(\.layoutMetrics) private var metrics
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0, content: content)
            .frame(maxWidth: Ledger.pageWidth, alignment: .leading)
            .padding(.top, metrics.pageTop)
            .padding(.bottom, metrics.pageBottom)
            .padding(.horizontal, metrics.gutter)
            .frame(maxWidth: .infinity)
    }
}

/// Window-size breakpoints from base.css (`max-height: 800px`, `min-height: 1000px`, `max-width: 720px`).
struct LayoutMetrics: Equatable {
    var size: CGSize

    var narrow: Bool { size.width <= 720 }
    /// Two-column layouts stack below this width (menu.css, sheet.css, friend.css use 880-960).
    var stacked: Bool { size.width <= 900 }
    var gutter: CGFloat { narrow ? 16 : 24 }
    var pageTop: CGFloat { size.height >= 1000 ? 96 : (size.height <= 800 ? 32 : 48) }
    var pageBottom: CGFloat { size.height >= 1000 ? 32 : 24 }
    var display: CGFloat { narrow ? 44 : (size.height <= 800 ? 56 : 72) }
}

private struct LayoutMetricsKey: EnvironmentKey { static let defaultValue = LayoutMetrics(size: CGSize(width: 1280, height: 800)) }
extension EnvironmentValues {
    var layoutMetrics: LayoutMetrics {
        get { self[LayoutMetricsKey.self] }
        set { self[LayoutMetricsKey.self] = newValue }
    }
}

/// The scroll area of a screen or sheet: as tall as its content, up to the space offered.
struct ScrollContainer<Content: View>: View {
    var indicators: ScrollIndicatorVisibility = .never
    var scroll: Binding<ScrollPosition>? = nil
    var onScroll: ((_ offset: CGFloat, _ maxOffset: CGFloat) -> Void)? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        FitHeight {
                ScrollView(content: content)
                    .scrollIndicators(indicators)
                    .scrollPosition(scroll ?? .constant(ScrollPosition()))
                    .onScrollGeometryChange(for: CGSize.self) { geometry in
                        CGSize(width: geometry.contentOffset.y, height: max(0, geometry.contentSize.height - geometry.containerSize.height))
                    } action: { _, value in
                        onScroll?(value.width, value.height)
                    }
        }
    }
}

/// Takes its child's natural height, or the offered height when that is less, and pins the child to the top.
/// A sheet then ends where its content does instead of always filling the window (sheet.css `max-height: 100%`).
struct FitHeight: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        let natural = child.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil))
        return CGSize(width: proposal.width ?? natural.width, height: min(proposal.height ?? natural.height, natural.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}

// The sheet frame from src/ui/styles/sheet.css at cbe0add: a card panel with a head, optional tabs,
// a scrolling body and a foot with Back and key hints.
import SwiftUI

struct SheetPanel<Head: View, Tabs: View, Content: View>: View {
    let solid: Bool
    let backID: String
    var hints: [(String, String)] = [("Esc", "back")]
    let onBack: () -> Void
    /// Credits drive the body's scroll from the keyboard; other sheets leave these nil.
    var scroll: Binding<ScrollPosition>? = nil
    var onScroll: ((_ offset: CGFloat, _ maxOffset: CGFloat) -> Void)? = nil
    @ViewBuilder let head: () -> Head
    @ViewBuilder let tabs: () -> Tabs
    @ViewBuilder let content: () -> Content
    @Environment(\.layoutMetrics) private var metrics

    private var outer: CGFloat { metrics.narrow ? 16 : (metrics.size.height <= 800 ? 24 : 48) }

    var body: some View {
        ScreenFrame(solid: solid) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center, spacing: 24, content: head)
                    .frame(minHeight: 36)
                    .padding([.top, .horizontal], 24)
                tabs()
                ScrollContainer(indicators: .automatic, scroll: scroll, onScroll: onScroll) {
                    content()
                        .padding(.horizontal, 24)
                        .padding(.vertical, metrics.size.height <= 800 ? 16 : 24)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                HStack(spacing: 24) {
                    LedgerButton("Back", id: backID, action: onBack)
                    KeyHints(hints: hints)
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 16)
                .padding(.horizontal, 24)
                .overlay(alignment: .top) { Rectangle().fill(Ledger.line2).frame(height: 1) }
            }
            .frame(maxWidth: Ledger.sheetWidth)
            .background(Ledger.card, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Ledger.line2))
            .padding(.horizontal, outer)
            .padding(.top, metrics.size.height >= 1000 ? 96 : outer)
            .padding(.bottom, outer)
            .frame(maxHeight: .infinity, alignment: .top)
        }
    }
}

extension SheetPanel where Tabs == EmptyView {
    init(solid: Bool, backID: String, hints: [(String, String)] = [("Esc", "back")], onBack: @escaping () -> Void,
         scroll: Binding<ScrollPosition>? = nil, onScroll: ((CGFloat, CGFloat) -> Void)? = nil,
         @ViewBuilder head: @escaping () -> Head, @ViewBuilder content: @escaping () -> Content) {
        self.init(solid: solid, backID: backID, hints: hints, onBack: onBack, scroll: scroll, onScroll: onScroll,
                  head: head, tabs: { EmptyView() }, content: content)
    }
}

/// Two equal columns 48 apart, stacked on narrow windows (`.iv-sheet__cols`).
struct TwoColumns<Left: View, Right: View>: View {
    var spacing: CGFloat = 48
    @ViewBuilder let left: () -> Left
    @ViewBuilder let right: () -> Right
    @Environment(\.layoutMetrics) private var metrics

    var body: some View {
        if metrics.stacked {
            VStack(alignment: .leading, spacing: 32) { left(); right() }
        } else {
            HStack(alignment: .top, spacing: spacing) {
                left().frame(maxWidth: .infinity, alignment: .topLeading)
                right().frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
    }
}

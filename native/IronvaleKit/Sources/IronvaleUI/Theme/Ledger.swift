// The web interface's "Ledger" tokens (src/ui/styles/base.css at cbe0add), dark only: the game draws
// its own scene, so the interface never follows the system theme.
import SwiftUI

public enum Ledger {
    static func rgb(_ hex: UInt32, _ alpha: Double = 1) -> Color {
        Color(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }

    static let canvas = rgb(0x0E0E0D)
    static let card = rgb(0x141413)
    static let hover = rgb(0x1A1A18)
    static let thumbHover = rgb(0x21211F)
    static let ink = rgb(0xF2F0EA)
    static let body = rgb(0xF2F0EA, 0.86)
    static let mute = rgb(0xF2F0EA, 0.55)
    static let stone = rgb(0xF2F0EA, 0.28)
    static let line = rgb(0xF2F0EA, 0.08)
    static let line2 = rgb(0xF2F0EA, 0.18)
    static let field = rgb(0xF2F0EA, 0.42)
    static let primary = rgb(0xF2F0EA)
    static let primaryOn = rgb(0x0E0E0D)
    static let primaryHover = rgb(0xE4E1D9)
    static let accent = rgb(0x4C8DFF)
    static let accentHover = rgb(0x6FA3FF)
    static let accentOn = rgb(0x0E0E0D)
    static let wash = rgb(0x4C8DFF, 0.1)
    static let danger = rgb(0xEE5A4B)
    static let warn = rgb(0xD9A23A)
    static let scrim = rgb(0x090908, 0.7)
    /// Ghost buttons on a scrim sit on a dark wash so the scene does not show through them.
    static let ghostOnScrim = rgb(0x0E0E0D, 0.6)

    /// Fonts bundled by the app (OFL). If one is missing SwiftUI falls back to the system face.
    static func serif(_ size: CGFloat) -> Font { .custom("Newsreader", size: size) }
    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .custom("Geist", size: size).weight(weight) }
    static func mono(_ size: CGFloat) -> Font { .custom("Geist Mono", size: size).monospacedDigit() }

    static let ease = Animation.timingCurve(0.2, 0, 0, 1, duration: 0.15)
    /// `.iv-page`: content column width and padding.
    static let pageWidth: CGFloat = 1168
    static let sheetWidth: CGFloat = 976
}

/// Text styles from base.css, applied as modifiers so screens read like the web markup.
enum LedgerText {
    case display, title, headline, lede, label, note, ruleLabel, ruleMeta

    var font: Font {
        switch self {
        case .display: Ledger.serif(72)
        case .title: Ledger.serif(40)
        case .headline: Ledger.serif(24)
        case .lede: Ledger.serif(20)
        case .label, .ruleLabel, .ruleMeta: Ledger.mono(12)
        case .note: Ledger.sans(14)
        }
    }

    var color: Color {
        switch self {
        case .display, .title, .headline, .ruleLabel: Ledger.ink
        case .lede: Ledger.body
        case .label, .note, .ruleMeta: Ledger.mute
        }
    }

    var tracking: CGFloat {
        switch self {
        case .display: -72 * 0.015
        case .title: -0.4
        default: 0
        }
    }
}

extension View {
    func ledger(_ style: LedgerText) -> some View {
        font(style.font).foregroundStyle(style.color).tracking(style.tracking)
    }
}

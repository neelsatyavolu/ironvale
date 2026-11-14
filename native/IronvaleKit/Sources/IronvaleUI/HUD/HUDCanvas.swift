// The HUD's draw list: one GPU item per shape or glyph, in points, drawn in order by Shaders/Hud.metal.
// Every item carries the HUD element it belongs to, so tests can ask what is on screen without a GPU.
import Foundation
import simd

/// One instanced quad for `hudFragment`. Layout matches `HudItem` in Shaders/Hud.metal (96 bytes).
public struct HUDGPUItem: Sendable, Equatable {
    public var rect: SIMD4<Float>
    public var color: SIMD4<Float>
    public var p0: SIMD4<Float>
    public var p1: SIMD4<Float>
    public var p2: SIMD4<Float>
    public var kind: SIMD4<UInt32>

    public enum Kind: UInt32, Sendable {
        case rect = 0, glyph = 1, arc = 2, disc = 3, segment = 4, triangle = 5, minimap = 6, scope = 7, vignette = 8, ring = 9
    }
}

/// The HUD elements of the inventory (docs/native-port/maps/audio-ui.md 5.4), so a draw list can be checked by element.
public enum HUDElement: String, Sendable, CaseIterable {
    case status, net, minimap, chat, feed, health, ammo, grenade, crosshair, hitMarker, damageArcs, reload, toast, death,
         vignette, grade, scope, perf, killNote, enemyBars
}

/// Builds a frame's items. Text goes through the MTSDF atlas with the HUD's dark text shadow.
public struct HUDCanvas {
    public let font: MSDFFont
    /// Pixels per point on the target.
    public let pointScale: Double
    public private(set) var items: [HUDGPUItem] = []
    public private(set) var owners: [HUDElement] = []
    /// What each element wrote, for tests and the accessibility summary.
    public private(set) var texts: [HUDElement: [String]] = [:]
    var element: HUDElement = .status

    public init(font: MSDFFont, pointScale: Double) {
        self.font = font
        self.pointScale = pointScale
    }

    public func has(_ element: HUDElement) -> Bool { owners.contains(element) }
    public func text(of element: HUDElement) -> [String] { texts[element] ?? [] }

    mutating func push(_ kind: HUDGPUItem.Kind, rect: (Double, Double, Double, Double), color: HUDColor,
                       p0: SIMD4<Float> = .zero, p1: SIMD4<Float> = .zero, p2: SIMD4<Float> = .zero) {
        items.append(HUDGPUItem(rect: SIMD4(Float(rect.0), Float(rect.1), Float(rect.2), Float(rect.3)),
                                color: SIMD4(color.r, color.g, color.b, color.a), p0: p0, p1: p1, p2: p2,
                                kind: SIMD4(kind.rawValue, 0, 0, 0)))
        owners.append(element)
    }

    // MARK: Shapes

    /// A filled box; `radius` rounds its corners.
    mutating func rect(_ x: Double, _ y: Double, _ w: Double, _ h: Double, _ color: HUDColor, radius: Double = 0) {
        guard w > 0, h > 0, color.a > 0 else { return }
        push(.rect, rect: (x, y, w, h), color: color, p0: SIMD4(Float(radius), 0, 0, 0))
    }

    /// A 1-point CSS `outline` (or border) around a box.
    mutating func outline(_ x: Double, _ y: Double, _ w: Double, _ h: Double, width: Double, _ color: HUDColor) {
        rect(x - width, y - width, w + 2 * width, width, color)
        rect(x - width, y + h, w + 2 * width, width, color)
        rect(x - width, y, width, h, color)
        rect(x + w, y, width, h, color)
    }

    mutating func disc(cx: Double, cy: Double, radius: Double, _ color: HUDColor) {
        let pad = radius + 2
        push(.disc, rect: (cx - pad, cy - pad, pad * 2, pad * 2), color: color, p0: SIMD4(Float(cx), Float(cy), Float(radius), 0))
    }

    /// A stroked circle of `radius` (to the middle of the line), `width` wide.
    mutating func ring(cx: Double, cy: Double, radius: Double, width: Double, _ color: HUDColor) {
        let pad = radius + width + 2
        push(.ring, rect: (cx - pad, cy - pad, pad * 2, pad * 2), color: color,
             p0: SIMD4(Float(cx), Float(cy), Float(radius), Float(width / 2)))
    }

    /// A stroked arc with butt caps; angles in radians clockwise from straight up.
    mutating func arc(cx: Double, cy: Double, radius: Double, width: Double, from start: Double, to end: Double, _ color: HUDColor) {
        let pad = radius + width + 2
        push(.arc, rect: (cx - pad, cy - pad, pad * 2, pad * 2), color: color,
             p0: SIMD4(Float(cx), Float(cy), Float(radius), Float(width / 2)), p1: SIMD4(Float(start), Float(end), 0, 0))
    }

    /// A line with round ends (`square` extends the ends by half the width first, as SVG's square caps do).
    mutating func segment(_ ax: Double, _ ay: Double, _ bx: Double, _ by: Double, width: Double, _ color: HUDColor, square: Bool = false) {
        var a = SIMD2(ax, ay), b = SIMD2(bx, by)
        if square, simd_length(b - a) > 0 {
            let d = simd_normalize(b - a) * (width / 2)
            a -= d
            b += d
        }
        let pad = width + 2
        let lo = simd_min(a, b) - pad, hi = simd_max(a, b) + pad
        push(.segment, rect: (lo.x, lo.y, hi.x - lo.x, hi.y - lo.y), color: color,
             p0: SIMD4(Float(a.x), Float(a.y), Float(b.x), Float(b.y)), p1: SIMD4(Float(width / 2), 0, 0, 0))
    }

    /// A filled triangle, grown by `outset` points (a stroke drawn under it).
    mutating func triangle(_ a: SIMD2<Double>, _ b: SIMD2<Double>, _ c: SIMD2<Double>, outset: Double = 0, _ color: HUDColor) {
        let pad = outset + 2
        let lo = simd_min(simd_min(a, b), c) - pad, hi = simd_max(simd_max(a, b), c) + pad
        push(.triangle, rect: (lo.x, lo.y, hi.x - lo.x, hi.y - lo.y), color: color,
             p0: SIMD4(Float(a.x), Float(a.y), Float(b.x), Float(b.y)), p1: SIMD4(Float(c.x), Float(c.y), Float(outset), 0))
    }

    mutating func fullscreen(_ kind: HUDGPUItem.Kind, width: Double, height: Double, alpha: Double, p0: SIMD4<Float> = .zero) {
        push(kind, rect: (0, 0, width, height), color: HUDColor(1, 1, 1, Float(alpha)), p0: p0)
    }

    /// The minimap raster, turned about the player: `toTexture` maps a point on screen to texture coordinates.
    mutating func minimap(cx: Double, cy: Double, radius: Double, toTexture m: simd_double3x2, alpha: Double) {
        push(.minimap, rect: (cx - radius - 1, cy - radius - 1, radius * 2 + 2, radius * 2 + 2), color: HUDColor(1, 1, 1, Float(alpha)),
             p0: SIMD4(Float(cx), Float(cy), Float(radius), 0),
             p1: SIMD4(Float(m[0].x), Float(m[1].x), Float(m[2].x), 0),
             p2: SIMD4(Float(m[0].y), Float(m[1].y), Float(m[2].y), 0))
    }

    // MARK: Text

    public enum Align { case left, center, right }

    /// Text shadow of the HUD (`.iv-hud` text-shadow): a tight dark edge and a soft shade.
    public struct Shadow: Sendable {
        public var layers: [(blur: Double, dy: Double, color: HUDColor)]
        public static let hud = Shadow(layers: [(1.2, 1, HUDColor(9 / 255, 9 / 255, 8 / 255, 0.5)), (0.6, 0, HUDColor(9 / 255, 9 / 255, 8 / 255, 0.95))])
        public static let none = Shadow(layers: [])
    }

    /// Width of `string` in points.
    public func measure(_ string: String, face: MSDFFont.Face, size: Double, tracking: Double = 0) -> Double {
        font.layout(string, face: face, size: size, tracking: tracking).width
    }

    /// Baseline of a CSS line box `lineHeight` (multiple of the size) tall whose top is `top`.
    public func baseline(top: Double, face: MSDFFont.Face, size: Double, lineHeight: Double = 1) -> Double {
        let v = font.variants[face.rawValue]
        let ascent = -v.ascender, descent = v.descender
        return top + ((lineHeight - (ascent + descent)) / 2 + ascent) * size
    }

    /// Draws one line with its left, centre or right end at `x` and its baseline at `baseline`. Returns its width.
    @discardableResult
    mutating func text(_ string: String, x: Double, baseline: Double, face: MSDFFont.Face, size: Double, color: HUDColor,
                       align: Align = .left, tracking: Double = 0, shadow: Shadow = .hud) -> Double {
        guard !string.isEmpty, color.a > 0 else { return 0 }
        texts[element, default: []].append(string)
        let line = font.layout(string, face: face, size: size, tracking: tracking)
        let left: Double = switch align {
        case .left: x
        case .center: x - line.width / 2
        case .right: x - line.width
        }
        let unitsToPixels = font.distanceRange * size * pointScale / font.emPixels
        for layer in shadow.layers {
            for g in line.glyphs {
                push(.glyph, rect: (left + g.x0, baseline + g.y0 + layer.dy, g.x1 - g.x0, g.y1 - g.y0), color: layer.color.alpha(Double(color.a)),
                     p0: SIMD4(Float(g.u0), Float(g.v0), Float(g.u1), Float(g.v1)),
                     p1: SIMD4(Float(unitsToPixels), Float(layer.blur), Float(layer.blur * 0.5), 0))
            }
        }
        for g in line.glyphs {
            push(.glyph, rect: (left + g.x0, baseline + g.y0, g.x1 - g.x0, g.y1 - g.y0), color: color,
                 p0: SIMD4(Float(g.u0), Float(g.v0), Float(g.u1), Float(g.v1)), p1: SIMD4(Float(unitsToPixels), 0, 0, 0))
        }
        return line.width
    }
}

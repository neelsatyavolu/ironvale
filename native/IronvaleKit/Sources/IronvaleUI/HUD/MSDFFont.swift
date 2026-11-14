// The HUD's text: an MTSDF atlas of Geist Mono 400/500, Newsreader and Geist baked by native/Tools/hud-font/build.sh
// (msdf-atlas-gen JSON layout, y origin at the top). Lays out single lines in points; the renderer draws them.
import Foundation

public struct MSDFFont: Sendable {
    public enum Face: Int, Sendable, CaseIterable {
        case mono = 0, monoMedium = 1, serif = 2, sans = 3
    }

    public struct Glyph: Sendable {
        public let advance: Double
        /// Quad relative to the pen on the baseline, in ems (y down).
        public let plane: (left: Double, top: Double, right: Double, bottom: Double)?
        /// Atlas pixels.
        public let atlas: (left: Double, top: Double, right: Double, bottom: Double)?
    }

    public struct Variant: Sendable {
        public let ascender: Double
        public let descender: Double
        public let lineHeight: Double
        public let glyphs: [UInt32: Glyph]
        public let kerning: [UInt64: Double]
    }

    public let width: Int
    public let height: Int
    /// The SDF range in atlas pixels.
    public let distanceRange: Double
    /// Atlas pixels per em.
    public let emPixels: Double
    public let variants: [Variant]

    public struct DecodeError: Error, CustomStringConvertible { public let description: String }

    public init(json data: Data) throws {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let atlas = root["atlas"] as? [String: Any],
              let variants = root["variants"] as? [[String: Any]] else { throw DecodeError(description: "not an msdf-atlas-gen layout") }
        guard atlas["yOrigin"] as? String == "top" else { throw DecodeError(description: "atlas must be baked with -yorigin top") }
        width = atlas["width"] as? Int ?? 0
        height = atlas["height"] as? Int ?? 0
        distanceRange = atlas["distanceRange"] as? Double ?? 0
        emPixels = atlas["size"] as? Double ?? 0
        guard width > 0, height > 0, distanceRange > 0, emPixels > 0 else { throw DecodeError(description: "bad atlas header") }
        self.variants = try variants.map { variant in
            guard let metrics = variant["metrics"] as? [String: Any], let glyphs = variant["glyphs"] as? [[String: Any]] else {
                throw DecodeError(description: "variant without metrics or glyphs")
            }
            func rect(_ value: Any?) -> (left: Double, top: Double, right: Double, bottom: Double)? {
                guard let r = value as? [String: Double], let l = r["left"], let t = r["top"], let rr = r["right"], let b = r["bottom"] else { return nil }
                return (l, t, rr, b)
            }
            var table: [UInt32: Glyph] = [:]
            for glyph in glyphs {
                guard let code = glyph["unicode"] as? Int else { continue }
                table[UInt32(code)] = Glyph(advance: glyph["advance"] as? Double ?? 0, plane: rect(glyph["planeBounds"]), atlas: rect(glyph["atlasBounds"]))
            }
            var kerning: [UInt64: Double] = [:]
            for pair in variant["kerning"] as? [[String: Any]] ?? [] {
                guard let a = pair["unicode1"] as? Int, let b = pair["unicode2"] as? Int, let adv = pair["advance"] as? Double else { continue }
                kerning[UInt64(a) << 32 | UInt64(b)] = adv
            }
            return Variant(ascender: metrics["ascender"] as? Double ?? -1, descender: metrics["descender"] as? Double ?? 0.25,
                           lineHeight: metrics["lineHeight"] as? Double ?? 1.2, glyphs: table, kerning: kerning)
        }
        guard self.variants.count == Face.allCases.count else { throw DecodeError(description: "expected \(Face.allCases.count) faces") }
    }

    /// Loads `hud-atlas.json` from `directory` (the app's Resources, or the source tree in tests).
    public static func load(directory: URL) throws -> MSDFFont {
        try MSDFFont(json: Data(contentsOf: directory.appending(path: "hud-atlas.json")))
    }

    /// One glyph placed by `layout`: a quad in points relative to the line's left end on the baseline, and its atlas rect.
    public struct Placed: Sendable {
        public let x0, y0, x1, y1: Double
        public let u0, v0, u1, v1: Double
    }

    public struct Line: Sendable {
        public let width: Double
        public let glyphs: [Placed]
    }

    /// Lays out `text` at `size` points per em; `tracking` is CSS letter-spacing in ems.
    public func layout(_ text: String, face: Face, size: Double, tracking: Double = 0) -> Line {
        let variant = variants[face.rawValue]
        var pen = 0.0
        var placed: [Placed] = []
        var previous: UInt32?
        let fallback = variant.glyphs[0x3F]
        for scalar in text.unicodeScalars {
            let code = scalar.value
            guard let glyph = variant.glyphs[code] ?? fallback else { continue }
            if let previous, let kern = variant.kerning[UInt64(previous) << 32 | UInt64(code)] { pen += kern * size }
            if let p = glyph.plane, let a = glyph.atlas {
                placed.append(Placed(x0: pen + p.left * size, y0: p.top * size, x1: pen + p.right * size, y1: p.bottom * size,
                                     u0: a.left / Double(width), v0: a.top / Double(height),
                                     u1: a.right / Double(width), v1: a.bottom / Double(height)))
            }
            pen += glyph.advance * size + tracking * size
            previous = code
        }
        // CSS adds letter-spacing after every character, the last one included.
        return Line(width: pen, glyphs: placed)
    }

    /// Height of capital letters above the baseline, in points (for vertical centring).
    public func capHeight(face: Face, size: Double) -> Double {
        let h = variants[face.rawValue].glyphs[0x48]?.plane.map { -$0.top } ?? 0.7
        return h * size
    }
}

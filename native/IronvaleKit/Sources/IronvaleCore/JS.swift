// Ported from src/core/random.ts and the JS numeric semantics used by src/net/protocol.ts,
// src/net/events.ts and src/net/limits.ts at commit cbe0add (PLAN.md 5.1).
import Foundation

/// JavaScript numeric and string semantics that are part of the cross-play contract.
public enum JS {
    /// `Math.round`: halves go toward +infinity (-2.5 -> -2), unlike Swift's `.rounded()`.
    public static func round(_ x: Double) -> Double {
        guard x.isFinite else { return x }
        // Integers and anything at or past 2^52 are already whole; adding 0.5 there would round.
        if x.magnitude >= 4_503_599_627_370_496 { return x }
        let floor = x.rounded(.down)
        let result = (x - floor >= 0.5) ? floor + 1 : floor
        // Math.round keeps the sign of zero: Math.round(-0.4) is -0.
        return result == 0 ? (x.sign == .minus ? -0.0 : 0.0) : result
    }

    /// The `%` operator: truncated remainder, sign of the dividend (`fmod`, not `remainder`).
    public static func mod(_ a: Double, _ b: Double) -> Double { fmod(a, b) }

    /// `Math.imul(a, b) >>> 0`.
    public static func imul(_ a: UInt32, _ b: UInt32) -> UInt32 { a &* b }

    /// `string.length`: UTF-16 code units.
    public static func length(_ text: String) -> Int { text.utf16.count }

    /// `Number.isInteger`.
    public static func isInteger(_ x: Double) -> Bool { x.isFinite && x.rounded(.towardZero) == x }

    /// The characters JavaScript's `\s` and `String.prototype.trim` treat as white space.
    public static func isWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }

    /// `String.prototype.trim`.
    public static func trim(_ text: String) -> String {
        let scalars = text.unicodeScalars
        guard let first = scalars.firstIndex(where: { !isWhitespace($0) }) else { return "" }
        let last = scalars.lastIndex(where: { !isWhitespace($0) })!
        return String(scalars[first...last])
    }

    /// `text.replace(/\s+/g, ' ')`.
    public static func collapseWhitespace(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        var inRun = false
        for scalar in text.unicodeScalars {
            if isWhitespace(scalar) {
                if !inRun { out.append(" ") }
                inRun = true
            } else {
                out.append(scalar)
                inRun = false
            }
        }
        return String(out)
    }

    /// `text.slice(0, count)` on UTF-16 code units. A surrogate pair cut in half leaves a lone
    /// surrogate in JavaScript; a Swift `String` cannot hold one, so it becomes U+FFFD here
    /// (what `String.prototype.toWellFormed` gives on the web side).
    public static func slice(_ text: String, _ count: Int) -> String {
        let units = text.utf16
        guard units.count > count else { return text }
        return String(decoding: Array(units.prefix(count)), as: UTF16.self)
    }

    /// `Number.prototype.toString()` (and `JSON.stringify` for finite numbers): the shortest
    /// round-tripping digits, laid out by the ECMAScript Number::toString rules.
    public static func numberString(_ value: Double) -> String {
        if value.isNaN { return "NaN" }
        if value.isInfinite { return value < 0 ? "-Infinity" : "Infinity" }
        if value == 0 { return "0" }
        let negative = value < 0
        let (digits, n) = shortestDigits(value.magnitude)
        let k = digits.count
        var out = negative ? "-" : ""
        if k <= n && n <= 21 {
            out += digits + String(repeating: "0", count: n - k)
        } else if 0 < n && n <= 21 {
            let cut = digits.index(digits.startIndex, offsetBy: n)
            out += digits[..<cut] + "." + digits[cut...]
        } else if -6 < n && n <= 0 {
            out += "0." + String(repeating: "0", count: -n) + digits
        } else {
            let exponent = n - 1
            let sign = exponent < 0 ? "-" : "+"
            let head = digits.prefix(1)
            let tail = digits.dropFirst()
            out += head + (tail.isEmpty ? "" : "." + tail) + "e" + sign + String(exponent.magnitude)
        }
        return out
    }

    /// Digits d1...dk (no leading or trailing zeros) and n such that value = 0.d1...dk x 10^n,
    /// taken from Swift's shortest round-trip description.
    private static func shortestDigits(_ value: Double) -> (String, Int) {
        let text = value.description
        var mantissa = Substring(text)
        var exponent = 0
        if let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mantissa = text[..<e]
            exponent = Int(text[text.index(after: e)...])!
        }
        let parts = mantissa.split(separator: ".", omittingEmptySubsequences: false)
        let integer = String(parts[0])
        let fraction = parts.count > 1 ? String(parts[1]) : ""
        var all = integer + fraction
        var point = integer.count + exponent
        while all.hasPrefix("0") {
            all.removeFirst()
            point -= 1
        }
        while all.hasSuffix("0") { all.removeLast() }
        return (all, point)
    }
}

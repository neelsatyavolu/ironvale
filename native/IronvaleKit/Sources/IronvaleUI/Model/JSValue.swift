// Ported from src/core/settings.ts and src/ui/dom.ts (readStored) at cbe0add: the JSON semantics those rely on.
import Foundation

/// A parsed JSON value with the distinctions JavaScript's `typeof` makes. Objects keep key order so
/// `stringify` writes keys in the order `JSON.stringify` would for objects built the same way.
public enum JSValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSValue])
    case object([(String, JSValue)])

    public static func == (lhs: JSValue, rhs: JSValue) -> Bool {
        switch (lhs, rhs) {
        case (.null, .null): true
        case let (.bool(a), .bool(b)): a == b
        case let (.number(a), .number(b)): a == b
        case let (.string(a), .string(b)): a == b
        case let (.array(a), .array(b)): a == b
        case let (.object(a), .object(b)): a.count == b.count && zip(a, b).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
        default: false
        }
    }

    /// JavaScript's `typeof` for this value (`null` and arrays are "object").
    public var typeName: String {
        switch self {
        case .null, .array, .object: "object"
        case .bool: "boolean"
        case .number: "number"
        case .string: "string"
        }
    }

    public subscript(key: String) -> JSValue? {
        guard case let .object(pairs) = self else { return nil }
        return pairs.last { $0.0 == key }?.1
    }

    public var isRecord: Bool {
        if case .object = self { return true }
        return false
    }

    /// `JSON.parse`, or nil where it would throw.
    public static func parse(_ text: String) -> JSValue? {
        guard let data = text.data(using: .utf8),
              let any = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        else { return nil }
        return from(any)
    }

    private static func from(_ any: Any) -> JSValue? {
        switch any {
        case is NSNull: return .null
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(number.boolValue) }
            return .number(number.doubleValue)
        case let string as String: return .string(string)
        case let array as [Any]:
            let items = array.compactMap(from)
            return items.count == array.count ? .array(items) : nil
        case let dictionary as [String: Any]:
            // JSONSerialization drops key order; settings code only reads stored objects by key, so sort for determinism.
            var pairs: [(String, JSValue)] = []
            for key in dictionary.keys.sorted() {
                guard let value = dictionary[key].flatMap(from) else { return nil }
                pairs.append((key, value))
            }
            return .object(pairs)
        default: return nil
        }
    }

    /// `JSON.stringify` with no indentation.
    public func stringify() -> String {
        switch self {
        case .null: return "null"
        case let .bool(value): return value ? "true" : "false"
        case let .number(value): return value.isFinite ? JSNumber.string(value) : "null"
        case let .string(value): return JSValue.quote(value)
        case let .array(items): return "[" + items.map { $0.stringify() }.joined(separator: ",") + "]"
        case let .object(pairs): return "{" + pairs.map { JSValue.quote($0.0) + ":" + $0.1.stringify() }.joined(separator: ",") + "}"
        }
    }

    static func quote(_ text: String) -> String {
        var out = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }
}

/// JavaScript `Number.prototype.toString()` for finite doubles (ECMA-262 Number::toString, radix 10).
public enum JSNumber {
    public static func string(_ value: Double) -> String {
        if value == 0 { return "0" }
        if value < 0 { return "-" + string(-value) }
        let (digits, point) = decompose(value)
        let k = digits.count
        if k <= point && point <= 21 {
            return digits + String(repeating: "0", count: point - k)
        }
        if 0 < point && point <= 21 {
            let index = digits.index(digits.startIndex, offsetBy: point)
            return digits[..<index] + "." + digits[index...]
        }
        if -6 < point && point <= 0 {
            return "0." + String(repeating: "0", count: -point) + digits
        }
        let exponent = point - 1
        let sign = exponent < 0 ? "-" : "+"
        let mantissa = k == 1 ? digits : String(digits.prefix(1)) + "." + String(digits.dropFirst())
        return "\(mantissa)e\(sign)\(abs(exponent))"
    }

    /// Shortest round-trip digits (no leading or trailing zeros) and the decimal point position `n`,
    /// so that value = 0.digits × 10^n. Swift's `description` is already shortest round-trip.
    private static func decompose(_ value: Double) -> (String, Int) {
        let text = value.description
        let parts = text.split(separator: "e", maxSplits: 1)
        let mantissa = String(parts[0])
        let exponent = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
        let pieces = mantissa.split(separator: ".", omittingEmptySubsequences: false)
        let whole = String(pieces[0])
        let fraction = pieces.count > 1 ? String(pieces[1]) : ""
        var digits = whole + fraction
        var point = whole.count + exponent
        while digits.hasPrefix("0") && digits.count > 1 {
            digits.removeFirst()
            point -= 1
        }
        while digits.hasSuffix("0") && digits.count > 1 {
            digits.removeLast()
        }
        return (digits, point)
    }
}

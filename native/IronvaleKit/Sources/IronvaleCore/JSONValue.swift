// JSON with JavaScript's semantics: `JSON.parse` and `JSON.stringify` as the web build uses them
// for the events channel (src/net/events.ts at commit cbe0add). Foundation's JSONSerialization
// differs on number formatting, key order and overflow, so the wire uses this instead.

/// A parsed JSON value. Objects keep their keys in insertion order, as JavaScript objects do.
public enum JSONValue: Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object(JSONObject)

    public subscript(key: String) -> JSONValue? {
        if case .object(let object) = self { return object[key] }
        return nil
    }

    public var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var number: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    public var bool: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    public var array: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    public var object: JSONObject? {
        if case .object(let value) = self { return value }
        return nil
    }
}

/// Insertion-ordered string-keyed map. Setting an existing key keeps its first position, as in
/// JavaScript (so `{"t":1,"t":2}` parses to one key `t` with value 2).
public struct JSONObject: Sendable, Equatable {
    public private(set) var keys: [String] = []
    private var values: [String: JSONValue] = [:]

    public init() {}

    public init(_ pairs: [(String, JSONValue)]) {
        for (key, value) in pairs { self[key] = value }
    }

    public subscript(key: String) -> JSONValue? {
        get { values[key] }
        set {
            if let newValue {
                if values.updateValue(newValue, forKey: key) == nil { keys.append(key) }
            } else if values.removeValue(forKey: key) != nil {
                keys.removeAll { $0 == key }
            }
        }
    }

    public var count: Int { keys.count }

    /// Equal when the same keys hold equal values, regardless of order.
    public static func == (lhs: JSONObject, rhs: JSONObject) -> Bool {
        lhs.values == rhs.values
    }
}

// MARK: - JSON.parse

extension JSONValue {
    /// `JSON.parse`. Returns nil wherever JavaScript would throw. One difference: an escaped lone
    /// surrogate (`"\ud800"`) becomes U+FFFD, because a Swift `String` cannot hold one.
    public static func parse(_ text: String) -> JSONValue? {
        var parser = Parser(units: Array(text.utf16))
        parser.skipWhitespace()
        guard let value = parser.value() else { return nil }
        parser.skipWhitespace()
        return parser.atEnd ? value : nil
    }

    private struct Parser {
        let units: [UInt16]
        var at = 0
        var depth = 0

        var atEnd: Bool { at >= units.count }

        mutating func skipWhitespace() {
            // JSON white space only: space, tab, line feed, carriage return.
            while at < units.count, [0x20, 0x09, 0x0A, 0x0D].contains(units[at]) { at += 1 }
        }

        mutating func consume(_ literal: String) -> Bool {
            let wanted = Array(literal.utf16)
            guard at + wanted.count <= units.count, Array(units[at..<at + wanted.count]) == wanted else { return false }
            at += wanted.count
            return true
        }

        mutating func value() -> JSONValue? {
            guard at < units.count else { return nil }
            switch units[at] {
            case 0x7B: return objectValue()
            case 0x5B: return arrayValue()
            case 0x22: return stringValue().map(JSONValue.string)
            case 0x74: return consume("true") ? .bool(true) : nil
            case 0x66: return consume("false") ? .bool(false) : nil
            case 0x6E: return consume("null") ? .null : nil
            default: return numberValue()
            }
        }

        mutating func objectValue() -> JSONValue? {
            depth += 1
            defer { depth -= 1 }
            guard depth <= 2048 else { return nil }
            at += 1
            var object = JSONObject()
            skipWhitespace()
            if at < units.count, units[at] == 0x7D {
                at += 1
                return .object(object)
            }
            while true {
                skipWhitespace()
                guard at < units.count, units[at] == 0x22, let key = stringValue() else { return nil }
                skipWhitespace()
                guard at < units.count, units[at] == 0x3A else { return nil }
                at += 1
                skipWhitespace()
                guard let item = value() else { return nil }
                object[key] = item
                skipWhitespace()
                guard at < units.count else { return nil }
                if units[at] == 0x2C {
                    at += 1
                    continue
                }
                if units[at] == 0x7D {
                    at += 1
                    return .object(object)
                }
                return nil
            }
        }

        mutating func arrayValue() -> JSONValue? {
            depth += 1
            defer { depth -= 1 }
            guard depth <= 2048 else { return nil }
            at += 1
            var items: [JSONValue] = []
            skipWhitespace()
            if at < units.count, units[at] == 0x5D {
                at += 1
                return .array(items)
            }
            while true {
                skipWhitespace()
                guard let item = value() else { return nil }
                items.append(item)
                skipWhitespace()
                guard at < units.count else { return nil }
                if units[at] == 0x2C {
                    at += 1
                    continue
                }
                if units[at] == 0x5D {
                    at += 1
                    return .array(items)
                }
                return nil
            }
        }

        mutating func hex4() -> UInt16? {
            guard at + 4 <= units.count else { return nil }
            var value: UInt16 = 0
            for unit in units[at..<at + 4] {
                let digit: UInt16
                switch unit {
                case 0x30...0x39: digit = unit - 0x30
                case 0x41...0x46: digit = unit - 0x41 + 10
                case 0x61...0x66: digit = unit - 0x61 + 10
                default: return nil
                }
                value = value << 4 | digit
            }
            at += 4
            return value
        }

        mutating func stringValue() -> String? {
            at += 1
            var out: [UInt16] = []
            while at < units.count {
                let unit = units[at]
                at += 1
                switch unit {
                case 0x22:
                    return String(decoding: out, as: UTF16.self)
                case 0x5C:
                    guard at < units.count else { return nil }
                    let escape = units[at]
                    at += 1
                    switch escape {
                    case 0x22, 0x5C, 0x2F: out.append(escape)
                    case 0x62: out.append(0x08)
                    case 0x66: out.append(0x0C)
                    case 0x6E: out.append(0x0A)
                    case 0x72: out.append(0x0D)
                    case 0x74: out.append(0x09)
                    case 0x75:
                        guard let code = hex4() else { return nil }
                        out.append(code)
                    default: return nil
                    }
                case 0x00..<0x20:
                    return nil
                default:
                    out.append(unit)
                }
            }
            return nil
        }

        mutating func numberValue() -> JSONValue? {
            let start = at
            func digits() -> Int {
                let from = at
                while at < units.count, (0x30...0x39).contains(units[at]) { at += 1 }
                return at - from
            }
            if at < units.count, units[at] == 0x2D { at += 1 }
            guard at < units.count else { return nil }
            if units[at] == 0x30 {
                at += 1
            } else if (0x31...0x39).contains(units[at]) {
                _ = digits()
            } else {
                return nil
            }
            if at < units.count, units[at] == 0x2E {
                at += 1
                guard digits() > 0 else { return nil }
            }
            if at < units.count, units[at] == 0x65 || units[at] == 0x45 {
                at += 1
                if at < units.count, units[at] == 0x2B || units[at] == 0x2D { at += 1 }
                guard digits() > 0 else { return nil }
            }
            let lexeme = String(decoding: units[start..<at], as: UTF16.self)
            // Double(String) rounds correctly and overflows to infinity, as JSON.parse does.
            guard let number = Double(lexeme) else { return nil }
            return .number(number)
        }
    }
}

// MARK: - JSON.stringify

extension JSONValue {
    /// `JSON.stringify(value)` with no indentation. Non-finite numbers become `null`, as in JS.
    public func stringify() -> String {
        var out = ""
        write(into: &out)
        return out
    }

    private func write(into out: inout String) {
        switch self {
        case .null:
            out += "null"
        case .bool(let value):
            out += value ? "true" : "false"
        case .number(let value):
            out += value.isFinite ? JS.numberString(value) : "null"
        case .string(let value):
            JSONValue.quote(value, into: &out)
        case .array(let items):
            out += "["
            for (index, item) in items.enumerated() {
                if index > 0 { out += "," }
                item.write(into: &out)
            }
            out += "]"
        case .object(let object):
            out += "{"
            for (index, key) in object.keys.enumerated() {
                if index > 0 { out += "," }
                JSONValue.quote(key, into: &out)
                out += ":"
                object[key]!.write(into: &out)
            }
            out += "}"
        }
    }

    /// JSON.stringify's string quoting.
    public static func quote(_ text: String, into out: inout String) {
        out += "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    let hex = String(scalar.value, radix: 16)
                    out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }
}

// Golden fixtures from native/Contract/fixtures/core.json, produced by contract-export running
// src/core/random.ts and JS built-ins (PLAN.md 5.4 layer 1).
import Foundation
import Testing
@testable import IronvaleCore

private func coreFixture() throws -> JSONValue {
    let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Contract/fixtures/core.json")
    let text = try String(contentsOf: url, encoding: .utf8)
    return try #require(JSONValue.parse(text))
}

@Test func mulberry32MatchesTypeScript() throws {
    let cases = try #require(try coreFixture()["mulberry32"]?.array)
    #expect(cases.count >= 10)
    for entry in cases {
        var random = SeededRandom(seed: UInt32(try #require(entry["seed"]?.number)))
        let values = try #require(entry["values"]?.array)
        for value in values {
            #expect(random.next() == value.number)
        }
    }
}

@Test func fnv1aMatchesTypeScript() throws {
    let cases = try #require(try coreFixture()["fnv1a"]?.array)
    for entry in cases {
        let text = try #require(entry["text"]?.string)
        #expect(Double(hashString(text)) == entry["hash"]?.number, "\(text)")
    }
}

@Test func jsRoundModAndImulMatchTypeScript() throws {
    let fixture = try coreFixture()
    for entry in try #require(fixture["jsRound"]?.array) {
        let x = try #require(entry["x"]?.number)
        #expect(JS.round(x) == entry["out"]?.number, "Math.round(\(x))")
    }
    for entry in try #require(fixture["jsMod"]?.array) {
        let a = try #require(entry["a"]?.number), b = try #require(entry["b"]?.number)
        #expect(JS.mod(a, b) == entry["out"]?.number)
    }
    for entry in try #require(fixture["imul"]?.array) {
        let a = UInt32(try #require(entry["a"]?.number)), b = UInt32(try #require(entry["b"]?.number))
        #expect(Double(JS.imul(a, b)) == entry["out"]?.number)
    }
}

@Test func roundingHalvesGoUp() {
    #expect(JS.round(-2.5) == -2)
    #expect(JS.round(2.5) == 3)
    #expect(JS.round(-0.4).sign == .minus)
    #expect(JS.round(0.49999999999999994) == 0)
}

@Test func numberStringFollowsECMAScript() {
    let cases: [(Double, String)] = [
        (0, "0"), (-0.0, "0"), (1, "1"), (-1, "-1"), (86.4, "86.4"), (0.1 + 0.2, "0.30000000000000004"),
        (1e21, "1e+21"), (1e20, "100000000000000000000"), (123456789012, "123456789012"),
        (1e-6, "0.000001"), (1e-7, "1e-7"), (1.5e-7, "1.5e-7"), (5e-324, "5e-324"), (1e300, "1e+300"),
        (1.7976931348623157e308, "1.7976931348623157e+308"), (123e-20, "1.23e-18"), (0.5, "0.5"),
        (-4999.5, "-4999.5"), (1 / 3.0, "0.3333333333333333"), (1e16, "10000000000000000"), (2.5e-5, "0.000025"),
    ]
    for (value, expected) in cases {
        #expect(JS.numberString(value) == expected, "\(value)")
    }
}

@Test func jsonParseFollowsJSONParse() {
    #expect(JSONValue.parse(#" {"a" : [1, -0.5e2, true, null, "x\u0041\n"]} "#) == .object(JSONObject([
        ("a", .array([.number(1), .number(-50), .bool(true), .null, .string("xA\n")])),
    ])))
    for bad in ["", "{", "{'a':1}", "[1,]", "01", "1.", ".5", "+1", "\"a\nb\"", "{} x", "\u{FEFF}{}", "\u{A0}1", "tru", "\"\\x\""] {
        #expect(JSONValue.parse(bad) == nil, "\(bad)")
    }
    #expect(JSONValue.parse("1e400") == .number(.infinity))
    #expect(JSONValue.parse("-1e-400")?.number == 0)
    // Duplicate keys: last value wins, first position kept.
    let object = JSONValue.parse(#"{"t":"a","x":1,"t":"b"}"#)?.object
    #expect(object?.keys == ["t", "x"])
    #expect(object?["t"] == .string("b"))
}

@Test func jsonStringifyQuotesLikeJSONStringify() {
    let value = JSONValue.object(JSONObject([("q", .string("\"\\\u{08}\u{0C}\n\r\t\u{01}\u{1F}\u{7F}\u{2028}🙂")), ("n", .number(.nan))]))
    #expect(value.stringify() == #"{"q":"\"\\\b\f\n\r\t\u0001\u001f"# + "\u{7F}\u{2028}🙂" + #"","n":null}"#)
}

@Test func whitespaceAndSlicingFollowJavaScript() {
    #expect(JS.trim("\u{FEFF}\u{3000} a b\u{2029}\n") == "a b")
    #expect(JS.trim("\u{85}a") == "\u{85}a")
    #expect(JS.collapseWhitespace("a \t\u{A0}b") == "a b")
    #expect(JS.slice("ab𝐀", 3) == "ab\u{FFFD}")
    #expect(JS.length("𝐀") == 2)
}

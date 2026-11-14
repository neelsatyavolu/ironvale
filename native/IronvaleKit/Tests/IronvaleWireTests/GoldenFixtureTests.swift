// Golden fixtures from native/Contract/fixtures, produced by contract-export running the real
// TypeScript encoders, validators and sanitisers (PLAN.md 5.4 layer 1). Exact comparison:
// bytes, strings and doubles must be identical.
import Foundation
import IronvaleCore
import Testing
@testable import IronvaleWire

/// Collects mismatches so one broken rule reports a few examples, not thousands of failures.
struct Mismatches {
    private(set) var items: [String] = []
    private(set) var checked = 0

    mutating func check(_ ok: Bool, _ message: @autoclosure () -> String) {
        checked += 1
        if !ok, items.count < 20 { items.append(message()) }
    }

    func expectNone(_ what: String, minimum: Int, sourceLocation: SourceLocation = #_sourceLocation) {
        #expect(checked >= minimum, Comment(rawValue: "\(what): only \(checked) cases checked"), sourceLocation: sourceLocation)
        #expect(items.isEmpty, Comment(rawValue: "\(what):\n" + items.joined(separator: "\n")), sourceLocation: sourceLocation)
    }
}

@Test func binaryEncodeMatchesGoldenBytes() throws {
    var miss = Mismatches()
    for entry in try Fixture.cases("binary.json", "encode") {
        let kind = try entry.text("kind")
        let message = try binaryMessage(kind: kind, try need(entry["input"], "input"))
        let encoded = BinaryCodec.encode(message)
        let want = try entry.text("hex")
        miss.check(hex(encoded) == want, "encode \(kind) \(entry["input"]!.stringify())\n  swift \(hex(encoded))\n  ts    \(want)")
        let decoded = BinaryCodec.decode(encoded)
        let expected = entry["decoded"] == .null ? nil : try decodedMessage(try need(entry["decoded"], "decoded"))
        miss.check(decoded == expected, "decode of encoded \(kind) \(want)")
    }
    miss.expectNone("binary encode", minimum: 300)
}

@Test func binaryDecodeMatchesTypeScript() throws {
    var miss = Mismatches()
    var accepted = 0
    for entry in try Fixture.cases("binary.json", "decode") {
        let input = try entry.text("hex")
        let decoded = BinaryCodec.decode(bytes(hex: input))
        let expected = entry["decoded"] == .null ? nil : try decodedMessage(try need(entry["decoded"], "decoded"))
        if expected != nil { accepted += 1 }
        miss.check(decoded == expected, "decode \(input)\n  swift \(String(describing: decoded))\n  ts    \(String(describing: expected))")
    }
    miss.expectNone("binary decode", minimum: 5000)
    // The fixture must exercise the accepting paths, not just rejections.
    #expect(accepted > 500)
}

@Test func eventsParseAndEncodeLikeTypeScript() throws {
    var miss = Mismatches()
    var accepted = 0
    for entry in try Fixture.cases("events.json", "parse") {
        let text = try entry.text("text")
        let expected = entry["out"]?.string
        let parsed = EventCodec.parse(text)
        if expected != nil { accepted += 1 }
        let got = parsed.map(EventCodec.encode)
        miss.check(got == expected, "parse \(text.prefix(200))\n  swift \(got ?? "null")\n  ts    \(expected ?? "null")")
        if let expected {
            // What the web writes, Swift reads back to the same event.
            miss.check(EventCodec.parse(expected) == parsed, "reparse \(expected)")
        }
    }
    miss.expectNone("events", minimum: 4000)
    #expect(accepted > 500)
}

@Test func namesAndChatSanitiseLikeTypeScript() throws {
    var miss = Mismatches()
    var illFormed = 0
    for entry in try Fixture.cases("limits.json", "names") {
        let input = try entry.text("input")
        let got = entry["fallback"] == .null ? Sanitize.name(input) : Sanitize.name(input, fallback: try entry.text("fallback"))
        if entry["wellFormed"] == .bool(false) { illFormed += 1 }
        miss.check(got == (try entry.text("out")), "name \(input.debugDescription) -> \(got.debugDescription), ts \(entry["out"]!.stringify())")
    }
    for entry in try Fixture.cases("limits.json", "chats") {
        let input = try entry.text("input")
        let got = Sanitize.chat(input)
        if entry["wellFormed"] == .bool(false) { illFormed += 1 }
        miss.check(got == (try entry.text("out")), "chat \(input.debugDescription) -> \(got.debugDescription), ts \(entry["out"]!.stringify())")
    }
    miss.expectNone("sanitisers", minimum: 4000)
    // The UTF-16 cut that splits a surrogate pair must be covered (U+FFFD on both sides).
    #expect(illFormed > 0)
}

@Test func damageCapMatchesTypeScript() throws {
    var miss = Mismatches()
    for entry in try Fixture.cases("limits.json", "damage") {
        let weapon = try FixtureWeapon(try need(entry["weapon"], "weapon"))
        let out = try entry.num("out")
        if entry["amount"] == .string("max") {
            miss.check(DamageCap.maxHit(weapon) == out, "maxHit \(weapon.id)")
        } else {
            let amount = try entry.num("amount")
            miss.check(DamageCap.cap(weapon, amount) == out, "cap \(weapon.id) \(amount)")
        }
    }
    miss.expectNone("damage cap", minimum: 50)
}

@Test func tokenBucketTracesMatchTypeScript() throws {
    var miss = Mismatches()
    for (index, entry) in try Fixture.cases("limits.json", "tokenBucket").enumerated() {
        var bucket = TokenBucket(perSecond: try entry.num("perSecond"), size: try entry.num("size"))
        let ops = try need(entry["ops"]?.array, "ops")
        let results = try need(entry["results"]?.array, "results")
        for (op, result) in zip(ops, results) {
            let pair = try need(op.array, "op")
            let got = bucket.take(now: try need(pair[0].number, "now"), count: try need(pair[1].number, "count"))
            miss.check(.bool(got) == result, "bucket \(index) op \(op.stringify())")
        }
    }
    miss.expectNone("token bucket", minimum: 1000)
}

@Test func weaponGateTracesMatchTypeScript() throws {
    let fixture = try need(try Fixture.load("limits.json")["weaponGate"], "weaponGate")
    let weapons = try need(fixture["weapons"]?.array, "weapons").map(FixtureWeapon.init)
    var miss = Mismatches()
    for trace in try need(fixture["traces"]?.array, "traces") {
        var gate = WeaponGate()
        for op in try need(trace["ops"]?.array, "ops") {
            let weapon = weapons[try op.int("weapon")]
            let now = try op.num("now")
            let got = try op.text("kind") == "shot" ? gate.allowShot(weapon, now: now) : gate.allowHit(weapon, now: now)
            miss.check(got == (try op.flag("result")), "gate \(op.stringify())")
        }
    }
    miss.expectNone("weapon gate", minimum: 10000)
}

@Test func roomCodesMatchTypeScript() throws {
    var miss = Mismatches()
    for entry in try Fixture.cases("room.json", "text") {
        let input = try entry.text("input")
        miss.check(RoomCode.normalize(input) == (try entry.text("normalized")), "normalize \(input.debugDescription) -> \(RoomCode.normalize(input))")
        miss.check(RoomCode.from(input) == (try entry.text("from")), "from \(input.debugDescription) -> \(RoomCode.from(input))")
        miss.check(RoomCode.isValid(input) == (try entry.flag("isRoomCode")), "isValid \(input.debugDescription)")
    }
    for entry in try Fixture.cases("room.json", "make") {
        var random = SeededRandom(seed: UInt32(try entry.num("seed")))
        for code in try need(entry["codes"]?.array, "codes") {
            miss.check(.string(RoomCode.make { random.next() }) == code, "make \(code.stringify())")
        }
    }
    for entry in try Fixture.cases("room.json", "links") {
        let got = RoomCode.inviteLink(code: try entry.text("code"), page: try entry.text("page"))
        miss.check(got == (try entry.text("out")), "inviteLink \(entry.stringify()) -> \(got ?? "nil")")
    }
    miss.expectNone("room codes", minimum: 300)
}

@Test func inviteCodesDecodeLikeTypeScript() throws {
    var miss = Mismatches()
    var accepted = 0
    for entry in try Fixture.cases("invite.json", "decode") {
        let text = try entry.text("text")
        let expected = try need(InviteKind(rawValue: try entry.text("expected")), "expected")
        let result = try need(entry["result"], "result")
        let got = InviteCodec.decode(text, expected: expected)
        switch got {
        case .success(let sdp):
            miss.check(result["ok"] == .bool(true) && result["sdp"] == .string(sdp), "decode \(text.prefix(80)) ok, ts \(result.stringify().prefix(120))")
            accepted += 1
        case .failure(let reason):
            miss.check(result["reason"] == .string(reason.rawValue), "decode \(text.prefix(80)) -> \(reason.rawValue), ts \(result.stringify().prefix(120))")
        }
    }
    miss.expectNone("invite decode", minimum: 300)
    #expect(accepted >= 40)
}

@Test func inviteCodesRoundTripInSwift() throws {
    let sdp = try Fixture.load("invite.json")["sampleSdp"]?.string ?? ""
    for kind in [InviteKind.offer, .answer] {
        let code = InviteCodec.encode(kind: kind, sdp: sdp)
        #expect(code.hasPrefix(InviteCodec.prefix(kind)))
        #expect(code.unicodeScalars.allSatisfy { CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-").contains($0) })
        #expect(code.count < sdp.count)
        #expect(InviteCodec.decode(code, expected: kind) == .success(sdp))
    }
}

// PLAN.md 5.4 layer 2: everything Swift encodes is written to native/Contract/out/swift-encoded.json,
// and native/Tools/contract-export/verify-swift-encoded.test.ts decodes it with the real
// src/net/protocol.ts, events.ts, invite.ts, limits.ts and room-code.ts. This test only writes;
// native/ci/check-m1.sh runs the TypeScript side after it.
import Foundation
import IronvaleContract
import IronvaleCore
import Testing
@testable import IronvaleWire

private struct Generator {
    var random: SeededRandom

    mutating func unit() -> Double { random.next() }
    mutating func range(_ low: Double, _ high: Double) -> Double { low + unit() * (high - low) }
    mutating func int(_ count: Int) -> Int { Int((unit() * Double(count)).rounded(.down)) }
    mutating func bool() -> Bool { unit() < 0.5 }
    mutating func weapon() -> WeaponID { WeaponID.allCases[int(WeaponID.allCases.count)] }
    mutating func point(_ limit: Double) -> Vec3 { Vec3(range(-limit, limit), range(-limit, limit), range(-limit, limit)) }

    mutating func state() -> PlayerState {
        PlayerState(
            seq: int(200_000), time: range(0, 1e9), x: range(-4000, 4000), y: range(-50, 200), z: range(-4000, 4000),
            vx: range(-400, 400), vy: Double(int(4000) - 2000) / 200 + 0.005, vz: range(-20, 20),
            yaw: range(-40, 40), pitch: range(-2.5, 2.5), crouching: bool(), sprinting: bool(), aiming: bool(),
            alive: bool(), onGround: bool(), reloading: bool(), weapon: weapon(), health: range(-20, 140), life: int(700)
        )
    }

    mutating func bot() -> BotState {
        BotState(id: 2 + int(65534), x: range(-4000, 4000), y: range(-50, 200), z: range(-4000, 4000), yaw: range(-40, 40),
                 pitch: range(-2, 2), speed: range(-1, 15), crouching: bool(), aiming: bool(), reloading: bool(), alive: bool(), weapon: weapon())
    }

    mutating func shot() -> ShotMessage {
        let a = range(0, .pi * 2), b = range(-1.4, 1.4)
        let ends = (0..<int(16)).map { _ in Vec3(range(-4000, 4000), range(-50, 200), range(-4000, 4000)) }
        return ShotMessage(actor: int(65536), weapon: weapon(), muzzle: point(4000),
                           direction: Vec3(cos(b) * sin(a), sin(b), cos(b) * cos(a)), ends: ends)
    }

    mutating func text(_ max: Int) -> String {
        let palette: [String] = ["a", "Z", "0", " ", "\t", "\n", "_", ".", "'", "-", "<", "\"", "\\", "\u{0}", "\u{7F}", "\u{A0}", "é", "ß",
                                 "\u{301}", "Ж", "日", "\u{200B}", "\u{202E}", "\u{2028}", "\u{3000}", "\u{FEFF}", "𝐀", "🙂", "²", "Ⅷ"]
        return (0..<int(max)).map { _ in palette[int(palette.count)] }.joined()
    }

    mutating func damage() -> DamageSource { unit() < 0.15 ? .grenade : .weapon(weapon()) }

    mutating func number(_ limit: Double) -> Double {
        let pool: [Double] = [0, 1, 0.1, 1.0 / 3, 1e-7, 1.5e-6, 86.4, 0.30000000000000004, 5e-324]
        return unit() < 0.3 ? pool[int(pool.count)] * (bool() ? 1 : -1) : range(-limit, limit)
    }

    mutating func event() -> NetEvent {
        let config = NetMatchConfig(mapId: ["railyard", "harbor", "headworks", "range", "a-1"][int(5)], mode: bool() ? .coop : .duel,
                                    rules: bool() ? .skirmish : .survival, difficulty: Difficulty.allCases[int(4)], botCount: int(33),
                                    killTarget: 1 + int(50), duelBot: DuelBot.allCases[int(3)])
        func dir(_ g: inout Generator) -> Vec3 { Vec3(g.range(-1, 1), g.range(-1, 1), g.range(-1, 1)) }
        switch int(17) {
        case 0: return .hello(v: int(1001), name: Sanitize.name(text(20)))
        case 1: return .lobby(config)
        case 2: return .ready(bool())
        case 3: return .load(config)
        case 4: return .loaded
        case 5: return .go(at: abs(number(1e12)))
        case 6: return .hit(target: int(65536), attacker: int(65536), weapon: damage(), zone: HitZone.allCases[int(3)],
                            amount: abs(number(1000)), p: Vec3(number(5000), number(5000), number(5000)), d: dir(&self))
        case 7: return .death(victim: int(65536), killer: int(65536), weapon: damage(), headshot: bool(), life: int(256), d: dir(&self))
        case 8: return .action(actor: int(65536), weapon: weapon(), stage: WeaponActionStage.allCases[int(9)])
        case 9: return .switchWeapon(weapon())
        case 10: return .botSpawn(id: 2 + int(65534), name: Sanitize.name(text(20), fallback: "Soldier"), weapon: weapon(), p: point(5000), yaw: range(-10, 10))
        case 11: return .match(wave: int(100_001), enemies: int(100_001), result: MatchResult.allCases[int(3)], hostKills: int(100_001), guestKills: int(100_001))
        case 12: return .nade(p: point(5000), v: point(40))
        case 13: return .boom(p: point(5000))
        case 14:
            let line = Sanitize.chat(text(160))
            return line.isEmpty ? .chat("ok") : .chat(line)
        case 15: return .away(bool())
        default: return .bye(ByeReason.allCases[int(3)])
        }
    }
}

@Test func writeSwiftEncodedForTypeScript() throws {
    var g = Generator(random: SeededRandom(seed: 0x5EED))
    var binary: [JSONValue] = []
    var messages: [BinaryMessage] = [
        .state(PlayerState(seq: 513, time: 12345.5, x: 1.5, y: 0, z: -2.25, vx: 3.21, vy: -0.5, vz: 0, yaw: 1, pitch: -0.25,
                           crouching: true, sprinting: false, aiming: true, alive: true, onGround: true, reloading: false, weapon: .m24, health: 87, life: 3)),
        .bots(seq: 7, time: 1000, bots: []),
        .bots(seq: 9, time: 2, bots: (0..<50).map { _ in g.bot() }),
        .ping(id: 300, sentAt: 0),
    ]
    for i in 0..<500 {
        switch i % 5 {
        case 0: messages.append(.state(g.state()))
        case 1: messages.append(.bots(seq: g.int(70000), time: g.range(0, 1e8), bots: (0..<g.int(6)).map { _ in g.bot() }))
        case 2: messages.append(.shot(g.shot()))
        case 3: messages.append(.ping(id: g.int(300), sentAt: g.range(0, 1e9)))
        default: messages.append(.pong(id: g.int(300), sentAt: g.range(0, 1e9), remoteTime: g.range(0, 1e9)))
        }
    }
    for message in messages {
        let (kind, input) = json(message)
        binary.append(.object(JSONObject([("kind", .string(kind)), ("input", input), ("hex", .string(hex(BinaryCodec.encode(message))))])))
    }

    let events: [JSONValue] = (0..<1500).map { _ in
        let event = g.event()
        return .object(JSONObject([("event", EventCodec.json(event)), ("text", .string(EventCodec.encode(event)))]))
    }

    var sanitize: [JSONValue] = []
    for _ in 0..<1000 {
        let input = g.text(40)
        sanitize.append(.object(JSONObject([("kind", .string("name")), ("input", .string(input)), ("out", .string(Sanitize.name(input)))])))
        let line = g.text(200)
        sanitize.append(.object(JSONObject([("kind", .string("chat")), ("input", .string(line)), ("out", .string(Sanitize.chat(line)))])))
    }

    let sdp = try #require(try Fixture.load("invite.json")["sampleSdp"]?.string)
    var invites: [JSONValue] = []
    for index in 0..<40 {
        var body = sdp
        for line in 0..<index { body += "a=x-\(line):\(String(repeating: "z", count: g.int(60)))\r\n" }
        let kind: InviteKind = g.bool() ? .offer : .answer
        invites.append(.object(JSONObject([("kind", .string(kind.rawValue)), ("sdp", .string(body)), ("code", .string(InviteCodec.encode(kind: kind, sdp: body)))])))
    }

    let rooms: [JSONValue] = (0..<200).map { _ in .string(RoomCode.make()) }
    let links: [JSONValue] = (0..<20).map { _ in
        let code = RoomCode.make()
        return .object(JSONObject([("code", .string(code)), ("page", .string("https://ironvale.n3el.dev/")),
                                   ("out", .string(RoomCode.inviteLink(code: code, page: "https://ironvale.n3el.dev/") ?? ""))]))
    }

    let document = JSONValue.object(JSONObject([
        ("binary", .array(binary)), ("events", .array(events)), ("sanitize", .array(sanitize)),
        ("invites", .array(invites)), ("roomCodes", .array(rooms)), ("inviteLinks", .array(links)),
    ]))
    let out = ContractLocation.sourceTreeDirectory.appendingPathComponent("out", isDirectory: true)
    try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    try Data(document.stringify().utf8).write(to: out.appendingPathComponent("swift-encoded.json"), options: .atomic)
}

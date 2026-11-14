// P0 wire test cases ported from tests/net/protocol.test.ts, limits.test.ts (sanitizeName,
// damage, TokenBucket, WeaponGate, room codes), chat.test.ts (chat lines), invite.test.ts and
// invite-link.test.ts at commit cbe0add. Cases that need other modules (duel rules, minimap,
// session, signaling, clock, interp) are ported with IronvaleNet and IronvaleSim.
import Foundation
import IronvaleContract
import IronvaleCore
import Testing
@testable import IronvaleWire

private func state(_ patch: (inout PlayerState) -> Void = { _ in }) -> PlayerState {
    var value = PlayerState(
        seq: 513, time: 123456.75, x: 12.5, y: 0.25, z: -31.75, vx: 3.2, vy: -1.5, vz: 0.4, yaw: 1.25, pitch: -0.5,
        crouching: true, sprinting: false, aiming: true, alive: true, onGround: true, reloading: false,
        weapon: .m24, health: 87, life: 3
    )
    patch(&value)
    return value
}

private func bot(_ id: Int, _ patch: (inout BotState) -> Void = { _ in }) -> BotState {
    var value = BotState(id: id, x: Double(id * 2), y: 0, z: Double(-id), yaw: 0.5, pitch: 0.1, speed: 3.4,
                         crouching: false, aiming: true, reloading: false, alive: true, weapon: .mp5)
    patch(&value)
    return value
}

private func close(_ a: Double, _ b: Double, _ digits: Int) -> Bool { abs(a - b) < pow(10, -Double(digits)) / 2 }

private func setF32(_ bytes: inout [UInt8], _ at: Int, _ value: Float) {
    withUnsafeBytes(of: value.bitPattern.littleEndian) { bytes.replaceSubrange(at..<at + 4, with: $0) }
}

private func setF64(_ bytes: inout [UInt8], _ at: Int, _ value: Double) {
    withUnsafeBytes(of: value.bitPattern.littleEndian) { bytes.replaceSubrange(at..<at + 8, with: $0) }
}

@Suite struct PlayerStateTests {
    @Test func roundTripsEveryField() throws {
        guard case .state(let got) = BinaryCodec.decode(BinaryCodec.encodeState(state())) else { Issue.record("expected a state"); return }
        #expect(got.seq == 513)
        #expect(got.time == 123456.75)
        #expect(got.x == 12.5)
        #expect(got.z == -31.75)
        #expect(close(got.vx, 3.2, 2))
        #expect(close(got.vy, -1.5, 2))
        #expect(close(got.yaw, 1.25, 3))
        #expect(close(got.pitch, -0.5, 3))
        #expect(got.crouching && !got.sprinting && got.aiming && got.alive && got.onGround && !got.reloading)
        #expect(got.weapon == .m24)
        #expect(got.health == 87)
        #expect(got.life == 3)
    }

    @Test func isCompact() {
        #expect(BinaryCodec.encodeState(state()).count <= 40)
    }

    @Test func wrapsYawAndClampsWhatDoesNotFit() {
        let encoded = BinaryCodec.encodeState(state { $0.yaw = .pi * 5 + 0.3; $0.health = 250; $0.vx = 9999 })
        guard case .state(let got) = BinaryCodec.decode(encoded) else { Issue.record("expected a state"); return }
        #expect(close(got.yaw, -.pi + 0.3, 3))
        #expect(got.health == 100)
        #expect(got.vx <= 327.67)
    }

    @Test func rejectsPositionsThatAreNotFiniteOrFarOutside() {
        for bad in [Float.nan, .infinity, 1e7] {
            var bytes = BinaryCodec.encodeState(state())
            setF32(&bytes, 11, bad)
            #expect(BinaryCodec.decode(bytes) == nil)
        }
    }

    @Test func rejectsUnknownWeaponWrongLengthAndBadTime() {
        var bytes = BinaryCodec.encodeState(state())
        bytes[bytes.count - 3] = 200
        #expect(BinaryCodec.decode(bytes) == nil)
        #expect(BinaryCodec.decode(Array(BinaryCodec.encodeState(state()).prefix(20))) == nil)
        var late = BinaryCodec.encodeState(state())
        setF64(&late, 3, .nan)
        #expect(BinaryCodec.decode(late) == nil)
    }
}

@Suite struct BotSnapshotTests {
    @Test func roundTripsASquad() {
        let bots = [bot(3), bot(4) { $0.alive = false; $0.crouching = true; $0.weapon = .m249 }, bot(900) { $0.speed = 0 }]
        guard case .bots(let seq, let time, let got) = BinaryCodec.decode(BinaryCodec.encodeBots(seq: 7, time: 5000.5, bots: bots)) else {
            Issue.record("expected bots")
            return
        }
        #expect(seq == 7)
        #expect(time == 5000.5)
        #expect(got.map(\.id) == [3, 4, 900])
        #expect(!got[1].alive && got[1].crouching && got[1].weapon == .m249)
        #expect(close(got[0].speed, 3.4, 1))
        #expect(close(got[0].yaw, 0.5, 3))
        #expect(close(got[0].pitch, 0.1, 1))
    }

    @Test func rejectsACountThatDoesNotMatchTheLength() {
        var bytes = BinaryCodec.encodeBots(seq: 1, time: 10, bots: [bot(3), bot(4)])
        bytes[11] = 5
        #expect(BinaryCodec.decode(bytes) == nil)
    }

    @Test func acceptsAnEmptySnapshot() {
        guard case .bots(_, _, let bots) = BinaryCodec.decode(BinaryCodec.encodeBots(seq: 1, time: 10, bots: [])) else {
            Issue.record("expected bots")
            return
        }
        #expect(bots.isEmpty)
    }
}

@Suite struct ShotTests {
    let shot = ShotMessage(actor: 1, weapon: .m24, muzzle: Vec3(1, 1.5, -2), direction: Vec3(0, 0, -1), ends: [Vec3(1, 1.4, -40), Vec3(1.5, 1.6, -41)])

    @Test func roundTrips() {
        guard case .shot(let got) = BinaryCodec.decode(BinaryCodec.encodeShot(shot)) else { Issue.record("expected a shot"); return }
        #expect(got.actor == 1)
        #expect(got.weapon == .m24)
        #expect(got.muzzle == Vec3(1, 1.5, -2))
        #expect(close(got.direction.z, -1, 3))
        #expect(got.ends.count == 2)
        #expect(got.ends[1].z == -41)
    }

    @Test func rejectsTooManyPelletsAndANonUnitDirection() {
        var many = BinaryCodec.encodeShot(ShotMessage(actor: 1, weapon: .m24, muzzle: shot.muzzle, direction: shot.direction, ends: Array(repeating: .zero, count: 12)))
        many[22] = 40
        #expect(BinaryCodec.decode(many) == nil)
        #expect(BinaryCodec.decode(BinaryCodec.encodeShot(ShotMessage(actor: 1, weapon: .m24, muzzle: shot.muzzle, direction: .zero, ends: shot.ends))) == nil)
    }
}

@Test func pingAndPongRoundTrip() {
    #expect(BinaryCodec.decode(BinaryCodec.encodePing(id: 9, sentAt: 100.5)) == .ping(id: 9, sentAt: 100.5))
    #expect(BinaryCodec.decode(BinaryCodec.encodePong(id: 9, sentAt: 100.5, remoteTime: 7000.25)) == .pong(id: 9, sentAt: 100.5, remoteTime: 7000.25))
}

@Suite struct FuzzedBinaryTests {
    @Test func neverCrashesAndNeverReturnsNonFiniteValues() {
        var random = SeededRandom(seed: 42)
        for _ in 0..<4000 {
            let length = Int((random.next() * 80).rounded(.down))
            var bytes = (0..<length).map { _ in UInt8((random.next() * 256).rounded(.down)) }
            if length > 0 && random.next() < 0.8 { bytes[0] = 1 + UInt8((random.next() * 5).rounded(.down)) }
            guard let decoded = BinaryCodec.decode(bytes) else { continue }
            var numbers: [Double] = []
            switch decoded {
            case .state(let s): numbers = [s.time, s.x, s.y, s.z, s.vx, s.vy, s.vz, s.yaw, s.pitch, s.health]
            case .bots(_, let time, let bots): numbers = [time] + bots.flatMap { [$0.x, $0.y, $0.z, $0.yaw, $0.pitch, $0.speed] }
            case .shot(let s): numbers = [s.muzzle, s.direction].flatMap { [$0.x, $0.y, $0.z] } + s.ends.flatMap { [$0.x, $0.y, $0.z] }
            case .ping(_, let sentAt): numbers = [sentAt]
            case .pong(_, let sentAt, let remoteTime): numbers = [sentAt, remoteTime]
            }
            let finite = numbers.allSatisfy { $0.isFinite }
            #expect(finite)
        }
    }

    @Test func rejectsTruncatedCopiesOfRealMessages() {
        let real = [BinaryCodec.encodeState(state()), BinaryCodec.encodeBots(seq: 1, time: 2, bots: [bot(3)]),
                    BinaryCodec.encodePing(id: 1, sentAt: 2), BinaryCodec.encodePong(id: 1, sentAt: 2, remoteTime: 3)]
        for bytes in real {
            for cut in 0..<bytes.count {
                #expect(BinaryCodec.decode(Array(bytes.prefix(cut))) == nil)
            }
        }
    }
}

@Suite struct EventTests {
    let config = NetMatchConfig(mapId: "range", mode: .duel, rules: .skirmish, difficulty: .regular, botCount: 0, killTarget: 10, duelBot: .none)

    @Test func acceptsEachWellFormedEventAndRoundTrips() {
        let events: [NetEvent] = [
            .hello(v: 1, name: "Ada"), .lobby(config), .ready(true), .load(config), .loaded, .go(at: 1234.5),
            .hit(target: 1, attacker: 0, weapon: .weapon(.m4a1), zone: .head, amount: 86.4, p: Vec3(1, 2, 3), d: Vec3(0, 0, -1)),
            .death(victim: 1, killer: 0, weapon: .weapon(.m4a1), headshot: true, life: 2, d: Vec3(0, 0, -1)),
            .action(actor: 0, weapon: .m4a1, stage: .magOut), .switchWeapon(.mp5),
            .botSpawn(id: 17, name: "Sgt. Hale", weapon: .m4a1, p: Vec3(1, 0, 3), yaw: 1),
            .match(wave: 2, enemies: 7, result: .none, hostKills: 3, guestKills: 1), .away(true), .bye(.left),
            .nade(p: Vec3(1, 1.5, -3), v: Vec3(0, 2.8, -15.7)), .boom(p: Vec3(1, 0.05, -18)),
            .hit(target: 5, attacker: 1, weapon: .grenade, zone: .torso, amount: 140, p: Vec3(1, 2, 3), d: Vec3(0, 0, -1)),
            .death(victim: 1, killer: 1, weapon: .grenade, headshot: false, life: 2, d: Vec3(0, 1, 0)),
        ]
        for event in events {
            #expect(EventCodec.parse(EventCodec.encode(event)) == event)
        }
        #expect(EventCodec.encode(.hit(target: 1, attacker: 0, weapon: .weapon(.m4a1), zone: .head, amount: 86.4, p: Vec3(0, 1.65, -20), d: Vec3(0, 0, -1)))
            == #"{"t":"hit","target":1,"attacker":0,"weapon":"m4a1","zone":"head","amount":86.4,"p":[0,1.65,-20],"d":[0,0,-1]}"#)
    }

    @Test func dropsUnknownFields() {
        #expect(EventCodec.parse(#"{"t":"ready","ready":false,"extra":"<img src=x>"}"#) == .ready(false))
    }

    @Test func readsAHostThatPredatesDuelBotsAsNobody() {
        #expect(EventCodec.parse(#"{"t":"lobby","config":{"mapId":"range","mode":"duel","rules":"skirmish","difficulty":"regular","botCount":0,"killTarget":10,"duelBot":"guest"}}"#)
            == .lobby(NetMatchConfig(mapId: "range", mode: .duel, rules: .skirmish, difficulty: .regular, botCount: 0, killTarget: 10, duelBot: .guest)))
        #expect(EventCodec.parse(#"{"t":"load","config":{"mapId":"range","mode":"duel","rules":"skirmish","difficulty":"regular","botCount":0,"killTarget":10}}"#) == .load(config))
    }

    @Test func sanitisesNames() {
        #expect(EventCodec.parse(#"{"t":"hello","v":1,"name":"<b>Ada</b>\u0000 Lovelace the First"}"#) == .hello(v: 1, name: "bAdab Lovelace t"))
    }

    @Test func rejectsMalformedEvents() {
        let bad = [
            "null", "42", "[]", "{}", #"{"t":"nope"}"#, #"{"t":"ready","ready":"yes"}"#, #"{"t":"hello","v":1}"#,
            #"{"t":"go","at":"soon"}"#, #"{"t":"go","at":null}"#,
            #"{"t":"hit","target":1,"attacker":0,"weapon":"bfg","zone":"head","amount":10,"p":[1,2,3],"d":[0,0,-1]}"#,
            #"{"t":"hit","target":1,"attacker":0,"weapon":"m4a1","zone":"toe","amount":10,"p":[1,2,3],"d":[0,0,-1]}"#,
            #"{"t":"hit","target":1,"attacker":0,"weapon":"m4a1","zone":"head","amount":-5,"p":[1,2,3],"d":[0,0,-1]}"#,
            #"{"t":"hit","target":1,"attacker":0,"weapon":"m4a1","zone":"head","amount":10,"p":[1,2],"d":[0,0,-1]}"#,
            #"{"t":"hit","target":1.5,"attacker":0,"weapon":"m4a1","zone":"head","amount":10,"p":[1,2,3],"d":[0,0,-1]}"#,
            #"{"t":"hit","target":70000,"attacker":0,"weapon":"m4a1","zone":"head","amount":10,"p":[1,2,3],"d":[0,0,-1]}"#,
            #"{"t":"lobby","config":{"mapId":"../../etc","mode":"duel","rules":"skirmish","difficulty":"regular","botCount":0,"killTarget":10}}"#,
            #"{"t":"lobby","config":{"mapId":"range","mode":"duel","rules":"skirmish","difficulty":"regular","botCount":400,"killTarget":10}}"#,
            #"{"t":"lobby","config":{"mapId":"range","mode":"duel","rules":"skirmish","difficulty":"god","botCount":0,"killTarget":10}}"#,
            #"{"t":"lobby","config":{"mapId":"range","mode":"duel","rules":"skirmish","difficulty":"regular","botCount":0,"killTarget":10,"duelBot":"both"}}"#,
            #"{"t":"action","actor":0,"weapon":"m4a1","stage":"explode"}"#,
            #"{"t":"match","wave":-1,"enemies":3,"result":"","hostKills":0,"guestKills":0}"#,
            #"{"t":"match","wave":1,"enemies":3,"result":"draw","hostKills":0,"guestKills":0}"#,
            #"{"t":"bye","reason":"because"}"#, #"{"t":"nade","p":[1,1.5,-3]}"#, #"{"t":"nade","p":[1,1.5,-3],"v":[0,0,-400]}"#,
            #"{"t":"nade","p":[1,1.5,9e9],"v":[0,0,-10]}"#, #"{"t":"boom","p":[1,"x",3]}"#, #"{"t":"boom"}"#,
            #"{"t":"action","actor":0,"weapon":"grenade","stage":"magOut"}"#, #"{"t":"switch","weapon":"grenade"}"#,
        ]
        for text in bad {
            #expect(EventCodec.parse(text) == nil, "\(text)")
        }
    }

    @Test func rejectsTextThatIsNotJSONOrTooLong() {
        #expect(EventCodec.parse("{not json") == nil)
        #expect(EventCodec.parse(#"{"t":"hello","v":1,"name":""# + String(repeating: "x", count: Wire.maxEventChars) + #""}"#) == nil)
    }

    @Test func survivesFuzzedObjects() {
        var random = SeededRandom(seed: 7)
        func pick<T>(_ items: [T]) -> T { items[Int((random.next() * Double(items.count)).rounded(.down))] }
        let junk = ["null", "1", "-1", "1e400", #""x""#, #""""#, "[]", "{}", "true", "[1,2,3]", #"{"length":3}"#, #""m4a1""#, #""head""#, "0.5"]
        let types = ["hello", "lobby", "ready", "load", "loaded", "go", "hit", "death", "action", "switch", "botSpawn", "match", "away", "bye"]
        let keys = ["v", "name", "config", "ready", "at", "target", "attacker", "weapon", "zone", "amount", "p", "d", "victim", "killer",
                    "headshot", "life", "actor", "stage", "id", "yaw", "wave", "enemies", "result", "away", "reason"]
        for _ in 0..<3000 {
            var text = #"{"t":""# + pick(types) + "\""
            for key in keys where random.next() < 0.5 { text += ",\"\(key)\":" + pick(junk) }
            _ = EventCodec.parse(text + "}")
        }
    }
}

@Suite struct LimitTests {
    @Test func sanitizeName() {
        #expect(Sanitize.name("Ada") == "Ada")
        #expect(Sanitize.name("Zoë_99") == "Zoë_99")
        #expect(Sanitize.name("<script>x</script>") == "scriptxscript")
        #expect(Sanitize.name("  a \u{0000}\u{202E}  b\n") == "a b")
        #expect(Sanitize.name("abcdefghijklmnopqrstuvwxyz") == "abcdefghijklmnop")
        #expect(Sanitize.name("<<<>>>") == "Player")
        #expect(Sanitize.name("", fallback: "Friend") == "Friend")
    }

    @Test func damageCap() throws {
        let contract = try Contract(directory: ContractLocation.sourceTreeDirectory)
        let m4 = try #require(contract.weapons.def("m4a1"))
        let most = DamageCap.maxHit(m4)
        #expect(close(most, m4.damage * m4.headshotMultiplier, 6))
        #expect(DamageCap.cap(m4, most) == most)
        #expect(DamageCap.cap(m4, 10_000) == most)
        #expect(DamageCap.cap(m4, 12) == 12)
        let m24 = try #require(contract.weapons.def("m24"))
        #expect(DamageCap.cap(m24, -4) == 0)
        #expect(DamageCap.cap(m24, .nan) == 0)
        #expect(DamageCap.cap(m24, .infinity) == 0)
    }

    @Test func tokenBucket() {
        var bucket = TokenBucket(perSecond: 10, size: 3)
        let burst = [bucket.take(now: 0), bucket.take(now: 0), bucket.take(now: 0), bucket.take(now: 0)]
        let refill = [bucket.take(now: 100), bucket.take(now: 100), bucket.take(now: 5000)]
        #expect(burst == [true, true, true, false])
        #expect(refill == [true, false, true])
        var small = TokenBucket(perSecond: 10, size: 2)
        let capped = [small.take(now: 60_000, count: 2), small.take(now: 60_000), small.take(now: 1000)]
        #expect(capped == [true, false, false])
    }

    @Test func weaponGate() throws {
        let contract = try Contract(directory: ContractLocation.sourceTreeDirectory)
        let m4 = try #require(contract.weapons.def("m4a1"))
        let interval = 60_000 / m4.roundsPerMinute
        var gate = WeaponGate()
        let steady = (0..<40).filter { gate.allowShot(m4, now: Double($0) * interval) }.count
        #expect(steady == 40)
        var fast = WeaponGate()
        let through = (0..<270).filter { fast.allowShot(m4, now: Double($0) * (interval / 10)) }.count
        #expect(through < 60 && through > 20)
        let m24 = try #require(contract.weapons.def("m24"))
        var bolt = WeaponGate()
        let boltHits = (0..<50).filter { bolt.allowHit(m24, now: Double($0) * 20) }.count
        #expect(boltHits <= 4)
    }

    @Test func roomCodes() {
        var n = 0.0
        let code = RoomCode.make { defer { n += 1 }; return JS.mod(n * 0.137, 1) }
        #expect(code.count == RoomCode.length)
        #expect(RoomCode.isValid(code))
        #expect(!code.contains { "ILO01".contains($0) })
        #expect(RoomCode.isValid(RoomCode.make()))
        #expect(RoomCode.normalize(" k7m-2qx ") == "K7M2QX")
        #expect(RoomCode.isValid(RoomCode.normalize("k7m 2qx")))
        #expect(!RoomCode.isValid("K7M2Q"))
        #expect(!RoomCode.isValid("K7M2QO"))
    }

    @Test func chatLines() {
        #expect(Sanitize.chat("  nice shot  ") == "nice shot")
        #expect(Sanitize.chat("one\ntwo\u{0000}three\u{200B}") == "one two three")
        #expect(JS.length(Sanitize.chat(String(repeating: "x", count: 500))) == Sanitize.chatLength)
        #expect(Sanitize.chat("   ") == "")
        #expect(EventCodec.parse(EventCodec.encode(.chat("on your left"))) == .chat("on your left"))
        #expect(EventCodec.parse(#"{"t":"chat","text":"<b>hi</b>\n"}"#) == .chat("<b>hi</b>"))
        #expect(EventCodec.parse(#"{"t":"chat","text":""}"#) == nil)
    }
}

@Suite struct InviteTests {
    static let sdp = [
        "v=0", "o=- 4611731400430051336 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0", "a=extmap-allow-mixed",
        "a=msid-semantic: WMS", "m=application 54321 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 203.0.113.7",
        "a=candidate:1 1 udp 2113937151 0d8e7a1c-1c1f-4a0b-b1b4-2f8c9d6a4e11.local 54321 typ host generation 0 network-cost 999",
        "a=candidate:2 1 udp 1677729535 203.0.113.7 54321 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999",
        "a=ice-ufrag:4ZcD", "a=ice-pwd:2/1muCWoOi3uLifh0NuRHlQ1", "a=ice-options:trickle",
        "a=fingerprint:sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08",
        "a=setup:actpass", "a=mid:0", "a=sctp-port:5000", "a=max-message-size:262144", "",
    ].joined(separator: "\r\n")

    @Test func roundTripsAnOfferAndAnAnswer() {
        #expect(InviteCodec.decode(InviteCodec.encode(kind: .offer, sdp: Self.sdp), expected: .offer) == .success(Self.sdp))
        #expect(InviteCodec.decode(InviteCodec.encode(kind: .answer, sdp: Self.sdp), expected: .answer) == .success(Self.sdp))
    }

    @Test func survivesWhitespaceAMessengerAdds() {
        let code = Array(InviteCodec.encode(kind: .offer, sdp: Self.sdp))
        let wrapped = "  " + String(code[0..<40]) + "\n" + String(code[40..<90]) + " \r\n" + String(code[90...]) + "\n"
        #expect(InviteCodec.decode(wrapped, expected: .offer) == .success(Self.sdp))
    }

    @Test func refusesWrongKindEmptyJunkAndCutCodes() {
        let code = InviteCodec.encode(kind: .offer, sdp: Self.sdp)
        #expect(InviteCodec.decode(code, expected: .answer) == .failure(.wrongKind))
        #expect(InviteCodec.decode("   ", expected: .offer) == .failure(.empty))
        #expect(InviteCodec.decode("see you at eight", expected: .offer) == .failure(.malformed))
        #expect(InviteCodec.decode("K7M2QX", expected: .offer) == .failure(.malformed))
        #expect(InviteCodec.decode(String(code.dropLast(25)), expected: .offer) == .failure(.malformed))
        #expect(InviteCodec.decode("IVH1." + String(repeating: "A", count: InviteCodec.maxCodeChars), expected: .offer) == .failure(.tooLong))
    }

    @Test func refusesContentsThatAreNotASessionDescription() {
        let notSdp = InviteCodec.encode(kind: .offer, sdp: "v=0\r\n<script>alert(1)</script>\u{0007}\r\n")
        #expect(InviteCodec.decode(notSdp, expected: .offer) == .failure(.malformed))
        #expect(InviteCodec.decode(InviteCodec.encode(kind: .offer, sdp: "hello there"), expected: .offer) == .failure(.malformed))
    }

    @Test func refusesASmallCodeThatUnpacksToSomethingHuge() {
        let bomb = InviteCodec.encode(kind: .offer, sdp: "v=0\r\n" + String(repeating: "a=x\r\n", count: 40_000))
        #expect(bomb.count < InviteCodec.maxCodeChars)
        #expect(InviteCodec.decode(bomb, expected: .offer) == .failure(.malformed))
    }

    @Test func neverAcceptsFuzzedText() {
        var random = SeededRandom(seed: 11)
        let alphabet = Array("IVHG1.ABCabc012-_=+/ \n{}<>")
        for _ in 0..<300 {
            var text = random.next() < 0.5 ? "IVH1." : ""
            let length = Int((random.next() * 200).rounded(.down))
            for _ in 0..<length { text.append(alphabet[Int((random.next() * Double(alphabet.count)).rounded(.down))]) }
            if case .success = InviteCodec.decode(text, expected: .offer) { Issue.record("accepted \(text)") }
        }
    }
}

@Suite struct InviteLinkTests {
    @Test func putsTheRoomCodeOnThePageAddress() {
        #expect(RoomCode.inviteLink(code: "ABC234", page: "https://ironvale.n3el.dev/play/?map=harbor#x") == "https://ironvale.n3el.dev/play/?join=ABC234")
    }

    @Test func readsTheCodeBackOutOfAPastedLink() {
        #expect(RoomCode.from(" https://ironvale.n3el.dev/play/?join=abc234 ") == "ABC234")
        #expect(RoomCode.from("https://x.dev/play/?q=high&join=ABC-234") == "ABC234")
        #expect(RoomCode.from("abc 234") == "ABC234")
        #expect(RoomCode.isValid(RoomCode.from("abc-234")))
        #expect(!RoomCode.isValid(RoomCode.from("https://example.com/")))
        #expect(!RoomCode.isValid(RoomCode.from("")))
    }
}

// Ported from src/net/protocol.ts at commit cbe0add.
//
// State travels as compact binary on the unreliable channel; shots are binary on the reliable
// one. Every decoder returns nil for anything it does not recognise: wrong length, values that
// are not finite, ids nobody defined. Nothing here throws. All multi-byte fields little-endian.
import Foundation
import IronvaleCore

public struct PlayerState: Sendable, Equatable {
    /// Wraps at 65536; lets the receiver drop duplicates.
    public var seq: Int
    /// Sender's clock, milliseconds.
    public var time: Double
    public var x: Double, y: Double, z: Double
    public var vx: Double, vy: Double, vz: Double
    public var yaw: Double
    public var pitch: Double
    public var crouching: Bool
    public var sprinting: Bool
    public var aiming: Bool
    public var alive: Bool
    public var onGround: Bool
    public var reloading: Bool
    public var weapon: WeaponID
    /// 0 - 100, whole numbers.
    public var health: Double
    /// Goes up by one at every respawn.
    public var life: Int

    public init(
        seq: Int, time: Double, x: Double, y: Double, z: Double, vx: Double, vy: Double, vz: Double,
        yaw: Double, pitch: Double, crouching: Bool, sprinting: Bool, aiming: Bool, alive: Bool,
        onGround: Bool, reloading: Bool, weapon: WeaponID, health: Double, life: Int
    ) {
        self.seq = seq
        self.time = time
        self.x = x
        self.y = y
        self.z = z
        self.vx = vx
        self.vy = vy
        self.vz = vz
        self.yaw = yaw
        self.pitch = pitch
        self.crouching = crouching
        self.sprinting = sprinting
        self.aiming = aiming
        self.alive = alive
        self.onGround = onGround
        self.reloading = reloading
        self.weapon = weapon
        self.health = health
        self.life = life
    }
}

public struct BotState: Sendable, Equatable {
    /// Wire id.
    public var id: Int
    public var x: Double, y: Double, z: Double
    public var yaw: Double
    public var pitch: Double
    /// Horizontal speed, m/s.
    public var speed: Double
    public var crouching: Bool
    public var aiming: Bool
    public var reloading: Bool
    public var alive: Bool
    public var weapon: WeaponID

    public init(
        id: Int, x: Double, y: Double, z: Double, yaw: Double, pitch: Double, speed: Double,
        crouching: Bool, aiming: Bool, reloading: Bool, alive: Bool, weapon: WeaponID
    ) {
        self.id = id
        self.x = x
        self.y = y
        self.z = z
        self.yaw = yaw
        self.pitch = pitch
        self.speed = speed
        self.crouching = crouching
        self.aiming = aiming
        self.reloading = reloading
        self.alive = alive
        self.weapon = weapon
    }
}

public struct ShotMessage: Sendable, Equatable {
    /// Wire id of the shooter.
    public var actor: Int
    public var weapon: WeaponID
    public var muzzle: Vec3
    public var direction: Vec3
    /// Where each projectile stopped.
    public var ends: [Vec3]

    public init(actor: Int, weapon: WeaponID, muzzle: Vec3, direction: Vec3, ends: [Vec3]) {
        self.actor = actor
        self.weapon = weapon
        self.muzzle = muzzle
        self.direction = direction
        self.ends = ends
    }
}

public enum BinaryMessage: Sendable, Equatable {
    case state(PlayerState)
    case bots(seq: Int, time: Double, bots: [BotState])
    case shot(ShotMessage)
    case ping(id: Int, sentAt: Double)
    case pong(id: Int, sentAt: Double, remoteTime: Double)
}

public enum BinaryCodec {
    static let typeState: UInt8 = 1
    static let typeBots: UInt8 = 2
    static let typeShot: UInt8 = 3
    static let typePing: UInt8 = 4
    static let typePong: UInt8 = 5

    public static let stateBytes = 37
    public static let botsHeaderBytes = 12
    public static let botBytes = 20
    public static let shotHeaderBytes = 23
    public static let pingBytes = 10
    public static let pongBytes = 18

    public static let angleScale: Double = 10000
    public static let velocityScale: Double = 100
    public static let speedScale: Double = 20
    public static let directionScale: Double = 32767
    static let deg = Double.pi / 180

    // MARK: Helpers with JS semantics

    static func clamp(_ value: Double, _ min: Double, _ max: Double) -> Double {
        // Same comparisons as the TS ternary, so NaN passes through unchanged.
        value < min ? min : value > max ? max : value
    }

    /// `((angle + PI) % 2PI + 2PI) % 2PI - PI` with JS truncated `%`.
    public static func wrapAngle(_ angle: Double) -> Double {
        let turn = Double.pi * 2
        let wrapped = JS.mod(JS.mod(angle + .pi, turn) + turn, turn)
        return wrapped - .pi
    }

    static func int16(_ value: Double, _ scale: Double) -> Int16 {
        integer(clamp(JS.round(value * scale), -32767, 32767))
    }

    /// DataView's ToInt16/ToUint8 for a value already clamped into range: NaN stores 0.
    static func integer<T: FixedWidthInteger>(_ value: Double) -> T {
        value.isNaN ? 0 : T(value)
    }

    static func coordinate(_ value: Double) -> Bool { value.isFinite && abs(value) <= Wire.maxCoordinate }

    static func timestamp(_ value: Double) -> Bool { value.isFinite && value >= 0 && value <= Wire.maxTimeMs }

    /// V8's `Math.hypot`: scaled by the largest magnitude, Kahan-summed, then `sqrt(sum) * max`.
    static func hypot(_ values: Double...) -> Double {
        var max = 0.0
        var sawNaN = false
        for value in values {
            let magnitude = abs(value)
            if magnitude.isNaN { sawNaN = true } else if magnitude > max { max = magnitude }
        }
        if max == .infinity { return .infinity }
        if sawNaN { return .nan }
        if max == 0 { return 0 }
        var sum = 0.0
        var compensation = 0.0
        for value in values {
            let n = abs(value) / max
            let summand = n * n - compensation
            let preliminary = sum + summand
            compensation = (preliminary - sum) - summand
            sum = preliminary
        }
        return sum.squareRoot() * max
    }

    // MARK: Encode

    public static func encode(_ message: BinaryMessage) -> [UInt8] {
        switch message {
        case .state(let state): encodeState(state)
        case .bots(let seq, let time, let bots): encodeBots(seq: seq, time: time, bots: bots)
        case .shot(let shot): encodeShot(shot)
        case .ping(let id, let sentAt): encodePing(id: id, sentAt: sentAt)
        case .pong(let id, let sentAt, let remoteTime): encodePong(id: id, sentAt: sentAt, remoteTime: remoteTime)
        }
    }

    public static func encodeState(_ state: PlayerState) -> [UInt8] {
        var out = ByteWriter(capacity: stateBytes)
        out.u8(typeState)
        out.u16(UInt16(truncatingIfNeeded: state.seq & 0xFFFF))
        out.f64(state.time)
        out.f32(state.x)
        out.f32(state.y)
        out.f32(state.z)
        out.i16(int16(state.vx, velocityScale))
        out.i16(int16(state.vy, velocityScale))
        out.i16(int16(state.vz, velocityScale))
        out.i16(int16(wrapAngle(state.yaw), angleScale))
        out.i16(int16(clamp(state.pitch, -.pi / 2, .pi / 2), angleScale))
        var flags: UInt8 = 0
        if state.crouching { flags |= 1 }
        if state.sprinting { flags |= 2 }
        if state.aiming { flags |= 4 }
        if state.alive { flags |= 8 }
        if state.onGround { flags |= 16 }
        if state.reloading { flags |= 32 }
        out.u8(flags)
        out.u8(UInt8(state.weapon.wireIndex))
        out.u8(integer(clamp(JS.round(state.health), 0, 100)))
        out.u8(UInt8(truncatingIfNeeded: state.life & 0xFF))
        return out.bytes
    }

    /// At most `Wire.maxBotsPerSnapshot` bots; send a larger squad as several snapshots.
    public static func encodeBots(seq: Int, time: Double, bots: [BotState]) -> [UInt8] {
        let count = min(bots.count, Wire.maxBotsPerSnapshot)
        var out = ByteWriter(capacity: botsHeaderBytes + count * botBytes)
        out.u8(typeBots)
        out.u16(UInt16(truncatingIfNeeded: seq & 0xFFFF))
        out.f64(time)
        out.u8(UInt8(count))
        for bot in bots.prefix(count) {
            out.u16(UInt16(truncatingIfNeeded: bot.id & 0xFFFF))
            out.f32(bot.x)
            out.f32(bot.y)
            out.f32(bot.z)
            out.i16(int16(wrapAngle(bot.yaw), angleScale))
            out.i8(integer(clamp(JS.round(bot.pitch / deg), -90, 90)))
            out.u8(integer(clamp(JS.round(bot.speed * speedScale), 0, 255)))
            var flags: UInt8 = 0
            if bot.crouching { flags |= 1 }
            if bot.aiming { flags |= 2 }
            if bot.reloading { flags |= 4 }
            if bot.alive { flags |= 8 }
            out.u8(flags)
            out.u8(UInt8(bot.weapon.wireIndex))
        }
        return out.bytes
    }

    public static func encodeShot(_ shot: ShotMessage) -> [UInt8] {
        let count = min(shot.ends.count, Wire.maxPellets)
        var out = ByteWriter(capacity: shotHeaderBytes + count * 12)
        out.u8(typeShot)
        out.u16(UInt16(truncatingIfNeeded: shot.actor & 0xFFFF))
        out.u8(UInt8(shot.weapon.wireIndex))
        out.f32(shot.muzzle.x)
        out.f32(shot.muzzle.y)
        out.f32(shot.muzzle.z)
        out.i16(int16(shot.direction.x, directionScale))
        out.i16(int16(shot.direction.y, directionScale))
        out.i16(int16(shot.direction.z, directionScale))
        out.u8(UInt8(count))
        for end in shot.ends.prefix(count) {
            out.f32(end.x)
            out.f32(end.y)
            out.f32(end.z)
        }
        return out.bytes
    }

    public static func encodePing(id: Int, sentAt: Double) -> [UInt8] {
        var out = ByteWriter(capacity: pingBytes)
        out.u8(typePing)
        out.u8(UInt8(truncatingIfNeeded: id & 0xFF))
        out.f64(sentAt)
        return out.bytes
    }

    public static func encodePong(id: Int, sentAt: Double, remoteTime: Double) -> [UInt8] {
        var out = ByteWriter(capacity: pongBytes)
        out.u8(typePong)
        out.u8(UInt8(truncatingIfNeeded: id & 0xFF))
        out.f64(sentAt)
        out.f64(remoteTime)
        return out.bytes
    }

    // MARK: Decode

    public static func decode(_ data: Data) -> BinaryMessage? { decode([UInt8](data)) }

    public static func decode(_ bytes: [UInt8]) -> BinaryMessage? {
        guard let type = bytes.first else { return nil }
        let view = ByteReader(bytes: bytes)
        switch type {
        case typeState: return decodeState(view)
        case typeBots: return decodeBots(view)
        case typeShot: return decodeShot(view)
        case typePing:
            guard bytes.count == pingBytes else { return nil }
            let sentAt = view.f64(2)
            return timestamp(sentAt) ? .ping(id: Int(view.u8(1)), sentAt: sentAt) : nil
        case typePong:
            guard bytes.count == pongBytes else { return nil }
            let sentAt = view.f64(2)
            let remoteTime = view.f64(10)
            return timestamp(sentAt) && timestamp(remoteTime) ? .pong(id: Int(view.u8(1)), sentAt: sentAt, remoteTime: remoteTime) : nil
        default:
            return nil
        }
    }

    static func decodeState(_ view: ByteReader) -> BinaryMessage? {
        guard view.count == stateBytes else { return nil }
        let time = view.f64(3)
        let x = view.f32(11), y = view.f32(15), z = view.f32(19)
        let health = view.u8(35)
        guard let weapon = WeaponID(wireIndex: Int(view.u8(34))),
              timestamp(time), coordinate(x), coordinate(y), coordinate(z), health <= 100 else { return nil }
        let flags = view.u8(33)
        return .state(PlayerState(
            seq: Int(view.u16(1)),
            time: time,
            x: x, y: y, z: z,
            vx: Double(view.i16(23)) / velocityScale,
            vy: Double(view.i16(25)) / velocityScale,
            vz: Double(view.i16(27)) / velocityScale,
            yaw: wrapAngle(Double(view.i16(29)) / angleScale),
            pitch: clamp(Double(view.i16(31)) / angleScale, -.pi / 2, .pi / 2),
            crouching: flags & 1 != 0,
            sprinting: flags & 2 != 0,
            aiming: flags & 4 != 0,
            alive: flags & 8 != 0,
            onGround: flags & 16 != 0,
            reloading: flags & 32 != 0,
            weapon: weapon,
            health: Double(health),
            life: Int(view.u8(36))
        ))
    }

    static func decodeBots(_ view: ByteReader) -> BinaryMessage? {
        guard view.count >= botsHeaderBytes else { return nil }
        let count = Int(view.u8(11))
        let time = view.f64(3)
        guard count <= Wire.maxBotsPerSnapshot, view.count == botsHeaderBytes + count * botBytes, timestamp(time) else { return nil }
        var bots: [BotState] = []
        bots.reserveCapacity(count)
        for i in 0..<count {
            let at = botsHeaderBytes + i * botBytes
            let id = Int(view.u16(at))
            let x = view.f32(at + 2), y = view.f32(at + 6), z = view.f32(at + 10)
            let pitch = Int(view.i8(at + 16))
            guard id >= Wire.botBase, coordinate(x), coordinate(y), coordinate(z), pitch >= -90, pitch <= 90,
                  let weapon = WeaponID(wireIndex: Int(view.u8(at + 19))) else { return nil }
            let flags = view.u8(at + 18)
            bots.append(BotState(
                id: id, x: x, y: y, z: z,
                yaw: wrapAngle(Double(view.i16(at + 14)) / angleScale),
                pitch: Double(pitch) * deg,
                speed: Double(view.u8(at + 17)) / speedScale,
                crouching: flags & 1 != 0,
                aiming: flags & 2 != 0,
                reloading: flags & 4 != 0,
                alive: flags & 8 != 0,
                weapon: weapon
            ))
        }
        return .bots(seq: Int(view.u16(1)), time: time, bots: bots)
    }

    static func readPoint(_ view: ByteReader, _ at: Int) -> Vec3? {
        let x = view.f32(at), y = view.f32(at + 4), z = view.f32(at + 8)
        return coordinate(x) && coordinate(y) && coordinate(z) ? Vec3(x, y, z) : nil
    }

    static func decodeShot(_ view: ByteReader) -> BinaryMessage? {
        guard view.count >= shotHeaderBytes else { return nil }
        let count = Int(view.u8(22))
        guard count <= Wire.maxPellets, view.count == shotHeaderBytes + count * 12 else { return nil }
        guard let weapon = WeaponID(wireIndex: Int(view.u8(3))), let muzzle = readPoint(view, 4) else { return nil }
        let dx = Double(view.i16(16)) / directionScale
        let dy = Double(view.i16(18)) / directionScale
        let dz = Double(view.i16(20)) / directionScale
        let length = hypot(dx, dy, dz)
        guard length >= 0.9, length <= 1.1 else { return nil }
        var ends: [Vec3] = []
        ends.reserveCapacity(count)
        for i in 0..<count {
            guard let end = readPoint(view, shotHeaderBytes + i * 12) else { return nil }
            ends.append(end)
        }
        return .shot(ShotMessage(
            actor: Int(view.u16(1)),
            weapon: weapon,
            muzzle: muzzle,
            direction: Vec3(dx / length, dy / length, dz / length),
            ends: ends
        ))
    }
}

// MARK: - Little-endian byte access

struct ByteWriter {
    private(set) var bytes: [UInt8] = []

    init(capacity: Int) { bytes.reserveCapacity(capacity) }

    mutating func u8(_ value: UInt8) { bytes.append(value) }
    mutating func i8(_ value: Int8) { bytes.append(UInt8(bitPattern: value)) }
    mutating func u16(_ value: UInt16) { append(value) }
    mutating func i16(_ value: Int16) { append(UInt16(bitPattern: value)) }
    /// Float64 to float32 rounds to nearest, ties to even, as DataView.setFloat32 does.
    mutating func f32(_ value: Double) { append(Float(value).bitPattern) }
    mutating func f64(_ value: Double) { append(value.bitPattern) }

    private mutating func append<T: FixedWidthInteger>(_ value: T) {
        withUnsafeBytes(of: value.littleEndian) { bytes.append(contentsOf: $0) }
    }
}

struct ByteReader {
    let bytes: [UInt8]

    var count: Int { bytes.count }

    func u8(_ at: Int) -> UInt8 { bytes[at] }
    func i8(_ at: Int) -> Int8 { Int8(bitPattern: bytes[at]) }
    func u16(_ at: Int) -> UInt16 { read(at) }
    func i16(_ at: Int) -> Int16 { Int16(bitPattern: read(at)) }
    func f32(_ at: Int) -> Double { Double(Float(bitPattern: read(at))) }
    func f64(_ at: Int) -> Double { Double(bitPattern: read(at)) }

    private func read<T: FixedWidthInteger>(_ at: Int) -> T {
        var value: T = 0
        for index in 0..<MemoryLayout<T>.size {
            value |= T(bytes[at + index]) << (8 * index)
        }
        return value
    }
}

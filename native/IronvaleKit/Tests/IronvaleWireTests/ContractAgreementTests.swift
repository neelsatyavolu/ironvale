// The Swift wire constants and enums against native/Contract (extracted from src/ by
// contract-export). A web change to any of them fails here until the Swift side follows.
import IronvaleContract
import Testing
@testable import IronvaleWire

@Test func wireConstantsMatchContract() throws {
    let contract = try Contract(directory: ContractLocation.sourceTreeDirectory)
    let p = contract.protocolTable
    #expect(Wire.protocolVersion == p.protocolVersion)
    #expect(Wire.host == p.wire.host)
    #expect(Wire.guest == p.wire.guest)
    #expect(Wire.botBase == p.wire.botBase)
    #expect(Wire.maxWireId == p.wire.maxWireId)
    #expect(Wire.maxEventChars == p.wire.maxEventChars)
    #expect(Wire.maxPellets == p.wire.maxPellets)
    #expect(Wire.maxBotsPerSnapshot == p.wire.maxBotsPerSnapshot)
    #expect(Wire.maxCoordinate == p.wire.maxCoordinate)
    #expect(Wire.maxTimeMs == p.wire.maxTimeMs)
}

@Test func binaryLayoutMatchesContract() throws {
    let b = try Contract(directory: ContractLocation.sourceTreeDirectory).protocolTable.binary
    #expect([BinaryCodec.typeState, BinaryCodec.typeBots, BinaryCodec.typeShot, BinaryCodec.typePing, BinaryCodec.typePong].map(Int.init)
        == [b.TYPE_STATE, b.TYPE_BOTS, b.TYPE_SHOT, b.TYPE_PING, b.TYPE_PONG])
    #expect([BinaryCodec.stateBytes, BinaryCodec.botsHeaderBytes, BinaryCodec.botBytes, BinaryCodec.shotHeaderBytes, BinaryCodec.pingBytes, BinaryCodec.pongBytes]
        == [b.STATE_BYTES, b.BOTS_HEADER_BYTES, b.BOT_BYTES, b.SHOT_HEADER_BYTES, b.PING_BYTES, b.PONG_BYTES])
    #expect([BinaryCodec.angleScale, BinaryCodec.velocityScale, BinaryCodec.speedScale, BinaryCodec.directionScale]
        == [b.ANGLE_SCALE, b.VELOCITY_SCALE, b.SPEED_SCALE, b.DIRECTION_SCALE])
}

@Test func weaponOrderMatchesContract() throws {
    let weapons = try Contract(directory: ContractLocation.sourceTreeDirectory).weapons
    #expect(WeaponID.allCases.map(\.rawValue) == weapons.weaponIds)
    #expect(DamageSource.grenadeID == weapons.grenadeId)
}

@Test func eventVocabularyMatchesContract() throws {
    let e = try Contract(directory: ContractLocation.sourceTreeDirectory).protocolTable.events
    #expect(NetMode.allCases.map(\.rawValue) == e.MODES)
    #expect(DuelBot.allCases.map(\.rawValue) == e.DUEL_BOTS)
    #expect(NetRules.allCases.map(\.rawValue) == e.RULES)
    #expect(Difficulty.allCases.map(\.rawValue) == e.DIFFICULTIES)
    #expect(HitZone.allCases.map(\.rawValue) == e.ZONES)
    #expect(ByeReason.allCases.map(\.rawValue) == e.BYE_REASONS)
    #expect(MatchResult.allCases.map(\.rawValue) == e.RESULTS)
    #expect(WeaponActionStage.allCases.map(\.rawValue) == e.STAGES)
    #expect(e.MAP_ID == "^[a-z0-9-]{1,24}$", "EventCodec.isMapId implements this pattern by hand")
    #expect(EventCodec.maxDamage == e.MAX_DAMAGE)
    #expect(EventCodec.maxCount == e.MAX_COUNT)
    #expect(EventCodec.maxThrowSpeed == e.MAX_THROW_SPEED)
    #expect(EventCodec.maxNetBots == e.maxNetBots)
    #expect(EventCodec.maxKillTarget == e.maxKillTarget)
    #expect(DamageSource.grenadeID == e.grenadeSource)
}

@Test func limitsRoomAndInviteMatchContract() throws {
    let p = try Contract(directory: ContractLocation.sourceTreeDirectory).protocolTable
    #expect(Sanitize.nameLength == p.limits.nameLength)
    #expect(Sanitize.chatLength == p.limits.chatLength)
    #expect(WeaponGate.rateSlack == p.limits.RATE_SLACK)
    #expect(WeaponGate.burstSeconds == p.limits.BURST_SECONDS)
    #expect(RoomCode.alphabet == p.room.alphabet)
    #expect(RoomCode.length == p.room.length)
    #expect(RoomCode.joinParam == p.room.joinParam)
    #expect(InviteCodec.maxCodeChars == p.invite.maxCodeChars)
    #expect(InviteCodec.maxSdpBytes == p.invite.MAX_SDP_BYTES)
    #expect(InviteCodec.prefix(.offer) == p.invite.PREFIX["offer"])
    #expect(InviteCodec.prefix(.answer) == p.invite.PREFIX["answer"])
}

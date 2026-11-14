// Ported from the co-op parts of src/net/session.ts at commit cbe0add (`authority`, `partner`,
// `partnerKills`, `hostMatch`, `reportMatch`): what the match rules ask of a two-player session (M7b).
import Foundation
import IronvaleSim
import enum IronvaleWire.MatchResult

/// The host says how the co-op match stands at least this often, even when nothing changed.
private let matchReportMs = 500.0

extension NetMatch {
    /// False only for a co-op guest while the host is there: the host runs the bots, waves and result.
    public var authority: Bool {
        !(session.inMatch && role == .guest && config?.mode == .coop)
    }

    public var partner: NetPartner? {
        guard let sync, session.inMatch else { return nil }
        return NetPartner(id: sync.remote.id, alive: sync.remote.alive, deaths: sync.partnerDeaths)
    }

    public var partnerKills: Int { sync?.partnerKills ?? 0 }

    public var hostMatch: (wave: Int, enemies: Int)? { authority ? nil : sync?.hostMatch }

    /// Co-op host: tell the guest the wave, enemies left, the result and both kill counts when any of
    /// them changed, and twice a second regardless.
    public func reportMatch(wave: Int, enemies: Int, result: GamePhase?, localKills: Int) {
        guard session.inMatch, role == .host, config?.mode == .coop, localLoaded else { return }
        let verdict: MatchResult = result == .won ? .won : result == .lost ? .lost : .none
        // The last kill must reach the guest before the result it produced.
        if verdict != .none { sync?.flush() }
        let now = NetClock.now()
        let key = "\(wave)|\(enemies)|\(verdict.rawValue)|\(localKills)|\(partnerKills)"
        if key == lastReport, now - lastReportAt < matchReportMs { return }
        lastReport = key
        lastReportAt = now
        session.send(.match(wave: wave, enemies: enemies, result: verdict, hostKills: localKills, guestKills: partnerKills))
    }
}

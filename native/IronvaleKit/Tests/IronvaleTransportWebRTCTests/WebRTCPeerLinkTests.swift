// WebRTCPeerLink in one process: two links wired back to back (no relay), checking the PLAN.md
// 3.11.1 details the web relies on: negotiated channels, text versus binary frames on `events`,
// the 8192-byte receive drop, and the candidate filter.
import Foundation
import IronvaleNet
import Testing
@testable import IronvaleTransportWebRTC

@Test func candidateFilter() {
    #expect(CandidateFilter.allows("candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host generation 0 ufrag AbCd network-id 1"))
    #expect(CandidateFilter.allows("candidate:2 1 udp 1686052607 203.0.113.9 54321 typ srflx raddr 192.168.1.2 rport 54321"))
    #expect(CandidateFilter.allows("candidate:3 1 udp 2122262783 2001:db8::5 50000 typ host"))
    #expect(CandidateFilter.allows("candidate:4 1 udp 2122262783 3c1f0d6e-1111-4c4e-9a4b-2b8a8d3c6c11.local 50000 typ host"))
    #expect(!CandidateFilter.allows("candidate:5 1 udp 2122262783 127.0.0.1 50000 typ host"))
    #expect(!CandidateFilter.allows("candidate:6 1 udp 2122262783 ::1 50000 typ host"))
    #expect(!CandidateFilter.allows("candidate:7 1 udp 2122262783 fe80::1c2b:3aff:fe4d:5e6f 50000 typ host"))
    #expect(!CandidateFilter.allows("candidate:8 1 udp 2122262783 169.254.10.20 50000 typ host"))
    #expect(!CandidateFilter.allows("not a candidate"))
    #expect(CandidateFilter.usernameFragment("candidate:1 1 udp 1 10.0.0.1 1 typ host generation 0 ufrag AbCd network-id 1") == "AbCd")
    #expect(CandidateFilter.usernameFragment("candidate:1 1 udp 1 10.0.0.1 1 typ host") == nil)
}

@MainActor
private final class Side {
    var link: PeerLink!
    var opened = false
    var closed = false
    var states: [[UInt8]] = []
    var texts: [String] = []
    var binaries: [[UInt8]] = []
    var signals: [SignalMessage] = []
    weak var other: Side?

    func handlers() -> PeerLinkHandlers {
        PeerLinkHandlers(
            onOpen: { self.opened = true },
            onState: { self.states.append($0) },
            onEventText: { self.texts.append($0) },
            onEventBinary: { self.binaries.append($0) },
            onClosed: { self.closed = true },
            onSignal: { message in
                self.signals.append(message)
                guard let other = self.other else { return }
                switch message {
                case .offer(let sdp): other.link.acceptOffer(sdp: sdp, patient: false)
                case .answer(let sdp): other.link.acceptAnswer(sdp: sdp)
                case .candidate(let candidate): other.link.addCandidate(candidate)
                }
            }
        )
    }
}

@MainActor
private func waitUntil(_ what: String, seconds: Double = 15, _ condition: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(seconds)
    while !condition(), Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
    #expect(condition(), "timed out waiting for \(what)")
    if !condition() { throw CancellationError() }
}

@MainActor
@Test(arguments: [true, false])
func backToBackLink(trickle: Bool) async throws {
    let host = Side()
    let guest = Side()
    host.other = guest
    guest.other = host
    // Host candidates only: no STUN, so the test needs no network beyond this machine.
    let options = PeerLinkOptions(iceServers: [], trickle: trickle)
    host.link = WebRTCPeerLink.make(options: options, handlers: host.handlers())
    guest.link = WebRTCPeerLink.make(options: options, handlers: guest.handlers())
    host.link.makeOffer()
    try await waitUntil("both channels open") { host.opened && guest.opened }
    #expect(host.link.isOpen && guest.link.isOpen)

    let sentCandidates = host.signals.filter { if case .candidate = $0 { true } else { false } }.count
    #expect(sentCandidates <= TransportLimits.maxTrickledCandidates)
    if !trickle { #expect(sentCandidates == 0) }

    // Text stays text and binary stays binary on the reliable channel; state is binary only.
    #expect(host.link.sendEvent(text: #"{"t":"ready","ready":true}"#))
    #expect(host.link.sendEvent(binary: [3, 1, 2, 3]))
    host.link.sendState([1, 9, 9])
    try await waitUntil("frames") { guest.texts.count == 1 && guest.binaries.count == 1 && guest.states.count == 1 }
    #expect(guest.texts == [#"{"t":"ready","ready":true}"#])
    #expect(guest.binaries == [[3, 1, 2, 3]])
    #expect(guest.states == [[1, 9, 9]])

    // The receiver drops frames over 8192 bytes, as transport.ts does.
    guest.link.sendState([UInt8](repeating: 7, count: 9000))
    guest.link.sendState([UInt8](repeating: 7, count: 8192))
    try await waitUntil("big state") { host.states.count == 1 }
    try await Task.sleep(for: .milliseconds(100))
    #expect(host.states.map(\.count) == [8192])

    guest.link.close()
    try await waitUntil("host sees the close") { host.closed }
    #expect(!guest.closed, "closing a link yourself reports nothing")
    host.link.close()
}

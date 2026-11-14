// Web Audio AudioParam automation (setValueAtTime, linearRampToValueAtTime, setTargetAtTime,
// cancelScheduledValues), evaluated at a time. The same rules as the recording stub in
// native/Tools/audio-trace/stub-context.ts; MixCore's RenderParam renders the same curves per sample.

import Foundation

public struct ParamTimeline: Sendable {
    public let defaultValue: Double
    public private(set) var events: [Automation] = []

    public init(defaultValue: Double) {
        self.defaultValue = defaultValue
    }

    public mutating func apply(_ event: Automation) {
        if event.kind == .cancel {
            events.removeAll { $0.time >= event.time }
            return
        }
        // After every event at the same or an earlier time, before any later one.
        var index = events.count
        while index > 0 && events[index - 1].time > event.time { index -= 1 }
        events.insert(event, at: index)
    }

    /// Fold every event at or before `now` into at most two equivalent ones, so a long session's
    /// timeline stays short. Values at and after `now` are unchanged.
    public mutating func compact(now: Double) {
        guard events.count > 16, let k = events.lastIndex(where: { $0.time <= now }), k > 1 else { return }
        let last = events[k]
        var head: [Automation]
        if last.kind == .target {
            let start = ParamTimeline.evaluate(defaultValue: defaultValue, events: Array(events[..<k]), at: last.time)
            head = [Automation(.set, time: last.time, value: start), last]
        } else {
            head = [Automation(.set, time: last.time, value: last.value)]
        }
        head.append(contentsOf: events[(k + 1)...])
        events = head
    }

    public func value(at t: Double) -> Double {
        ParamTimeline.evaluate(defaultValue: defaultValue, events: events, at: t)
    }

    static func evaluate(defaultValue: Double, events: [Automation], at t: Double) -> Double {
        var value = defaultValue
        var targeting = false
        var segStart = 0.0, segFrom = defaultValue, segTarget = defaultValue, segTau = 1.0
        var prevTime = 0.0
        func at(_ time: Double) -> Double {
            targeting ? segTarget + (segFrom - segTarget) * exp(-(time - segStart) / segTau) : value
        }
        for event in events {
            if event.time > t {
                if event.kind == .lin {
                    let from = at(prevTime)
                    if event.time == prevTime { return event.value }
                    return from + ((event.value - from) * (t - prevTime)) / (event.time - prevTime)
                }
                return at(t)
            }
            let before = at(event.time)
            if event.kind == .target {
                targeting = true
                segStart = event.time
                segFrom = before
                segTarget = event.value
                segTau = event.tau
            } else {
                targeting = false
                value = event.value
            }
            prevTime = event.time
        }
        return at(t)
    }
}

// An AudioParam on the render thread: the same automation rules as ParamTimeline, rendered one
// value per sample. Events live in a fixed buffer and are consumed as time passes. No allocation.

import Foundation

struct RenderParam {
    static let capacity = 32

    private let events: UnsafeMutablePointer<Automation>
    private var count = 0
    /// Value of the current segment.
    private(set) var value: Double
    private var targeting = false
    private var target = 0.0
    private var decay = 0.0
    /// Per-sample factor of the exponential approach, exp(-1 / (tau * sampleRate)).
    private var factor = 0.0
    /// The incremental approach skipped samples (a ramp was in charge); resynchronise from the closed form.
    private var stale = false
    /// Time and value at the last event that took effect (where a following linear ramp starts).
    private var anchorTime = 0.0
    private var anchorValue: Double

    init(initial: Double) {
        events = .allocate(capacity: RenderParam.capacity)
        value = initial
        anchorValue = initial
    }

    func free() { events.deallocate() }

    /// Apply a command. A full buffer drops the oldest pending event (never happens at the web's rates).
    mutating func apply(_ event: Automation) {
        if event.kind == .cancel {
            var kept = 0
            for i in 0..<count where events[i].time < event.time {
                events[kept] = events[i]
                kept += 1
            }
            count = kept
            return
        }
        if count == RenderParam.capacity {
            for i in 1..<count { events[i - 1] = events[i] }
            count -= 1
        }
        var index = count
        while index > 0 && events[index - 1].time > event.time {
            events[index] = events[index - 1]
            index -= 1
        }
        events[index] = event
        count += 1
    }

    /// True when nothing will change: no pending events and not approaching a target.
    var isSteady: Bool { count == 0 && !targeting }

    /// Fill `out` with the value at t0, t0 + dt, ... (`frames` samples).
    mutating func render(_ out: UnsafeMutablePointer<Float>, frames: Int, t0: Double, dt: Double, sampleRate: Double) {
        if isSteady {
            let v = Float(value)
            for i in 0..<frames { out[i] = v }
            return
        }
        for i in 0..<frames {
            out[i] = Float(step(at: t0 + Double(i) * dt, sampleRate: sampleRate))
        }
    }

    /// Value at `t`, advancing the state. Calls must come in increasing `t`, one per sample.
    mutating func step(at t: Double, sampleRate: Double) -> Double {
        var changed = false
        defer { if count == 0 || events[0].kind != .lin { stale = false } }
        while count > 0 && events[0].time <= t {
            let event = events[0]
            let before = valueAt(event.time)
            for i in 1..<count { events[i - 1] = events[i] }
            count -= 1
            changed = true
            if event.kind == .target {
                targeting = true
                target = event.value
                decay = event.tau
                factor = exp(-1 / (event.tau * sampleRate))
                anchorTime = event.time
                anchorValue = before
                // Exact at this sample; the following ones decay by a constant factor per sample.
                value = target + (before - target) * exp(-(t - event.time) / event.tau)
            } else {
                targeting = false
                value = event.value
                anchorTime = event.time
                anchorValue = event.value
            }
        }
        if count > 0 && events[0].kind == .lin {
            let next = events[0]
            stale = true
            if next.time == anchorTime { return next.value }
            return anchorValue + (next.value - anchorValue) * (t - anchorTime) / (next.time - anchorTime)
        }
        if targeting && stale && !changed {
            value = target + (anchorValue - target) * exp(-(t - anchorTime) / decay)
        } else if targeting && !changed {
            value = target + (value - target) * factor
            // Settled below float32 resolution: stop stepping so a steady param costs nothing.
            if abs(value - target) <= 1e-9 * max(1, abs(target)) {
                value = target
                targeting = false
            }
        }
        return value
    }

    /// Value of the current segment at `t` (used where an event takes over).
    private func valueAt(_ t: Double) -> Double {
        if count > 0 && events[0].kind == .lin && events[0].time > anchorTime && t < events[0].time {
            return anchorValue + (events[0].value - anchorValue) * (t - anchorTime) / (events[0].time - anchorTime)
        }
        guard targeting else { return value }
        return target + (anchorValue - target) * exp(-(t - anchorTime) / decay)
    }
}

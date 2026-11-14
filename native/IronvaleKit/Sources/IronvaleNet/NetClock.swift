// The net time base (PLAN.md 5.1): a monotonic Double in milliseconds, never epoch time, which the
// web rejects above 1e12. The origin is arbitrary; ClockSync estimates the offset to the peer.
import Foundation

public enum NetClock {
    private static let origin = DispatchTime.now().uptimeNanoseconds

    /// Milliseconds since this process first asked, like `performance.now()`.
    public static func now() -> Double {
        let start = origin
        return Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
    }
}

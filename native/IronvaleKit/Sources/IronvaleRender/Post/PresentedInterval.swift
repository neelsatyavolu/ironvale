// What a vsynced display reports as the frame interval, for runs with no display (--offscreen).
// The web feeds DynamicResolution the requestAnimationFrame interval, and the native windowed loop
// the display link's: both are whole refresh intervals, so on a 120 Hz screen a frame that takes
// 8.6 ms arrives as 16.7 ms, which is past the controller's long-frame line (1.18 x budget). An
// offscreen run measures 8.6 ms itself and the controller never sees it as long, so it keeps a
// resolution the web would have stepped down. Rounding the offscreen interval up to whole refresh
// intervals gives the controller the input it gets on a display.

public enum PresentedInterval {
    /// Measurement slack, as a share of the refresh interval: a frame this little over a vsync
    /// still counts as on time (timer jitter between encode timestamps, not a missed vsync).
    static let slack = 0.02

    /// `dt` rounded up to a whole number (at least one) of `refresh` intervals.
    public static func quantized(_ dt: Double, refresh: Double) -> Double {
        guard refresh > 0, dt > 0 else { return dt }
        return max(1, (dt / refresh - slack).rounded(.up)) * refresh
    }
}

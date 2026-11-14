import Testing
@testable import IronvaleCore

@Test func frameTimeLogComputesDeltasAndCSV() {
    let log = FrameTimeLog()
        .recording(timestamp: 1.0)
        .recording(timestamp: 1.008)
        .recording(timestamp: 1.025)
    #expect(log.samples.map(\.frame) == [0, 1, 2])
    #expect(log.samples[0].dtMs == 0)
    #expect(abs(log.samples[1].dtMs - 8) < 1e-9)
    #expect(abs(log.samples[2].dtMs - 17) < 1e-9)
    let lines = log.csv.split(separator: "\n")
    #expect(lines.count == 4)
    #expect(lines[0] == "frame,timestamp_s,dt_ms")
    #expect(lines[2] == "1,1.008000,8.000")
}

@Test func recordingDoesNotMutateOriginal() {
    let empty = FrameTimeLog()
    _ = empty.recording(timestamp: 3)
    #expect(empty.samples.isEmpty)
}

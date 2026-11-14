import Testing
@testable import IronvaleCore

@Test func parsesFrameLogArguments() throws {
    let options = try LaunchOptions.parse(["-AppleLanguages", "(en)", "--frames", "300", "--frame-log", "/tmp/f.csv", "--uncapped"])
    #expect(options == LaunchOptions(frameLimit: 300, frameLogPath: "/tmp/f.csv", uncapped: true))
}

@Test func defaultsWhenNoArguments() throws {
    #expect(try LaunchOptions.parse([]) == LaunchOptions())
}

@Test func rejectsBadFrameCounts() {
    #expect(throws: LaunchOptions.ParseError.invalidFrameCount("0")) { try LaunchOptions.parse(["--frames", "0"]) }
    #expect(throws: LaunchOptions.ParseError.invalidFrameCount("x")) { try LaunchOptions.parse(["--frames", "x"]) }
    #expect(throws: LaunchOptions.ParseError.missingValue("--frame-log")) { try LaunchOptions.parse(["--frame-log"]) }
}

import Foundation
import Testing
@testable import IronvaleAudio

@Test func moduleIsLinked() {
    #expect(IronvaleAudioModule.name == "IronvaleAudio")
}

/// M8a gate: the 20 scripted scenes' per-voice traces match the web's within 1e-6.
@Suite struct TraceParity {
    static func inputs() throws -> (lengths: [String: Int], loops: [String: (start: Double, end: Double)], files: [URL]) {
        let sounds = try Fixtures.json(Fixtures.traces.appending(path: "sounds.json"))
        #expect(sounds["sampleRate"] as? Int == 48000)
        return (sounds["lengths"] as! [String: Int], try Fixtures.loops(), try Fixtures.sceneFiles())
    }

    @Test func twentyScenes() throws {
        #expect(try Self.inputs().files.count == 20)
    }

    @Test(arguments: try TraceParity.inputs().files)
    func scene(_ file: URL) throws {
        let (lengths, loops, _) = try Self.inputs()
        let result = try SceneRunner.run(file, lengths: lengths, loops: loops)
        let diffs = TraceDiff.compare(native: result.native, web: result.web)
        #expect(!result.web.voices.isEmpty)
        let worst = TraceDiff.maxDeviation(native: result.native, web: result.web)
        print("M8a trace \(result.name): \(result.web.voices.count) voices, max deviation \(worst)")
        #expect(worst <= TraceDiff.tolerance)
        #expect(diffs.isEmpty, Comment(rawValue: "\(result.name): \(result.web.voices.count) web voices\n" + diffs.joined(separator: "\n")))
    }

    /// The comparison is not vacuous: a 2e-6 change to one web gain value, one dropped event or a
    /// different take is reported.
    @Test func comparisonCatchesDifferences() throws {
        let (lengths, loops, files) = try Self.inputs()
        let result = try SceneRunner.run(files[0], lengths: lengths, loops: loops)
        #expect(TraceDiff.compare(native: result.native, web: result.web).isEmpty)
        var nudged = result.web
        nudged.voices[3].gain[1].value += 2e-6
        #expect(!TraceDiff.compare(native: result.native, web: nudged).isEmpty)
        var dropped = result.web
        dropped.voices[5].cutoff.removeLast()
        #expect(!TraceDiff.compare(native: result.native, web: dropped).isEmpty)
        var other = result.web
        other.voices[0].sound += "x"
        #expect(!TraceDiff.compare(native: result.native, web: other).isEmpty)
        var bus = result.web
        bus.buses["duck"]![0].time += 1e-5
        #expect(!TraceDiff.compare(native: result.native, web: bus).isEmpty)
    }
}

// Decodes the web build's sounds for MixCore: the MP3s under public/assets/local/sounds (listed in
// assets/sounds.json) through AVAudioFile, and the loop points from src/audio/sound-meta.json.
// Mirrors AudioEngine.decodeOne + describe in src/audio/index.ts.

import AVFoundation
import Foundation

public final class SoundLibrary: SoundDecoder {
    public enum Failure: Error, CustomStringConvertible {
        case manifest(String)
        case decode(String, String)

        public var description: String {
            switch self {
            case let .manifest(why): "sound manifest: \(why)"
            case let .decode(id, why): "sound \(id): \(why)"
            }
        }
    }

    public let ids: [String]
    private let paths: [String: URL]
    private let loops: [String: (start: Double, end: Double)]
    private let core: MixCore
    public private(set) var decodedFrames = 0
    public private(set) var failures: [String] = []
    /// Sound id of each MixCore table row this library registered.
    public private(set) var tableIds: [Int32: String] = [:]

    /// `repo`: the repository root (assets/, public/, src/ are read from it).
    public init(repo: URL, core: MixCore) throws {
        self.core = core
        let manifest = try Self.json(repo.appending(path: "assets/sounds.json"))
        guard let assets = manifest["assets"] as? [[String: Any]] else { throw Failure.manifest("no assets array") }
        var paths: [String: URL] = [:]
        for entry in assets {
            guard let id = entry["id"] as? String, id.hasPrefix("snd-"),
                  let files = entry["files"] as? [String: Any], let audio = files["audio"] as? [String: Any],
                  let path = audio["path"] as? String else { continue }
            let local = audio["local"] as? Bool ?? false
            paths[id] = repo.appending(path: local ? "public/assets/local/\(path)" : "public/assets/dl/\(path)")
        }
        self.paths = paths
        ids = paths.keys.sorted()
        let meta = try Self.json(repo.appending(path: "src/audio/sound-meta.json"))
        var loops: [String: (Double, Double)] = [:]
        for (id, value) in meta["loops"] as? [String: [String: Double]] ?? [:] {
            if let start = value["start"], let end = value["end"] { loops[id] = (start, end) }
        }
        self.loops = loops
    }

    public func decode(_ id: String) -> DecodedSound? {
        do {
            return try decodeOrThrow(id)
        } catch {
            failures.append("\(error)")
            return nil
        }
    }

    public func decodeOrThrow(_ id: String) throws -> DecodedSound {
        guard let url = paths[id] else { throw Failure.decode(id, "not in the manifest") }
        let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
        let format = file.processingFormat
        let frames = AVAudioFrameCount(file.length)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { throw Failure.decode(id, "no buffer") }
        try file.read(into: buffer)
        let count = Int(buffer.frameLength)
        let channels = min(2, Int(format.channelCount))
        guard count > 1, let data = buffer.floatChannelData else { throw Failure.decode(id, "empty") }
        var samples = [Float](repeating: 0, count: count * channels)
        for channel in 0..<channels {
            samples.withUnsafeMutableBufferPointer { out in
                out.baseAddress!.advanced(by: channel * count).update(from: data[channel], count: count)
            }
        }
        let table = core.registerSound(samples: samples, frames: count, channels: channels, sampleRate: format.sampleRate)
        tableIds[table] = id
        decodedFrames += count
        let duration = Double(count) / format.sampleRate
        return AudioEngine.describe(id: id, table: table, duration: duration, sampleRate: format.sampleRate,
                                    head: UnsafeBufferPointer(start: data[0], count: count), frames: count, loops: loops)
    }

    public func register(_ id: String, samples: [Float], sampleRate: Double) -> DecodedSound {
        let table = core.registerSound(samples: samples, frames: samples.count, channels: 1, sampleRate: sampleRate)
        tableIds[table] = id
        let duration = Double(samples.count) / sampleRate
        return DecodedSound(id: id, table: table, duration: duration, offset: 0, loopStart: 0, loopEnd: duration)
    }

    private static func json(_ url: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure.manifest("\(url.lastPathComponent) is not an object") }
        return object
    }
}

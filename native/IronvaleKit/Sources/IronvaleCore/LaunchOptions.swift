import Foundation

/// Launch arguments understood by the app. Unknown arguments are ignored, so
/// macOS-injected ones (`-NSDocumentRevisionsDebugMode`, `-AppleLanguages`) pass through.
public struct LaunchOptions: Sendable, Equatable {
    /// Quit after this many presented frames.
    public let frameLimit: Int?
    /// Write a frame-time CSV here when the app quits.
    public let frameLogPath: String?
    /// Disable display sync (tearing allowed) instead of display-linked VRR.
    public let uncapped: Bool

    public init(frameLimit: Int? = nil, frameLogPath: String? = nil, uncapped: Bool = false) {
        self.frameLimit = frameLimit
        self.frameLogPath = frameLogPath
        self.uncapped = uncapped
    }

    public enum ParseError: Error, Equatable, CustomStringConvertible {
        case missingValue(String)
        case invalidFrameCount(String)

        public var description: String {
            switch self {
            case .missingValue(let flag): "\(flag) needs a value"
            case .invalidFrameCount(let value): "--frames needs a positive integer, got \"\(value)\""
            }
        }
    }

    /// Parses `arguments` without the executable path (`CommandLine.arguments.dropFirst()`).
    public static func parse(_ arguments: some Sequence<String>) throws(ParseError) -> LaunchOptions {
        var frameLimit: Int?
        var frameLogPath: String?
        var uncapped = false
        var iterator = arguments.makeIterator()
        while let arg = iterator.next() {
            switch arg {
            case "--frames":
                guard let value = iterator.next() else { throw .missingValue(arg) }
                guard let count = Int(value), count > 0 else { throw .invalidFrameCount(value) }
                frameLimit = count
            case "--frame-log":
                guard let value = iterator.next() else { throw .missingValue(arg) }
                frameLogPath = value
            case "--uncapped":
                uncapped = true
            default:
                continue
            }
        }
        return LaunchOptions(frameLimit: frameLimit, frameLogPath: frameLogPath, uncapped: uncapped)
    }
}

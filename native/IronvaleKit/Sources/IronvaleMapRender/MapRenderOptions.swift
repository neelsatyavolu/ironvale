import Foundation
import IronvaleRender

/// M3 launch arguments, read alongside `LaunchOptions` (IronvaleCore), whose flags they leave alone:
///   --map ID              render map package ID (without it the app runs the M0 clear loop)
///   --pose x,y,z,yaw,pitch fixed camera, the web's ?pose= form (feet position, degrees)
///   --flythrough SECONDS  fly the Railyard loop and quit after SECONDS
///   --capture PATH        render the pose offscreen at the internal size, write a PNG, quit
///   --offscreen           with --flythrough: render offscreen, uncapped, without a window
///   --gpu-log PATH        write per-frame GPU times (frame,gpu_ms) on quit
///   --internal WxH        internal render size (default 2560x1600)
///   --repo PATH           repository root holding native/MapPackages, assets/ and public/
public struct MapRenderOptions: Sendable, Equatable {
    public var mapId: String?
    public var pose: CameraPose?
    public var flythroughSeconds: Double?
    public var capturePath: String?
    public var gpuLogPath: String?
    public var offscreen = false
    public var internalWidth = 2560
    public var internalHeight = 1600
    public var repositoryRoot: String?

    public init() {}

    public enum ParseError: Error, Equatable, CustomStringConvertible {
        case missingValue(String)
        case invalid(String, String)

        public var description: String {
            switch self {
            case .missingValue(let flag): "\(flag) needs a value"
            case .invalid(let flag, let value): "\(flag): invalid value \"\(value)\""
            }
        }
    }

    public static func parse(_ arguments: some Sequence<String>) throws(ParseError) -> MapRenderOptions {
        var options = MapRenderOptions()
        var iterator = arguments.makeIterator()
        func value(_ flag: String) throws(ParseError) -> String {
            guard let v = iterator.next() else { throw .missingValue(flag) }
            return v
        }
        while let arg = iterator.next() {
            switch arg {
            case "--map": options.mapId = try value(arg)
            case "--pose":
                let v = try value(arg)
                guard let pose = CameraPose(webPose: v) else { throw .invalid(arg, v) }
                options.pose = pose
            case "--flythrough":
                let v = try value(arg)
                guard let s = Double(v), s > 0 else { throw .invalid(arg, v) }
                options.flythroughSeconds = s
            case "--capture": options.capturePath = try value(arg)
            case "--gpu-log": options.gpuLogPath = try value(arg)
            case "--offscreen": options.offscreen = true
            case "--repo": options.repositoryRoot = try value(arg)
            case "--internal":
                let v = try value(arg)
                let parts = v.split(separator: "x").compactMap { Int($0) }
                guard parts.count == 2, parts[0] > 0, parts[1] > 0 else { throw .invalid(arg, v) }
                options.internalWidth = parts[0]
                options.internalHeight = parts[1]
            default: continue
            }
        }
        return options
    }
}

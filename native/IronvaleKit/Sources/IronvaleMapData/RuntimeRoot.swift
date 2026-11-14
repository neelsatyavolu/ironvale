// Where the app finds the repository-shaped data it reads at run time (map packages, baked assets, asset
// manifests, the public/ files they name). The build copies them into the bundle (native/ci/stage-runtime.py),
// so a shipped app never opens a file in the source tree; walking up to the repository is for tests only.
import Foundation

public enum RuntimeRoot {
    /// The app bundle's `Contents/Resources/Runtime`, when the build staged it.
    public static var bundled: URL? {
        guard let resources = Bundle.main.resourceURL?.appending(path: "Runtime", directoryHint: .isDirectory),
              FileManager.default.fileExists(atPath: resources.appending(path: "native/MapPackages").path)
        else { return nil }
        return resources
    }

    /// The root the app reads from: an explicit `--repo PATH`, else the bundled copy.
    public static func resolve(explicit: String?) -> URL? {
        explicit.map { URL(fileURLWithPath: $0, isDirectory: true) } ?? bundled
    }
}

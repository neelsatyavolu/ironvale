// Registers the OFL fonts the app bundles (Newsreader, Geist, Geist Mono; PLAN.md 3.9) for this process,
// so the SwiftUI screens' `.custom("Geist", ...)` faces resolve without installing anything.
import CoreText
import Foundation

public enum BundledFonts {
    /// The font files the Ledger theme and the HUD atlas are built from.
    public static let files = ["Newsreader.ttf", "Geist-Regular.ttf", "Geist-Medium.ttf", "GeistMono-Regular.ttf", "GeistMono-Medium.ttf"]

    /// Registers every bundled font found in `directory`; returns the names it could not register.
    @discardableResult
    public static func register(in directory: URL) -> [String] {
        files.filter { name in
            var error: Unmanaged<CFError>?
            let url = directory.appending(path: name) as CFURL
            if CTFontManagerRegisterFontsForURL(url, .process, &error) { return false }
            // Already registered (a second window, or a test run) is fine.
            let code = error.map { CFErrorGetCode($0.takeRetainedValue()) } ?? -1
            return code != CTFontManagerError.alreadyRegistered.rawValue
        }
    }
}

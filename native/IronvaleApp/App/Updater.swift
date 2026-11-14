import AppKit
import Sparkle

/// Sparkle updates (M12, docs/native-port/RELEASE.md). The feed and public key are SUFeedURL and
/// SUPublicEDKey in Info.plist. Automated runs (Presentation.background) never start the updater,
/// so check scripts make no network requests and show no update windows.
@MainActor
enum Updater {
    private static var controller: SPUStandardUpdaterController?

    static func start() {
        guard !Presentation.background else { return }
        let controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        Self.controller = controller
        installMenu(controller)
    }

    /// The app had no menu bar; this gives it the standard app menu with the update command and Quit.
    private static func installMenu(_ controller: SPUStandardUpdaterController) {
        let appMenu = NSMenu(title: "Ironvale")
        let check = NSMenuItem(title: "Check for Updates…", action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)), keyEquivalent: "")
        check.target = controller
        appMenu.addItem(check)
        appMenu.addItem(.separator())
        appMenu.addItem(NSMenuItem(title: "Hide Ironvale", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        appMenu.addItem(NSMenuItem(title: "Quit Ironvale", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        let appItem = NSMenuItem()
        appItem.submenu = appMenu
        let mainMenu = NSApp.mainMenu ?? NSMenu()
        mainMenu.insertItem(appItem, at: 0)
        NSApp.mainMenu = mainMenu
    }
}

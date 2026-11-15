import AppKit
import SwiftUI

/// The game's window. Keys nothing handles (WASD in the menus, unbound keys in play) would make
/// AppKit play the system "not allowed" sound; a game ignores them silently instead.
final class GameWindow: NSWindow {
    override func noResponder(for eventSelector: Selector) {
        if eventSelector == #selector(NSResponder.keyDown(with:)) { return }
        super.noResponder(for: eventSelector)
    }
}

/// Map card pictures for the menu: `public/assets/thumbs/<id>.jpg`, staged into the bundle like the
/// web's own thumbnails. A missing file leaves the card's flat block.
@MainActor
final class MapThumbnails {
    private let folder: URL
    private var cache: [String: Image] = [:]

    init(repositoryRoot: URL) {
        folder = repositoryRoot.appending(path: "public/assets/thumbs")
    }

    func image(_ id: String) -> Image? {
        if let cached = cache[id] { return cached }
        guard let picture = NSImage(contentsOf: folder.appending(path: "\(id).jpg")) else { return nil }
        let image = Image(nsImage: picture)
        cache[id] = image
        return image
    }
}

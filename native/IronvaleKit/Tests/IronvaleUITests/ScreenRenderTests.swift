// Renders every screen offscreen with ImageRenderer (no window, no previews), checks each one draws
// real content at three window sizes, and writes the PNGs for review when IV_UI_SNAPSHOTS names a folder.
import AppKit
import Foundation
import SwiftUI
import Testing
@testable import IronvaleUI

@MainActor
enum ScreenStates {
    /// Every screen in the inventory (maps/audio-ui.md 5.4), with the friend screen in each of its views.
    static let all: [(String, () -> InterfaceModel)] = [
        ("menu", { InterfaceModel.demo() }),
        ("loading", {
            let model = InterfaceModel.demo()
            model.settings.update { $0.controls = WebData.shared.controlPresets[.mouse]! }
            model.play()
            model.updateLoading(progress: 0.42, label: "Building the yard")
            return model
        }),
        ("pause", { let m = InterfaceModel.demo(); m.showPause(detail: "Railyard · Skirmish · 3:07", live: false); return m }),
        ("pause-live", { let m = InterfaceModel.demo(); m.showPause(detail: "Harbor · Co-op · 0:41", live: true); return m }),
        ("end", {
            let m = InterfaceModel.demo()
            m.showEnd(MatchResult(won: true, mode: .skirmish, mapName: "Railyard", kills: 8, deaths: 1, elapsed: 245, wave: 1, accuracy: 37))
            return m
        }),
        ("end-coop", {
            let m = InterfaceModel.demo()
            m.showEnd(MatchResult(won: false, mode: .coop, mapName: "Headworks", kills: 11, deaths: 2, elapsed: 512, wave: 4, accuracy: 29,
                                  rules: .survival, friend: .init(name: "Sam", kills: 9, killTarget: 10, connected: true)))
            return m
        }),
        ("settings-graphics", { let m = InterfaceModel.demo(); m.open(.settings); return m }),
        ("settings-controls", { let m = InterfaceModel.demo(); m.open(.settings); m.settingsTab = .controls; return m }),
        ("settings-audio", { let m = InterfaceModel.demo(); m.open(.settings); m.settingsTab = .audio; return m }),
        ("settings-gameplay", { let m = InterfaceModel.demo(); m.open(.settings); m.settingsTab = .gameplay; return m }),
        ("controls", { let m = InterfaceModel.demo(); m.open(.controls); return m }),
        ("credits", { let m = InterfaceModel.demo(); m.open(.credits); return m }),
        ("first-run", { let m = InterfaceModel.demo(); m.play(); return m }),
        ("friend-idle", { let m = InterfaceModel.demo(); m.open(.friend); return m }),
        ("friend-invited", { let m = InterfaceModel.demo(); m.openInvite("K7M3QX"); return m }),
        ("friend-link", { let m = InterfaceModel.demo(); m.open(.friend); m.lobby.host(.room); return m }),
        ("friend-manual", { let m = InterfaceModel.demo(); m.open(.friend); m.lobby.host(.manual); return m }),
        ("friend-lobby-host", {
            let m = InterfaceModel.demo()
            m.open(.friend)
            m.lobby.host(.room)
            (m.lobby as! MockLobby).simulateConnected()
            return m
        }),
        ("friend-lobby-guest", {
            let m = InterfaceModel.demo()
            m.open(.friend)
            m.lobby.join(.room, code: "K7M3QX")
            (m.lobby as! MockLobby).simulateConnected(peerName: "Ana")
            return m
        }),
        ("friend-error", {
            let m = InterfaceModel.demo()
            m.open(.friend)
            (m.lobby as! MockLobby).simulateError(.noRoom)
            return m
        }),
    ]

    static let sizes: [CGSize] = [CGSize(width: 1440, height: 900), CGSize(width: 1000, height: 760), CGSize(width: 680, height: 900)]
}

@MainActor
@Suite struct ScreenRender {
    @Test func everyScreenDrawsAtEverySize() throws {
        let folder = ProcessInfo.processInfo.environment["IV_UI_SNAPSHOTS"].map { URL(fileURLWithPath: $0) }
        if let folder { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
        for (name, make) in ScreenStates.all {
            for size in ScreenStates.sizes {
                let model = make()
                let image = try #require(Self.render(RootView(model: model), size: size), "\(name) did not render")
                #expect(image.width * Int(size.height) == image.height * Int(size.width) && image.width >= Int(size.width))
                let inked = Self.inkedShare(image)
                // A screen that drew only its background (or nothing) has almost no light pixels.
                #expect(inked > 0.004, "\(name) at \(Int(size.width))x\(Int(size.height)) looks empty (\(inked))")
                if let folder {
                    let rep = NSBitmapImageRep(cgImage: image)
                    let data = try #require(rep.representation(using: .png, properties: [:]))
                    try data.write(to: folder.appendingPathComponent("\(name)-\(Int(size.width))x\(Int(size.height)).png"))
                }
            }
        }
    }

    /// Draws the view the way a window would, through NSHostingView, so scroll views and text fields render too.
    static func render(_ view: some View, size: CGSize) -> CGImage? {
        let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
        host.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        host.layoutSubtreeIfNeeded()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return nil }
        rep.size = size
        host.cacheDisplay(in: host.bounds, to: rep)
        return rep.cgImage
    }

    /// Share of pixels clearly lighter than the Ledger canvas: text, rules and controls.
    static func inkedShare(_ image: CGImage) -> Double {
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return 0 }
        var lit = 0
        for index in stride(from: 0, to: pixels.count, by: 4) where Int(pixels[index]) + Int(pixels[index + 1]) + Int(pixels[index + 2]) > 240 {
            lit += 1
        }
        return Double(lit) / Double(width * height)
    }
}

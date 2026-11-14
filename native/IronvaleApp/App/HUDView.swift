// Placeholder in-match HUD for M4 (the Metal HUD with MSDF text is M10): health, weapon and ammo,
// grenade, crosshair and the respawn count. Shown only while a match is playing.
import Observation
import SwiftUI

@MainActor
@Observable
final class HUDModel {
    var visible = false
    var health = 100
    var weaponName = ""
    var fireMode = ""
    var magazine = 0
    var reserve = 0
    var reloading = false
    var grenades = 0
    var grenadeAiming = false
    var scopedIn = false
    var aiming = false
    var respawnIn = 0.0
    var alive = true
    var livesRemaining = 0
    var mapName = ""
    var spread = 0.0
}

struct HUDView: View {
    let model: HUDModel

    var body: some View {
        if model.visible {
            ZStack {
                if model.alive, !model.scopedIn, !model.aiming {
                    Crosshair(gap: 6 + model.spread * 4)
                }
                if model.scopedIn {
                    Rectangle().fill(.black).mask {
                        ZStack {
                            Rectangle()
                            Circle().frame(width: 560, height: 560).blendMode(.destinationOut)
                        }
                        .compositingGroup()
                    }
                    Rectangle().fill(.black).frame(width: 1, height: 200)
                    Rectangle().fill(.black).frame(width: 200, height: 1)
                }
                VStack {
                    HStack {
                        Text(model.mapName.uppercased())
                        Spacer()
                        Text("LIVES \(model.livesRemaining)")
                    }
                    Spacer()
                    if !model.alive {
                        Text(String(format: "RESPAWN IN %.1f", model.respawnIn))
                            .font(.system(size: 22, weight: .semibold, design: .monospaced))
                        Spacer()
                    }
                    HStack(alignment: .bottom) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("HEALTH").font(.system(size: 11, weight: .medium, design: .monospaced)).opacity(0.7)
                            Text("\(model.health)").font(.system(size: 34, weight: .semibold, design: .monospaced))
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            Text("\(model.weaponName) · \(model.fireMode.uppercased())")
                                .font(.system(size: 13, weight: .medium, design: .monospaced))
                            Text(model.reloading ? "RELOADING" : "\(model.magazine) / \(model.reserve)")
                                .font(.system(size: 30, weight: .semibold, design: .monospaced))
                            Text("GRENADE \(model.grenades)\(model.grenadeAiming ? " · AIMING" : "")")
                                .font(.system(size: 11, weight: .medium, design: .monospaced)).opacity(0.7)
                        }
                    }
                }
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .padding(24)
            }
            .foregroundStyle(Color(red: 0.97, green: 0.96, blue: 0.94))
            .shadow(color: .black.opacity(0.6), radius: 2)
            .allowsHitTesting(false)
        }
    }
}

private struct Crosshair: View {
    let gap: Double

    var body: some View {
        ZStack {
            ForEach(0 ..< 4, id: \.self) { i in
                Rectangle()
                    .frame(width: 2, height: 8)
                    .offset(y: -(gap + 4))
                    .rotationEffect(.degrees(Double(i) * 90))
            }
            Circle().frame(width: 2, height: 2)
        }
    }
}

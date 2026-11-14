// The soldiers of a match, drawn inside the map's passes (PLAN.md 7, M7a: "renders the remote
// player and bot proxies"). Keeps one animated Soldier per actor id, fed each frame from the
// frame's SoldierDrawList (IronvaleSim): position, facing and pose state every frame, and the
// one-shot reactions (die, revive, flinch) when the actor's counters change, as the web's
// RemoteSoldier and Bot drive their SoldierVisual. Bodies that leave the list are dropped.
import Foundation
import IronvaleRender
import IronvaleSim
import IronvaleWorld
import Metal
import simd

@MainActor
public final class SoldierLayer: SceneLayer {
    private struct Entry {
        let soldier: Soldier
        var life: Int
        var hits: Int
    }

    public let renderer: SoldierRenderer
    private var entries: [Int: Entry] = [:]
    /// Draw order: the list's order.
    private var order: [Soldier] = []

    public init(renderer: SoldierRenderer) {
        self.renderer = renderer
    }

    public var count: Int { order.count }

    /// Brings the soldiers in line with this frame's actors and advances their animation.
    public func update(_ list: SoldierDrawList, dt: Double) {
        var seen = Set<Int>()
        order.removeAll(keepingCapacity: true)
        for actor in list.soldiers where seen.insert(actor.id).inserted {
            var entry = entries[actor.id] ?? {
                let team = Team(rawValue: actor.uniform.rawValue) ?? .bravo
                return Entry(soldier: Soldier(rig: renderer.rig, team: team), life: actor.life, hits: actor.hits)
            }()
            let soldier = entry.soldier
            if actor.life != entry.life {
                entry.life = actor.life
                soldier.revive()
            }
            if actor.alive, soldier.dead { soldier.revive() }
            soldier.position = Vec3(actor.position.x, actor.position.y, actor.position.z)
            soldier.yaw = actor.yaw
            soldier.setState(SoldierState(speed: actor.speed, crouching: actor.crouching, aimPitch: actor.pitch,
                                          aiming: actor.aiming, firing: actor.firing, reloading: actor.reloading))
            if actor.hits > entry.hits, let zone = actor.lastHitZone.flatMap({ HitZone(rawValue: $0.rawValue) }) {
                soldier.flinch(zone)
            }
            entry.hits = actor.hits
            if !actor.alive, !soldier.dead {
                let d = actor.deathDirection ?? IronvaleWorld.Vec3(0, 0, -1)
                soldier.die(direction: Vec3(d.x, d.y, d.z))
            }
            soldier.update(dt)
            entries[actor.id] = entry
            order.append(soldier)
        }
        for id in entries.keys where !seen.contains(id) { entries[id] = nil }
    }

    public func prepare(viewProjection: simd_float4x4, eye: SIMD3<Float>) {
        renderer.prepare(soldiers: order, viewProjection: viewProjection, eye: eye)
    }

    public func encodeShadow(_ encoder: any MTLRenderCommandEncoder) { renderer.encodeShadow(encoder) }
    public func encodeScene(_ encoder: any MTLRenderCommandEncoder) { renderer.encodeScene(encoder) }
}

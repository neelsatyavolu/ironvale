// Ported from src/ai/roles.ts, src/ai/spawn.ts and `scaledWeapon` in src/ai/difficulty.ts at commit
// cbe0add. The role and difficulty tables themselves come from native/Contract/ai.json.
import Foundation
import IronvaleContract
import IronvaleWorld

public enum BotRole: String, Sendable, CaseIterable { case rifleman, rusher, breacher, marksman, gunner }

private let specialists: [BotRole] = [.rusher, .marksman, .gunner, .breacher]

/// Roles for a squad of `count`, specialists spread through the order.
public func assignRoles(_ count: Int) -> [BotRole] {
    var left: [BotRole: Int] = [.rifleman: 0, .rusher: count / 4, .marksman: count / 6, .gunner: count / 8, .breacher: count / 7]
    var picked: [BotRole] = []
    var added = true
    while added {
        added = false
        for role in specialists where left[role, default: 0] > 0 {
            left[role, default: 0] -= 1
            picked.append(role)
            added = true
        }
    }
    var roles = [BotRole](repeating: .rifleman, count: count)
    for (k, role) in picked.enumerated() { roles[1 + (k * (count - 1)) / picked.count] = role }
    return roles
}

/// The 24 names in src/ai/roles.ts (display only: the guest shows whatever name it is sent).
public let botNames = [
    "Voss", "Harlan", "Reyes", "Okafor", "Lindqvist", "Marek", "Dunne", "Sato", "Brandt", "Kessler", "Ivers", "Molina",
    "Thorne", "Varga", "Quill", "Navarro", "Strand", "Petrov", "Hale", "Corbin", "Ashby", "Renner", "Falk", "Mercer",
]

public func botName(_ index: Int) -> String {
    let name = botNames[index % botNames.count]
    let lap = index / botNames.count
    return lap == 0 ? name : "\(name) \(lap + 1)"
}

public struct SpawnOrder: Sendable, Equatable {
    public let indices: [Int]
    public let hidden: Int
}

/// Rank enemy spawns: those out of the player's view first, each group furthest first (stable).
public func orderSpawns(_ spawns: [Vec3], player: Vec3, inView: (Int) -> Bool) -> SpawnOrder {
    let ranked = spawns.enumerated().map { (index: $0.offset, seen: inView($0.offset), distance: $0.element.distance(to: player)) }
    let sorted = ranked.enumerated().sorted { a, b in
        if a.element.seen != b.element.seen { return !a.element.seen }
        if a.element.distance != b.element.distance { return a.element.distance > b.element.distance }
        return a.offset < b.offset
    }.map(\.element)
    return SpawnOrder(indices: sorted.map(\.index), hidden: sorted.filter { !$0.seen }.count)
}

/// A spawn index for each of `count` soldiers; hidden spawns fill (up to `capacity` each) first.
public func assignSpawns(_ count: Int, _ order: SpawnOrder, capacity: Int) -> [Int] {
    let indices = order.indices
    if indices.isEmpty { return [] }
    var picks: [Int] = []
    func fill(_ from: Int, _ to: Int) {
        var lap = 0
        while lap < capacity, picks.count < count {
            var i = from
            while i < to, picks.count < count {
                picks.append(indices[i])
                i += 1
            }
            lap += 1
        }
    }
    fill(0, order.hidden)
    fill(order.hidden, indices.count)
    var i = 0
    while picks.count < count {
        picks.append(indices[i % indices.count])
        i += 1
    }
    return picks
}

/// true when `point` lies within `halfAngle` of where the player faces, ignoring height.
public func inViewCone(player: Vec3, yaw: Double, point: Vec3, halfAngle: Double) -> Bool {
    let dx = point.x - player.x
    let dz = point.z - player.z
    let distance = hypot(dx, dz)
    if distance < 1e-6 { return true }
    return -sin(yaw) * dx - cos(yaw) * dz >= cos(halfAngle) * distance
}

/// The weapon as a bot of this difficulty carries it (`scaledWeapon`): damage times the
/// difficulty's multiplier; snipers are left alone so a hit kills on every difficulty.
public func scaledWeapon(_ def: WeaponDef, multiplier: Double) -> WeaponDef {
    if def.weaponClass == "sniper" { return def }
    // WeaponDef has no public memberwise init; a JSON round trip changes the one field.
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(def),
          var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return def }
    object["damage"] = def.damage * multiplier
    guard let changed = try? JSONSerialization.data(withJSONObject: object),
          let copy = try? JSONDecoder().decode(WeaponDef.self, from: changed) else { return def }
    return copy
}

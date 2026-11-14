// native/Contract/fx/pure.json (from src/fx): pools, tracer math, casing physics, the roof mask,
// the quality tiers' densities and the per-surface looks.
import Foundation
@testable import IronvaleFX
import IronvaleWorld
import Testing

nonisolated(unsafe) private let pure = try! fixture("pure.json") as! [String: Any]

@Test func scaledCountMatches() {
    for row in pure["scaled"] as! [Any] {
        let r = doubles(row)
        #expect(scaledCount(r[0], r[1], r[2]) == Int(r[3]), "scaledCount\(r)")
    }
}

@Test func ringPoolAndDirtyRangeMatch() {
    var ring = RingPool(capacity: 5)
    for (i, row) in (pure["ringTrace"] as! [Any]).enumerated() {
        let r = doubles(row)
        let peek = ring.peek(3), wrapped = ring.wrapped
        #expect([Double(ring.next()), Double(peek), wrapped ? 1 : 0] == r, "ring step \(i)")
        if i == 9 { ring.reset() }
    }
    var dirty = DirtyRange()
    for (marks, expected) in zip([[], [4], [7, 2, 9], [3, 3]], pure["dirtyTrace"] as! [Any]) {
        for m in marks { dirty.mark(m) }
        let got = dirty.take().map { [Double($0.start), Double($0.count)] }
        #expect(got == (expected is NSNull ? nil : doubles(expected)))
    }
}

@Test func tracerMathMatches() {
    for row in pure["tracer"] as! [Any] {
        let r = doubles(row)
        let speed = TracerMath.visibleSpeed(r[0], r[1])
        #expect(speed == r[2] && TracerMath.length(speed, r[1]) == r[3], "tracer \(r)")
    }
    for row in pure["showTracer"] as! [Any] {
        let r = doubles(row)
        #expect(TracerMath.showLocal(Int(r[1]), Int(r[0])) == (r[2] == 1))
    }
}

@Test func casingPhysicsMatches() throws {
    let scenes = try fixture("scenes.json") as! [String: Any]
    let world = try fixtureWorld(scenes["world"] as! [String: Any])
    let tuning = pure["casingTuning"] as! [String: Any]
    let standard = CasingTuning.standard
    #expect(standard.gravity == double(tuning["gravity"]) && standard.restitution == double(tuning["restitution"])
        && standard.friction == double(tuning["friction"]) && Double(standard.maxBounces) == double(tuning["maxBounces"])
        && standard.restSpeed == double(tuning["restSpeed"]))
    for (n, item) in (pure["casing"] as! [[String: Any]]).enumerated() {
        let start = item["start"] as! [Any]
        var body = CasingBody()
        body.position = d3(start[0])
        body.velocity = d3(start[1])
        for (f, row) in (item["trace"] as! [[Any]]).enumerated() {
            let result = CasingPhysics.step(&body, 1.0 / 60, world: world, radius: 0.0054, tuning: standard)
            let e = doubles(Array(row[1...7]))
            let ok = result.rawValue == row[0] as! String
                && zip(e, [body.position.x, body.position.y, body.position.z, body.velocity.x, body.velocity.y, body.velocity.z, Double(body.bounces)])
                    .allSatisfy { close($0, $1, 1e-9) }
                && (body.surface?.name ?? "") == row[8] as! String
            #expect(ok, "casing \(n) frame \(f): web \(row) native \(result) \(body)")
            if !ok { break }
        }
    }
    for row in pure["reflect"] as! [[Any]] {
        let out = CasingPhysics.reflect(d3(row[0]), d3(row[1]), 0.38, 0.45)
        let e = doubles(row[2])
        #expect(close(out.x, e[0], 1e-12) && close(out.y, e[1], 1e-12) && close(out.z, e[2], 1e-12))
    }
}

@Test func roofMaskMatches() throws {
    let scenes = try fixture("scenes.json") as! [String: Any]
    let world = try fixtureWorld(scenes["world"] as! [String: Any])
    let zone = ((scenes["world"] as! [String: Any])["interiors"] as! [[String: Any]])[0]
    let lo = d3(zone["min"]), hi = d3(zone["max"])
    let top = world.bounds.max.y + 1, bottom = world.bounds.min.y - 1
    let probe: (Double, Double) -> Double = { x, z in
        var h = world.groundHeight(x: x, z: z, fromY: top, maxDrop: top - bottom) ?? -1000
        if x >= lo.x, x <= hi.x, z >= lo.z, z <= hi.z { h = max(h, hi.y) }
        return h
    }
    let mask = RoofMask(size: 32, cell: 1)
    for item in pure["mask"] as! [[String: Any]] {
        let c = doubles(item["centre"])
        mask.setCentre(c[0], c[1])
        let stale = mask.stale
        let done = mask.refresh(probe, budget: stale > 512 ? .max : 48)
        #expect(Double(stale) == double(item["stale"]) && Double(done) == double(item["done"]) && Double(mask.version) == double(item["version"]))
        #expect(zip(doubles(item["heights"]), mask.heights).allSatisfy { close($0, Double($1), 1e-7) }, "heights at \(c)")
        let samples = [-3, 0.5, 7.2].flatMap { dx in [-2, 1.5].map { dz in mask.heightAt(c[0] + dx, c[1] + dz) } }
        #expect(zip(doubles(item["samples"]), samples).allSatisfy { close($0, $1, 1e-7) })
    }
}

@Test func tiersAndSurfacesMatch() {
    let tiers = pure["tiers"] as! [String: Any]
    for tier in FXQuality.allCases {
        let e = doubles(tiers[tier.rawValue])
        #expect(tier.particleDensity == e[0] && tier.detailDensity == e[1], "tier \(tier)")
    }
    let surfaces = pure["surfaces"] as! [String: Any]
    for surface in Surface.allCases {
        let e = surfaces[surface.name] as! [String: Any]
        let look = SurfaceLook.of(surface)
        let decal = e["decal"] as? String
        #expect(look.family.rawValue == e["family"] as! String && look.dustiness == double(e["dustiness"])
            && [look.dust.x, look.dust.y, look.dust.z] == doubles(e["dust"]) && [look.debris.x, look.debris.y, look.debris.z] == doubles(e["debris"])
            && decal == look.decal.map { "\($0)" }, "surface \(surface)")
    }
}

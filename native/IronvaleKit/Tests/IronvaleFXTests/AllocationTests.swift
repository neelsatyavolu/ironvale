// "No per-frame heap allocation in the FX update" (M9 FX gate): a 16-bot scripted firefight on the
// fixture box world, with rain on, is warmed up, then every frame's events and Effects.update run
// with libmalloc's logger counting allocations on this thread. The pools wrap many times over.
import Foundation
@testable import IronvaleFX
import IronvaleSim
import IronvaleWorld
import Testing

#if DEBUG
private let optimized = false
#else
private let optimized = true
#endif

/// Unoptimised Swift boxes generic iterators on the heap, so the count means something only in a
/// Release build: check-m9fx.sh runs this test with `swift test -c release -Xswiftc -enable-testing`.
@Test(.enabled(if: optimized, "allocation counts need an optimised build (swift test -c release)"))
func firefightUpdateDoesNotAllocate() throws {
    #expect(MallocHook.install(), "malloc_logger is not available")
    let scenes = try fixture("scenes.json") as! [String: Any]
    let world = try fixtureWorld(scenes["world"] as! [String: Any])
    let weapons = Effects.weapons(from: contract.weapons)
    let fx = Effects(weapons: weapons, grenades: GrenadeMath(), particleDensity: 1, detailDensity: 0.85)
    fx.env.camera = FXCamera(position: D3(0, 1.6, 12), yaw: 0, pitch: -0.1)
    fx.env.player.position = D3(0, 0, 12)
    fx.enterMap(lighting: FXLighting(sunDirection: D3(0.4, 0.8, -0.4), sunColor: 0xffe2c0, sunIntensity: 2.6, skyIntensity: 0.9, fogColor: 0x8a9099),
                weather: .rain, interiors: [FXBox(min: D3(-2, 0, 4), max: D3(2, 1.3, 8))], world: world)
    let fight = Firefight(centre: D3(0, 0, 0), bots: 16, radius: 18, weapons: Array(weapons.values).sorted { $0.muzzleVelocity < $1.muzzleVelocity }, world: world)
    let dt = 1.0 / 120
    var frame = 0
    func tick() {
        // Walk the player and turn the view so the roof mask scrolls and the splashes move.
        fx.env.player.position = D3(sin(Double(frame) * 0.01) * 6, 0, 12)
        fx.env.camera = FXCamera(position: fx.env.player.position.adding(.up, 1.6), yaw: Double(frame) * 0.002, pitch: -0.1)
        fight.step(dt, fx)
        fx.update(dt)
        frame += 1
    }
    for _ in 0..<600 { tick() }
    let before = MallocHook.count(.offline)
    let draws = fx.env.random.draws
    MallocHook.counting(.offline)
    for _ in 0..<2400 { tick() }
    MallocHook.counting(nil)
    let allocations = MallocHook.count(.offline) - before
    // Positive control: the hook does see an allocation made in the same region.
    let control = MallocHook.count(.offline)
    MallocHook.counting(.offline)
    let probe = [Int](repeating: frame, count: 64 + frame % 7)
    MallocHook.counting(nil)
    #expect(MallocHook.count(.offline) > control && probe.count > 0, "the malloc hook missed a deliberate allocation")
    #expect(fx.env.random.draws - draws > 50_000, "the firefight should have spawned a lot")
    #expect(allocations == 0, "\(allocations) heap allocations in 2400 FX frames:\n\(mallocHookReport(.offline, since: before))")
}

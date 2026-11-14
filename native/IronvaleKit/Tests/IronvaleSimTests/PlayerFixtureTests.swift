// Replays the PlayerController scripted-input fixtures (native/Tools/sim-fixtures/player.ts) on the
// Swift port. M4 exit check: every frame's position within 1e-5 m of the TypeScript, on the box
// world and on each map; flags and events identical.
import Foundation
import IronvaleMapData
@testable import IronvaleSim
import IronvaleWorld
import Testing

private let tolerance = 1e-5

private struct Mismatch: CustomStringConvertible {
    var frames = 0
    var maxPositionError = 0.0
    var maxAngleError = 0.0
    var failures: [String] = []
    var description: String { "\(frames) frames, max position error \(maxPositionError) m, max angle error \(maxAngleError) rad; \(failures.prefix(8))" }
}

private func replay(world: CollisionWorld, interiors: [ZoneBox], file: String) throws -> Mismatch {
    let root = try fixture(file) as! [String: Any]
    var tally = Mismatch()
    for trace in root["traces"] as! [[String: Any]] {
        let name = trace["name"] as! String
        let input = ScriptInput()
        let settings = PlayerSettings.defaults(trace["preset"] as! String)
        let events = EventBus()
        var frameEvents: [String] = []
        events.on { event in
            switch event {
            case .jumped, .landed, .footstep, .spawned: frameEvents.append(event.name)
            default: break
            }
        }
        let player = PlayerController(id: 1, team: .alpha, input: input, settings: { settings }, events: events,
                                      world: { world }, interiors: { interiors }, random: { 0.5 })
        let start = trace["start"] as! [String: Any]
        player.respawn(position: Vec3(doubles(start["position"])), yaw: double(start["yaw"]))
        frameEvents.removeAll()
        let frames = trace["frames"] as! [[String: Any]]
        let records = trace["records"] as! [[Any]]
        let expectedEvents = trace["events"] as! [[String]]
        for (i, frame) in frames.enumerated() {
            input.held = Set((frame["held"] as! [String]).compactMap(Action.init))
            input.pressed = Set((frame["pressed"] as! [String]).compactMap(Action.init))
            let look = doubles(frame["look"])
            input.look = (look[0], look[1])
            if let mods = frame["mods"] as? [String: Any] {
                player.setWeaponModifiers(mobility: double(mods["mobility"]), aimBlend: double(mods["aimBlend"]),
                                          zoom: double(mods["zoom"]), blockSprint: mods["blockSprint"] as! Bool)
            }
            player.update(double(frame["dt"]))
            let r = records[i].map(double)
            tally.frames += 1
            let p = player.position, v = player.velocity, cam = player.camera
            let positionError = max(abs(p.x - r[0]), abs(p.y - r[1]), abs(p.z - r[2]),
                                    abs(cam.position.x - r[12]), abs(cam.position.y - r[13]), abs(cam.position.z - r[14]))
            let angleError = max(abs(player.yaw - r[6]), abs(player.pitch - r[7]),
                                 abs(cam.pitch - r[15]), abs(cam.yaw - r[16]), abs(cam.roll - r[17]))
            tally.maxPositionError = max(tally.maxPositionError, positionError)
            tally.maxAngleError = max(tally.maxAngleError, angleError)
            let velocityError = max(abs(v.x - r[3]), abs(v.y - r[4]), abs(v.z - r[5]))
            let flags = [player.onGround, player.crouching, player.sprinting, player.indoors].map { $0 ? 1.0 : 0.0 }
            if positionError > tolerance || angleError > tolerance || velocityError > 1e-3 || abs(cam.fov - r[18]) > 1e-6 {
                tally.failures.append("\(name)#\(i): pos err \(positionError), angle err \(angleError), vel err \(velocityError)")
            }
            if flags != Array(r[8 ... 11]) { tally.failures.append("\(name)#\(i): flags \(flags) vs \(Array(r[8 ... 11]))") }
            if frameEvents != expectedEvents[i] { tally.failures.append("\(name)#\(i): events \(frameEvents) vs \(expectedEvents[i])") }
            frameEvents.removeAll()
        }
    }
    return tally
}

@Test func playerControllerMatchesTypeScriptOnTheBoxWorld() throws {
    let worlds = try fixture("worlds.json") as! [String: Any]
    let zones = ((worlds["box"] as! [String: Any])["interiors"] as! [[String: Any]])
        .map { ZoneBox(min: Vec3(doubles($0["min"])), max: Vec3(doubles($0["max"]))) }
    let result = try replay(world: testWorld("box"), interiors: zones, file: "player-box.json")
    #expect(result.frames > 1000)
    #expect(result.failures.isEmpty, "\(result)")
    print("player-box: \(result)")
}

@Test(arguments: ["range", "railyard", "headworks", "harbor"])
func playerControllerMatchesTypeScriptOnMap(_ id: String) throws {
    let package = try MapPackage.load(directory: packagesRoot.appending(path: id))
    let zones = package.meta.interiors.map { ZoneBox(min: Vec3($0.min), max: Vec3($0.max)) }
    let result = try replay(world: package.world, interiors: zones, file: "player-\(id).json")
    #expect(result.frames > 1000)
    #expect(result.failures.isEmpty, "\(result)")
    print("player-\(id): \(result)")
}

// The stand-in gun shapes exported from src/weapons/view/fallback.ts load for every weapon and turn
// into triangle lists the ViewModel.metal vertex layout reads.
import Foundation
import IronvaleContract
@testable import IronvaleViewModel
import Testing

@Test func everyWeaponHasAStandInGun() throws {
    let contract = try Contract.load()
    let guns = try FallbackGunData.loadAll(contractDirectory: contract.directory)
    #expect(Set(guns.keys) == Set(contract.weapons.weaponIds))
    #expect(MemoryLayout<ViewModelVertex>.stride == 48)
    for (id, gun) in guns {
        let vertices = FallbackGunMesh.vertices(gun)
        #expect(vertices.count % 3 == 0)
        #expect(vertices.count >= gun.shapes.count * 36, "\(id)")
        // The muzzle is ahead of the grip (barrel along -Z) and the sight above the bore.
        #expect(gun.muzzle[2] < -0.3, "\(id)")
        #expect(gun.sight[1] > gun.muzzle[1], "\(id)")
        for v in vertices {
            let n = (v.normal.0 * v.normal.0 + v.normal.1 * v.normal.1 + v.normal.2 * v.normal.2).squareRoot()
            #expect(abs(n - 1) < 1e-3)
        }
    }
}

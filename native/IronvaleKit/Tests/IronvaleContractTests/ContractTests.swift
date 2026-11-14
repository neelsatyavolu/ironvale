// Checks that native/Contract loads and that contract.lock matches the table bytes (PLAN.md 5.3).
import Foundation
import Testing
@testable import IronvaleContract

@Test func contractLoadsFromSourceTree() throws {
    let contract = try Contract(directory: ContractLocation.sourceTreeDirectory)
    #expect(contract.protocolTable.protocolVersion == contract.lock.protocolVersion)
    #expect(contract.weapons.weapons.map(\.id) == contract.weapons.weaponIds)
    #expect(contract.weapons.def(contract.weapons.grenadeId) == contract.weapons.grenadeDef)
    #expect(contract.ai.difficultyOrder.allSatisfy { contract.ai.difficulty[$0] != nil })
    #expect(contract.ai.roles.values.allSatisfy { contract.weapons.weaponIds.contains($0.weapon) })
    #expect(contract.bodies.hitbox.STANDING.map(\.zone) == ["head", "torso", "limb"])
    #expect(contract.bodies.hitbox.CROUCHING.map(\.zone) == ["head", "torso", "limb"])
    #expect(Set(contract.maps.playable).isSubset(of: contract.maps.all))
}

@Test func contractHashMatchesLock() throws {
    let contract = try Contract(directory: ContractLocation.sourceTreeDirectory)
    #expect(try contract.computedHash() == contract.lock.contractHash)
}

@Test func locationFindsTheSourceTree() throws {
    #expect(try ContractLocation.directory().standardizedFileURL.path.hasSuffix("native/Contract"))
}

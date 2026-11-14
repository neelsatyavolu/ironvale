import Foundation
import Testing
import simd
@testable import IronvaleRender

@Test func reverseZMapsNearToOneAndFarToZero() {
    let p = RenderMath.perspectiveReverseZ(fovYRadians: 78 * .pi / 180, aspect: 1.6, near: 0.04, far: 900)
    func depth(_ z: Float) -> Float { let c = p * SIMD4(0, 0, z, 1); return c.z / c.w }
    #expect(abs(depth(-0.04) - 1) < 1e-5)
    #expect(abs(depth(-900)) < 1e-5)
    #expect(depth(-10) > depth(-100))
}

@Test func orthographicDepthRunsZeroToOne() {
    let o = RenderMath.orthographic(left: -55, right: 55, bottom: -55, top: 55, near: 1, far: 320)
    #expect(abs((o * SIMD4(0, 0, -1, 1)).z) < 1e-6)
    #expect(abs((o * SIMD4(0, 0, -320, 1)).z - 1) < 1e-6)
    #expect(abs((o * SIMD4(55, -55, -5, 1)).x - 1) < 1e-6)
}

@Test func poseMatchesTheWebCameraConvention() throws {
    // ?pose=x,y,z,yawDeg,pitchDeg: eye 1.64 m above the feet, yaw 0 looks down -Z, yaw 90 looks down -X.
    let pose = try #require(CameraPose(webPose: "-3,0,45.5,0,0"))
    #expect(pose.eye == SIMD3(-3, 1.64, 45.5))
    #expect(simd_distance(pose.forward, SIMD3(0, 0, -1)) < 1e-6)
    let turned = try #require(CameraPose(webPose: "0,0,0,90,0"))
    #expect(simd_distance(turned.forward, SIMD3(-1, 0, 0)) < 1e-6)
    let up = try #require(CameraPose(webPose: "0,0,0,0,10"))
    #expect(up.forward.y > 0)
    #expect(CameraPose(webPose: "1,2,3") == nil)
    #expect(CameraPose(webPose: "1,2,3,x,5") == nil)
}

@Test func lookAtViewPutsTheTargetOnTheNegativeZAxis() {
    let view = RenderMath.lookAt(eye: SIMD3(10, 20, 30), target: SIMD3(0, 0, 0), up: SIMD3(0, 1, 0))
    let t = view * SIMD4(0, 0, 0, 1)
    #expect(abs(t.x) < 1e-4 && abs(t.y) < 1e-4)
    #expect(abs(t.z + simd_length(SIMD3<Float>(10, 20, 30))) < 1e-3)
}

@Test func srgbHexConvertsLikeThreeColorManagement() {
    let c = RenderMath.linearFromSRGBHex(0xff8000)
    #expect(abs(c.x - 1) < 1e-6)
    #expect(abs(c.y - 0.21586) < 1e-4)
    #expect(c.z == 0)
    #expect(simd_distance(RenderMath.linearHex(0x336699), SIMD3<Float>(0x33, 0x66, 0x99) / 255) < 1e-6)
}

@Test func normalMatrixUndoesNonUniformScale() {
    let m = simd_float4x4(diagonal: SIMD4(2, 1, 1, 1))
    let n = RenderMath.normalMatrix(m)
    #expect(abs(n.columns.0.x - 0.5) < 1e-6)
    #expect(abs(n.columns.1.y - 1) < 1e-6)
}

@Test func sunShadowSnapsToWholeTexels() {
    let sun = SunShadow(sunDirection: SIMD3(-0.103, 0.163, -0.981), mapSize: 4096)
    let texel = sun.texelWorld
    #expect(abs(texel - 110 / 4096) < 1e-7)
    let a = sun.center(cameraPosition: SIMD3(3.001, 1.64, 45.5), forward: SIMD3(0, 0, -1))
    let b = sun.center(cameraPosition: SIMD3(3.002, 1.64, 45.5), forward: SIMD3(0, 0, -1))
    // Sub-texel camera motion does not move the frustum across the sun.
    let moved = abs(simd_dot(a - b, sun.right))
    #expect(moved < 1e-4 || moved >= texel * 0.99)
    let r = simd_dot(a, sun.right) / texel
    #expect(abs(r - r.rounded()) < 1e-2)
    // The frustum looks along -sun from 160 m out; the snapped centre lands in the middle of the map.
    let vp = sun.viewProjection(cameraPosition: SIMD3(3, 1.64, 45.5), forward: SIMD3(0, 0, -1))
    let clip = vp * SIMD4(a, 1)
    #expect(abs(clip.x) < 1e-3 && abs(clip.y) < 1e-3)
    #expect(abs(clip.z - (160 - 1) / (320 - 1)) < 1e-3)
}

@Test func jsRoundRoundsHalvesUp() {
    #expect(jsRound(2.5) == 3)
    #expect(jsRound(-2.5) == -2)
    #expect(jsRound(-2.6) == -3)
}

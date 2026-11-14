// CPU side of the soldier renderer: frustum culling (which feeds the pose LOD) and the benchmark's
// launch options and crowd layout.
import IronvaleRender
import Testing
import simd
@testable import IronvaleCharacters

@Suite("characters: renderer CPU side")
@MainActor
struct RendererMathTests {
    let viewProjection: simd_float4x4 = {
        let projection = RenderMath.perspectiveReverseZ(fovYRadians: 78 * .pi / 180, aspect: 1.6, near: 0.04, far: 900)
        return projection * CameraPose(eye: SIMD3(0, 1.64, 0), yaw: 0, pitch: 0).view
    }()

    @Test func cullsSpheresOutsideTheView() {
        let planes = SoldierRenderer.frustumPlanes(viewProjection)
        #expect(SoldierRenderer.sphereVisible(SIMD3(0, 0.9, -10), 2.4, planes))
        #expect(!SoldierRenderer.sphereVisible(SIMD3(0, 0.9, 10), 2.4, planes))     // behind
        #expect(!SoldierRenderer.sphereVisible(SIMD3(60, 0.9, -10), 2.4, planes))   // far right
        #expect(!SoldierRenderer.sphereVisible(SIMD3(0, 0.9, -1000), 2.4, planes))  // past the far plane
        #expect(SoldierRenderer.sphereVisible(SIMD3(0, 0.9, 1.5), 2.4, planes))     // straddling the camera
    }

    @Test func benchmarkCrowdIsAllOnScreen() {
        let planes = SoldierRenderer.frustumPlanes(viewProjection)
        for i in 0..<32 {
            let a = SoldierBenchmark.crowdAnchor(i, count: 32)
            // The whole body, not just the centre: shrink the radius check to "fully inside".
            for p in planes {
                let n = SIMD3(p.x, p.y, p.z)
                #expect(simd_dot(n, SIMD3<Float>(a) + SIMD3(0, 0.9, 0)) + p.w > 0.9 * simd_length(n))
            }
        }
    }

    @Test func parsesBenchmarkOptions() {
        #expect(SoldierBenchmark.Options.parse(["--map", "railyard"]) == nil)
        let o = SoldierBenchmark.Options.parse(["--soldier-bench", "12", "--soldiers", "48", "--bench-json", "/tmp/b.json", "-AppleLanguages", "(en)"])
        #expect(o?.seconds == 12)
        #expect(o?.soldiers == 48)
        #expect(o?.jsonPath == "/tmp/b.json")
        #expect(o?.mapId == "railyard")
    }
}

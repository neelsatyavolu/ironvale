// M9post: the TRAA port against three's values (native/Tools/m3-parity/fixtures/traa.json, from
// traa.test.ts): the jitter sequence and view offset, and the per-pixel math of
// IronvaleApp/Shaders/PostTRAA.h run on the GPU at the fixture's cases.
import Foundation
import Metal
import Testing
import simd
@testable import IronvaleRender

private struct TRAAFixture: Decodable {
    struct Case: Decodable {
        let current, history, min, max: [Float]
        let weight: Float
        let size, velocityUV: [Float]
        let motionFactor: Float
        let historyUV: [Float]
        let closest, farthest, previous: Float
        let clipAABB, flickerReduction: [Float]
        let subpixelCorrection, currentWeight, currentWeightNoSubpixel, varianceGamma: Float
        let hasValidHistory: Bool
    }
    let halton: [[Double]]
    let depthThreshold, edgeDepthDiff, maxVelocityLength: Float
    let useSubpixelCorrection: Bool
    let luminanceCoefficients: [Float]
    let cases: [Case]
}

private let native = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

private func loadFixture() throws -> TRAAFixture {
    try JSONDecoder().decode(TRAAFixture.self, from: Data(contentsOf: native.appending(path: "Tools/m3-parity/fixtures/traa.json")))
}

@MainActor @Test func traaJitterIsThreesHaltonSequence() throws {
    let fixture = try loadFixture()
    #expect(PostTRAA.phases == fixture.halton.count)
    #expect(PostTRAA.useSubpixelCorrection == fixture.useSubpixelCorrection)
    for frame in 0..<(2 * PostTRAA.phases) {
        let h = fixture.halton[frame % fixture.halton.count]
        let j = PostTRAA.jitter(frame: frame)
        #expect(abs(Double(j.x) - (h[0] - 0.5)) < 1e-7 && abs(Double(j.y) - (h[1] - 0.5)) < 1e-7, "frame \(frame)")
    }
}

@MainActor @Test func traaViewOffsetShiftsTheProjectionAsThreeDoes() throws {
    // camera.setViewOffset(w, h, ox, oy, w, h): projection[8] += 2 ox / w, projection[9] -= 2 oy / h.
    let device = try #require(MTLCreateSystemDefaultDevice())
    let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba16Float, width: 400, height: 200, mipmapped: false)
    d.usage = [.renderTarget]
    d.storageMode = .private
    let t = try #require(device.makeTexture(descriptor: d))
    let targets = PostChain.SceneTargets(color: t, normal: t, metalRough: t, depth: t)
    let frame = PostChain.Frame(targets: targets, jitterPixels: SIMD2(0.25, -0.125))
    let p = RenderMath.perspectiveReverseZ(fovYRadians: 1, aspect: 2, near: 0.1, far: 500)
    let j = frame.jittered(p)
    #expect(abs(j.columns.2.x - (p.columns.2.x + 2 * 0.25 / 400)) < 1e-7)
    #expect(abs(j.columns.2.y - (p.columns.2.y + 2 * 0.125 / 200)) < 1e-7)
    #expect(j.columns.0 == p.columns.0 && j.columns.1 == p.columns.1 && j.columns.3 == p.columns.3)
}

/// Per case: 32 floats in (see `kernel`), 16 out.
private let kernelSource = """
kernel void ivTRAATestKernel(device const float *in [[buffer(0)]], device float *out [[buffer(1)]],
                             uint i [[thread_position_in_grid]]) {
    device const float *c = in + i * 32;
    device float *o = out + i * 16;
    float4 current = float4(c[0], c[1], c[2], c[3]);
    float4 history = float4(c[4], c[5], c[6], c[7]);
    float4 minColor = float4(c[8], c[9], c[10], c[11]);
    float4 maxColor = float4(c[12], c[13], c[14], c[15]);
    float2 velocityUV = float2(c[17], c[18]);
    float2 size = float2(c[19], c[20]);
    float motion = c[21];
    bool valid = ivTRAAHasValidHistory(float2(c[24], c[25]), c[26], c[27], c[28]);
    float4 clip = ivTRAAClipAABB(current, history, minColor, maxColor);
    float4 blend = ivTRAAFlickerReduction(current, history, c[16]);
    for (int k = 0; k < 4; ++k) { o[k] = clip[k]; o[4 + k] = blend[k]; }
    o[8] = ivTRAASubpixelCorrection(velocityUV, size);
    o[9] = ivTRAACurrentWeight(velocityUV, size, motion, valid, true);
    o[10] = ivTRAAVarianceGamma(motion);
    o[11] = ivTRAACurrentWeight(velocityUV, size, motion, valid, false);
    o[12] = valid ? 1.0 : 0.0;
    o[13] = IV_TRAA_DEPTH_THRESHOLD;
    o[14] = IV_TRAA_EDGE_DEPTH_DIFF;
    o[15] = IV_TRAA_MAX_VELOCITY;
}
kernel void ivTRAALuminanceKernel(device float *out [[buffer(0)]]) {
    out[0] = ivTRAALuminance(float3(1, 0, 0));
    out[1] = ivTRAALuminance(float3(0, 1, 0));
    out[2] = ivTRAALuminance(float3(0, 0, 1));
}
"""

@Test func traaShaderMathMatchesThree() throws {
    let fixture = try loadFixture()
    let device = try #require(MTLCreateSystemDefaultDevice())
    let header = try String(contentsOf: native.appending(path: "IronvaleApp/Shaders/PostTRAA.h"), encoding: .utf8)
    let library = try device.makeLibrary(source: header + kernelSource, options: nil)
    let queue = try #require(device.makeCommandQueue())

    var input = [Float](repeating: 0, count: fixture.cases.count * 32)
    for (i, c) in fixture.cases.enumerated() {
        let row = c.current + c.history + c.min + c.max + [c.weight] + c.velocityUV + c.size + [c.motionFactor, 0, 0]
            + c.historyUV + [c.closest, c.farthest, c.previous]
        for (k, v) in row.enumerated() { input[i * 32 + k] = v }
    }
    let inBuffer = try #require(device.makeBuffer(bytes: input, length: input.count * 4, options: .storageModeShared))
    let outBuffer = try #require(device.makeBuffer(length: fixture.cases.count * 16 * 4, options: .storageModeShared))
    let lumBuffer = try #require(device.makeBuffer(length: 16, options: .storageModeShared))
    let commands = try #require(queue.makeCommandBuffer())
    let encoder = try #require(commands.makeComputeCommandEncoder())
    for (name, buffers, count) in [("ivTRAATestKernel", [inBuffer, outBuffer], fixture.cases.count), ("ivTRAALuminanceKernel", [lumBuffer], 1)] {
        let function = try #require(library.makeFunction(name: name))
        encoder.setComputePipelineState(try device.makeComputePipelineState(function: function))
        for (index, buffer) in buffers.enumerated() { encoder.setBuffer(buffer, offset: 0, index: index) }
        encoder.dispatchThreads(MTLSize(width: count, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 1, height: 1, depth: 1))
    }
    encoder.endEncoding()
    commands.commit()
    commands.waitUntilCompleted()

    let lum = lumBuffer.contents().bindMemory(to: Float.self, capacity: 3)
    for k in 0..<3 { #expect(lum[k] == fixture.luminanceCoefficients[k]) }
    let out = outBuffer.contents().bindMemory(to: Float.self, capacity: fixture.cases.count * 16)
    #expect(out[13] == fixture.depthThreshold && out[14] == fixture.edgeDepthDiff && out[15] == fixture.maxVelocityLength)

    func close(_ a: Float, _ b: Float) -> Bool { abs(a - b) <= 2e-5 * max(1, abs(b)) }
    for (i, c) in fixture.cases.enumerated() {
        let o = (0..<16).map { out[i * 16 + $0] }
        let expected = c.clipAABB + c.flickerReduction + [c.subpixelCorrection, c.currentWeight, c.varianceGamma,
                                                          c.currentWeightNoSubpixel, c.hasValidHistory ? 1 : 0]
        let names = ["clipAABB", "clipAABB", "clipAABB", "clipAABB", "flickerReduction", "flickerReduction", "flickerReduction",
                     "flickerReduction", "subpixelCorrection", "currentWeight", "varianceGamma", "currentWeight (no subpixel)",
                     "hasValidHistory"]
        for k in 0..<expected.count where !close(o[k], expected[k]) {
            Issue.record("case \(i) \(names[k]): GPU \(o[k]), three \(expected[k])")
        }
    }
}

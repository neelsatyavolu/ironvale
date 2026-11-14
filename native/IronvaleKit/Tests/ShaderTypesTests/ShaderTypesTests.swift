import Testing
import ShaderTypes

@Test func clearUniformsLayoutMatchesMSL() {
    // float4 (16) + 4 floats (16): MSL sees the same 32-byte, 16-aligned struct.
    #expect(MemoryLayout<IVClearUniforms>.size == 32)
    #expect(MemoryLayout<IVClearUniforms>.alignment == 16)
}

// Expected sizes follow the MSL rules, which the C simd types share: float3 is 16 bytes with
// 16-byte alignment (a scalar after it does not fill its fourth lane), float2 8/8, float4x4 64/16.
@Test func m3UniformLayoutsMatchMSL() {
    // 4 matrices (256), 8 float3 + scalar pairs (256..464+4), 7 scalars, padded to 16.
    #expect(MemoryLayout<IVFrameUniforms>.offset(of: \IVFrameUniforms.cameraPosition) == 256)
    #expect(MemoryLayout<IVFrameUniforms>.offset(of: \IVFrameUniforms.fogBaseHeight) == 464)
    #expect(MemoryLayout<IVFrameUniforms>.offset(of: \IVFrameUniforms.lightCount) == 492)
    #expect(MemoryLayout<IVFrameUniforms>.stride == 512)
    #expect(MemoryLayout<IVLight>.offset(of: \IVLight.color) == 32)
    #expect(MemoryLayout<IVLight>.offset(of: \IVLight.kind) == 84)
    #expect(MemoryLayout<IVLight>.stride == 112)
    #expect(MemoryLayout<IVDrawUniforms>.stride == 144)
    #expect(MemoryLayout<IVMaterialUniforms>.offset(of: \IVMaterialUniforms.normalScale) == 40)
    #expect(MemoryLayout<IVMaterialUniforms>.offset(of: \IVMaterialUniforms.flags) == 64)
    #expect(MemoryLayout<IVMaterialUniforms>.stride == 80)
    #expect(MemoryLayout<IVPostUniforms>.stride == 16)
    #expect(MemoryLayout<IVPrefilterUniforms>.stride == 16)
}

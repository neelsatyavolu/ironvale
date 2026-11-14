// M0 clear pass: one full-screen triangle filled from IVClearUniforms.
#include <metal_stdlib>
#include "ShaderTypes.h"
using namespace metal;

struct ClearVaryings {
    float4 position [[position]];
    float2 uv;
};

vertex ClearVaryings ivFullscreenVertex(uint vid [[vertex_id]]) {
    float2 uv = float2((vid << 1) & 2, vid & 2);
    ClearVaryings out;
    out.position = float4(uv * 2.0 - 1.0, 0.0, 1.0);
    out.uv = uv;
    return out;
}

fragment float4 ivClearFragment(ClearVaryings in [[stage_in]],
                                constant IVClearUniforms &uniforms [[buffer(0)]]) {
    // A slow vertical gradient pulse, so a stalled loop is visible at a glance.
    float pulse = 0.5 + 0.5 * sin(uniforms.time * 2.0);
    float3 color = uniforms.color.rgb * (0.8 + 0.4 * in.uv.y) + float3(0.0, 0.0, 0.03 * pulse);
    return float4(color, uniforms.color.a);
}

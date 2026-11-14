// Background: the scene backdrop of engine.ts setLighting (equirect panorama, rotated by
// hdriRotation, scaled by backgroundIntensity), drawn where nothing else wrote depth.
// Maps with a sky program use their own fragment instead (Railyard: SkyRailyard.metal).
#include <metal_stdlib>
#include "ShaderTypes.h"
#include "Common.h"
using namespace metal;

struct SkyVaryings {
    float4 position [[position]];
    float2 ndc;
};

vertex SkyVaryings ivSkyVertex(uint vid [[vertex_id]]) {
    float2 uv = float2((vid << 1) & 2, vid & 2);
    SkyVaryings out;
    out.ndc = uv * 2.0 - 1.0;
    // Reverse-Z: depth 0 is the far plane, so the sky only fills untouched pixels.
    out.position = float4(out.ndc, 0.0, 1.0);
    return out;
}

fragment float4 ivSkyFragment(SkyVaryings in [[stage_in]],
                              constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                              texture2d<float> panorama [[texture(0)]]) {
    float4 far = frame.inverseViewProjection * float4(in.ndc, 0.0, 1.0);
    float4 near = frame.inverseViewProjection * float4(in.ndc, 1.0, 1.0);
    float3 dir = normalize(far.xyz / far.w - near.xyz / near.w);
    constexpr sampler s(filter::linear, mip_filter::linear, s_address::repeat, t_address::clamp_to_edge);
    float3 color = panorama.sample(s, ivEquirectUV(dir, frame.environmentRotation), level(0)).rgb;
    return float4(color * frame.backgroundIntensity, 1.0);
}

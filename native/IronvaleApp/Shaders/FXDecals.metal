// Port of src/fx/decals.ts buildMaterial (commit a487033): bullet holes, lit quads (three's
// MeshStandardMaterial) over the decal sheet, fading out at the end of their hold.
#include "FXCommon.h"

struct DecalVaryings {
    float4 position [[position]];
    float2 sheetUV;
    float strength;
    float metal;
    float3 world;
    float3 normal;
    float viewZ;
};

vertex DecalVaryings fxDecalVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                   constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                                   constant FXUniforms &fx [[buffer(FX_BUFFER_UNIFORMS)]],
                                   device const float4x4 *matrices [[buffer(FX_BUFFER_INSTANCES)]],
                                   device const float4 *info [[buffer(FX_BUFFER_EXTRA)]]) {
    float2 uv = fxQuadUV(vid);
    float4x4 m = matrices[iid];
    float4 world = m * float4(uv - 0.5, 0.0, 1.0);
    float4 aInfo = info[iid];
    DecalVaryings out;
    out.position = frame.viewProjection * world;
    out.sheetUV = fxSheetUV(aInfo.x, 4.0, uv);
    out.strength = 1.0 - smoothstep(aInfo.y, aInfo.z, fx.clock.x);
    out.metal = aInfo.w;
    out.world = world.xyz;
    out.normal = normalize((m * float4(0, 0, 1, 0)).xyz);
    out.viewZ = fxViewZ(frame, world.xyz);
    return out;
}

fragment FXOut fxDecalFragment(DecalVaryings in [[stage_in]], bool front [[front_facing]],
                               constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                               device const IVLight *lights [[buffer(IV_BUFFER_LIGHTS)]],
                               texture2d<float> environment [[texture(IV_TEXTURE_ENVIRONMENT)]],
                               depth2d<float> shadowMap [[texture(IV_TEXTURE_SHADOW)]],
                               texture2d<float> atlas [[texture(FX_TEXTURE_ATLAS)]]) {
    constexpr sampler s(filter::linear, mip_filter::linear, address::clamp_to_edge);
    float4 sample = atlas.sample(s, in.sheetUV);
    float a = sample.a * in.strength;
    if (a < 0.02) discard_fragment();
    float3 n = normalize(in.normal);
    float3 color = fxStandard(frame, lights, environment, shadowMap, sample.rgb, in.metal * 0.85, 0.92 - in.metal * 0.5, n, n,
                              in.world, true);
    FXOut out;
    out.color = float4(fxFog(frame, color, in.world, in.viewZ), a);
    return out;
}

// Port of src/fx/muzzle.ts buildMaterial (commit a487033): the flash quads (head-on star and two
// crossed jets) over the flash-sheet masks.
#include "FXCommon.h"

struct FlashVaryings {
    float4 position [[position]];
    float2 sheetUV;
    float brightness;
};

vertex FlashVaryings fxMuzzleVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                    constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                                    device const float4x4 *matrices [[buffer(FX_BUFFER_INSTANCES)]],
                                    device const float2 *info [[buffer(FX_BUFFER_EXTRA)]]) {
    float2 uv = fxQuadUV(vid);
    float4 world = matrices[iid] * float4(uv - 0.5, 0.0, 1.0);
    FlashVaryings out;
    out.position = frame.viewProjection * world;
    out.sheetUV = fxSheetUV(info[iid].x, 2.0, uv);
    out.brightness = info[iid].y;
    return out;
}

fragment FXOut fxMuzzleFragment(FlashVaryings in [[stage_in]], texture2d<float> atlas [[texture(FX_TEXTURE_ATLAS)]]) {
    constexpr sampler s(filter::linear, mip_filter::linear, address::clamp_to_edge);
    float mask = atlas.sample(s, in.sheetUV).a;
    if (mask < 0.01) discard_fragment();
    // Orange at the ragged edge, pale yellow-white in the core.
    float3 colour = mix(float3(1, 0.36, 0.08), float3(1, 0.86, 0.6), smoothstep(0.2, 0.85, mask));
    FXOut out;
    out.color = float4(colour * in.brightness * 9.0, mask);
    return out;
}

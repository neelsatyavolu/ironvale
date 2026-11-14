// Final pass (src/render/pipeline.ts tail): renderOutput = three's ACES Filmic tone map with
// exposure, then sRGB encoding, then the vignette on display-referred colour.
// ACES from three r180 nodes/display/ToneMappingFunctions.js (acesFilmicToneMapping), in PostCommon.h.
// ivPostVertex is the full-screen triangle every post pass (Post*.metal) draws.
#include <metal_stdlib>
#include "ShaderTypes.h"
#include "PostCommon.h"
using namespace metal;

vertex PostVaryings ivPostVertex(uint vid [[vertex_id]]) {
    float2 uv = float2((vid << 1) & 2, vid & 2);
    PostVaryings out;
    out.position = float4(uv * 2.0 - 1.0, 0.0, 1.0);
    out.uv = float2(uv.x, 1.0 - uv.y);
    return out;
}

fragment float4 ivPostFragment(PostVaryings in [[stage_in]],
                               constant IVPostUniforms &post [[buffer(0)]],
                               texture2d<float> hdr [[texture(0)]]) {
    float3 color = ivLinearToSRGB(ivACESFilmic(hdr.sample(ivPostLinear, in.uv).rgb, post.exposure));
    float fromCentre = length(in.uv - 0.5);
    color *= mix(1.0, post.vignetteStrength, smoothstep(post.vignetteInner, post.vignetteOuter, fromCentre));
    return float4(color, 1.0);
}

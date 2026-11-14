// Final pass (src/render/pipeline.ts tail): renderOutput = three's ACES Filmic tone map with
// exposure, then sRGB encoding, then the vignette on display-referred colour.
// ACES from three r180 nodes/display/ToneMappingFunctions.js (acesFilmicToneMapping).
#include <metal_stdlib>
#include "ShaderTypes.h"
using namespace metal;

struct PostVaryings {
    float4 position [[position]];
    float2 uv;
};

vertex PostVaryings ivPostVertex(uint vid [[vertex_id]]) {
    float2 uv = float2((vid << 1) & 2, vid & 2);
    PostVaryings out;
    out.position = float4(uv * 2.0 - 1.0, 0.0, 1.0);
    out.uv = float2(uv.x, 1.0 - uv.y);
    return out;
}

static float3 RRTAndODTFit(float3 c) {
    float3 a = c * (c + 0.0245786) - 0.000090537;
    float3 b = c * (0.983729 * c + 0.4329510) + 0.238081;
    return a / b;
}

static float3 acesFilmic(float3 color, float exposure) {
    // Columns of three's row-major mat3 literals.
    const float3x3 input = float3x3(float3(0.59719, 0.07600, 0.02840),
                                    float3(0.35458, 0.90834, 0.13383),
                                    float3(0.04823, 0.01566, 0.83777));
    const float3x3 output = float3x3(float3(1.60475, -0.10208, -0.00327),
                                     float3(-0.53108, 1.10813, -0.07276),
                                     float3(-0.07367, -0.00605, 1.07602));
    color = color * exposure / 0.6;
    color = output * RRTAndODTFit(input * color);
    return saturate(color);
}

static float3 linearToSRGB(float3 c) {
    return select(1.055 * pow(c, 1.0 / 2.4) - 0.055, c * 12.92, c <= 0.0031308);
}

fragment float4 ivPostFragment(PostVaryings in [[stage_in]],
                               constant IVPostUniforms &post [[buffer(0)]],
                               texture2d<float> hdr [[texture(0)]]) {
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    float3 color = linearToSRGB(acesFilmic(hdr.sample(s, in.uv).rgb, post.exposure));
    float fromCentre = length(in.uv - 0.5);
    color *= mix(1.0, post.vignetteStrength, smoothstep(post.vignetteInner, post.vignetteOuter, fromCentre));
    return float4(color, 1.0);
}

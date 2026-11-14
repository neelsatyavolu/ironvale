// Unreal-style bloom, ported from three r187 examples/jsm/tsl/display/BloomNode.js as
// src/render/pipeline.ts uses it (commit 1aca0b7): strength 0.22 x map bloom, radius 0.6,
// threshold 1.0, smooth width 0.01, five mips from half resolution down, kernel radii
// 6, 10, 14, 18, 22 with linearly-sampled tap pairs, composite factors 1.0 ... 0.2 and white tints.
#include <metal_stdlib>
#include "ShaderTypes.h"
#include "PostCommon.h"
using namespace metal;

/// luminosityHighPass.
fragment float4 ivBloomHighPassFragment(PostVaryings in [[stage_in]],
                                        constant IVBloomParams &params [[buffer(0)]],
                                        texture2d<float> source [[texture(0)]]) {
    float4 input = source.sample(ivPostLinear, in.uv);
    float alpha = smoothstep(params.threshold, params.threshold + params.smoothWidth, ivLuminance(input.rgb));
    return mix(float4(0.0), input, alpha);
}

/// One direction of one level's separable Gaussian.
fragment float4 ivBloomBlurFragment(PostVaryings in [[stage_in]],
                                    constant IVBloomParams &params [[buffer(0)]],
                                    texture2d<float> source [[texture(0)]]) {
    float3 sum = source.sample(ivPostLinear, in.uv).rgb * params.centerWeight;
    for (uint i = 0; i < params.kernelTaps; i++) {
        float4 pair = params.offsetsWeights[i / 2];
        float2 ow = (i & 1) == 0 ? pair.xy : pair.zw;
        float2 uvOffset = params.direction * params.invSize * ow.x;
        sum += (source.sample(ivPostLinear, in.uv + uvOffset).rgb + source.sample(ivPostLinear, in.uv - uvOffset).rgb) * ow.y;
    }
    return float4(sum, 1.0);
}

static float lerpBloomFactor(float factor, float radius) { return mix(factor, 1.2 - factor, radius); }

fragment float4 ivBloomCompositeFragment(PostVaryings in [[stage_in]],
                                         constant IVBloomParams &params [[buffer(0)]],
                                         texture2d<float> blur0 [[texture(0)]],
                                         texture2d<float> blur1 [[texture(1)]],
                                         texture2d<float> blur2 [[texture(2)]],
                                         texture2d<float> blur3 [[texture(3)]],
                                         texture2d<float> blur4 [[texture(4)]]) {
    float r = params.radius;
    float4 sum = lerpBloomFactor(1.0, r) * blur0.sample(ivPostLinear, in.uv)
        + lerpBloomFactor(0.8, r) * blur1.sample(ivPostLinear, in.uv)
        + lerpBloomFactor(0.6, r) * blur2.sample(ivPostLinear, in.uv)
        + lerpBloomFactor(0.4, r) * blur3.sample(ivPostLinear, in.uv)
        + lerpBloomFactor(0.2, r) * blur4.sample(ivPostLinear, in.uv);
    return sum * params.strength;
}

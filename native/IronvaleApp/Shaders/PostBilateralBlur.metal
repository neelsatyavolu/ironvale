// Edge-preserving separable blur, ported from three r187 examples/jsm/tsl/display/BilateralBlurNode.js
// as src/render/pipeline.ts uses it on the light shafts (sigma 3, sigma colour 0.1). One direction
// per draw; the weights depend on the luminance difference to the centre tap.
#include <metal_stdlib>
#include "ShaderTypes.h"
#include "PostCommon.h"
using namespace metal;

fragment float4 ivBilateralBlurFragment(PostVaryings in [[stage_in]],
                                        constant IVBilateralParams &params [[buffer(0)]],
                                        texture2d<float> source [[texture(0)]]) {
    float4 centerColor = source.sample(ivPostLinear, in.uv);
    float centerLuminance = ivLuminance(centerColor.rgb);
    float weightSum = params.coefficients[0];
    float4 colorSum = centerColor * params.coefficients[0];
    for (uint i = 1; i < params.kernelSize; i++) {
        float2 uvOffset = params.direction * params.invSize * float(i);
        float4 sample1 = source.sample(ivPostLinear, in.uv + uvOffset);
        float4 sample2 = source.sample(ivPostLinear, in.uv - uvOffset);
        float diff1 = abs(ivLuminance(sample1.rgb) - centerLuminance);
        float diff2 = abs(ivLuminance(sample2.rgb) - centerLuminance);
        float w1 = params.coefficients[i] * exp(diff1 * diff1 * params.sigmaColorFactor);
        float w2 = params.coefficients[i] * exp(diff2 * diff2 * params.sigmaColorFactor);
        colorSum += sample1 * w1 + sample2 * w2;
        weightSum += w1 + w2;
    }
    return colorSum / max(weightSum, 0.0001);
}

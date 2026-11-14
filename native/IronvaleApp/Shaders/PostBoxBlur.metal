// Box blur, ported from three r187 examples/jsm/tsl/display/boxBlur.js as SSRNode uses it: mip 0 of
// the SSR blur chain is a copy, mip i a (2 size + 1)^2 box over the full SSR target with taps i
// texels apart (size 2, the default blurQuality). No premultiplied alpha.
#include <metal_stdlib>
#include "ShaderTypes.h"
#include "PostCommon.h"
using namespace metal;

fragment float4 ivBoxBlurFragment(PostVaryings in [[stage_in]],
                                  constant IVBoxBlurParams &params [[buffer(0)]],
                                  texture2d<float> source [[texture(0)]]) {
    float2 pixelStep = 1.0 / float2(source.get_width(), source.get_height());
    float sep = max(params.separation, 1.0);
    float4 result = 0.0;
    int count = 0;
    for (int i = -params.size; i <= params.size; i++) {
        for (int j = -params.size; j <= params.size; j++) {
            result += source.sample(ivPostLinear, in.uv + float2(i, j) * pixelStep * sep);
            count++;
        }
    }
    return result / float(count);
}

fragment float4 ivPostCopyFragment(PostVaryings in [[stage_in]], texture2d<float> source [[texture(0)]]) {
    return source.sample(ivPostLinear, in.uv);
}

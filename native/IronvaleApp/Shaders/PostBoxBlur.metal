// Box blur, ported from three r187 examples/jsm/tsl/display/boxBlur.js as SSRNode uses it: mip 0 of
// the SSR blur chain is a copy, mip i a (2 size + 1)^2 box over the full SSR target with taps i
// texels apart (size 2, the default blurQuality). No premultiplied alpha.
// ivSSRBlurKernel computes the whole chain in one dispatch (the small mips alone leave the GPU idle
// between passes); the fragments are kept for reference and other users.
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

/// The SSR blur chain in one dispatch over mip 0: every thread copies its mip 0 texel, and the
/// threads inside mip i (i >= 1) also write that mip's (2 x 2 + 1)^2 box with taps i texels apart,
/// sampled exactly as ivBoxBlurFragment does at the mip's pixel centres.
kernel void ivSSRBlurKernel(texture2d<float> source [[texture(0)]],
                            array<texture2d<float, access::write>, 5> mips [[texture(1)]],
                            constant uint &levels [[buffer(0)]],
                            uint2 gid [[thread_position_in_grid]]) {
    const int size = 2;
    if (gid.x < mips[0].get_width() && gid.y < mips[0].get_height()) mips[0].write(source.read(gid), gid);
    float2 pixelStep = 1.0 / float2(source.get_width(), source.get_height());
    for (uint level = 1; level < levels; level++) {
        uint2 extent = uint2(mips[level].get_width(), mips[level].get_height());
        if (gid.x >= extent.x || gid.y >= extent.y) break;
        float2 uv = (float2(gid) + 0.5) / float2(extent);
        float sep = float(level);
        float4 result = 0.0;
        for (int i = -size; i <= size; i++) {
            for (int j = -size; j <= size; j++) {
                result += source.sample(ivPostLinear, uv + float2(i, j) * pixelStep * sep);
            }
        }
        mips[level].write(result / float((2 * size + 1) * (2 * size + 1)), gid);
    }
}

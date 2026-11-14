// The frame graph glue of src/render/pipeline.ts (commit 1aca0b7), around the passes in the other
// Post*.metal files:
//   ivPostCompositeFragment: colour x GTAO, + SSR (roughness-selected blur mip) x its alpha, mixed
//     toward the sun colour by the blurred shafts with the 110 - 320 m near-field fade. It is TRAA's
//     beauty input (PostTRAA.metal, which reprojects the camera motion itself).
//   ivPostOutputFragment: + bloom, renderOutput (ACES Filmic with exposure, sRGB), vignette, then
//     film grain (three r187 examples/jsm/tsl/display/FilmNode.js, intensity 0.055).
#include <metal_stdlib>
#include "ShaderTypes.h"
#include "PostCommon.h"
using namespace metal;

static float4 composite(float2 uv, float depth, constant IVPostView &view, constant IVPostCompositeParams &params,
                        texture2d<float> sceneColor, texture2d<float> metalRoughTex, texture2d<float> aoTex,
                        texture2d<float> ssrTex, texture2d<float> shaftsTex) {
    constexpr sampler trilinear(filter::linear, mip_filter::linear, address::clamp_to_edge);
    float4 color = sceneColor.sample(ivPostNearest, uv);

    if ((params.flags & IV_POST_AO) != 0) color.rgb *= aoTex.sample(ivPostLinear, uv).r;
    if ((params.flags & IV_POST_SSR) != 0) {
        float r = metalRoughTex.sample(ivPostLinear, uv).g;
        float lod = clamp(r * r * params.ssrMips, 0.0, params.ssrMips);
        float4 reflection = ssrTex.sample(trilinear, uv, level(lod));
        color.rgb += reflection.rgb * reflection.a;
    }
    if ((params.flags & IV_POST_GODRAYS) != 0) {
        float viewDistance = -ivViewZ(depth, view.near, view.far);
        float nearField = 1.0 - smoothstep(params.shaftFadeStart, params.shaftFadeEnd, viewDistance) * 0.8;
        float amount = shaftsTex.sample(ivPostLinear, uv).r * params.volumetric * nearField;
        color.rgb = mix(color.rgb, params.shaftColor, amount);
    }
    return color;
}

fragment float4 ivPostCompositeFragment(PostVaryings in [[stage_in]],
                                        constant IVPostView &view [[buffer(0)]],
                                        constant IVPostCompositeParams &params [[buffer(1)]],
                                        texture2d<float> sceneColor [[texture(0)]],
                                        depth2d<float> depthTex [[texture(1)]],
                                        texture2d<float> metalRoughTex [[texture(2)]],
                                        texture2d<float> aoTex [[texture(3)]],
                                        texture2d<float> ssrTex [[texture(4)]],
                                        texture2d<float> shaftsTex [[texture(5)]]) {
    return composite(in.uv, depthTex.sample(ivPostNearest, in.uv), view, params, sceneColor, metalRoughTex, aoTex,
                     ssrTex, shaftsTex);
}

/// FilmNode: base + base x clamp(rand(fract(uv + time)) + 0.1, 0, 1), mixed by the intensity.
static float3 film(float3 base, float2 uv, float time, float intensity) {
    float noise = ivRand(fract(uv + time));
    float3 color = base + base * clamp(noise + 0.1, 0.0, 1.0);
    return mix(base, color, intensity);
}

fragment float4 ivPostOutputFragment(PostVaryings in [[stage_in]],
                                     constant IVPostOutputParams &params [[buffer(0)]],
                                     texture2d<float> hdr [[texture(0)]],
                                     texture2d<float> bloom [[texture(1)]]) {
    float3 color = hdr.sample(ivPostLinear, in.uv).rgb;
    if ((params.flags & IV_POST_BLOOM) != 0) color += bloom.sample(ivPostLinear, in.uv).rgb;
    float3 display = ivLinearToSRGB(ivACESFilmic(color, params.exposure));
    float fromCentre = length(in.uv - 0.5);
    display *= mix(1.0, params.vignetteStrength, smoothstep(params.vignetteInner, params.vignetteOuter, fromCentre));
    if (params.grainIntensity > 0.0) display = film(display, in.uv, params.time, params.grainIntensity);
    return float4(display, 1.0);
}

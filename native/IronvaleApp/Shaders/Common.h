// Helpers shared by the M3 shaders. Header only; included by MapPBR, Sky and IBLPrefilter.
#ifndef IRONVALE_COMMON_H
#define IRONVALE_COMMON_H
#include <metal_stdlib>
using namespace metal;

#define IV_PI 3.141592653589793
#define IV_RECIPROCAL_PI 0.3183098861837907

// three's equirectUV (nodes/utils/EquirectUV.js), with the sky rotation of engine.ts setLighting:
// rotating the sky by r moves a texture direction at azimuth a = atan2(z, x) to a - r
// (src/maps/railyard/lighting.ts), so a world direction samples the texture at azimuth + r.
// three samples with flipY images (v = 0 at the bottom); Metal's v = 0 is the top row.
static inline float2 ivEquirectUV(float3 dir, float rotation) {
    float az = atan2(dir.z, dir.x) + rotation;
    float u = az * (0.5 * IV_RECIPROCAL_PI) + 0.5;
    float v = asin(clamp(dir.y, -1.0, 1.0)) * IV_RECIPROCAL_PI + 0.5;
    return float2(u, 1.0 - v);
}

// Prefiltered environment: an equirect mip chain whose level i holds roughness i / maxLod.
static inline float3 sampleEnvironment(texture2d<float> env, float3 dir, float lod, float rotation) {
    constexpr sampler s(filter::linear, mip_filter::linear, s_address::repeat, t_address::clamp_to_edge);
    return env.sample(s, ivEquirectUV(dir, rotation), level(lod)).rgb;
}
#endif

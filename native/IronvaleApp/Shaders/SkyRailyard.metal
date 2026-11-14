// Railyard sky dome: buildSky() of src/maps/railyard/sky.ts at commit cbe0add. The evening
// panorama graded to a rain sky: cool blue pulled to grey, a dark uneven cloud deck overhead,
// the horizon hazed to the fog colour, and a warm glow around the sun. Drawn as a full-screen
// pass where nothing wrote depth, like the dome (radius 800, depthWrite off, renderOrder -1000).
// The dome is turned by hdriRotation, so its local direction is the world direction turned back.
// Lighting still comes from the untouched HDRI (MapPBR.metal).
#include <metal_stdlib>
#include "ShaderTypes.h"
#include "Common.h"
#include "MapSurface.h"
#include "Noise.metal"
using namespace metal;

/// sky.ts constants: the tone-mapped panorama is shown (assets.sky), so PANORAMA_GAIN applies.
constant float PANORAMA_GAIN = 0.8;
constant float DECK_DARK = 0.07;
constant float DECK_LIGHT = 0.3;
constant float3 DECK_TINT = float3(0.7, 0.88, 1.08);
constant uint3 SUN_GLOW_SRGB = uint3(0xff, 0xd0, 0xa2);  // 0xffd0a2

static inline float3 srgbToLinear(float3 c) {
    return select(pow((c + 0.055) / 1.055, 2.4), c / 12.92, c <= 0.04045);
}

struct SkyVaryings {
    float4 position [[position]];
    float2 ndc;
};

fragment float4 ivSkyRailyardFragment(SkyVaryings in [[stage_in]],
                                      constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                                      constant float4 *params [[buffer(IV_BUFFER_PROGRAM_PARAMS)]],
                                      texture2d<float> panorama [[texture(0)]]) {
    float4 far = frame.inverseViewProjection * float4(in.ndc, 0.0, 1.0);
    float4 near = frame.inverseViewProjection * float4(in.ndc, 1.0, 1.0);
    float3 world = normalize(far.xyz / far.w - near.xyz / near.w);
    float r = frame.environmentRotation;
    float3 direction = float3(cos(r) * world.x - sin(r) * world.z, world.y, sin(r) * world.x + cos(r) * world.z);

    constexpr sampler s(filter::linear, mip_filter::linear, s_address::repeat, t_address::clamp_to_edge);
    float3 sampled = min(panorama.sample(s, ivEquirectUV(direction, 0.0), level(0)).rgb, float3(4.0));
    float luma = dot(sampled, float3(0.2126, 0.7152, 0.0722));
    float warmth = smoothstep(0.0, 0.16, (sampled.r - sampled.b) / (luma + 0.05));
    float3 grey = float3(luma) * float3(0.9, 0.96, 1.05);
    float towardSun = max(dot(direction, params[IV_RY_SUN_IN_SKY].xyz), 0.0);
    float3 graded = mix(mix(grey, sampled, 0.1), sampled, warmth * smoothstep(0.6, 0.95, towardSun));
    float billow = ivMxFractalNoise(direction * float3(2.4, 6.0, 2.4), 3, 2.0, 0.5) * 0.5 + 0.5;
    float nearSun = smoothstep(0.45, 0.97, towardSun);
    float overhead = smoothstep(0.02, 0.34, direction.y) * (1.0 - nearSun * 0.75);
    float deck = mix(1.0, mix(DECK_DARK, DECK_LIGHT, billow * billow), overhead);
    float3 cast = mix(float3(1.0), DECK_TINT, overhead * (1.0 - nearSun));
    float haze = (1.0 - smoothstep(0.0, 0.16, abs(direction.y))) * 0.8 * (1.0 - pow(towardSun, 5.0));
    float band = pow(towardSun, 7.0) * (1.0 - smoothstep(0.0, 0.3, abs(direction.y))) * 0.55;
    float3 glowColor = srgbToLinear(float3(SUN_GLOW_SRGB) / 255.0);
    float3 glow = glowColor * (band + pow(towardSun, 28.0) * 0.5 + pow(towardSun, 500.0) * 2.4);
    float3 color = mix(graded * deck * cast * PANORAMA_GAIN, frame.fogColor, haze) + glow;
    return float4(color, 1.0);
}

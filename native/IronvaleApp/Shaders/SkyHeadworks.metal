// Headworks sky dome: buildSky() of src/maps/headworks/sky.ts at commit 3ec2f09. The panorama's
// broken cumulus over a cold blue graded for a winter afternoon: deeper blue overhead and away
// from the sun, slate cloud bases, the horizon hazed to the fog colour, a straw glow and the disc
// round the sun. Drawn as a full-screen pass where nothing wrote depth, like the dome (depthWrite
// off, renderOrder -1000). The dome is turned by hdriRotation, so its local direction is the
// world direction turned back. HDRI_SUN, fog and sun colours and the panorama gain come from
// scene.json programRows.
#include <metal_stdlib>
#include "ShaderTypes.h"
#include "Common.h"
#include "MapSurface.h"
using namespace metal;

struct SkyVaryings {
    float4 position [[position]];
    float2 ndc;
};

fragment float4 ivSkyHeadworksFragment(SkyVaryings in [[stage_in]],
                                       constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                                       constant float4 *rows [[buffer(IV_BUFFER_PROGRAM_PARAMS)]],
                                       texture2d<float> panorama [[texture(0)]]) {
    float4 far = frame.inverseViewProjection * float4(in.ndc, 0.0, 1.0);
    float4 near = frame.inverseViewProjection * float4(in.ndc, 1.0, 1.0);
    float3 world = normalize(far.xyz / far.w - near.xyz / near.w);
    float r = frame.environmentRotation;
    float3 direction = float3(cos(r) * world.x - sin(r) * world.z, world.y, sin(r) * world.x + cos(r) * world.z);

    constexpr sampler s(filter::linear, mip_filter::linear, s_address::repeat, t_address::clamp_to_edge);
    float3 sampled = min(panorama.sample(s, ivEquirectUV(direction, 0.0), level(0)).rgb, float3(4.0)) * rows[IV_HW_COUNTS].z;
    float3 sunColor = rows[IV_HW_SUN_COLOR].xyz;
    float up = max(direction.y, 0.0);
    float towardSun = max(dot(direction, rows[IV_HW_HDRI_SUN].xyz), 0.0);
    float luma = dot(sampled, float3(0.2126, 0.7152, 0.0722));
    float3 contrast = sampled * mix(0.62, 1.25, smoothstep(0.25, 0.9, luma));
    float depth = smoothstep(0.1, 0.8, up) * (1.0 - pow(towardSun, 2.0));
    float3 graded = mix(contrast, contrast * float3(0.6, 0.74, 1.02), depth * 0.75);
    float haze = pow(1.0 - up, 9.0) * 0.9 * (step(-0.2, direction.y) * 0.4 + 0.6);
    float3 fog = rows[IV_HW_FOG].xyz * 1.15;
    float3 warmHaze = mix(fog, sunColor * 1.5, pow(towardSun, 6.0) * 0.85);
    float3 glow = sunColor * (pow(towardSun, 18.0) * 0.5 + pow(towardSun, 160.0) * 1.6 + pow(towardSun, 2600.0) * 9.0);
    return float4(mix(graded, warmHaze, haze) + glow, 1.0);
}

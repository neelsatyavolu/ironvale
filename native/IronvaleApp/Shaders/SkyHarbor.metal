// Harbor sky dome: addSky() of src/maps/harbor/sky.ts at commit 3ec2f09. The evening panorama
// with a deck of broken high cloud: long bars across the line to the sun, gold where the low sun
// rakes them, rose to the sides and mauve behind, darker cores, and a band of warm air above the
// horizon. Drawn as a full-screen pass where nothing wrote depth, like the dome; its local
// direction is the world direction turned back by hdriRotation. The HDRI sun and the panorama gain
// come from scene.json programRows (IV_HB_SKY).
#include <metal_stdlib>
#include "ShaderTypes.h"
#include "Common.h"
#include "MapSurface.h"
#include "Noise.metal"
using namespace metal;

constant uint HB_GOLD = 0xffcf8au;
constant uint HB_ROSE = 0xe88f74u;
constant uint HB_MAUVE = 0x9d8faeu;

struct SkyVaryings {
    float4 position [[position]];
    float2 ndc;
};

fragment float4 ivSkyHarborFragment(SkyVaryings in [[stage_in]],
                                    constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                                    constant float4 *rows [[buffer(IV_BUFFER_PROGRAM_PARAMS)]],
                                    texture2d<float> panorama [[texture(0)]]) {
    float4 far = frame.inverseViewProjection * float4(in.ndc, 0.0, 1.0);
    float4 near = frame.inverseViewProjection * float4(in.ndc, 1.0, 1.0);
    float3 world = normalize(far.xyz / far.w - near.xyz / near.w);
    float r = frame.environmentRotation;
    float3 direction = float3(cos(r) * world.x - sin(r) * world.z, world.y, sin(r) * world.x + cos(r) * world.z);

    constexpr sampler s(filter::linear, mip_filter::linear, s_address::repeat, t_address::clamp_to_edge);
    float4 skyRow = rows[IV_HB_SKY];
    float3 sky = min(panorama.sample(s, ivEquirectUV(direction, 0.0), level(0)).rgb, float3(6.0)) * skyRow.z;
    float2 sunFlat = float2(cos(skyRow.x), sin(skyRow.x));
    float3 sun = float3(sunFlat.x * cos(skyRow.y), sin(skyRow.y), sunFlat.y * cos(skyRow.y));
    float facing = dot(direction, sun);
    float towardSun = max(facing, 0.0);

    float2 plane = direction.xz / (max(direction.y, 0.0) + 0.09);
    float along = dot(plane, sunFlat);
    float across = dot(plane, float2(-sunFlat.y, sunFlat.x));
    float bars = ivMxFractalNoise(float3(along * 0.56, across * 0.17, 3.7), 4, 2.0, 0.5) * 0.5 + 0.5;
    float wisps = ivMxFractalNoise(float3(along * 1.7, across * 0.7, 11.3), 3, 2.0, 0.5) * 0.5 + 0.5;
    float density = bars * 0.74 + wisps * 0.26;
    float lift = smoothstep(0.012, 0.1, direction.y) * mix(1.0, 0.7, smoothstep(0.5, 0.95, direction.y));
    float cover = smoothstep(0.47, 0.7, density) * lift;
    float core = smoothstep(0.66, 0.9, density);

    float side = smoothstep(-0.55, 0.6, facing);
    float3 lit = mix(mix(ivHexColor(HB_MAUVE), ivHexColor(HB_ROSE), side), ivHexColor(HB_GOLD) * 1.5, pow(towardSun, 5.0));
    float3 cloud = lit * mix(1.0, 0.5, core) + ivHexColor(HB_GOLD) * pow(towardSun, 14.0) * (1.0 - core) * 0.9;
    float band = (1.0 - smoothstep(0.0, 0.26, direction.y)) * mix(0.1, 0.34, side);
    float3 air = mix(sky, sky + ivHexColor(HB_ROSE) * 0.5, band);
    return float4(mix(air, cloud, cover * 0.88), 1.0);
}

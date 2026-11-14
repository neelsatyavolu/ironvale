// Port of src/fx/rain.ts buildMaterial (commit a487033): 7000 streaks wrapped in a box around the
// camera, positioned from the effect clock, hidden under the roof mask.
#include "FXCommon.h"

struct RainVaryings {
    float4 position [[position]];
    float2 uv;
    float3 light;
    float strength;
    float3 world;
    float viewZ;
};

vertex RainVaryings fxRainVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                 constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                                 constant FXUniforms &fx [[buffer(FX_BUFFER_UNIFORMS)]],
                                 device const float4 *seeds [[buffer(FX_BUFFER_INSTANCES)]],
                                 texture2d<float> mask [[texture(FX_TEXTURE_MASK)]]) {
    constexpr sampler nearest(filter::nearest, address::repeat);
    float4 seed = seeds[iid];
    float2 uv = fxQuadUV(vid);
    const float3 box = float3(26, 16, 26);
    float3 fall = fx.b.xyz;
    float3 centre = fx.a.xyz;
    float indoors = fx.a.w;
    float3 velocity = fall * (seed.w * 0.4 + 0.8);
    float3 travelled = seed.xyz * box + velocity * fx.clock.x;
    float3 drop = centre + (fract((travelled - centre) / box + 0.5) - 0.5) * box;

    float3 heading = normalize(fall);
    float3 toEye = frame.cameraPosition - drop;
    float distance = length(toEye);
    float3 side = normalize(cross(heading, toEye) + float3(1e-5, 0, 0));
    float roof = mask.sample(nearest, drop.xz / fx.c.x, level(0)).r;
    float open = step(roof, drop.y);
    float flat = length(toEye.xz);
    float nearFade = smoothstep(0.5, 1.8, distance);
    float indoorFade = mix(1.0, smoothstep(1.4, 2.8, flat), indoors);
    float fromCentre = length(drop.xz - centre.xz) / box.x;
    float edgeFade = 1.0 - smoothstep(0.36, 0.5, fromCentre);
    float visible = open * nearFade * indoorFade * edgeFade;
    float streak = seed.w * 0.35 + 0.38;
    float width = max(0.0032, distance * 0.0021) * step(0.001, visible);
    float3 world = drop + heading * ((uv.y - 0.5) * streak) + side * ((uv.x - 0.5) * width);

    // Drops scatter sunlight forward, so rain is brightest looking toward the sun.
    float towardSun = max(dot(-normalize(toEye), fx.sunDirection.xyz), 0.0);
    RainVaryings out;
    out.position = frame.viewProjection * float4(world, 1.0);
    out.uv = uv;
    out.light = fx.ambientLight.rgb * 1.25 + fx.sunLight.rgb * (pow(towardSun, 6.0) * 3.0 + 0.35);
    out.strength = visible * 0.3 * (seed.x * 0.5 + 0.6);
    out.world = world;
    out.viewZ = fxViewZ(frame, world);
    return out;
}

fragment FXOut fxRainFragment(RainVaryings in [[stage_in]], constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]]) {
    float across = abs((in.uv.x - 0.5) * 2.0);
    float profile = (1.0 - across * across) * sin(in.uv.y * M_PI_F);
    float a = in.strength * profile;
    if (a < 0.01) discard_fragment();
    FXOut out;
    out.color = float4(fxFog(frame, in.light, in.world, in.viewZ), a);
    return out;
}

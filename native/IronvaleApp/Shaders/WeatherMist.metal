// Port of src/fx/mist.ts (commit a487033): FogBanks (ground mist sprites drifting with the wind)
// and Motes (dust glinting in the sun), both wrapped around the camera or player.
#include "FXCommon.h"

struct MistVaryings {
    float4 position [[position]];
    float2 sheetUV;
    float3 light;
    float strength;
    float3 world;
    float viewZ;
};

vertex MistVaryings fxBankVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                 constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                                 constant FXUniforms &fx [[buffer(FX_BUFFER_UNIFORMS)]],
                                 device const float4 *seeds [[buffer(FX_BUFFER_INSTANCES)]]) {
    const float area = 76.0;
    float4 seed = seeds[iid];
    float2 uv = fxQuadUV(vid);
    float3 centre = fx.a.xyz;
    float indoors = fx.a.w;
    float time = fx.clock.x;
    float2 drift = fx.wind.xz * time * (seed.w * 0.8 + 0.6);
    float2 raw = seed.xz * area + drift;
    float2 flat = centre.xz + (fract((raw - centre.xz) / area + 0.5) - 0.5) * area;
    float width = seed.y * 7.0 + 8.0;
    float height = width * 0.34;
    float3 base = float3(flat.x, centre.y + height * 0.42 + seed.w * 0.7, flat.y);
    float2 corner = uv - 0.5;
    float3 toEye = frame.cameraPosition - base;
    float distance = length(toEye);
    float nearFade = smoothstep(3.5, 10.0, distance);
    float fromCentre = length(flat - centre.xz) / area;
    float edgeFade = 1.0 - smoothstep(0.34, 0.49, fromCentre);
    float breathing = sin(time * 0.17 + seed.x * 6.28) * 0.25 + 0.75;
    float visible = nearFade * edgeFade * breathing * mix(1.0, 0.35, indoors);
    float shown = step(0.001, visible);
    float3 world = base + fxCameraRight(frame) * (corner.x * width * shown) + float3(0, 1, 0) * (corner.y * height * shown);
    float towardSun = max(dot(-normalize(toEye), fx.sunDirection.xyz), 0.0);
    MistVaryings out;
    out.position = frame.viewProjection * float4(world, 1.0);
    out.sheetUV = fxSheetUV(0.0, 4.0, uv);  // SPRITE.puffA
    out.light = fx.ambientLight.rgb * 1.1 + fx.sunLight.rgb * (pow(towardSun, 4.0) * 1.5 + 0.3);
    out.strength = visible * 0.2 * (seed.y * 0.5 + 0.6);
    out.world = world;
    out.viewZ = fxViewZ(frame, world);
    return out;
}

fragment FXOut fxBankFragment(MistVaryings in [[stage_in]], constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                              texture2d<float> atlas [[texture(FX_TEXTURE_ATLAS)]]) {
    constexpr sampler s(filter::linear, mip_filter::linear, address::clamp_to_edge);
    float4 sample = atlas.sample(s, in.sheetUV);
    float a = in.strength * sample.a;
    if (a < 0.003) discard_fragment();
    FXOut out;
    out.color = float4(fxFog(frame, in.light * sample.rgb, in.world, in.viewZ), a);
    return out;
}

vertex MistVaryings fxMoteVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                 constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                                 constant FXUniforms &fx [[buffer(FX_BUFFER_UNIFORMS)]],
                                 device const float4 *seeds [[buffer(FX_BUFFER_INSTANCES)]],
                                 texture2d<float> mask [[texture(FX_TEXTURE_MASK)]]) {
    constexpr sampler nearest(filter::nearest, address::repeat);
    const float3 box = float3(15, 7, 15);
    float4 seed = seeds[iid];
    float2 uv = fxQuadUV(vid);
    float time = fx.clock.x;
    float phase = seed.w * 6.28;
    float3 wander = float3(sin(time * 0.31 + phase), sin(time * 0.23 + phase * 1.7) * 0.6, sin(time * 0.27 + phase * 2.3)) * 0.3;
    float3 raw = seed.xyz * box + fx.wind.xyz * time * 0.3 + wander;
    float3 centre = fx.a.xyz;
    float3 mote = centre + (fract((raw - centre) / box + 0.5) - 0.5) * box;
    float3 toEye = frame.cameraPosition - mote;
    float distance = length(toEye);
    float size = max(seed.x * 0.007 + 0.006, distance * 0.0017);
    float2 corner = uv - 0.5;
    float3 world = mote + (fxCameraRight(frame) * corner.x + fxCameraUp(frame) * corner.y) * size;

    float roof = mask.sample(nearest, mote.xz / fx.c.x, level(0)).r;
    float sunlit = mix(0.12, 1.0, step(roof, mote.y));
    float nearFade = smoothstep(0.35, 1.1, distance);
    float fromCentre = length((mote - centre) / box);
    float edgeFade = 1.0 - smoothstep(0.36, 0.5, fromCentre);
    float twinkle = pow(sin(time * (seed.y * 1.6 + 0.7) + phase) * 0.5 + 0.5, 3.0) * 0.75 + 0.25;
    float towardSun = max(dot(-normalize(toEye), fx.sunDirection.xyz), 0.0);
    float3 glint = fx.sunLight.rgb * (pow(towardSun, 5.0) * 5.0 + 0.5) * sunlit + fx.ambientLight.rgb * 0.2;
    MistVaryings out;
    out.position = frame.viewProjection * float4(world, 1.0);
    out.sheetUV = fxSheetUV(11.0, 4.0, uv);  // SPRITE.glow
    out.light = glint * twinkle * nearFade * edgeFade;
    out.strength = 1.0;
    out.world = world;
    out.viewZ = 0.0;
    return out;
}

fragment FXOut fxMoteFragment(MistVaryings in [[stage_in]], texture2d<float> atlas [[texture(FX_TEXTURE_ATLAS)]]) {
    constexpr sampler s(filter::linear, mip_filter::linear, address::clamp_to_edge);
    float a = atlas.sample(s, in.sheetUV).a;
    if (a < 0.02) discard_fragment();
    FXOut out;
    out.color = float4(in.light, a);
    return out;
}

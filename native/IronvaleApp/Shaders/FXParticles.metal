// Port of src/fx/particles.ts buildMaterial (commit a487033): the lit and additive particle pools,
// simulated in closed form from each particle's birth record (20 floats, ParticlePool.swift).
#include "FXCommon.h"

struct ParticleVaryings {
    float4 position [[position]];
    float2 sheetUV;
    float4 tint;
    float3 world;
    float viewZ;
};

vertex ParticleVaryings fxParticleVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                         constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                                         constant FXUniforms &fx [[buffer(FX_BUFFER_UNIFORMS)]],
                                         device const float4 *data [[buffer(FX_BUFFER_INSTANCES)]]) {
    float4 aOrigin = data[iid * 5 + 0], aVelocity = data[iid * 5 + 1], aShape = data[iid * 5 + 2];
    float4 aColor = data[iid * 5 + 3], aPhysics = data[iid * 5 + 4];
    float2 uv = fxQuadUV(vid);
    float age = fx.clock.x - aOrigin.w;
    float life = aVelocity.w;
    float progress = clamp(age / max(life, 1e-4), 0.0, 1.0);
    float alive = (age >= 0.0 && age < life) ? 1.0 : 0.0;

    // x(t) = x0 + v0 (1 - e^-kt)/k + (wind + g/k) (t - (1 - e^-kt)/k)
    float drag = aPhysics.y;
    float decay = exp(-drag * age);
    float reach = (1.0 - decay) / drag;
    float3 terminal = float3(0.0, -aPhysics.x, 0.0) / drag + fx.wind.xyz;
    float3 centre = aOrigin.xyz + aVelocity.xyz * reach + terminal * (age - reach);
    float3 velocity = aVelocity.xyz * decay + terminal * (1.0 - decay);

    float growth = 1.0 - (1.0 - progress) * (1.0 - progress);
    float size = mix(aShape.x, aShape.y, growth) * alive;
    float2 corner = uv - 0.5;
    float angle = aShape.z + aShape.w * age;
    float c = cos(angle), s = sin(angle);
    float3 facing = (fxCameraRight(frame) * (corner.x * c - corner.y * s) + fxCameraUp(frame) * (corner.x * s + corner.y * c)) * size;

    float speed = length(velocity);
    float3 axis = velocity / max(speed, 1e-4);
    float3 side = normalize(cross(axis, frame.cameraPosition - centre) + float3(1e-5, 0, 0));
    float streak = max(size, speed * aPhysics.w * alive);
    float3 stretched = axis * ((corner.y - 0.5) * streak) + side * (corner.x * size);
    float3 world = centre + (aPhysics.w > 0.0 ? stretched : facing);

    float fade = smoothstep(0.0, 0.035, age) * pow(1.0 - progress, fx.clock.y);
    float nearFade = smoothstep(0.12, 0.5, length(frame.cameraPosition - centre));
    ParticleVaryings out;
    out.position = frame.viewProjection * float4(world, 1.0);
    out.sheetUV = fxSheetUV(aPhysics.z, 4.0, uv);
    out.tint = float4(aColor.rgb, aColor.a * fade * nearFade);
    out.world = world;
    out.viewZ = fxViewZ(frame, world);
    return out;
}

fragment FXOut fxParticleFragment(ParticleVaryings in [[stage_in]],
                                  constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                                  constant FXUniforms &fx [[buffer(FX_BUFFER_UNIFORMS)]],
                                  texture2d<float> atlas [[texture(FX_TEXTURE_ATLAS)]]) {
    constexpr sampler s(filter::linear, mip_filter::linear, address::clamp_to_edge);
    float4 sample = atlas.sample(s, in.sheetUV);
    float4 color = float4(in.tint.rgb * sample.rgb, in.tint.a * sample.a);
    if (color.a < fx.clock.z) discard_fragment();
    if (fx.clock.w == 0.0) color.rgb = fxFog(frame, color.rgb, in.world, in.viewZ);
    FXOut out;
    out.color = color;
    return out;
}

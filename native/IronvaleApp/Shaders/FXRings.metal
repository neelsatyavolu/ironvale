// Port of src/fx/rings.ts buildMaterial (commit a487033): rings spreading flat on a surface.
#include "FXCommon.h"

struct RingVaryings {
    float4 position [[position]];
    float2 uv;
    float strength;
    float3 world;
    float viewZ;
};

vertex RingVaryings fxRingVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                 constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                                 constant FXUniforms &fx [[buffer(FX_BUFFER_UNIFORMS)]],
                                 device const float4 *data [[buffer(FX_BUFFER_INSTANCES)]]) {
    float4 aCentre = data[iid * 3 + 0], aNormal = data[iid * 3 + 1], aShape = data[iid * 3 + 2];
    float2 uv = fxQuadUV(vid);
    float age = fx.clock.x - aCentre.w;
    float life = aNormal.w;
    float progress = clamp(age / max(life, 1e-4), 0.0, 1.0);
    float alive = (age >= 0.0 && age < life) ? 1.0 : 0.0;
    float3 normal = aNormal.xyz;
    float3 helper = abs(normal.y) < 0.99 ? float3(0, 1, 0) : float3(1, 0, 0);
    float3 tangent = normalize(cross(helper, normal));
    float3 bitangent = cross(normal, tangent);
    float size = mix(aShape.x, aShape.y, 1.0 - (1.0 - progress) * (1.0 - progress)) * alive;
    float2 corner = uv - 0.5;
    float3 world = aCentre.xyz + normal * 0.012 + (tangent * corner.x + bitangent * corner.y) * size;
    RingVaryings out;
    out.position = frame.viewProjection * float4(world, 1.0);
    out.uv = uv;
    out.strength = aShape.z * pow(1.0 - progress, 1.5);
    out.world = world;
    out.viewZ = fxViewZ(frame, world);
    return out;
}

fragment FXOut fxRingFragment(RingVaryings in [[stage_in]],
                              constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                              constant FXUniforms &fx [[buffer(FX_BUFFER_UNIFORMS)]]) {
    float radius = length(in.uv - 0.5) * 2.0;
    float band = smoothstep(0.6, 0.84, radius) * (1.0 - smoothstep(0.9, 1.0, radius));
    // Disturbed water shows the sky and a little sun.
    float3 sheen = fx.ambientLight.rgb * 1.5 + fx.sunLight.rgb * 0.5;
    float a = band * in.strength;
    if (a < 0.004) discard_fragment();
    FXOut out;
    out.color = float4(fxFog(frame, sheen, in.world, in.viewZ), a);
    return out;
}

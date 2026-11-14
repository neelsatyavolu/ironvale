// Port of src/fx/casings.ts buildMaterial (commit a487033): instanced cylinders, brass, or a red
// plastic hull on a brass head for shotgun shells; and src/fx/grenade.ts's grenade bodies, which
// share the lit opaque path (MeshStandardMaterial, colour 0x343d27, roughness 0.62, metalness 0.35).
#include "FXCommon.h"

struct SolidVertex {
    packed_float3 position;
    packed_float3 normal;
};

struct SolidVaryings {
    float4 position [[position]];
    float3 world;
    float3 normal;
    float plastic;
    float viewZ;
};

vertex SolidVaryings fxCasingVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                    constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                                    device const SolidVertex *geometry [[buffer(FX_BUFFER_GEOMETRY)]],
                                    device const float4x4 *matrices [[buffer(FX_BUFFER_INSTANCES)]],
                                    device const float *hull [[buffer(FX_BUFFER_EXTRA)]]) {
    SolidVertex v = geometry[vid];
    float4x4 m = matrices[iid];
    float4 world = m * float4(float3(v.position), 1.0);
    float3x3 linear = float3x3(m[0].xyz, m[1].xyz, m[2].xyz);
    SolidVaryings out;
    out.position = frame.viewProjection * world;
    out.world = world.xyz;
    // Scale is uniform across x and z and only stretches y, so the inverse-transpose is the per-axis inverse scale.
    float3 inverseScale = 1.0 / max(float3(length(m[0].xyz), length(m[1].xyz), length(m[2].xyz)), 1e-8);
    out.normal = linear * (float3(v.normal) * inverseScale * inverseScale);
    out.plastic = hull[iid] * step(-0.3, v.position[1]);
    out.viewZ = fxViewZ(frame, world.xyz);
    return out;
}

vertex float4 fxSolidShadowVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                  constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                                  device const SolidVertex *geometry [[buffer(FX_BUFFER_GEOMETRY)]],
                                  device const float4x4 *matrices [[buffer(FX_BUFFER_INSTANCES)]]) {
    return frame.shadowViewProjection * (matrices[iid] * float4(float3(geometry[vid].position), 1.0));
}

fragment FXOpaqueOut fxCasingFragment(SolidVaryings in [[stage_in]],
                                      constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                                      constant float4 &material [[buffer(FX_BUFFER_UNIFORMS)]],
                                      device const IVLight *lights [[buffer(IV_BUFFER_LIGHTS)]],
                                      texture2d<float> environment [[texture(IV_TEXTURE_ENVIRONMENT)]],
                                      depth2d<float> shadowMap [[texture(IV_TEXTURE_SHADOW)]]) {
    // material: rgb base colour and w < 0 for casings (colour from the hull), else w = roughness.
    float3 n = normalize(in.normal);
    float3 base; float metalness; float roughness;
    if (material.w < 0.0) {
        base = mix(float3(0.83, 0.61, 0.27), float3(0.5, 0.045, 0.035), in.plastic);
        metalness = 1.0 - in.plastic;
        roughness = mix(0.32, 0.56, in.plastic);
    } else {
        base = material.rgb;
        metalness = 0.35;
        roughness = material.w;
    }
    float3 color = fxStandard(frame, lights, environment, shadowMap, base, metalness, roughness, n, n, in.world, true);
    FXOpaqueOut out;
    out.color = float4(fxFog(frame, color, in.world, in.viewZ), 1.0);
    out.normal = float4(normalize((frame.view * float4(n, 0.0)).xyz) * 0.5 + 0.5, 1.0);
    out.metalRough = float2(metalness, roughness);
    return out;
}

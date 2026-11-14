// Port of src/fx/grenade-arc.ts (commit a487033): the aim-preview ribbon (two vertices per path
// point, built on the CPU facing the eye) and the end marker, RingGeometry(0.8, 1, 48) turned to
// the camera; both MeshBasicMaterial, unlit, without fog.
#include "FXCommon.h"

struct ArcVaryings {
    float4 position [[position]];
};

vertex ArcVaryings fxArcRibbonVertex(uint vid [[vertex_id]],
                                     constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                                     device const float *positions [[buffer(FX_BUFFER_INSTANCES)]]) {
    const uint pattern[6] = { 0, 1, 2, 1, 3, 2 };
    uint index = (vid / 6) * 2 + pattern[vid % 6];
    float3 world = float3(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]);
    ArcVaryings out;
    out.position = frame.viewProjection * float4(world, 1.0);
    return out;
}

vertex ArcVaryings fxArcMarkerVertex(uint vid [[vertex_id]],
                                     constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                                     constant FXUniforms &fx [[buffer(FX_BUFFER_UNIFORMS)]]) {
    // Segment s of the annulus as two triangles between the inner (0.8) and outer (1) radius.
    const uint2 pattern[6] = { uint2(0, 0), uint2(0, 1), uint2(1, 0), uint2(0, 1), uint2(1, 1), uint2(1, 0) };
    uint s = vid / 6;
    uint2 p = pattern[vid % 6];
    float angle = float(s + p.x) / 48.0 * 2.0 * M_PI_F;
    float radius = p.y == 0 ? 0.8 : 1.0;
    float2 local = float2(cos(angle), sin(angle)) * radius * fx.a.w;
    float3 world = fx.a.xyz + fxCameraRight(frame) * local.x + fxCameraUp(frame) * local.y;
    ArcVaryings out;
    out.position = frame.viewProjection * float4(world, 1.0);
    return out;
}

fragment FXOut fxArcFragment(ArcVaryings in [[stage_in]], constant FXUniforms &fx [[buffer(FX_BUFFER_UNIFORMS)]]) {
    FXOut out;
    out.color = fx.b;  // linear colour and opacity
    return out;
}

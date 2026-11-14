// Port of src/fx/tracers.ts buildMaterial (commit a487033): streaks flown along their path.
#include "FXCommon.h"

struct TracerVaryings {
    float4 position [[position]];
    float2 uv;
    float brightness;
};

vertex TracerVaryings fxTracerVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                     constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                                     constant FXUniforms &fx [[buffer(FX_BUFFER_UNIFORMS)]],
                                     device const float4 *data [[buffer(FX_BUFFER_INSTANCES)]]) {
    float4 aStart = data[iid * 3 + 0], aPath = data[iid * 3 + 1], aShape = data[iid * 3 + 2];
    float2 uv = fxQuadUV(vid);
    float age = fx.clock.x - aStart.w;
    float travelled = aShape.x * age;
    float head = min(travelled, aPath.w);
    float tail = clamp(travelled - aShape.y, 0.0, aPath.w);
    float alive = (age >= 0.0 && tail < aPath.w) ? 1.0 : 0.0;
    float along = mix(tail, head, uv.y);
    float3 point = aStart.xyz + aPath.xyz * along;
    float3 toEye = frame.cameraPosition - point;
    float3 side = normalize(cross(aPath.xyz, toEye) + float3(1e-5, 0, 0));
    float width = max(aShape.z, length(toEye) * 0.0017) * alive;
    float3 world = point + side * ((uv.x - 0.5) * width);
    TracerVaryings out;
    out.position = frame.viewProjection * float4(world, 1.0);
    out.uv = uv;
    out.brightness = aShape.w;
    return out;
}

fragment FXOut fxTracerFragment(TracerVaryings in [[stage_in]]) {
    // Bright core with a soft skirt across the width; the tail thins out behind the head.
    float across = abs((in.uv.x - 0.5) * 2.0);
    float core = exp(across * across * -14.0) + exp(across * across * -3.0) * 0.22;
    float lengthwise = smoothstep(0.0, 0.75, in.uv.y) * ((1.0 - smoothstep(0.94, 1.0, in.uv.y)) * 0.5 + 0.5);
    float edge = 1.0 - smoothstep(0.82, 1.0, across);
    float a = core * lengthwise * edge;
    if (a < 0.004) discard_fragment();
    FXOut out;
    out.color = float4(float3(20, 11, 4) * in.brightness, a);
    return out;
}

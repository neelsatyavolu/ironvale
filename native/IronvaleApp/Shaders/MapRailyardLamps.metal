// Lamp pools: lampGlow() of src/maps/railyard/lamps.ts at commit cbe0add. The glow list
// (positions, colours, strengths, reach, down / facing) comes from scene.json programParams.
// lampLit() multiplies the result by diffuseColor and uses it as emission (ivMapFragment).
#ifndef IRONVALE_MAP_RAILYARD_LAMPS
#define IRONVALE_MAP_RAILYARD_LAMPS
#include "MapSurface.h"

IV_SHADER_FN float3 ivRailyardLampGlow(float3 p, float3 n, constant float4 *params) {
    uint count = min(uint(params[IV_RY_SUN_IN_SKY].w), uint(IV_RY_MAX_GLOWS));
    float3 total = 0.0;
    for (uint i = 0; i < count; i++) {
        float4 a = params[IV_RY_GLOWS + i * 3];      // at, strength
        float4 b = params[IV_RY_GLOWS + i * 3 + 1];  // linear colour, reach
        float4 c = params[IV_RY_GLOWS + i * 3 + 2];  // down, facing x, facing z, has facing
        float3 toLamp = a.xyz - p;
        float distance = max(length(toLamp), 0.05);
        // Past `reach` the fade below is exactly 0; skipping it changes nothing.
        if (distance >= b.w) continue;
        float lambert = max(dot(n, toLamp / distance), 0.0) * 0.85 + 0.15;
        float amount = lambert * (a.w / (distance * distance + 4.0)) * (1.0 - smoothstep(b.w * 0.35, b.w, distance));
        if (c.x > 0.5) amount *= smoothstep(0.35, 0.8, toLamp.y / distance);
        if (c.w > 0.5) {
            float inFront = (p.x - a.x) * c.y + (p.z - a.z) * c.z;
            amount *= smoothstep(-0.62, -0.52, inFront);
        }
        total += b.xyz * amount;
    }
    return total;
}
#endif  // IRONVALE_MAP_RAILYARD_LAMPS

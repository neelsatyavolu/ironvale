// Headworks lamp pools: lampGlow() of src/maps/headworks/lamps.ts at commit 3ec2f09. The lamp
// list (WALL_LAMPS: glow position, high or low, colour, wall normal) comes from scene.json
// programRows. lampLit() multiplies the result by diffuseColor and uses it as emission.
#ifndef IRONVALE_MAP_HEADWORKS_LAMPS
#define IRONVALE_MAP_HEADWORKS_LAMPS
#include "MapSurface.h"

IV_SHADER_FN float3 ivHeadworksLampGlow(float3 p, float3 n, constant float4 *rows) {
    uint houses = uint(rows[IV_HW_COUNTS].x);
    uint lamps = uint(rows[IV_HW_COUNTS].y);
    uint first = IV_HW_HOUSES + houses * 2;
    float3 total = 0.0;
    for (uint i = 0; i < lamps; i++) {
        float4 a = rows[first + i * 3];      // glow position, high
        float3 tint = rows[first + i * 3 + 1].xyz;
        float2 facing = rows[first + i * 3 + 2].xy;
        bool high = a.w > 0.5;
        float reach = high ? 9.0 : 6.5;
        float3 toLamp = a.xyz - p;
        float distance = max(length(toLamp), 0.05);
        // Past `reach` the fade below is exactly 0.
        if (distance >= reach) continue;
        float lambert = max(dot(n, toLamp / distance), 0.0) * 0.85 + 0.15;
        float inFront = (p.x - a.x) * facing.x + (p.z - a.z) * facing.y;
        float amount = lambert * ((high ? 34.0 : 20.0) / (distance * distance + 3.0))
            * (1.0 - smoothstep(reach * 0.35, reach, distance))
            * smoothstep(-0.6, -0.5, inFront)
            * smoothstep(-0.5, 0.25, toLamp.y);
        total += tint * amount;
    }
    return total;
}
#endif  // IRONVALE_MAP_HEADWORKS_LAMPS

// Rain-soaked paving: soak() and rainRings() of src/maps/railyard/ground.ts at commit cbe0add.
// The normal stage blends the paving's normal map toward flat water rings in the puddles; the
// colour stage darkens the paving, its puddle margins and the puddles, and sets their gloss.
#ifndef IRONVALE_MAP_RAILYARD_GROUND
#define IRONVALE_MAP_RAILYARD_GROUND
#include "MapSurface.h"
#include "Noise.metal"

IV_SHADER_FN float2 rainRings(float3 p, float time) {
    float2 grid = p.xz * 2.4;
    float2 id = floor(grid);
    float seed = ivTslHash(id.x + id.y * 57.3 + 13.0);
    float2 centre = float2(ivTslHash(seed * 91.7), ivTslHash(seed * 37.1)) * 0.5 + 0.25;
    float2 offset = fract(grid) - centre;
    float distance = length(offset);
    float age = fract(time * 1.15 + seed * 7.0);
    float front = abs(distance - age * 0.42);
    float ring = (1.0 - smoothstep(0.0, 0.035, front)) * (1.0 - age);
    return offset / (distance + 0.001) * (sin(front * 180.0) * ring * 0.22);
}

IV_SHADER_FN void ivRailyardSoak(thread IVSurface &s, IVSoak o, bool normalStage) {
    float2 p = s.p.xz;
    float broad = ivMxNoise(p / o.puddleScale) * 0.5 + 0.5;
    float mid = ivMxNoise(p / (o.puddleScale * 0.31) + float2(17.3, 5.1)) * 0.5 + 0.5;
    float hollow = broad * 0.66 + mid * 0.34;
    float level = 1.0 - o.cover * 0.62 - 0.3;
    float up = smoothstep(0.85, 0.98, s.n.y);
    float puddle = smoothstep(level, level + 0.022, hollow) * up;
    if (normalStage) {
        float2 rings = rainRings(s.p, s.time);
        float3 water = normalize(float3(rings.x, 1.0, rings.y));
        s.normal = normalize(mix(s.programNormal, water, puddle));
        return;
    }
    float margin = smoothstep(level - 0.13, level, hollow) * up;
    s.color = s.materialColor * o.tone * mix(1.0, 0.56, o.damp) * mix(1.0, 0.7, margin) * mix(1.0, 0.5, puddle);
    float wet = s.materialRoughness * mix(1.0, 0.62, o.damp) * mix(1.0, 0.6, margin);
    s.roughness = mix(wet, 0.02, puddle);
}
#endif  // IRONVALE_MAP_RAILYARD_GROUND

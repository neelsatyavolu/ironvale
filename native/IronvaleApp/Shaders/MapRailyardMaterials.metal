// Railyard level materials built in src/maps/railyard/materials.ts at commit cbe0add:
// asphalt and quay (through soak, MapRailyardGround.metal), the shed floor, the concrete wall,
// and tintable() for the profiled cladding. slabJoints() and slabTone() are ported here.
#ifndef IRONVALE_MAP_RAILYARD_MATERIALS
#define IRONVALE_MAP_RAILYARD_MATERIALS
#include "MapSurface.h"
#include "Noise.metal"
#include "MapRailyardGround.metal"

/// 1 on the joints of a square grid of slabs `spacing` metres across, 0 elsewhere.
IV_SHADER_FN float toJoint(float c, float spacing) { return (0.5 - abs(fract(c / spacing) - 0.5)) * spacing; }

IV_SHADER_FN float slabJoints(float3 p, float spacing, float width) {
    float nearest = min(toJoint(p.x, spacing), toJoint(p.z, spacing));
    return 1.0 - smoothstep(width * 0.3, width, nearest);
}

/// Tone that differs from slab to slab.
IV_SHADER_FN float slabTone(float3 p, float spacing) {
    float cell = floor(p.x / spacing) + 200.0 + (floor(p.z / spacing) + 200.0) * 57.0;
    return mix(0.86, 1.06, ivTslHash(cell));
}

IV_SHADER_FN void ivRailyardAsphalt(thread IVSurface &s, bool normalStage) {
    float drift = mix(0.62, 1.12, ivMxNoise(s.p.xz / 9.0) * 0.5 + 0.5);
    ivRailyardSoak(s, IVSoak{0.8, 5.5, 0.3, drift}, normalStage);
}

IV_SHADER_FN void ivRailyardQuay(thread IVSurface &s, bool normalStage) {
    float tone = slabTone(s.p, 6.0) * mix(1.0, 0.3, slabJoints(s.p, 6.0, 0.035));
    ivRailyardSoak(s, IVSoak{0.65, 3.6, 0.26, tone}, normalStage);
}

IV_SHADER_FN void ivRailyardFloor(thread IVSurface &s) {
    float damp = smoothstep(0.42, 0.7, ivMxNoise(s.p.xz / 3.4) * 0.5 + 0.5);
    float wornIn = mix(0.7, 1.05, ivWorldNoise(s.p, 0.23));
    s.color = s.materialColor * wornIn * slabTone(s.p, 5.5) * mix(1.0, 0.66, damp) * mix(1.0, 0.3, slabJoints(s.p, 5.5, 0.025));
    s.roughness = s.materialRoughness * mix(1.0, 0.22, damp);
}

IV_SHADER_FN void ivRailyardWall(thread IVSurface &s) {
    float3 p = s.p;
    float run = ivMxNoise(p * float3(1.5, 0.14, 1.5)) * 0.5 + 0.5;
    float fineRun = ivMxNoise(p * float3(6.0, 0.5, 6.0)) * 0.5 + 0.5;
    float streaks = smoothstep(0.34, 0.7, run * 0.7 + fineRun * 0.3 + smoothstep(1.2, 3.4, p.y) * 0.12);
    float foot = 1.0 - smoothstep(0.0, 0.9, p.y);
    float upright = 1.0 - abs(s.n.y);
    float along = mix(p.x, p.z, step(0.5, abs(s.n.x)));
    float toJoint = min((0.5 - abs(fract(along / 2.4) - 0.5)) * 2.4, abs(p.y - 1.75));
    float joints = (1.0 - smoothstep(0.006, 0.02, toJoint)) * upright;
    float3 scan = s.materialColor;
    float3 greyed = mix(float3((scan.r + scan.g + scan.b) / 3.0), scan, 0.25);
    s.color = greyed * mix(1.05, 0.42, streaks) * mix(1.0, 0.55, foot) * mix(1.0, 0.45, joints);
    s.roughness = s.materialRoughness * mix(1.0, 0.5, streaks);
}

/// tintable(maps, channel, gain, roughness, normalScale, height, wear) for the cladding:
/// channel 'r', gain 4.6, height positionWorld.y - 0.9, wear 0.5.
IV_SHADER_FN void ivRailyardCladding(thread IVSurface &s) {
    const float gain = 4.6, wear = 0.5;
    float height = s.p.y - 0.9;
    float value = s.programTexel.r * gain;
    float blotch = mix(0.62, 1.08, ivWorldNoise(s.p, 0.45));
    float fine = ivWorldNoise(s.p, 9.0);
    float streak = ivMxNoise(s.p * float3(2.6, 0.2, 2.6)) * 0.5 + 0.5;
    float low = 1.0 - smoothstep(0.0, 1.1, height);
    float grime = smoothstep(0.34, 0.82, streak * 0.6 + fine * 0.25 + low * 0.32) * wear;
    float rust = smoothstep(0.6, 0.76, ivWorldNoise(s.p, 1.7) * 0.5 + fine * 0.3 + low * 0.3) * wear;
    float3 paint = float3(value * blotch) * mix(1.0, 0.4, grime);
    s.color = mix(paint, float3(1.0, 0.44, 0.2) * value * 0.5, rust * 0.9);
    s.roughness = s.materialRoughness * mix(0.6, 1.4, max(grime, rust));
}
#endif  // IRONVALE_MAP_RAILYARD_MATERIALS

// Procedural Railyard surfaces of src/maps/railyard/surfaces.ts at commit cbe0add: painted
// steel, hazard stripes, timber, road paint, oil stains, chain-link, sea water, cardboard and
// stretch film, plus the plain `matte` colour node from materials.ts, which uses worldNoise.
#ifndef IRONVALE_MAP_RAILYARD_SURFACES
#define IRONVALE_MAP_RAILYARD_SURFACES
#include "MapSurface.h"
#include "Noise.metal"

IV_SHADER_FN void ivRailyardSteel(thread IVSurface &s) {
    float3 p = s.p;
    float upright = 1.0 - smoothstep(0.5, 0.8, abs(s.n.y));
    float top = smoothstep(0.6, 0.9, s.n.y);
    float streak = ivMxNoise(p * float3(1.7, 0.22, 1.7)) * 0.5 + 0.5;
    float fine = ivWorldNoise(p, 7.0);
    float grime = smoothstep(0.35, 0.9, streak * 0.7 + fine * 0.3);
    float drip = smoothstep(0.62, 0.8, ivMxNoise(p * float3(6.5, 0.3, 6.5)) * 0.5 + 0.5) * upright;
    float foot = smoothstep(0.42, 0.9, (1.0 - smoothstep(0.02, 0.7, p.y)) * 0.75 + fine * 0.35);
    float bloom = ivWorldNoise(p, 2.3) * 0.6 + fine * 0.4;
    float rust = smoothstep(0.7, 0.84, bloom);
    float chips = smoothstep(0.74, 0.8, ivWorldNoise(p, 16.0)) * smoothstep(0.45, 0.7, streak);
    float pooled = smoothstep(0.45, 0.6, bloom) * top;
    float3 base = mix(float3(1.0), float3(0.5, 0.47, 0.44), grime) * mix(1.0, 0.55, drip) * mix(1.0, 0.5, foot) * mix(1.0, 0.7, pooled);
    s.color = mix(base, float3(0.38, 0.17, 0.08), max(rust * 0.8, chips * 0.9));
    s.roughness = mix(mix(0.3, 0.74, max(max(grime, rust), max(foot, chips))), 0.07, pooled);
}

IV_SHADER_FN void ivRailyardHazard(thread IVSurface &s) {
    float along = (s.p.x + s.p.y + s.p.z) / 0.36;
    float stripe = step(0.5, fract(along));
    float wear = mix(0.62, 1.0, ivWorldNoise(s.p, 3.1));
    s.color = mix(float3(0.86, 0.6, 0.05), float3(0.03), stripe) * wear;
}

IV_SHADER_FN void ivRailyardTimber(thread IVSurface &s) {
    float3 p = s.p;
    float grain = ivMxNoise(p * float3(22.0, 22.0, 2.4)) * 0.5 + 0.5;
    float patch = ivWorldNoise(p, 1.4);
    float upright = 1.0 - smoothstep(0.5, 0.7, abs(s.n.y));
    float gap = (1.0 - smoothstep(0.02, 0.06, abs(fract(p.y / 0.14) - 0.5))) * upright;
    float damp = smoothstep(0.45, 0.7, ivWorldNoise(p, 0.8));
    s.color = float3(0.52, 0.43, 0.32) * mix(0.6, 1.08, grain * 0.55 + patch * 0.45) * mix(1.0, 0.72, damp) * mix(1.0, 0.4, gap);
    s.roughness = mix(0.78, 0.5, damp);
}

IV_SHADER_FN void ivRailyardMatte(thread IVSurface &s) {
    s.color = float3(mix(0.8, 1.04, ivWorldNoise(s.p, 2.6) * 0.6 + ivWorldNoise(s.p, 19.0) * 0.4));
}

IV_SHADER_FN void ivRailyardRoadPaint(thread IVSurface &s) {
    float coarse = ivMxNoise(s.p.xz * 1.6) * 0.5 + 0.5;
    float fine = ivMxNoise(s.p.xz * 17.0) * 0.5 + 0.5;
    s.opacity = smoothstep(0.3, 0.36, coarse * 0.4 + fine * 0.6);
    s.color = float3(mix(0.55, 0.95, fine));
}

IV_SHADER_FN void ivRailyardOilStain(thread IVSurface &s) {
    float fromCentre = length(s.uv - 0.5) * 2.0;
    float shape = ivMxNoise(s.p.xz * 2.2) * 0.5 + 0.5;
    float speckle = ivMxNoise(s.p.xz * 14.0) * 0.5 + 0.5;
    float body = 1.0 - smoothstep(0.35, 1.0, fromCentre + (shape - 0.5) * 0.7);
    s.opacity = body * mix(0.45, 0.9, speckle) * 0.78;
}

IV_SHADER_FN void ivRailyardChainlink(thread IVSurface &s) {
    const float pitch = 0.06, wire = 0.09;
    float2 p = s.uv / pitch;
    float a = abs(fract(p.x + p.y) - 0.5);
    float b = abs(fract(p.x - p.y) - 0.5);
    float lines = max(1.0 - smoothstep(wire, wire + 0.06, a), 1.0 - smoothstep(wire, wire + 0.06, b));
    float footprint = max(s.uvDiagonalWidth.x, s.uvDiagonalWidth.y) / pitch;
    float veil = max(smoothstep(0.18, 0.4, footprint), smoothstep(5.0, 16.0, s.viewDepth));
    s.opacity = mix(lines, 0.3, veil);
}

IV_SHADER_FN void ivRailyardSeaWaterNormal(thread IVSurface &s) {
    float2 p = s.p.xz;
    float t = s.time;
    float3 swell = ivMxNoiseVec3(float3(p * 0.3 + float2(t * 0.1, t * 0.04), t * 0.16));
    float3 chop = ivMxNoiseVec3(float3(p * 1.7 + float2(t * -0.22, t * 0.17), t * 0.4));
    float3 ripple = ivMxNoiseVec3(float3(p * 6.5 + float2(t * 0.3, t * -0.2), t * 0.8));
    float near = 1.0 - smoothstep(20.0, 260.0, s.viewDepth);
    float2 tilt = (swell.xy * 0.05 + chop.xy * 0.035 + ripple.xy * 0.02) * (near * 0.75 + 0.25);
    s.normal = normalize(float3(tilt.x, 1.0, tilt.y));
}

IV_SHADER_FN void ivRailyardCardboard(thread IVSurface &s) {
    float2 st = s.uv;
    float fibre = mix(0.84, 1.06, ivWorldNoise(s.p, 23.0) * 0.5 + ivWorldNoise(s.p, 3.1) * 0.5);
    float2 fromEdge = abs(st - 0.5) * 2.0;
    float edge = smoothstep(0.9, 1.0, max(fromEdge.x, fromEdge.y));
    float tape = 1.0 - smoothstep(0.075, 0.085, abs(st.x - 0.5));
    float upright = 1.0 - smoothstep(0.5, 0.7, abs(s.n.y));
    float inLabel = step(0.1, st.x) * step(st.x, 0.36) * step(0.5, st.y) * step(st.y, 0.78) * upright;
    float bars = step(0.5, fract(st.x * 64.0)) * step(st.y, 0.62) * step(0.14, st.x) * step(st.x, 0.32);
    float3 board = float3(fibre) * mix(1.0, 0.7, edge);
    float3 taped = mix(board, float3(1.18, 1.1, 0.92), tape * 0.55);
    s.color = mix(taped, mix(float3(1.5, 1.52, 1.5), float3(0.2, 0.2, 0.22), bars), inLabel);
    s.roughness = mix(0.86, 0.34, max(tape, inLabel * 0.5));
}

IV_SHADER_FN void ivRailyardShrinkWrap(thread IVSurface &s) {
    float load = ivWorldNoise(s.p, 2.1);
    float3 contents = mix(float3(0.42, 0.34, 0.24), float3(0.62, 0.66, 0.68), smoothstep(0.42, 0.58, load));
    float bands = ivMxNoise(s.p * float3(0.6, 34.0, 0.6)) * 0.5 + 0.5;
    s.color = mix(contents, float3(0.74, 0.77, 0.78), mix(0.45, 0.75, bands));
    s.roughness = mix(0.16, 0.5, bands);
}
#endif  // IRONVALE_MAP_RAILYARD_SURFACES

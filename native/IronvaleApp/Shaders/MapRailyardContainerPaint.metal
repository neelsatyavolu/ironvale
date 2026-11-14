// Container paint for the instanced boxes: containerPaint() of
// src/maps/railyard/container-paint.ts at commit cbe0add (gain 3.1, livery per instance).
#ifndef IRONVALE_MAP_RAILYARD_CONTAINER_PAINT
#define IRONVALE_MAP_RAILYARD_CONTAINER_PAINT
#include "MapSurface.h"
#include "Noise.metal"

constant float RIB_PITCH = 0.278;
constant float SHEET_TOP = 2.48;
constant float3 RUST = float3(0.25, 0.11, 0.046);
constant float3 RUST_DARK = float3(0.09, 0.045, 0.026);
constant float3 ROAD_FILM = float3(0.105, 0.095, 0.085);

IV_SHADER_FN void ivRailyardContainerPaint(thread IVSurface &s) {
    const float gain = 3.1;
    float3 g = s.localP;
    float3 p = s.p;
    float value = s.programTexel.g * gain;

    float side = step(0.5, abs(s.localN.x));
    float roof = smoothstep(0.6, 0.9, s.localN.y);
    float upright = 1.0 - roof;
    float along = mix(g.x, g.z, side);
    float fromTop = SHEET_TOP - g.y;
    float drift = ivWorldNoise(p, 0.31);
    float fine = ivWorldNoise(p, 11.0);

    float rib = along / RIB_PITCH;
    float cell = floor(rib);
    float pick = fract(ivTslHash(cell + 71.0) + drift * 2.7);
    float runLength = mix(0.15, 1.4, pow(fract(pick * 7.3), 2.0));
    float acrossRib = abs(fract(rib) - 0.5) * 2.0;
    float run = step(0.7, pick) * (1.0 - smoothstep(0.0, runLength, fromTop)) * (1.0 - smoothstep(0.1, 0.55, acrossRib))
        * mix(0.35, 1.0, fine) * step(0.0, fromTop) * upright;

    float curtain = ivMxNoise(float3(p.x * 2.3, p.y * 0.16, p.z * 2.3)) * 0.5 + 0.5;
    float underRail = 1.0 - smoothstep(0.0, 0.9, fromTop);
    float stain = smoothstep(0.42, 0.8, curtain * 0.65 + fine * 0.2 + underRail * 0.25) * upright;

    float bloom = ivWorldNoise(p, 1.6) * 0.6 + fine * 0.4;
    float low = 1.0 - smoothstep(0.05, 0.75, g.y);
    float splash = smoothstep(0.35, 0.8, low * 0.75 + fine * 0.35) * upright;
    float footRust = smoothstep(0.62, 0.82, (1.0 - smoothstep(0.0, 0.4, g.y)) * 0.5 + bloom * 0.45) * upright;

    float pitting = smoothstep(0.34, 0.6, fine);
    float patch = smoothstep(0.68, 0.86, bloom) * pitting;

    float fadeNoise = ivWorldNoise(p, 0.45);
    float wetness = fadeNoise * 0.7 + fine * 0.3;
    float pool = smoothstep(0.5, 0.62, wetness) * roof;
    float rim = smoothstep(0.42, 0.5, wetness) * (1.0 - smoothstep(0.5, 0.58, wetness));
    float roofRust = max(smoothstep(0.66, 0.82, bloom), rim * 0.75) * pitting * roof;

    float rust = max(max(run, patch * 0.72), max(footRust, roofRust * 0.8));
    float core = smoothstep(0.78, 0.9, bloom) * patch;

    float fade = mix(0.66, 1.1, fadeNoise);
    float chalk = mix(1.0, 1.22, smoothstep(0.55, 0.9, drift) * upright);
    float3 livery = s.livery * (value * fade * chalk) * mix(1.0, 0.48, stain) * mix(1.0, 0.62, pool);
    float relief = value * 0.6 + 0.55;
    float3 dirtied = mix(livery, ROAD_FILM * relief, splash * 0.72);
    float3 rusted = mix(dirtied, RUST * relief, rust * 0.85);
    s.color = mix(rusted, RUST_DARK * relief, core);

    float dull = max(max(rust, splash), stain * 0.5);
    s.roughness = mix(s.materialRoughness * mix(0.78, 1.6, dull), 0.06, pool);
}
#endif  // IRONVALE_MAP_RAILYARD_CONTAINER_PAINT

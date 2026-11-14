// Headworks mountains: the colour nodes of buildRange() in src/maps/headworks/range.ts at commit
// 3ec2f09. The terrain ring and the valley floor are MeshBasic (unlit, fog off): rock, scree, snow
// and forest are worked out per pixel from height and slope, lit by the level's sun and set back
// by haze. Sun direction, SUN_COLOR and FOG_COLOR come from scene.json programRows.
#ifndef IRONVALE_MAP_HEADWORKS_RANGE
#define IRONVALE_MAP_HEADWORKS_RANGE
#include "MapSurface.h"
#include "Noise.metal"

constant float HW_RANGE_INNER = 300.0;
constant float HW_RANGE_OUTER = 840.0;
constant float HW_RANGE_GAIN = 0.8;
constant float HW_RANGE_STEP = 2.0;

/// Crest lines of a noise field, 0 in the gullies and 1 on the ridge.
IV_SHADER_FN float hwCrest(float3 at) {
    float fall = 1.0 - abs(ivMxNoise(at));
    return fall * fall;
}

/// Relief the mesh is too coarse to carry, in metres.
IV_SHADER_FN float hwRelief(float3 at) {
    return hwCrest(float3(at.x * 0.016, at.y * 0.004, at.z * 0.016)) * 18.0
        + hwCrest(float3(at.x * 0.045, at.y * 0.012, at.z * 0.045) + 7.3) * 5.0
        + ivMxFractalNoise(at * 0.09, 3, 2.0, 0.5) * 1.2;
}

/// Aerial haze colour: fog, warm toward the sun.
IV_SHADER_FN float3 hwHazeColour(float3 p, constant float4 *rows, thread float &towardSun) {
    float3 sun = rows[IV_HW_SUN_DIRECTION].xyz;
    towardSun = max(dot(normalize(float3(p.x, 0.0, p.z)), normalize(float3(sun.x, 0.0, sun.z))), 0.0);
    return mix(rows[IV_HW_RANGE_FOG].xyz * 1.35, rows[IV_HW_SUN_COLOR].xyz * 1.7, pow(towardSun, 5.0) * 0.8);
}

IV_SHADER_FN void ivHeadworksRange(thread IVSurface &s) {
    float3 p = s.p;
    float3 sunward = s.rows[IV_HW_SUN_DIRECTION].xyz;
    float coarse = ivMxFractalNoise(p * 0.011, 4, 2.0, 0.5);
    float fine = ivMxFractalNoise(p * float3(0.05, 0.11, 0.05), 3, 2.0, 0.5);
    float height = hwRelief(p);
    float crags = ivMxFractalNoise(p * 0.09, 2, 2.0, 0.5);
    float3 flat = normalize(s.n);
    float gx = (hwRelief(p + float3(HW_RANGE_STEP, 0.0, 0.0)) - height) / HW_RANGE_STEP;
    float gz = (hwRelief(p + float3(0.0, 0.0, HW_RANGE_STEP)) - height) / HW_RANGE_STEP;
    float3 n = normalize(flat - float3(gx, 0.0, gz) * 0.8);

    float facing = dot(n, sunward);
    float lit = smoothstep(-0.05, 0.5, facing) * smoothstep(-0.22, 0.12, dot(flat, sunward));
    float slope = n.y;
    float snowLine = 46.0 + coarse * 26.0;
    float snow = smoothstep(snowLine - 12.0, snowLine + 30.0, p.y + fine * 14.0) * smoothstep(0.42, 0.62, slope + fine * 0.08);
    float strata = ivMxFractalNoise(float3(p.x * 0.02, p.y * 0.16 + coarse * 3.0, p.z * 0.02), 3, 2.0, 0.5) * 0.5 + 0.5;
    float3 rock = mix(float3(0.045, 0.047, 0.055), float3(0.17, 0.155, 0.14), strata * smoothstep(-0.6, 0.8, crags));
    float stand = ivMxNoise(p * 0.3) * 0.5 + 0.5;
    float forest = (1.0 - smoothstep(40.0, 96.0, p.y + coarse * 30.0))
        * smoothstep(0.4, 0.55, (ivMxNoise(p * 0.035) * 0.5 + 0.5) * 0.6 + stand * 0.4) * smoothstep(0.35, 0.6, slope);
    float3 ground = mix(rock, float3(0.9, 0.92, 0.96), snow);
    float3 surface = mix(ground, mix(float3(0.02, 0.035, 0.03), float3(0.06, 0.08, 0.07), stand), forest * 0.9);
    float3 light = s.rows[IV_HW_SUN_COLOR].xyz * (lit * 1.5) + float3(0.13, 0.19, 0.33) * (slope * 0.4 + 0.6);
    float distance = length(p.xz);
    float towardSun;
    float3 hazeColour = hwHazeColour(p, s.rows, towardSun);
    float haze = smoothstep(HW_RANGE_INNER - 80.0, HW_RANGE_OUTER, distance) * 0.34 + 0.3
        + (1.0 - smoothstep(0.0, 120.0, p.y)) * 0.4 + pow(towardSun, 5.0) * 0.2;
    s.color = mix(surface * light * HW_RANGE_GAIN, hazeColour * 0.62, clamp(haze, 0.0, 0.94));
}

/// The valley floor outside the wall: old snow over rough ground, lost in haze.
IV_SHADER_FN void ivHeadworksRangeFloor(thread IVSurface &s) {
    float3 p = s.p;
    float drift = smoothstep(0.35, 0.6, ivMxFractalNoise(p * 0.05, 3, 2.0, 0.5) * 0.5 + 0.5);
    float towardSun;
    float3 hazeColour = hwHazeColour(p, s.rows, towardSun);
    s.color = mix(mix(float3(0.09, 0.09, 0.085), float3(0.42, 0.47, 0.56), drift), hazeColour * 0.62,
                  smoothstep(40.0, HW_RANGE_INNER, length(p.xz)) * 0.6 + 0.15);
}
#endif  // IRONVALE_MAP_HEADWORKS_RANGE

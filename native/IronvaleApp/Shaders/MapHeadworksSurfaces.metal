// Headworks surfaces: src/maps/headworks/surfaces.ts at commit 3ec2f09. Board-formed concrete,
// the ground slabs (paving, road), coated and bare steel, grating and hazard stripes, and the
// pump-house sky visibility (skyVisibility, underRoof). The pump-house plan comes from scene.json
// programRows (IV_HW_HOUSES); the per-material constants below are the factory arguments of
// materials.ts, which the exporter's fingerprints tie to this port.
#ifndef IRONVALE_MAP_HEADWORKS_SURFACES
#define IRONVALE_MAP_HEADWORKS_SURFACES
#include "MapSurface.h"
#include "Noise.metal"

/// surfaces.ts luma().
IV_SHADER_FN float hwLuma(float3 rgb) { return dot(rgb, float3(0.3, 0.59, 0.11)); }
/// Distance in metres to the nearest line of a grid `spacing` apart, lines at half-cells.
IV_SHADER_FN float hwToLine(float c, float spacing) { return abs(fract(c / spacing) - 0.5) * spacing; }
IV_SHADER_FN float hwUpright(float3 n) { return 1.0 - smoothstep(0.35, 0.7, abs(n.y)); }
IV_SHADER_FN float hwAlongFace(float3 p, float3 n) { return mix(p.x, p.z, step(0.5, abs(n.x))); }

/// insideHouse(): 1 inside a pump house (and the strip just out of its door).
IV_SHADER_FN float hwInsideHouse(float3 p, float4 box, float height) {
    return step(box.x + 0.05, p.x) * step(p.x, box.y - 0.05) * step(box.z + 0.05, p.z) * step(p.z, box.w + 0.3) * step(p.y, height + 0.05);
}

IV_SHADER_FN float ivHeadworksUnderRoof(float3 p, constant float4 *rows) {
    uint houses = uint(rows[IV_HW_COUNTS].x);
    float roofed = 0.0;
    for (uint i = 0; i < houses; i++) {
        roofed = max(roofed, hwInsideHouse(p, rows[IV_HW_HOUSES + i * 2], rows[IV_HW_HOUSES + i * 2 + 1].x));
    }
    return roofed;
}

/// Share of sky light left in the middle of a pump house.
constant float HW_HOUSE_SKY = 0.2;

IV_SHADER_FN float ivHeadworksSkyVisibility(float3 p, constant float4 *rows) {
    uint houses = uint(rows[IV_HW_COUNTS].x);
    float visibility = 1.0;
    for (uint i = 0; i < houses; i++) {
        float4 h = rows[IV_HW_HOUSES + i * 2];
        float inside = hwInsideHouse(p, h, rows[IV_HW_HOUSES + i * 2 + 1].x);
        float fromWall = min(min(p.x - h.x, h.y - p.x), min(p.z - h.z, h.w - p.z));
        float depth = smoothstep(0.2, 4.5, fromWall);
        visibility *= mix(1.0, mix(0.55, HW_HOUSE_SKY, depth), inside);
    }
    return visibility;
}

/// formedConcrete(maps, roundTile); `roundTile` 0 projects along the face (materials.ts TILE_FORMED = 1.8 for the round work).
IV_SHADER_FN void ivHeadworksFormedConcrete(thread IVSurface &s, float roundTile) {
    float3 p = s.p;
    float3 n = s.n;
    float grain = clamp(hwLuma(s.programTexel.rgb) / 0.12, 0.4, 1.6);
    float upright = hwUpright(n);
    float along = roundTile > 0.0 ? s.uv.x * roundTile : hwAlongFace(p, n);

    float panel = floor(along / 2.4 + 0.5) + 300.0 + (floor(p.y / 1.2 + 0.5) + 40.0) * 71.0;
    float pour = mix(0.9, 1.06, ivTslHash(panel));
    float seam = (1.0 - smoothstep(0.004, 0.016, min(hwToLine(along, 2.4), hwToLine(p.y, 1.2)))) * upright;
    float hx = (fract(along / 0.6) - 0.5) * 0.6;
    float hy = (fract(p.y / 0.6) - 0.5) * 0.6;
    float hole = (1.0 - smoothstep(0.012, 0.024, length(float2(hx, hy)))) * upright;
    float weeps = step(0.62, ivTslHash(floor(along / 0.6) + floor(p.y / 0.6) * 13.0 + 500.0));
    float drip = (1.0 - smoothstep(0.008, 0.03, abs(hx))) * smoothstep(-0.29, -0.02, hy) * step(hy, 0.0) * weeps * upright;

    float run = ivMxNoise(float3(along * 2.1, p.y * 0.11, 3.7)) * 0.5 + 0.5;
    float fineRun = ivMxNoise(float3(along * 8.5, p.y * 0.5, 9.1)) * 0.5 + 0.5;
    float streak = smoothstep(0.44, 0.8, run * 0.7 + fineRun * 0.3) * upright;
    float under = smoothstep(0.1, 0.7, -n.y);
    float blotch = mix(0.9, 1.06, ivWorldNoise(p, 0.21));
    float patchy = ivWorldNoise(p, 1.3);
    float foot = (1.0 - smoothstep(0.02, 0.75, p.y)) * mix(0.45, 1.0, patchy) * upright;
    float salt = smoothstep(0.52, 0.7, ivWorldNoise(p, 0.9) * 0.6 + ivWorldNoise(p, 6.0) * 0.4)
        * smoothstep(0.15, 0.5, p.y) * (1.0 - smoothstep(0.6, 1.5, p.y)) * upright;
    float top = smoothstep(0.6, 0.9, n.y);
    float lichen = smoothstep(0.55, 0.75, ivWorldNoise(p, 1.7) * 0.55 + ivWorldNoise(p, 11.0) * 0.45) * top;

    float tongue = smoothstep(0.5, 0.74, (ivMxNoise(float3(along * 0.55, p.y * 0.06, 21.3)) * 0.5 + 0.5) * 0.75 + fineRun * 0.25) * upright;
    float rising = (1.0 - smoothstep(0.05, 0.3, p.y - patchy * 0.22)) * upright;
    float algae = smoothstep(0.45, 0.7, ivWorldNoise(p, 0.45) * 0.6 + ivWorldNoise(p, 4.1) * 0.4) * (1.0 - smoothstep(0.1, 0.9, p.y)) * upright;
    float wander = ivMxNoise(float3(along * 0.21, p.y * 0.16, 5.9)) + ivMxNoise(float3(along * 3.1, p.y * 3.1, 2.2)) * 0.035;
    float crack = (1.0 - smoothstep(0.0008, 0.003, abs(wander))) * smoothstep(0.6, 0.7, ivWorldNoise(p, 0.09)) * upright;
    float px = fract(along / 2.4 + 0.5);
    float py = fract(p.y / 1.2 + 0.5);
    float ragged = (ivWorldNoise(p, 7.5) - 0.5) * 0.05;
    float repair = step(0.9, ivTslHash(panel + 17.0))
        * (smoothstep(0.17, 0.21, px + ragged) * (1.0 - smoothstep(0.63, 0.67, px - ragged)))
        * (smoothstep(0.19, 0.24, py - ragged) * (1.0 - smoothstep(0.76, 0.81, py + ragged)))
        * upright;
    float snow = smoothstep(0.42, 0.52, ivWorldNoise(p, 0.5) * 0.55 + ivWorldNoise(p, 2.9) * 0.3 + ivWorldNoise(p, 13.0) * 0.15)
        * smoothstep(0.9, 0.97, n.y) * smoothstep(2.9, 3.1, p.y);

    float3 color = float3(0.4, 0.39, 0.362) * mix(1.0, grain, 0.55) * pour * blotch;
    color = mix(color, color * float3(0.46, 0.45, 0.42), streak * 0.8);
    color = mix(color, color * float3(0.5, 0.5, 0.49), tongue * 0.7);
    color = mix(color, color * float3(0.62, 0.65, 0.72), under);
    color = mix(color, color * float3(0.5, 0.48, 0.43), foot * 0.75);
    color = mix(color, color * float3(0.42, 0.5, 0.3), algae * 0.7);
    color = mix(color, color * 0.55, rising * 0.8);
    color = mix(color, float3(0.82, 0.83, 0.82), salt * 0.55);
    color = mix(color, color * 0.74, top * 0.6);
    color = mix(color, color * float3(0.6, 0.64, 0.6), lichen * 0.6);
    color = mix(color, color * float3(1.12, 1.13, 1.15), repair * 0.8);
    color = mix(color, float3(0.3, 0.17, 0.09), drip * 0.55);
    color = mix(color, color * 0.38, seam * 0.85);
    color = mix(color, color * 0.4, crack * 0.8);
    color = mix(color, float3(0.03), hole);
    color = mix(color, float3(0.86, 0.89, 0.94), snow);
    s.color = color;
    float wet = max(max(tongue * 0.7, rising), streak * 0.4);
    s.roughness = mix(mix(0.97, 0.48, wet), 0.8, snow);
}

IV_SHADER_FN float hwSlabJoints(float3 p, float spacing, float width) {
    return 1.0 - smoothstep(width * 0.3, width, min(hwToLine(p.x + spacing / 2.0, spacing), hwToLine(p.z + spacing / 2.0, spacing)));
}

IV_SHADER_FN float hwSlabTone(float3 p, float spacing, float low, float high) {
    float cell = floor(p.x / spacing) + 200.0 + (floor(p.z / spacing) + 200.0) * 57.0;
    return mix(low, high, ivTslHash(cell));
}

/// paving(maps, base, bay, average): materials.ts gives the slab (0.2, 0.2, 0.193), 4, 0.1 and the
/// road (0.115, 0.118, 0.125), 6, 0.3. The normal stage lays standing water flat over the scan's normal map.
IV_SHADER_FN void ivHeadworksPaving(thread IVSurface &s, float3 base, float bay, float average, bool normalStage) {
    float3 p = s.p;
    float joint = hwSlabJoints(p, bay, 0.03);
    float open = 1.0 - ivHeadworksUnderRoof(p, s.rows);
    float low = ivWorldNoise(p, 0.085) * 0.62 + ivWorldNoise(p, 0.37) * 0.3 + ivWorldNoise(p, 2.3) * 0.08;
    float damp = smoothstep(0.44, 0.53, low) * open;
    float puddle = smoothstep(0.56, 0.58, low) * (1.0 - joint) * open;
    float lie = (ivMxNoise(p.xz * 0.12 + float2(41.0, 7.0)) * 0.5 + 0.5) * 0.7 + ivWorldNoise(p, 1.9) * 0.22 + ivWorldNoise(p, 4.3) * 0.08;
    float snow = smoothstep(0.66, 0.72, lie) * open;
    float slush = smoothstep(0.58, 0.67, lie) * open;
    float wetness = max(damp, slush);
    if (normalStage) {
        s.normal = normalize(mix(s.programNormal, s.n, max(puddle, wetness * 0.6) * 0.95));
        return;
    }
    float grain = clamp(hwLuma(s.programTexel.rgb) / average, 0.45, 1.6);
    float nearJoint = hwSlabJoints(p, bay, 0.5);
    float dirt = smoothstep(0.42, 0.78, ivWorldNoise(p, 0.16) * 0.6 + ivWorldNoise(p, 1.1) * 0.4);
    float salt = smoothstep(0.5, 0.72, ivWorldNoise(p, 0.6) * 0.5 + ivWorldNoise(p, 5.0) * 0.5) * nearJoint;
    float polished = smoothstep(0.62, 0.8, ivWorldNoise(p, 0.33));
    float3 color = base * mix(1.0, grain, 0.7) * hwSlabTone(p, bay, 0.86, 1.08);
    color = mix(color, color * float3(0.56, 0.55, 0.52), dirt * 0.7);
    color = mix(color, color * 1.5 + 0.06, salt * 0.4);
    color = mix(color, color * 0.3, joint * 0.9);
    color = mix(color, color * float3(0.5, 0.52, 0.55), wetness * 0.9);
    color = mix(color, color * 0.45, puddle);
    color = mix(color, float3(0.74, 0.78, 0.84) * mix(0.8, 1.05, ivWorldNoise(p, 6.0)), snow);
    s.color = color;
    float dry = mix(0.94, 0.72, polished * (1.0 - joint));
    s.roughness = mix(mix(mix(dry, 0.4, wetness), 0.03, puddle), 0.85, snow);
}

/// coatedSteel(): plant, pipework and doors; vertex colour is the coat.
IV_SHADER_FN void ivHeadworksCoatedSteel(thread IVSurface &s) {
    float3 p = s.p;
    float fine = ivWorldNoise(p, 9.0);
    float fade = mix(0.74, 1.08, ivWorldNoise(p, 0.7) * 0.7 + ivWorldNoise(p, 3.3) * 0.3);
    float upright = hwUpright(s.n);
    float run = ivMxNoise(p * float3(2.4, 0.25, 2.4)) * 0.5 + 0.5;
    float thin = ivMxNoise(p * float3(11.0, 0.6, 11.0)) * 0.5 + 0.5;
    float grime = smoothstep(0.46, 0.84, run * 0.6 + thin * 0.2 + fine * 0.2) * (upright * 0.7 + 0.3);
    float settled = smoothstep(0.5, 0.9, s.n.y) * mix(0.5, 1.0, ivWorldNoise(p, 2.1));
    float spray = 1.0 - smoothstep(0.03, 0.5, p.y - ivWorldNoise(p, 3.7) * 0.2);
    float blister = ivWorldNoise(p, 3.1) * 0.55 + ivWorldNoise(p, 17.0) * 0.45;
    float chip = smoothstep(0.73, 0.77, blister + spray * 0.12);
    float primer = smoothstep(0.69, 0.73, blister + spray * 0.12) * (1.0 - chip);
    float bleed = smoothstep(0.66, 0.78, ivWorldNoise(p, 3.1) * 0.55 + (ivMxNoise(p * float3(17.0, 2.2, 17.0)) * 0.5 + 0.5) * 0.45) * upright;
    float3 coat = mix(float3(fade), float3(0.5, 0.48, 0.45), grime * 0.65);
    coat = mix(coat, float3(0.62, 0.61, 0.58), settled * 0.45);
    coat = mix(coat, float3(0.36, 0.33, 0.29), spray * 0.6);
    coat = mix(coat, float3(0.55, 0.3, 0.16), bleed * 0.3);
    coat = mix(coat, float3(0.72, 0.4, 0.3), primer * 0.7);
    s.color = mix(coat, float3(0.33, 0.13, 0.05) * mix(0.6, 1.3, fine), chip * 0.9);
    s.roughness = mix(mix(0.34, 0.5, ivWorldNoise(p, 1.3)), 0.88, max(max(grime, chip), max(settled * 0.7, spray * 0.8)));
    s.metalness = mix(0.1, 0.5, chip);
}

/// bareSteel(galvanised): brushed stainless, or the duller zinc of rails and gratings.
IV_SHADER_FN void ivHeadworksBareSteel(thread IVSurface &s, bool galvanised) {
    float brushed = ivMxNoise(s.p * float3(3.0, 60.0, 3.0)) * 0.5 + 0.5;
    float spangle = ivWorldNoise(s.p, galvanised ? 22.0 : 4.0);
    float dull = smoothstep(0.55, 0.85, ivWorldNoise(s.p, 1.2));
    s.color = float3(mix(0.8, 1.05, spangle * 0.6 + brushed * 0.4)) * mix(1.0, 0.78, dull);
    s.roughness = mix(galvanised ? 0.5 : 0.34, galvanised ? 0.72 : 0.55, max(brushed * 0.6, dull));
}

/// grating(): bright bearing bars over dark gaps, evening out with distance. UVs in metres.
IV_SHADER_FN void ivHeadworksGrating(thread IVSurface &s) {
    float bars = step(0.4, fract(s.uv.x / 0.04));
    float cross = step(0.9, fract(s.uv.y / 0.1));
    float near = 1.0 - smoothstep(4.0, 14.0, s.viewDepth);
    float open = bars * (1.0 - cross) * near;
    s.color = mix(float3(0.5, 0.52, 0.53) * mix(0.62, 1.0, (1.0 - near) * 0.4 + 0.6), float3(0.03), open);
}

/// hazardStripes(): diagonal yellow and black bands fixed in world space.
IV_SHADER_FN void ivHeadworksHazard(thread IVSurface &s) {
    float stripe = step(0.5, fract((s.p.x + s.p.y + s.p.z) / 0.3));
    float wear = mix(0.55, 1.0, ivWorldNoise(s.p, 4.3));
    float scuff = smoothstep(0.6, 0.72, ivWorldNoise(s.p, 2.2) * 0.5 + ivWorldNoise(s.p, 13.0) * 0.5);
    float3 paint = mix(float3(0.84, 0.62, 0.04), float3(0.03), stripe) * wear;
    s.color = mix(paint, float3(0.45, 0.45, 0.43), scuff * 0.8);
}
#endif  // IRONVALE_MAP_HEADWORKS_SURFACES

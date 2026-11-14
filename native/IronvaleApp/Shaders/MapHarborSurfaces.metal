// Harbor surfaces: the material factories of src/maps/harbor/surfaces.ts at commit 3ec2f09.
// plaster, masonry (rubble and slab), cobbles, roof tiles, stained and painted timber, louvred
// shutters, lit rooms, lamp glass, striped awnings, scuffed paint, stain decals, the hillside,
// tree shadows and leaf masses. Each factory is one program; the arguments materials.ts gives
// it (tints, mean luma, wear, ...) arrive per material in IVSurface.args (programs-harbor.ts
// reads them from the node constants). Constants that are not arguments are copied from the
// factory; the exporter's family fingerprints keep them honest.
#ifndef IRONVALE_MAP_HARBOR_SURFACES
#define IRONVALE_MAP_HARBOR_SURFACES
#include "MapSurface.h"
#include "MapHarborGrime.metal"
#include "MapHarborShade.metal"

constant float3 HB_LUMA = float3(0.2126, 0.7152, 0.0722);
/// surfaces.ts HAZE_TINT.
constant uint HB_HAZE_TINT = 0xa9adb2u;

IV_SHADER_FN float3 hbArg3(thread const IVSurface &s, uint i) { return float3(s.args[i], s.args[i + 1], s.args[i + 2]); }

/// distantHaze(): pale air over the mountain, thicker with distance north of the top terrace.
IV_SHADER_FN float3 hbDistantHaze(float3 surface, float3 p) {
    float far = smoothstep(62.0, 230.0, -p.z) * 0.3 + smoothstep(55.0, 75.0, -p.z) * 0.08;
    return mix(surface, ivHexColor(HB_HAZE_TINT), far);
}

/// relief(): brightness of the scanned colour map around its mean.
IV_SHADER_FN float hbRelief(thread const IVSurface &s, float mean, float low, float high) {
    return clamp(dot(s.mapTexel.rgb, HB_LUMA) / mean, low, high);
}

/// The normal `offset` (view space) added to the geometry normal, as `normalView.add(offset).normalize()`.
IV_SHADER_FN float3 hbViewNormal(thread const IVSurface &s, float3 offset) {
    float3 v = normalize(s.view * s.geometryNormal + offset);
    return normalize(transpose(s.view) * v);
}

IV_SHADER_FN void ivHarborPlaster(thread IVSurface &s, thread const IVProgramTextures &t) {
    float3 tint = hbArg3(s, 0);
    float mean = s.args[3], wear = s.args[4];
    float3 p = s.p;
    float2 sc = hbSurfaceCoord(p, s.n);
    float2 wc = hbWallCoord(p);
    float h = hbHeightAboveStreet(p, s.rows);
    float detail = hbRelief(s, mean, 0.5, 1.4);
    float blotch = hbGrime(t, sc, 9.3).r;
    float fine = hbGrime(t, sc, 1.9).b;
    float drips = smoothstep(0.5, 0.92, hbGrime(t, sc, 6.1, 0.21).g) * mix(0.3, 1.0, blotch) * wear;
    float damp = (1.0 - smoothstep(0.05, 1.7, h + (blotch - 0.5) * 1.5)) * wear;
    float algae = (1.0 - smoothstep(0.02, 0.55, h + (fine - 0.5) * 0.3 + (blotch - 0.5) * 0.5)) * wear;
    float runs = smoothstep(0.42, 0.8, hbGrime(t, float2(sc.x, sc.y * 0.22), 3.7, 0.63).g) * mix(0.35, 1.0, hbGrime(t, sc, 13.1, 0.2).a) * wear;
    float shade = detail * mix(0.68, 1.1, blotch) * mix(1.0, 0.58, drips) * mix(1.0, 0.74, runs) * mix(1.0, 0.52, damp);
    float3 coat = mix(tint * shade * mix(float3(1.0), float3(0.88, 0.92, 0.76), damp * 0.7), ivHexColor(0x23281au) * detail, algae * 0.62);

    float nearGround = 1.0 - smoothstep(0.3, 5.0, h);
    float islands = hbGrime(t, sc, 8.3, 0.37).a + (fine - 0.5) * 0.07 + nearGround * 0.07;
    float peel = smoothstep(0.8, 0.82, islands) * wear;
    float3 render = mix(ivHexColor(0xb5a68du), tint, 0.22) * detail * mix(0.78, 1.0, fine) * mix(1.0, 0.66, damp);

    // brickwork(): running bond, 0.075 m courses, 0.25 m bricks, 0.011 m joints.
    float row = floor(wc.y / 0.075);
    float along = wc.x / 0.25 + hbMod(row, 2.0) * 0.5;
    float fx = fract(along), fy = fract(wc.y / 0.075);
    float edge = min(min(fx, 1.0 - fx) * 0.25, min(fy, 1.0 - fy) * 0.075);
    float face = smoothstep(0.011 * 0.5, 0.011, edge);
    float each = t.grime.sample(hbGrimeSampler, float2(floor(along), row) * 0.0371).r;
    float bare = smoothstep(0.874, 0.884, islands) * smoothstep(0.46, 0.54, hbGrime(t, sc, 23.7, 0.15).r) * wear;
    float3 brick = mix(ivHexColor(0x8f8672u), mix(ivHexColor(0x5c3a2cu), ivHexColor(0x7c5340u), each) * mix(0.7, 1.05, fine), face) * mix(1.0, 0.6, damp);
    float lip = smoothstep(0.866, 0.878, islands) * (1.0 - smoothstep(0.878, 0.89, islands)) * min(bare + 0.3, 1.0);

    float contour = abs(hbGrime(t, sc, 4.3, 0.77).r - 0.5);
    float failing = smoothstep(0.66, 0.8, islands + (hbGrime(t, sc, 17.9, 0.4).r - 0.5) * 0.35);
    float crack = (1.0 - smoothstep(0.002, 0.007, contour)) * failing * wear;

    float3 layered = mix(mix(coat, render, peel * 0.88), brick, bare);
    s.color = hbDistantHaze(layered * mix(1.0, 0.5, lip) * mix(1.0, 0.55, crack * (1.0 - bare)), p);
}

/// masonry(); `slab` cuts flat tops into paving slabs args[4] x args[5] metres in a running bond.
IV_SHADER_FN void ivHarborMasonry(thread IVSurface &s, thread const IVProgramTextures &t, bool slab) {
    float3 tint = hbArg3(s, 0);
    float3 p = s.p;
    float2 sc = hbSurfaceCoord(p, s.n);
    float detail = hbRelief(s, s.args[3], 0.5, 1.4);
    float blotch = hbGrime(t, sc, 7.3).r;
    float drips = smoothstep(0.55, 0.95, hbGrime(t, sc, 5.3, 0.4).g);
    float shade = detail * mix(0.8, 1.08, blotch) * mix(1.0, 0.8, drips);
    if (slab) {
        float sx = s.args[4], sz = s.args[5];
        float row = floor(p.z / sz);
        float along = p.x / sx + hbMod(row, 2.0) * 0.5;
        float fx = fract(along), fz = fract(p.z / sz);
        float edge = min(min(fx, 1.0 - fx) * sx, min(fz, 1.0 - fz) * sz);
        float flat = step(0.7, s.n.y);
        float joint = (1.0 - smoothstep(0.004, 0.022, edge)) * flat;
        float each = t.grime.sample(hbGrimeSampler, float2(floor(along), row) * 0.173).r;
        shade *= mix(1.0, mix(0.82, 1.1, each), flat) * mix(1.0, 0.5, joint);
    }
    float tide = 1.0 - smoothstep(-0.8, -0.12, p.y + (blotch - 0.5) * 0.35);
    s.color = hbDistantHaze(mix(tint * shade, ivHexColor(0x2b3220u) * detail, tide * 0.8), p);
    s.roughness = mix(s.materialRoughness, 0.3, tide);
}

/// cobbles(): damp patches and puddles that fill the joints first; args[0] is 1 - coverage.
IV_SHADER_FN void ivHarborCobbles(thread IVSurface &s, thread const IVProgramTextures &t, bool normalStage) {
    float3 p = s.p;
    float2 gc = p.xz;
    HBShadeTerms shade = hbShadeTerms(p, s.n, s.rows, t.shade);
    float joints = 1.0 - s.armTexel.r;
    float pool = hbGrime(t, gc, 7.1, 0.13).a * 0.7 + hbGrime(t, gc, 2.9).r * 0.3;
    float threshold = s.args[0] + (shade.dry - 0.5) * 0.16;
    float level = smoothstep(0.985, 0.999, s.n.y);
    float puddle = smoothstep(threshold + 0.02, threshold + 0.07, pool + (joints - 0.25) * 0.22) * level;
    if (normalStage) {
        s.normal = normalize(mix(s.programNormal, s.n, puddle));
        return;
    }
    float macro = hbGrime(t, gc, 19.0).r;
    float warm = hbGrime(t, gc, 6.7, 0.5).b;
    float damp = smoothstep(threshold - 0.16, threshold, pool) * level;
    float tide = 1.0 - smoothstep(-0.7, -0.05, p.y);
    float drift = smoothstep(0.38, 0.62, hbGrime(t, gc, 5.3, 0.71).a + (1.0 - shade.street) * 0.3);
    float moss = smoothstep(0.2, 0.5, joints) * drift * (1.0 - shade.dry) * level;
    float3 base = s.mapTexel.rgb * mix(0.8, 1.1, macro) * mix(float3(1.0), float3(1.08, 1.0, 0.88), warm);
    float3 mossy = mix(base, ivHexColor(0x35451cu) * mix(0.6, 1.2, warm), moss * 0.75);
    float3 wet = mossy * mix(1.0, 0.6, damp) * mix(1.0, 0.42, puddle);
    s.color = mix(wet, ivHexColor(0x283020u), tide * 0.7);
    s.roughness = mix(s.materialRoughness * mix(1.0, 0.55, damp), 0.03, max(puddle, tide * 0.7));
}

IV_SHADER_FN void ivHarborRoofTiles(thread IVSurface &s, thread const IVProgramTextures &t) {
    float2 gc = s.p.xz;
    float macro = hbGrime(t, gc, 7.9).r;
    float fine = hbGrime(t, gc, 1.3).b;
    float lichen = smoothstep(0.6, 0.72, hbGrime(t, gc, 4.9, 0.6).a);
    float3 base = s.mapTexel.rgb * hbArg3(s, 0) * mix(0.66, 1.12, macro) * mix(0.86, 1.06, fine);
    s.color = hbDistantHaze(mix(base, ivHexColor(0x7d7b5cu) * mix(0.7, 1.1, fine), lichen * 0.4), s.p);
}

IV_SHADER_FN void ivHarborStained(thread IVSurface &s, thread const IVProgramTextures &t) {
    float blotch = hbGrime(t, hbSurfaceCoord(s.p, s.n), 3.1).r;
    s.color = hbArg3(s, 0) * hbRelief(s, s.args[3], 0.45, 1.4) * mix(0.78, 1.08, blotch);
}

IV_SHADER_FN void ivHarborPainted(thread IVSurface &s, thread const IVProgramTextures &t) {
    float detail = hbRelief(s, 0.2, 0.35, 1.3);
    float wear = hbGrime(t, hbSurfaceCoord(s.p, s.n), 0.83).b;
    s.color = hbArg3(s, 0) * detail * mix(0.74, 1.06, wear);
}

IV_SHADER_FN void ivHarborLouvred(thread IVSurface &s, thread const IVProgramTextures &t, bool normalStage) {
    float slat = fract(s.p.y / 0.052);
    if (normalStage) {
        s.normal = hbViewNormal(s, float3(0.0, (slat - 0.5) * 0.9, 0.0));
        return;
    }
    float2 sc = hbSurfaceCoord(s.p, s.n);
    float wear = hbGrime(t, sc, 0.83).b;
    float flake = smoothstep(0.78, 0.84, hbGrime(t, sc, 1.3, 0.3).a + (wear - 0.5) * 0.25);
    float shade = mix(0.42, 1.08, smoothstep(0.0, 0.3, slat)) * mix(1.0, 0.86, smoothstep(0.8, 1.0, slat));
    float3 coat = hbArg3(s, 0) * mix(0.74, 1.06, wear);
    s.color = hbDistantHaze(mix(coat, ivHexColor(0x8c8272u) * mix(0.7, 1.05, wear), flake * 0.55) * shade, s.p);
}

/// litRoom(): lamp glow behind a window, uneven pane to pane, with curtains and furniture.
IV_SHADER_FN void ivHarborLitRoom(thread IVSurface &s, thread const IVProgramTextures &t) {
    float2 wc = hbWallCoord(s.p);
    float folds = hbGrime(t, float2(wc.x, wc.y * 0.12), 0.9).g;
    float shapes = hbGrime(t, wc, 2.7, 0.13).a;
    float room = hbGrime(t, wc, 7.5, 0.6).r;
    float curtain = smoothstep(0.35, 0.75, folds) * 0.55;
    float furniture = smoothstep(0.5, 0.75, shapes) * 0.4;
    float glow = mix(0.55, 1.5, room) * (1.0 - curtain) * (1.0 - furniture);
    s.emissive = mix(ivHexColor(0xff8a3au), ivHexColor(0xffc26eu), room) * glow * 2.6;
}

/// lampGlass(tint, peak): hot where the pane is seen square on.
IV_SHADER_FN void ivHarborLampGlass(thread IVSurface &s) {
    float square = abs(dot(s.n, normalize(s.cameraPosition - s.p)));
    float peak = s.args[3];
    s.emissive = hbArg3(s, 0) * mix(peak * 0.16, peak, pow(square, 2.5));
}

IV_SHADER_FN void ivHarborStriped(thread IVSurface &s, thread const IVProgramTextures &t) {
    float band = step(0.5, fract(s.uv.x * s.args[3]));
    float2 c = s.p.xz + s.p.y;
    float fade = hbGrime(t, c, 2.3).r;
    float dirt = hbGrime(t, c, 0.9).b;
    s.color = mix(ivHexColor(0xe4d9c0u), hbArg3(s, 0), band * mix(0.7, 1.0, fade)) * mix(0.72, 1.02, dirt);
}

IV_SHADER_FN void ivHarborScuffed(thread IVSurface &s, thread const IVProgramTextures &t) {
    float2 c = s.p.xz + s.p.y * 0.7;
    s.color = hbArg3(s, 0) * mix(0.66, 1.06, hbGrime(t, c, 0.47).b) * mix(0.85, 1.05, hbGrime(t, c, 2.1).r);
}

/// stainDecal(): strongest where V is 1, fading from the sill or drain that feeds it.
IV_SHADER_FN void ivHarborStainDecal(thread IVSurface &s, thread const IVProgramTextures &t) {
    float2 st = s.uv;
    float2 sc = hbSurfaceCoord(s.p, s.n);
    float across = smoothstep(0.0, 0.3, st.x) * smoothstep(0.0, 0.3, 1.0 - st.x);
    float streak = hbGrime(t, float2(sc.x, sc.y * 0.12), 0.9, 0.31).g;
    float patch = hbGrime(t, sc, 1.7, 0.55).r;
    s.opacity = pow(st.y, 1.4) * across * mix(0.25, 1.0, streak) * mix(0.6, 1.0, patch) * 0.62;
}

IV_SHADER_FN void ivHarborHillside(thread IVSurface &s, thread const IVProgramTextures &t) {
    float3 p = s.p;
    float2 gc = p.xz;
    float broad = hbGrime(t, gc, 230.0).r;
    float drift = hbGrime(t, gc, 61.0, 0.3).a;
    float fine = hbGrime(t, gc, 13.0).b;
    float tiny = hbGrime(t, gc, 3.1, 0.7).b;
    float rockDetail = hbRelief(s, 0.15, 0.6, 1.5);
    float steep = 1.0 - smoothstep(0.26, 0.42, s.n.y + (drift - 0.5) * 0.3);
    float scrub = smoothstep(0.2, 0.36, broad * 0.45 + drift * 0.55 + (fine - 0.5) * 0.3);
    float3 grass = ivHexColor(0x5d5a33u) * mix(0.7, 1.15, fine) * mix(0.8, 1.1, rockDetail);
    float3 macchia = mix(ivHexColor(0x14301au), ivHexColor(0x42702cu), tiny * 0.6 + fine * 0.4) * mix(0.7, 1.1, drift);
    float3 rock = ivHexColor(0x8d8270u) * rockDetail * mix(0.8, 1.08, fine);
    float step4 = fract(p.y / 4.4 + fine * 0.16);
    float farmed = smoothstep(0.5, 0.62, hbGrime(t, gc, 97.0, 0.55).a) * (1.0 - smoothstep(60.0, 95.0, p.y)) * (1.0 - steep);
    float wallLine = smoothstep(0.86, 0.9, step4) * farmed;
    float3 plot = mix(ivHexColor(0x77703fu), ivHexColor(0x55633au), tiny) * mix(0.8, 1.1, fine);
    float3 ground = mix(mix(mix(grass, macchia, scrub), plot, farmed * 0.85), ivHexColor(0xa59a84u) * rockDetail, wallLine);
    s.color = hbDistantHaze(mix(ground, rock, steep), p);
    s.roughness = 1.0;
}

IV_SHADER_FN void ivHarborTreeShadow(thread IVSurface &s) {
    float fromCentre = length(s.uv - 0.5) * 2.0;
    float far = smoothstep(62.0, 230.0, -s.p.z);
    s.opacity = (1.0 - smoothstep(0.35, 1.0, fromCentre)) * mix(0.5, 0.3, far);
}

/// leafy(dark, light, grime, grain): mottled greens and a broken-up normal.
IV_SHADER_FN void ivHarborLeafy(thread IVSurface &s, thread const IVProgramTextures &t, bool normalStage) {
    float grain = s.args[6];
    float2 coord = s.p.xz + s.p.y * 0.61;
    float a = hbGrime(t, coord, grain).b;
    float b = hbGrime(t, coord + s.p.y, grain * 1.7, 0.4).r;
    if (normalStage) {
        s.normal = hbViewNormal(s, float3(a - 0.5, b - 0.5, a * b - 0.25) * 1.1);
        return;
    }
    s.color = hbDistantHaze(mix(hbArg3(s, 0), hbArg3(s, 3), a * 0.65 + b * 0.35) * mix(0.55, 1.1, b), s.p);
}
#endif  // IRONVALE_MAP_HARBOR_SURFACES

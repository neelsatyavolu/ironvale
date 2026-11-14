// Harbor sea: the colour, normal, emission and roughness nodes of createSea() in
// src/maps/harbor/water.ts at commit 3ec2f09. Normals from four scrolling layers of the exported
// wave slope map (programTextures.waves) plus the tilt of three swells; foam where the water works
// against the quay, the mole, the slipway and the jetty piles. The layout comes from scene.json
// programRows (IV_HB_WATER, MOLE, SLIPWAY, JETTIES). The swell's vertex heave (positionNode, a few
// centimetres) is not displaced here; its slope still tilts the normal.
#ifndef IRONVALE_MAP_HARBOR_WATER
#define IRONVALE_MAP_HARBOR_WATER
#include "MapSurface.h"

constexpr sampler hbWaveSampler(filter::linear, mip_filter::linear, address::repeat, max_anisotropy(8));

/// water.ts SWELLS: direction x, direction z, wavelength m, height m, speed m/s.
constant float4 HB_SWELLS[3] = { float4(0.62, -0.78, 23.0, 0.05), float4(0.86, -0.5, 13.5, 0.03), float4(0.2, -0.98, 7.3, 0.016) };
constant float HB_SWELL_SPEED[3] = { 2.6, 2.1, 1.7 };

struct HBSea {
    float2 slope;
    float heave;
    float tiltX, tiltZ;
    float exposure;
    float distance;
};

IV_SHADER_FN float2 hbWaveLayer(thread const IVProgramTextures &t, float3 p, float time, float scale, float vx, float vz) {
    return t.waves.sample(hbWaveSampler, p.xz / scale + float2(vx, vz) * time).xy * 2.0 - 1.0;
}

IV_SHADER_FN HBSea hbSea(thread const IVSurface &s, thread const IVProgramTextures &t) {
    float quay = s.rows[IV_HB_WATER].x;
    float originZ = quay - 0.3 + 450.0;  // water.ts ORIGIN_Z
    HBSea sea;
    sea.distance = length(s.p - s.cameraPosition);
    float near = 1.0 - smoothstep(8.0, 70.0, sea.distance);
    sea.slope = hbWaveLayer(t, s.p, s.time, 6.1, 0.021, 0.013) * 0.55 + hbWaveLayer(t, s.p, s.time, 15.7, -0.009, 0.012) * 0.7
        + hbWaveLayer(t, s.p, s.time, 2.3, 0.04, -0.031) * 0.3 + hbWaveLayer(t, s.p, s.time, 0.83, -0.06, 0.05) * (near * 0.22);
    float wx = s.localP.x;
    float wz = s.localP.z + originZ;
    sea.exposure = mix(0.55, 1.0, smoothstep(quay + 20.0, quay + 60.0, wz)) * (smoothstep(quay - 0.3, quay + 2.5, wz) * 0.6 + 0.4);
    sea.heave = 0.0;
    sea.tiltX = 0.0;
    sea.tiltZ = 0.0;
    for (int i = 0; i < 3; i++) {
        float4 w = HB_SWELLS[i];
        float k = 2.0 * M_PI_F / w.z;
        float phase = wx * (w.x * k) + wz * (w.y * k) - s.time * (HB_SWELL_SPEED[i] * k);
        sea.heave += sin(phase) * w.w;
        sea.tiltX += cos(phase) * (w.w * k * w.x);
        sea.tiltZ += cos(phase) * (w.w * k * w.y);
    }
    return sea;
}

IV_SHADER_FN void ivHarborSeaNormal(thread IVSurface &s, thread const IVProgramTextures &t) {
    HBSea sea = hbSea(s, t);
    float calm = mix(1.0, 0.6, smoothstep(60.0, 500.0, sea.distance));
    float strength = 0.4 * calm;
    float swellTilt = sea.exposure * (1.0 - smoothstep(60.0, 420.0, sea.distance)) * 1.6;
    s.normal = normalize(float3(-(sea.slope.x * strength + sea.tiltX * swellTilt), 1.0, -(sea.slope.y * strength + sea.tiltZ * swellTilt)));
}

/// band(gap, width): foam `width` metres wide against an edge, moved by the lap of the water.
IV_SHADER_FN float hbFoamBand(float gap, float width, float lap) { return ivSmoothstep(width, 0.04, gap + lap * width * 0.55); }

IV_SHADER_FN void ivHarborSea(thread IVSurface &s, thread const IVProgramTextures &t) {
    HBSea sea = hbSea(s, t);
    float4 water = s.rows[IV_HB_WATER];
    float quay = water.x;
    float3 p = s.p;
    float shore = ivSmoothstep(quay + 14.0, quay, p.z);
    float crest = (sea.slope.x + sea.slope.y) * 0.5 + 0.5;
    float3 body = mix(ivHexColor(0x0b3340u), ivHexColor(0x1f4f47u), shore * 0.7) * mix(0.92, 1.07, crest);
    float lap = sin(s.time * 1.1 + p.x * 0.7) * 0.12 + sea.heave * 2.2 + (crest - 0.5) * 0.5;
    float2 mole = s.rows[IV_HB_MOLE].xy;
    float3 slip = s.rows[IV_HB_SLIPWAY].xyz;
    float alongQuay = hbFoamBand(p.z - quay, 0.75, lap) * step(mole.x, p.x);
    float alongMole = hbFoamBand(p.x - mole.x, 0.7, lap) * step(p.z, mole.y + 0.6) + hbFoamBand(abs(p.z - mole.y), 0.9, lap) * step(p.x, mole.x + 0.4);
    float onSlip = hbFoamBand(abs(p.z - (slip.z - 6.2)), 1.1, lap) * step(slip.x, p.x) * step(p.x, slip.y);
    float piles = 0.0;
    uint jetties = uint(water.w);
    for (uint i = 0; i < jetties; i++) {
        float4 j = s.rows[IV_HB_JETTIES + i];  // x, width, length, head
        float side = abs(p.x - j.x) - (j.y / 2.0 + 0.1);
        float bays = max(2.0, floor((j.z - 0.06) / 3.2 + 0.5));  // Math.round
        float pitch = (j.z - 0.06) / bays;
        float alongJetty = (p.z - (quay + 0.06 - 0.25)) / pitch;
        float toPile = (alongJetty - rint(alongJetty)) * pitch;  // WGSL round: half to even
        float ring = sqrt(side * side + toPile * toPile);
        float inRun = step(quay + 1.0, p.z) * step(p.z, quay + j.z + 0.3);
        piles = max(piles, hbFoamBand(ring - 0.16, 0.5, lap) * inRun);
    }
    float edge = max(max(alongQuay, alongMole), max(onSlip, piles));
    float lace = smoothstep(0.3, 0.62, crest + hbWaveLayer(t, p, s.time, 1.1, 0.03, 0.02).x * 0.55);
    float open = smoothstep(quay + 34.0, quay + 80.0, p.z) * (1.0 - smoothstep(90.0, 300.0, sea.distance));
    float whitecap = smoothstep(0.78, 0.9, crest + hbWaveLayer(t, p, s.time, 31.0, 0.011, -0.006).x * 0.3 + sea.heave * 2.5) * open * 0.55;
    float atSea = step(p.y, water.y + 0.5);
    float froth = max(edge * mix(0.35, 1.0, lace), whitecap) * atSea;
    s.color = mix(body, ivHexColor(0xd6ddd6u), froth * 0.8);
    s.emissive = mix(ivHexColor(0x0d4650u), ivHexColor(0x2a6b62u), shore * 0.6) * 0.2;
    s.roughness = mix(0.06, 0.16, smoothstep(40.0, 400.0, sea.distance)) + froth * 0.5;
}
#endif  // IRONVALE_MAP_HARBOR_WATER

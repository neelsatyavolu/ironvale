// Headworks overlays of src/maps/headworks/decals.ts at commit 3ec2f09: stains, run-off, line
// paint and tyre marks. Their colour is the vertex colour; these programs set opacity (and the
// worn line paint's grey). The sign atlas has no nodes and draws generically.
#ifndef IRONVALE_MAP_HEADWORKS_DECALS
#define IRONVALE_MAP_HEADWORKS_DECALS
#include "MapSurface.h"
#include "Noise.metal"

IV_SHADER_FN void ivHeadworksStain(thread IVSurface &s) {
    float fromCentre = length(s.uv - 0.5) * 2.0;
    float shape = ivMxNoise(s.p * 1.9) * 0.5 + 0.5;
    float speckle = ivMxNoise(s.p * 13.0) * 0.5 + 0.5;
    float body = 1.0 - smoothstep(0.3, 1.0, fromCentre + (shape - 0.5) * 0.8);
    s.opacity = body * mix(0.55, 1.0, speckle) * 0.92;
}

IV_SHADER_FN void ivHeadworksRunOff(thread IVSurface &s) {
    float2 st = s.uv;
    float across = abs(st.x - 0.5) * 2.0;
    float spread = mix(1.0, 0.3, st.y);
    float core = 1.0 - smoothstep(spread * 0.25, spread, across);
    float threads = ivMxNoise(float3(s.p.x * 14.0 + s.p.z * 14.0, s.p.y * 0.9, 2.0)) * 0.5 + 0.5;
    float fade = smoothstep(0.0, 0.7, st.y);
    s.opacity = core * fade * mix(0.35, 1.0, threads) * 0.78;
}

IV_SHADER_FN void ivHeadworksLinePaint(thread IVSurface &s) {
    float coarse = ivMxNoise(s.p.xz * 1.4) * 0.5 + 0.5;
    float fine = ivMxNoise(s.p.xz * 16.0) * 0.5 + 0.5;
    s.opacity = smoothstep(0.3, 0.36, coarse * 0.45 + fine * 0.55);
    s.color = float3(mix(0.6, 1.0, fine));
}

IV_SHADER_FN void ivHeadworksTyreMarks(thread IVSurface &s) {
    float2 st = s.uv;
    float track = 1.0 - smoothstep(0.1, 0.16, abs(abs(st.x - 0.5) - 0.36));
    float tread = mix(0.55, 1.0, smoothstep(0.3, 0.5, abs(fract(st.y * 60.0) - 0.5)));
    float patchy = smoothstep(0.3, 0.7, ivMxNoise(s.p.xz * 0.7) * 0.5 + 0.5);
    float ends = smoothstep(0.0, 0.2, st.y) * smoothstep(0.0, 0.2, 1.0 - st.y);
    s.opacity = track * tread * patchy * ends * 0.5;
}
#endif  // IRONVALE_MAP_HEADWORKS_DECALS

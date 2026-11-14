// Headworks level materials of src/maps/headworks/materials.ts at commit 3ec2f09 that carry their
// own nodes: the plain `matte` surface, the glazing (dark rooms behind slat blinds) and the still
// process water. The rest of createMaterials comes from surfaces.ts and decals.ts.
#ifndef IRONVALE_MAP_HEADWORKS_MATERIALS
#define IRONVALE_MAP_HEADWORKS_MATERIALS
#include "MapSurface.h"
#include "Noise.metal"

IV_SHADER_FN void ivHeadworksMatte(thread IVSurface &s) {
    s.color = float3(mix(0.8, 1.05, ivWorldNoise(s.p, 2.4) * 0.6 + ivWorldNoise(s.p, 17.0) * 0.4));
}

/// Glazing seen from outside by day: a dark room, pale slat blinds drawn to a different height in each bay.
IV_SHADER_FN void ivHeadworksGlass(thread IVSurface &s) {
    float3 p = s.p;
    float bay = floor((p.x + p.z) / 1.8) + 400.0;
    float drawn = step(fract(p.y / 1.8), mix(0.25, 1.0, ivTslHash(bay + 90.0)));
    float slat = smoothstep(0.25, 0.4, fract(p.y / 0.045));
    s.color = mix(float3(0.035, 0.05, 0.06), mix(float3(0.2, 0.21, 0.2), float3(0.5, 0.5, 0.47), slat),
                  (1.0 - drawn) * step(0.35, ivTslHash(bay + 7.0)));
}

/// Still, slightly green water; a low world-space ripple replaces the normal.
IV_SHADER_FN void ivHeadworksWaterNormal(thread IVSurface &s) {
    float ripple = ivMxNoise(s.p.xz * 1.3);
    float ripple2 = ivMxNoise(s.p.xz * 1.3 + float2(31.0, 17.0));
    s.normal = normalize(float3(ripple * 0.03, 1.0, ripple2 * 0.03));
}
#endif  // IRONVALE_MAP_HEADWORKS_MATERIALS

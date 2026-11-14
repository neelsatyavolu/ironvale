// Harbor grime: the noise-atlas sampler, the wall and ground coordinates and the street height
// under a wall (groundLevel, heightAboveStreet) of src/maps/harbor/grime.ts at commit 3ec2f09.
// The atlas itself is the exported DataTexture (programTextures.grime); the terrace layout comes
// from scene.json programRows (IV_HB_*).
#ifndef IRONVALE_MAP_HARBOR_GRIME
#define IRONVALE_MAP_HARBOR_GRIME
#include "MapSurface.h"

constexpr sampler hbGrimeSampler(filter::linear, mip_filter::linear, address::repeat);

/// grimeSampler(map)(coord, scale, offset): the atlas in metres, `scale` the size one repeat covers.
IV_SHADER_FN float4 hbGrime(thread const IVProgramTextures &t, float2 coord, float scale, float offset = 0.0) {
    return t.grime.sample(hbGrimeSampler, coord / scale + offset);
}

IV_SHADER_FN float2 hbWallCoord(float3 p) { return float2(p.x + p.z, p.y); }

/// surfaces.ts surfaceCoord: the wall coordinate, or the ground one on flat tops.
IV_SHADER_FN float2 hbSurfaceCoord(float3 p, float3 n) { return mix(hbWallCoord(p), p.xz, step(0.7, abs(n.y))); }

/// TSL mod(): x - y floor(x / y).
IV_SHADER_FN float hbMod(float x, float y) { return x - y * floor(x / y); }

IV_SHADER_FN float hbGroundLevel(float3 p, constant float4 *rows) {
    float4 tz = rows[IV_HB_TIER_Z], ty = rows[IV_HB_TIER_Y];
    float terrace = rows[IV_HB_HEIGHTS].z;
    float tiers = step(p.z, tz.x) * ty.x + step(p.z, tz.y) * (ty.y - ty.x) + step(p.z, tz.z) * (ty.z - ty.y);
    float4 alleyRow = rows[IV_HB_ALLEY], rampRow = rows[IV_HB_RAMP];
    float inAlley = step(alleyRow.x - 0.3, p.x) * step(p.x, alleyRow.y + 0.3);
    float alley = clamp((alleyRow.z - p.z) / alleyRow.w, 0.0, 1.0) * terrace;
    float inRamp = step(rampRow.x - 0.3, p.x) * step(p.x, rampRow.y + 0.3);
    float ramp = clamp((rampRow.w - p.z) / (rampRow.w - rampRow.z), 0.0, 1.0) * terrace;
    return max(tiers, max(inAlley * alley, inRamp * ramp));
}

/// Height of a wall fragment above the street it stands on.
IV_SHADER_FN float hbHeightAboveStreet(float3 p, constant float4 *rows) { return p.y - hbGroundLevel(p, rows); }
#endif  // IRONVALE_MAP_HARBOR_GRIME

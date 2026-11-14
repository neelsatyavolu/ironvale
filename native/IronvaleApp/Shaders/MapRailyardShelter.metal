// Sky visibility: skyVisibility() of src/maps/railyard/shelter.ts at commit cbe0add. The plan
// numbers (shed, mezzanine, office) come from scene.json programParams, not from this file.
#ifndef IRONVALE_MAP_RAILYARD_SHELTER
#define IRONVALE_MAP_RAILYARD_SHELTER
#include "MapSurface.h"

constant float SHED_FLOOR = 0.14;
constant float UNDER_DECK = 0.55;
constant float OFFICE_FLOOR = 0.24;

IV_SHADER_FN float between(float v, float low, float high) { return step(low, v) * step(v, high); }

IV_SHADER_FN float ivRailyardSkyVisibility(float3 p, constant float4 *params) {
    float4 wa = params[IV_RY_WAREHOUSE_A];  // west, east, north, south
    float4 wb = params[IV_RY_WAREHOUSE_B];  // eaves, ridge, door west, door east
    float4 mezz = params[IV_RY_MEZZANINE];  // east, north, south, top
    float4 oa = params[IV_RY_OFFICE_A];     // west, east, north, south
    float officeHeight = params[IV_RY_OFFICE_B].x;
    float west = wa.x, east = wa.y, north = wa.z, south = wa.w;
    float eaves = wb.x, ridge = wb.y;

    float ridgeX = (west + east) / 2.0;
    float halfSpan = (east - west) / 2.0;
    float roofY = ridge - abs(p.x - ridgeX) / halfSpan * (ridge - eaves);
    float inShed = between(p.x, west + 0.1, east - 0.02) * between(p.z, north - 0.02, south + 0.02) * step(p.y, roofY + 0.02);

    float doorX = (wb.z + wb.w) / 2.0;
    float acrossDoor = 1.0 - smoothstep(3.5, 9.0, abs(p.x - doorX));
    float fromEast = smoothstep(east - 8.0, east + 0.5, p.x) * (1.0 - smoothstep(4.5, 7.5, p.y));
    float fromNorth = (1.0 - smoothstep(north, north + 9.0, p.z)) * acrossDoor;
    float fromSouth = smoothstep(south - 7.0, south, p.z) * acrossDoor;
    float daylight = max(fromEast * 0.8, max(fromNorth * 0.75, fromSouth * 0.55));
    float underDeck = step(p.x, mezz.x) * between(p.z, mezz.y, mezz.z) * step(p.y, mezz.w - 0.08);
    float shed = mix(SHED_FLOOR, 1.0, daylight) * mix(1.0, UNDER_DECK, underDeck);

    float inOffice = between(p.x, oa.x + 0.05, oa.y - 0.05) * between(p.z, oa.z + 0.05, oa.w - 0.05) * step(p.y, officeHeight - 0.1);
    return mix(mix(1.0, shed, inShed), OFFICE_FLOOR, inOffice);
}
#endif  // IRONVALE_MAP_RAILYARD_SHELTER

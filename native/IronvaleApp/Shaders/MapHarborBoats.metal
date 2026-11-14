// Harbor boats: boatMaterial() of src/maps/harbor/boats.ts at commit 3ec2f09. Vertex paint
// (attribute 'paint': rgb, and a = 1 on the planking, 2 on the lettering decals) with antifouling
// below the waterline, weed along it, rust weeps, salt and bare patches; the decals cut their
// letters from the lettering atlas (programTextures.lettering, uv 'duv'). DRAFT comes from rows.
#ifndef IRONVALE_MAP_HARBOR_BOATS
#define IRONVALE_MAP_HARBOR_BOATS
#include "MapSurface.h"
#include "MapHarborGrime.metal"

IV_SHADER_FN void ivHarborBoat(thread IVSurface &s, thread const IVProgramTextures &t, bool letteringFlipY) {
    float4 paint = s.boatPaint;
    float isHull = step(0.5, paint.a) * step(paint.a, 1.5);
    float isDecal = step(1.5, paint.a);
    float y = s.localP.y;
    float2 coord = float2(s.localP.x + s.localP.z * 0.6, y);
    float blotch = hbGrime(t, coord, 1.7).r;
    float fine = hbGrime(t, coord, 0.33).b;
    float drips = hbGrime(t, coord, 1.1, 0.23).g;
    float islands = hbGrime(t, coord, 2.6, 0.41).a;
    float waterline = s.rows[IV_HB_WATER].z + (blotch - 0.5) * 0.05;
    float below = (1.0 - smoothstep(-0.02, 0.025, y - waterline)) * isHull;
    float slime = (1.0 - smoothstep(0.0, 0.17, abs(y - waterline - 0.03))) * mix(0.45, 1.0, fine) * isHull;
    float weep = smoothstep(0.6, 0.92, drips) * smoothstep(0.0, 0.35, y - waterline) * isHull;
    float bare = smoothstep(0.79, 0.82, islands + (fine - 0.5) * 0.12) * isHull;
    float salt = (1.0 - smoothstep(0.05, 0.3, y - waterline)) * smoothstep(0.55, 0.8, fine) * isHull;
    float3 coat = paint.rgb * mix(0.78, 1.06, fine) * mix(0.85, 1.06, blotch);
    float3 worn = mix(coat, ivHexColor(0x6f5d47u) * mix(0.6, 1.1, fine), bare * 0.85);
    float3 streaked = mix(worn, worn * ivHexColor(0x9a6a48u), weep * 0.65);
    float3 antifoul = ivHexColor(0x5a2a23u) * mix(0.6, 1.15, fine) * mix(0.8, 1.1, blotch);
    float3 wetted = mix(mix(streaked, antifoul, below), ivHexColor(0x39472au), slime * 0.7);
    s.color = mix(wetted, ivHexColor(0xd9d6cbu), salt * 0.35);
    s.roughness = mix(mix(0.62, 0.9, bare), 0.28, max(below, slime * 0.8));
    constexpr sampler letters(filter::linear, mip_filter::linear, address::clamp_to_edge);
    float2 duv = letteringFlipY ? float2(s.boatDuv.x, 1.0 - s.boatDuv.y) : s.boatDuv;
    s.opacity = mix(1.0, t.lettering.sample(letters, duv).a, isDecal);
}
#endif  // IRONVALE_MAP_HARBOR_BOATS

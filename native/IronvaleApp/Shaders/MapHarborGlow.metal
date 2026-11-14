// Harbor lamp pools: the colour node of addGlow() in src/maps/harbor/glow.ts at commit 3ec2f09.
// Instanced quads drawn additively (AdditiveBlending), broken up by the grime atlas.
#ifndef IRONVALE_MAP_HARBOR_GLOW
#define IRONVALE_MAP_HARBOR_GLOW
#include "MapSurface.h"
#include "MapHarborGrime.metal"

IV_SHADER_FN void ivHarborGlow(thread IVSurface &s, thread const IVProgramTextures &t) {
    float fromCentre = length(s.uv - 0.5) * 2.0;
    float falloff = pow(1.0 - smoothstep(0.05, 1.0, fromCentre), 2.2);
    float mottle = t.grime.sample(hbGrimeSampler, (s.p.xz + s.p.y) / 3.7).r * 0.5 + 0.75;
    s.color = float3(1.0, 0.56, 0.22) * falloff * mottle * 0.42;
}
#endif  // IRONVALE_MAP_HARBOR_GLOW

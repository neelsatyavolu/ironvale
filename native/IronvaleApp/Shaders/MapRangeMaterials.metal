// Test range: applyWetness() of src/render/materials.ts at commit 3ec2f09, the only node program
// on the range (its wet ground concrete). Wetness and puddle scale come from scene.json
// programRows (IV_RG_WETNESS).
#ifndef IRONVALE_MAP_RANGE_MATERIALS
#define IRONVALE_MAP_RANGE_MATERIALS
#include "MapSurface.h"
#include "Noise.metal"

IV_SHADER_FN void ivRangeWetConcrete(thread IVSurface &s) {
    float wetness = s.rows[IV_RG_WETNESS].x;
    float puddleScale = s.rows[IV_RG_WETNESS].y;
    float noise = ivMxNoise(s.p.xz / puddleScale) * 0.5 + 0.5;
    float detail = ivMxNoise(s.p.xz / (puddleScale * 0.23)) * 0.5 + 0.5;
    float facingUp = smoothstep(0.85, 0.98, s.n.y);
    float threshold = 1.0 - wetness * 0.75;
    float puddle = smoothstep(threshold, threshold + 0.12, noise * 0.75 + detail * 0.25) * facingUp;
    s.color = s.materialColor * mix(1.0, 0.62, wetness * 0.8) * mix(1.0, 0.7, puddle);
    s.roughness = mix(s.materialRoughness * mix(1.0, 0.55, wetness), 0.04, puddle);
}
#endif  // IRONVALE_MAP_RANGE_MATERIALS

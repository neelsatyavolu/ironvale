// Harbor street shade: shadeTerms() and shadeLit() of src/maps/harbor/shade.ts at commit 3ec2f09.
// The bake (sky seen from the street, bounce, roof line, dry paving) is the exported DataTexture
// (programTextures.shade), sampled in plan; shadeLit scales the material's occlusion by `ambient`
// and adds diffuseColor x bounce x 0.55 as emission.
#ifndef IRONVALE_MAP_HARBOR_SHADE
#define IRONVALE_MAP_HARBOR_SHADE
#include "MapSurface.h"
#include "MapHarborGrime.metal"

struct HBShadeTerms {
    float ambient;
    float3 bounce;
    float dry;
    float street;
};

constexpr sampler hbShadeSampler(filter::linear, address::clamp_to_edge);

IV_SHADER_FN HBShadeTerms hbShadeTerms(float3 p, float3 n, constant float4 *rows, texture2d<float> shade) {
    float4 grid = rows[IV_HB_SHADE_GRID];
    float2 plan = p.xz + n.xz * 0.7;
    float4 sample = shade.sample(hbShadeSampler, (plan - grid.xy) / grid.zw);
    float heightRange = rows[IV_HB_HEIGHTS].x, heightFloor = rows[IV_HB_HEIGHTS].y;
    float h = hbHeightAboveStreet(p, rows);
    float ground = p.y - h;
    float roof = sample.b * heightRange + heightFloor;
    float hasRoof = smoothstep(0.004, 0.02, sample.b);
    float rise = max(roof - ground, 2.5);
    float up = clamp(h / rise, 0.0, 1.0);
    float sky = mix(sample.r, 1.0, up * up);
    float upright = 1.0 - smoothstep(0.5, 0.8, abs(n.y));
    float eave = smoothstep(roof - 1.5, roof - 0.05, p.y) * (1.0 - smoothstep(roof + 0.1, roof + 0.3, p.y)) * upright * hasRoof;
    float foot = (1.0 - smoothstep(0.0, 0.5, h)) * upright;
    HBShadeTerms t;
    t.ambient = mix(0.24, 1.0, sky) * mix(1.0, 0.5, eave) * mix(1.0, 0.78, foot);
    float fade = mix(1.0, 0.3, smoothstep(0.4, 7.0, h));
    float level = mix(1.0, 0.4, smoothstep(0.6, 0.9, n.y));
    t.bounce = float3(1.0, 0.6, 0.32) * sample.g * fade * level;
    t.dry = sample.a;
    t.street = sample.r;
    return t;
}

/// shadeLit(material, terms): the default bounce share.
constant float HB_BOUNCE = 0.55;
#endif  // IRONVALE_MAP_HARBOR_SHADE

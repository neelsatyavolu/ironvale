// First-person stand-in gun (IronvaleViewModel, M4). Shapes come from src/weapons/view/fallback.ts
// through native/Contract/sim/fallback-guns.json; the TSL gun materials (src/weapons/models/
// materials.ts) are approximated by a sun + hemisphere light with the materials' colour, roughness
// and metalness. Full gun materials, arms and the view rig are M9.
#include <metal_stdlib>
using namespace metal;

struct IVViewModelUniforms {
    float4x4 viewProjection;   // view-model camera: camera space -> clip
    float4x4 model;            // gun -> camera space
    float4 sunDirection;       // camera space, towards the sun; w unused
    float4 sunColor;           // linear rgb * intensity
    float4 skyColor;
    float4 groundColor;
};

struct IVViewModelVertex {
    packed_float3 position;
    packed_float3 normal;
    packed_float4 color;       // linear rgb + opacity
    packed_float2 material;    // roughness, metalness
};

struct VMOut {
    float4 position [[position]];
    float3 normal;
    float3 viewPosition;
    float4 color;
    float2 material;
};

vertex VMOut ivViewModelVertex(uint vid [[vertex_id]],
                               const device IVViewModelVertex *vertices [[buffer(0)]],
                               constant IVViewModelUniforms &u [[buffer(1)]]) {
    IVViewModelVertex v = vertices[vid];
    float4 p = u.model * float4(float3(v.position), 1.0);
    VMOut out;
    out.position = u.viewProjection * p;
    out.normal = normalize((u.model * float4(float3(v.normal), 0.0)).xyz);
    out.viewPosition = p.xyz;
    out.color = float4(v.color);
    out.material = float2(v.material);
    return out;
}

static inline float3 ivLinearToSRGB(float3 c) {
    c = max(c, 0.0);
    return select(1.055 * pow(c, 1.0 / 2.4) - 0.055, c * 12.92, c <= 0.0031308);
}

// ACES filmic (three's fitted curve), as the map's post pass uses, so the gun sits in the same image.
static inline float3 ivACES(float3 color) {
    const float3x3 inMat = float3x3(float3(0.59719, 0.07600, 0.02840), float3(0.35458, 0.90834, 0.13383), float3(0.04823, 0.01566, 0.83777));
    const float3x3 outMat = float3x3(float3(1.60475, -0.10208, -0.00327), float3(-0.53108, 1.10813, -0.07276), float3(-0.07367, -0.00605, 1.07602));
    color *= 1.0 / 0.6;
    color = inMat * color;
    float3 a = color * (color + 0.0245786) - 0.000090537;
    float3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
    return clamp(outMat * (a / b), 0.0, 1.0);
}

fragment float4 ivViewModelFragment(VMOut in [[stage_in]], bool front [[front_facing]],
                                    constant IVViewModelUniforms &u [[buffer(1)]]) {
    float3 n = normalize(in.normal);
    float3 v = normalize(-in.viewPosition);
    float3 l = normalize(u.sunDirection.xyz);
    float roughness = clamp(in.material.x, 0.04, 1.0);
    float metalness = in.material.y;
    float3 base = in.color.rgb;
    float3 diffuse = base * (1.0 - metalness);
    float3 f0 = mix(float3(0.04), base, metalness);
    float ndl = saturate(dot(n, l));
    float3 h = normalize(l + v);
    float ndh = saturate(dot(n, h));
    float a2 = roughness * roughness * roughness * roughness;
    float d = a2 / (M_PI_F * pow(ndh * ndh * (a2 - 1.0) + 1.0, 2.0));
    float3 specular = f0 * d * 0.25;
    float hemi = n.y * 0.5 + 0.5;
    float3 ambient = mix(u.groundColor.rgb, u.skyColor.rgb, hemi) * (diffuse + f0 * 0.5);
    float3 lit = ambient + (diffuse / M_PI_F + specular) * u.sunColor.rgb * ndl;
    return float4(ivLinearToSRGB(ivACES(lit)), in.color.a);
}

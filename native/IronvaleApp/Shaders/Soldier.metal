// M7a: the third-person soldier and its carbine (PLAN.md 3.4, maps/ai-characters.md 3).
// GPU skinning with four joints per vertex from a per-soldier palette, instanced over every soldier,
// three's MeshStandardMaterial lighting (the same model as MapPBR.metal: GGX/Smith/Schlick, Lambert,
// DFGApprox multi-scatter, prefiltered environment, sun shadow, hemisphere and punctual lights, fog)
// and the team tint of src/characters/rig.ts teamMaterial at commit f14381f:
//   colorNode = mix(base, tintColor * dot(base, luma) * gain, cloth * amount), cloth = packed map R.
// A rigid variant draws the carbine, and a depth-only variant feeds the sun shadow map.
#include <metal_stdlib>
#include "ShaderTypes.h"
#include "Common.h"
using namespace metal;

struct SoldierVaryings {
    float4 position [[position]];
    float3 worldPosition;
    float3 worldNormal;
    float2 uv;
    float viewZ;
    uint team [[flat]];
};

static float4x4 skinMatrix(device const ushort4 *joints, device const float4 *weights, device const float4x4 *palette,
                           uint vid, uint offset) {
    ushort4 j = joints[vid];
    float4 w = weights[vid];
    return palette[offset + j.x] * w.x + palette[offset + j.y] * w.y + palette[offset + j.z] * w.z + palette[offset + j.w] * w.w;
}

vertex SoldierVaryings ivSoldierVertex(uint vid [[vertex_id]],
                                       uint iid [[instance_id]],
                                       device const packed_float3 *positions [[buffer(IV_SOLDIER_BUFFER_POSITION)]],
                                       device const packed_float3 *normals [[buffer(IV_SOLDIER_BUFFER_NORMAL)]],
                                       device const packed_float2 *uvs [[buffer(IV_SOLDIER_BUFFER_UV)]],
                                       device const ushort4 *joints [[buffer(IV_SOLDIER_BUFFER_JOINTS)]],
                                       device const float4 *weights [[buffer(IV_SOLDIER_BUFFER_WEIGHTS)]],
                                       device const IVSoldierInstance *instances [[buffer(IV_SOLDIER_BUFFER_INSTANCES)]],
                                       device const float4x4 *palette [[buffer(IV_SOLDIER_BUFFER_PALETTE)]],
                                       constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]]) {
    IVSoldierInstance inst = instances[iid];
    float4x4 m = inst.model * skinMatrix(joints, weights, palette, vid, inst.paletteOffset);
    float4 world = m * float4(float3(positions[vid]), 1.0);
    SoldierVaryings out;
    out.position = frame.viewProjection * world;
    out.worldPosition = world.xyz;
    // Joint matrices are rigid (no scale), so the 3x3 transforms normals directly.
    out.worldNormal = float3x3(m[0].xyz, m[1].xyz, m[2].xyz) * float3(normals[vid]);
    out.uv = float2(uvs[vid]);
    out.viewZ = (frame.view * world).z;
    out.team = inst.team;
    return out;
}

vertex SoldierVaryings ivSoldierRigidVertex(uint vid [[vertex_id]],
                                            uint iid [[instance_id]],
                                            device const packed_float3 *positions [[buffer(IV_SOLDIER_BUFFER_POSITION)]],
                                            device const packed_float3 *normals [[buffer(IV_SOLDIER_BUFFER_NORMAL)]],
                                            device const packed_float2 *uvs [[buffer(IV_SOLDIER_BUFFER_UV)]],
                                            device const IVSoldierInstance *instances [[buffer(IV_SOLDIER_BUFFER_INSTANCES)]],
                                            constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]]) {
    IVSoldierInstance inst = instances[iid];
    float4 world = inst.model * float4(float3(positions[vid]), 1.0);
    SoldierVaryings out;
    out.position = frame.viewProjection * world;
    out.worldPosition = world.xyz;
    out.worldNormal = float3x3(inst.model[0].xyz, inst.model[1].xyz, inst.model[2].xyz) * float3(normals[vid]);
    out.uv = float2(uvs[vid]);
    out.viewZ = (frame.view * world).z;
    out.team = inst.team;
    return out;
}

vertex float4 ivSoldierShadowVertex(uint vid [[vertex_id]],
                                    uint iid [[instance_id]],
                                    device const packed_float3 *positions [[buffer(IV_SOLDIER_BUFFER_POSITION)]],
                                    device const ushort4 *joints [[buffer(IV_SOLDIER_BUFFER_JOINTS)]],
                                    device const float4 *weights [[buffer(IV_SOLDIER_BUFFER_WEIGHTS)]],
                                    device const IVSoldierInstance *instances [[buffer(IV_SOLDIER_BUFFER_INSTANCES)]],
                                    device const float4x4 *palette [[buffer(IV_SOLDIER_BUFFER_PALETTE)]],
                                    constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]]) {
    IVSoldierInstance inst = instances[iid];
    float4x4 m = inst.model * skinMatrix(joints, weights, palette, vid, inst.paletteOffset);
    return frame.shadowViewProjection * (m * float4(float3(positions[vid]), 1.0));
}

vertex float4 ivSoldierRigidShadowVertex(uint vid [[vertex_id]],
                                         uint iid [[instance_id]],
                                         device const packed_float3 *positions [[buffer(IV_SOLDIER_BUFFER_POSITION)]],
                                         device const IVSoldierInstance *instances [[buffer(IV_SOLDIER_BUFFER_INSTANCES)]],
                                         constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]]) {
    return frame.shadowViewProjection * (instances[iid].model * float4(float3(positions[vid]), 1.0));
}

// ---- Lighting: the MapPBR.metal model (three r180 PhysicalLightingModel), kept local to this file ----

static float3 svFresnel(float3 f0, float f90, float dotVH) {
    float fresnel = exp2((-5.55473 * dotVH - 6.98316) * dotVH);
    return f0 * (1.0 - fresnel) + f90 * fresnel;
}

static float3 svBRDF_GGX(float3 l, float3 v, float3 n, float3 f0, float f90, float roughness) {
    float alpha = roughness * roughness;
    float a2 = alpha * alpha;
    float3 h = normalize(l + v);
    float dotNL = saturate(dot(n, l));
    float dotNV = saturate(dot(n, v));
    float dotNH = saturate(dot(n, h));
    float dotVH = saturate(dot(v, h));
    float gv = dotNL * sqrt(a2 + (1.0 - a2) * dotNV * dotNV);
    float gl = dotNV * sqrt(a2 + (1.0 - a2) * dotNL * dotNL);
    float vis = 0.5 / max(gv + gl, 1e-6);
    float denom = dotNH * dotNH * (a2 - 1.0) + 1.0;
    float d = IV_RECIPROCAL_PI * a2 / (denom * denom);
    return svFresnel(f0, f90, dotVH) * vis * d;
}

static float2 svDFGApprox(float dotNV, float roughness) {
    const float4 c0 = float4(-1.0, -0.0275, -0.572, 0.022);
    const float4 c1 = float4(1.0, 0.0425, 1.04, -0.04);
    float4 r = roughness * c0 + c1;
    float a004 = min(r.x * r.x, exp2(-9.28 * dotNV)) * r.x + r.y;
    return float2(-1.04, 1.04) * a004 + r.zw;
}

static float svDistanceAttenuation(float d, float cutoff, float decay) {
    float falloff = 1.0 / max(pow(d, decay), 0.01);
    if (cutoff > 0.0) {
        float x = saturate(1.0 - pow(d / cutoff, 4.0));
        falloff *= x * x;
    }
    return falloff;
}

static float3 svPerturbNormal(float3 p, float3 n, float2 uv, float3 mapN, float faceDirection) {
    float3 q0 = dfdx(p);
    float3 q1 = -dfdy(p);
    float2 st0 = dfdx(uv);
    float2 st1 = -dfdy(uv);
    float3 q1perp = cross(q1, n);
    float3 q0perp = cross(n, q0);
    float3 t = q1perp * st0.x + q0perp * st1.x;
    float3 b = q1perp * st0.y + q0perp * st1.y;
    float det = max(dot(t, t), dot(b, b));
    float scale = det == 0.0 ? 0.0 : faceDirection * rsqrt(det);
    return normalize(t * (mapN.x * scale) + b * (mapN.y * scale) + n * mapN.z);
}

static float svSunShadow(constant IVFrameUniforms &frame, depth2d<float> shadowMap, float3 worldPos, float3 normal) {
    if (frame.shadowEnabled == 0.0) return 1.0;
    float4 clip = frame.shadowViewProjection * float4(worldPos + normal * frame.shadowNormalBias, 1.0);
    float3 ndc = clip.xyz / clip.w;
    float2 uv = float2(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    if (any(uv < 0.0) || any(uv > 1.0) || ndc.z < 0.0 || ndc.z > 1.0) return 1.0;
    constexpr sampler cmp(coord::normalized, filter::linear, address::clamp_to_edge, compare_func::less_equal);
    float depth = ndc.z + frame.shadowBias;
    float2 texel = 1.0 / float2(shadowMap.get_width(), shadowMap.get_height());
    float sum = 0.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) sum += shadowMap.sample_compare(cmp, uv + float2(x, y) * texel, depth);
    }
    return sum / 9.0;
}

fragment float4 ivSoldierFragment(SoldierVaryings in [[stage_in]],
                                  bool frontFacing [[front_facing]],
                                  constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                                  constant IVLight *lights [[buffer(IV_BUFFER_LIGHTS)]],
                                  constant IVSoldierMaterial &mat [[buffer(IV_SOLDIER_BUFFER_MATERIAL)]],
                                  texture2d<float> colorTex [[texture(IV_SOLDIER_TEXTURE_COLOR)]],
                                  texture2d<float> normalTex [[texture(IV_SOLDIER_TEXTURE_NORMAL)]],
                                  texture2d<float> ormTex [[texture(IV_SOLDIER_TEXTURE_ORM)]],
                                  texture2d<float> environment [[texture(IV_TEXTURE_ENVIRONMENT)]],
                                  depth2d<float> shadowMap [[texture(IV_TEXTURE_SHADOW)]]) {
    constexpr sampler material(filter::linear, mip_filter::linear, address::repeat, max_anisotropy(8));
    // glTF textures are not flipped (GLTFLoader sets flipY = false).
    float2 uv = in.uv;
    float3 base = colorTex.sample(material, uv).rgb;
    float3 orm = ormTex.sample(material, uv).rgb;
    if (mat.teamTint != 0) {
        float4 tint = mat.tint[min(in.team, 1u)];
        float value = dot(base, float3(0.2126, 0.7152, 0.0722));
        base = mix(base, tint.rgb * value, orm.r * tint.a);
    }

    float faceDirection = frontFacing ? 1.0 : -1.0;
    float3 geometryNormal = normalize(in.worldNormal) * faceDirection;
    float3 mapN = normalTex.sample(material, uv).xyz * 2.0 - 1.0;
    mapN.xy *= mat.normalScale;
    float3 n = svPerturbNormal(in.worldPosition, geometryNormal, uv, mapN, faceDirection);
    float3 toCamera = frame.cameraPosition - in.worldPosition;
    float3 v = normalize(toCamera);

    float roughness = mat.roughness * orm.g;
    float metalness = mat.metalness * orm.b;
    float3 dxy = max(abs(dfdx(geometryNormal)), abs(dfdy(geometryNormal)));
    roughness = min(max(roughness, 0.0525) + max(max(dxy.x, dxy.y), dxy.z), 1.0);

    float3 diffuseColor = base * (1.0 - metalness);
    float3 specularColor = mix(float3(0.04), base, metalness);
    float specularF90 = 1.0;

    float shadow = svSunShadow(frame, shadowMap, in.worldPosition, geometryNormal);
    float3 sunIrradiance = saturate(dot(n, frame.sunDirection)) * frame.sunColor * shadow;
    float3 directDiffuse = sunIrradiance * diffuseColor * IV_RECIPROCAL_PI;
    float3 directSpecular = sunIrradiance * svBRDF_GGX(frame.sunDirection, v, n, specularColor, specularF90, roughness);
    for (uint i = 0; i < frame.lightCount; i++) {
        IVLight light = lights[i];
        float3 lVector = light.position - in.worldPosition;
        float d = length(lVector);
        float3 l = lVector / max(d, 1e-5);
        float attenuation = svDistanceAttenuation(d, light.distance, light.decay);
        if (light.kind == IV_LIGHT_SPOT) attenuation *= smoothstep(light.coneCos, light.penumbraCos, dot(l, light.direction));
        if (attenuation <= 0.0) continue;
        float3 irradiance = saturate(dot(n, l)) * light.color * attenuation;
        directDiffuse += irradiance * diffuseColor * IV_RECIPROCAL_PI;
        directSpecular += irradiance * svBRDF_GGX(l, v, n, specularColor, specularF90, roughness);
    }

    float3 hemiIrradiance = mix(frame.hemiGroundColor, frame.hemiSkyColor, 0.5 * n.y + 0.5);
    float3 indirectDiffuse = hemiIrradiance * diffuseColor * IV_RECIPROCAL_PI;

    float envIntensity = frame.environmentIntensity;
    float3 r = normalize(mix(reflect(-v, n), n, roughness * roughness));
    float3 radiance = sampleEnvironment(environment, r, roughness * frame.environmentMaxLod, frame.environmentRotation) * envIntensity;
    float3 iblIrradiance = IV_PI * sampleEnvironment(environment, n, frame.environmentMaxLod, frame.environmentRotation) * envIntensity;
    float dotNV = saturate(dot(n, v));
    float2 fab = svDFGApprox(dotNV, roughness);
    float3 FssEss = specularColor * fab.x + specularF90 * fab.y;
    float Ess = fab.x + fab.y;
    float Ems = 1.0 - Ess;
    float3 Favg = specularColor + (1.0 - specularColor) * 0.047619;
    float3 Fms = FssEss * Favg / (1.0 - Ems * Favg);
    float3 multiScattering = Fms * Ems;
    float3 totalScattering = FssEss + multiScattering;
    float3 cosineWeightedIrradiance = iblIrradiance * IV_RECIPROCAL_PI;
    float3 diffuse = diffuseColor * (1.0 - max(max(totalScattering.r, totalScattering.g), totalScattering.b));
    float3 indirectSpecular = radiance * FssEss + multiScattering * cosineWeightedIrradiance;
    indirectDiffuse += diffuse * cosineWeightedIrradiance;

    float3 color = directDiffuse + indirectDiffuse + directSpecular + indirectSpecular;

    if (frame.fogDensity > 0.0) {
        float d = frame.fogDensity * in.viewZ;
        float factor = 1.0 - exp(-d * d);
        if (frame.fogHeightFalloff > 0.0) {
            factor *= max(exp(-max(in.worldPosition.y - frame.fogBaseHeight, 0.0) * frame.fogHeightFalloff), 0.25);
        }
        float3 fogColor = frame.fogColor;
        if (frame.fogSunTintStrength > 0.0) {
            float towardSun = pow(max(dot(normalize(-toCamera), frame.sunDirection), 0.0), 5.0);
            fogColor = mix(fogColor, frame.fogSunTint, towardSun * frame.fogSunTintStrength);
        }
        color = mix(color, fogColor, factor);
    }
    return float4(color, 1.0);
}

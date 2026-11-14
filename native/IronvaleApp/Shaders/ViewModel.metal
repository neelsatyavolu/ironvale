// M9 first-person view model (PLAN.md 3.4; maps/weapons-player.md 1b): the gun and the skinned arms,
// drawn inside the map's scene and sun shadow passes like the web, where the view model is part of the
// main scene. Depth compression (src/weapons/view/rig.ts root.scale.z): camera-space z is scaled by
// tan(54 deg / 2) / tan(fov / 2) about the eye, so the gun is seen through a 54 degree lens whatever the
// world's field of view; normals take the inverse scale.
// Materials, one MSL function per web finish:
//   standard  glTF factors x maps (guns-a-materials.ts convert, m24-materials.ts, the holo body, arms.ts)
//   tuned     src/weapons/models/lib/guns-c-materials.ts tunedFinish (texture levels remapped, roughness
//             broken up with object-space MaterialX noise, rubbed patches)
//   m7        src/weapons/models/lib/m7-materials.ts m7Finish (tint, mottle, rub, noise roughness)
//   reticle   src/weapons/models/lib/guns-c-optic.ts reticleMaterial (collimated dot, ring and glow by the
//             angle between the pixel's view ray and the sight axis)
// Gun finishes report metalness 0 and roughness 1 to the MRT (keepOutOfReflections) so SSR leaves them.
// Lighting is three r180's PhysicalLightingModel as MapPBR.metal and Soldier.metal port it.
#include <metal_stdlib>
#include "ShaderTypes.h"
#include "ViewModelTypes.h"
#include "Common.h"
#include "Noise.metal"
using namespace metal;

struct VMVaryings {
    float4 position [[position]];
    float3 worldPosition;
    float3 worldNormal;
    float3 localPosition;
    float3 cameraPosition;    // depth-compressed camera space, for the reticle
    float3 sightAxis;         // camera space -Z of the mesh, depth-compressed
    float2 uv;
    float viewZ;
};

static float4x4 vmSkin(device const ushort4 *joints, device const float4 *weights, device const float4x4 *palette, uint vid) {
    ushort4 j = joints[vid];
    float4 w = weights[vid];
    return palette[j.x] * w.x + palette[j.y] * w.y + palette[j.z] * w.z + palette[j.w] * w.w;
}

/// Camera-space point and normal (before compression) of one vertex.
static void vmCameraSpace(uint vid, device const packed_float3 *positions, device const packed_float3 *normals,
                          device const ushort4 *joints, device const float4 *weights, device const float4x4 *palette,
                          constant IVViewModelDraw &draw, thread float3 &p, thread float3 &n) {
    float3 local = float3(positions[vid]);
    float3 normal = float3(normals[vid]);
    if (draw.skinned != 0) {
        float4x4 m = vmSkin(joints, weights, palette, vid);
        p = (m * float4(local, 1.0)).xyz;
        // Bones carry only uniform scale (the model's 0.01), so the 3x3 maps normals once renormalised.
        n = float3x3(m[0].xyz, m[1].xyz, m[2].xyz) * normal;
    } else {
        p = (draw.model * float4(local, 1.0)).xyz;
        n = float3x3(draw.normalMatrix[0].xyz, draw.normalMatrix[1].xyz, draw.normalMatrix[2].xyz) * normal;
    }
}

vertex VMVaryings ivViewModelVertex(uint vid [[vertex_id]],
                                    device const packed_float3 *positions [[buffer(IV_VM_BUFFER_POSITION)]],
                                    device const packed_float3 *normals [[buffer(IV_VM_BUFFER_NORMAL)]],
                                    device const packed_float2 *uvs [[buffer(IV_VM_BUFFER_UV)]],
                                    device const ushort4 *joints [[buffer(IV_VM_BUFFER_JOINTS)]],
                                    device const float4 *weights [[buffer(IV_VM_BUFFER_WEIGHTS)]],
                                    device const float4x4 *palette [[buffer(IV_VM_BUFFER_PALETTE)]],
                                    constant IVViewModelDraw &draw [[buffer(IV_VM_BUFFER_DRAW)]],
                                    constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]]) {
    float3 p, n;
    vmCameraSpace(vid, positions, normals, joints, weights, palette, draw, p, n);
    p.z *= draw.depthScale;
    n.z /= draw.depthScale;
    float4 world = draw.cameraToWorld * float4(p, 1.0);
    VMVaryings out;
    out.position = frame.viewProjection * world;
    out.worldPosition = world.xyz;
    out.worldNormal = float3x3(draw.cameraToWorld[0].xyz, draw.cameraToWorld[1].xyz, draw.cameraToWorld[2].xyz) * n;
    out.localPosition = float3(positions[vid]);
    out.cameraPosition = p;
    float3 axis = (draw.model * float4(0.0, 0.0, -1.0, 0.0)).xyz;
    axis.z *= draw.depthScale;
    out.sightAxis = axis;
    out.uv = float2(uvs[vid]);
    out.viewZ = (frame.view * world).z;
    return out;
}

vertex float4 ivViewModelShadowVertex(uint vid [[vertex_id]],
                                      device const packed_float3 *positions [[buffer(IV_VM_BUFFER_POSITION)]],
                                      device const packed_float3 *normals [[buffer(IV_VM_BUFFER_NORMAL)]],
                                      device const ushort4 *joints [[buffer(IV_VM_BUFFER_JOINTS)]],
                                      device const float4 *weights [[buffer(IV_VM_BUFFER_WEIGHTS)]],
                                      device const float4x4 *palette [[buffer(IV_VM_BUFFER_PALETTE)]],
                                      constant IVViewModelDraw &draw [[buffer(IV_VM_BUFFER_DRAW)]],
                                      constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]]) {
    float3 p, n;
    vmCameraSpace(vid, positions, normals, joints, weights, palette, draw, p, n);
    p.z *= draw.depthScale;
    return frame.shadowViewProjection * (draw.cameraToWorld * float4(p, 1.0));
}

// ---- Lighting (three r180 PhysicalLightingModel, as MapPBR.metal) ----

static float3 vmFresnel(float3 f0, float f90, float dotVH) {
    float fresnel = exp2((-5.55473 * dotVH - 6.98316) * dotVH);
    return f0 * (1.0 - fresnel) + f90 * fresnel;
}

static float3 vmBRDF_GGX(float3 l, float3 v, float3 n, float3 f0, float f90, float roughness) {
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
    return vmFresnel(f0, f90, dotVH) * vis * d;
}

static float2 vmDFGApprox(float dotNV, float roughness) {
    const float4 c0 = float4(-1.0, -0.0275, -0.572, 0.022);
    const float4 c1 = float4(1.0, 0.0425, 1.04, -0.04);
    float4 r = roughness * c0 + c1;
    float a004 = min(r.x * r.x, exp2(-9.28 * dotNV)) * r.x + r.y;
    return float2(-1.04, 1.04) * a004 + r.zw;
}

static float vmDistanceAttenuation(float d, float cutoff, float decay) {
    float falloff = 1.0 / max(pow(d, decay), 0.01);
    if (cutoff > 0.0) {
        float x = saturate(1.0 - pow(d / cutoff, 4.0));
        falloff *= x * x;
    }
    return falloff;
}

static float3 vmPerturbNormal(float3 p, float3 n, float2 uv, float3 mapN, float faceDirection) {
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

static float vmSunShadow(constant IVFrameUniforms &frame, depth2d<float> shadowMap, float3 worldPos, float3 normal) {
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

struct VMFragmentOut {
    float4 color [[color(0)]];
    float4 normal [[color(IV_SCENE_ATTACHMENT_NORMAL)]];
    float2 metalRough [[color(IV_SCENE_ATTACHMENT_METALROUGH)]];
};

/// mx_noise_float(positionLocal * scale) * 0.5 + 0.5, coarse and fine as the finishes mix them.
static float vmVariation(float3 local, float scale) {
    float coarse = ivMxNoise(local * scale) * 0.5 + 0.5;
    float fine = ivMxNoise(local * (scale * 6.7)) * 0.5 + 0.5;
    return coarse * 0.6 + fine * 0.4;
}

fragment VMFragmentOut ivViewModelFragment(VMVaryings in [[stage_in]],
                                           bool frontFacing [[front_facing]],
                                           constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                                           constant IVLight *lights [[buffer(IV_BUFFER_LIGHTS)]],
                                           constant IVViewModelMaterial &mat [[buffer(IV_VM_BUFFER_MATERIAL)]],
                                           texture2d<float> colorTex [[texture(IV_VM_TEXTURE_COLOR)]],
                                           texture2d<float> normalTex [[texture(IV_VM_TEXTURE_NORMAL)]],
                                           texture2d<float> metalRoughTex [[texture(IV_VM_TEXTURE_METALROUGH)]],
                                           texture2d<float> aoTex [[texture(IV_VM_TEXTURE_AO)]],
                                           texture2d<float> environment [[texture(IV_TEXTURE_ENVIRONMENT)]],
                                           depth2d<float> shadowMap [[texture(IV_TEXTURE_SHADOW)]]) {
    constexpr sampler material(filter::linear, mip_filter::linear, address::repeat, max_anisotropy(8));
    VMFragmentOut out;
    uint flags = mat.flags;
    float faceDirection = frontFacing ? 1.0 : -1.0;
    float3 geometryNormal = normalize(in.worldNormal) * faceDirection;
    out.normal = float4(normalize((frame.view * float4(geometryNormal, 0.0)).xyz) * 0.5 + 0.5, 1.0);
    out.metalRough = float2(0.0, 1.0);

    if (mat.finish == IV_VM_FINISH_RETICLE) {
        // Angle between this pixel's view ray and the sight's own axis, both in view space.
        float offAxis = length(normalize(in.cameraPosition) - normalize(in.sightAxis));
        float dotTerm = 1.0 - smoothstep(mat.reticle.x * 0.6, mat.reticle.x * 1.5, offAxis);
        float ring = (1.0 - smoothstep(mat.reticle.z * 0.5, mat.reticle.z * 1.6, abs(offAxis - mat.reticle.y))) * 0.8;
        float glow = (1.0 - smoothstep(0.0, mat.reticle.x * 5.0, offAxis)) * 0.18;
        float alpha = max(max(dotTerm, ring), glow);
        out.color = float4(mat.tint.rgb * mat.reticle.w, saturate(alpha));
        return out;
    }

    float2 uv = in.uv;
    float4 base = mat.baseColor;
    if ((flags & IV_VM_COLOR_MAP) != 0) base *= colorTex.sample(material, uv);
    float3 packed = (flags & IV_VM_METALROUGH_MAP) != 0 ? metalRoughTex.sample(material, uv).rgb : float3(1.0);
    float roughness = mat.roughness * packed.g;
    float metalness = mat.metalness * packed.b;

    if (mat.finish == IV_VM_FINISH_TUNED) {
        float variation = vmVariation(in.localPosition, mat.noise.y);
        float3 texel = (flags & IV_VM_COLOR_MAP) != 0 ? colorTex.sample(material, uv).rgb : float3(1.0);
        metalness = packed.b * mat.rough.w;
        float scratched = smoothstep(0.03, 0.16, texel.g) * packed.b;
        float rough = (packed.g * mat.lift.z + mat.lift.w) * (scratched * -mat.rough.x + 1.0);
        float wear = mat.noise.x;
        roughness = clamp(mix(rough * (1.0 - wear), rough * (1.0 + wear), variation), mat.rough.y, mat.rough.z);
        float rubbed = smoothstep(0.55, 0.85, variation) * mat.noise.z * packed.b;
        base.rgb = (texel * mat.tint.rgb + mix(mat.lift.y, mat.lift.x, packed.b)) * (rubbed + 1.0);
    } else if (mat.finish == IV_VM_FINISH_M7) {
        float variation = vmVariation(in.localPosition, mat.noise.y);
        float patches = ivMxNoise(in.localPosition * (mat.noise.y * 0.31) + 7.3) * 0.5 + 0.5;
        float rubbed = smoothstep(0.62, 0.9, variation) * mat.noise.z;
        float mottle = mat.noise.w;
        base.rgb = mat.tint.rgb * mix(1.0 - mottle, 1.0 + mottle, patches) * (rubbed + 1.0);
        float wear = mat.noise.x;
        roughness = mix(mat.roughness * (1.0 - wear), min(1.0, mat.roughness * (1.0 + wear)), variation);
        metalness = mat.metalness;
    }

    if ((flags & IV_VM_UNLIT) != 0) {
        out.color = float4(base.rgb, base.a);
        return out;
    }

    float3 n = geometryNormal;
    if ((flags & IV_VM_NORMAL_MAP) != 0) {
        float3 mapN = normalTex.sample(material, uv).xyz * 2.0 - 1.0;
        mapN.xy *= mat.normalScale;
        n = vmPerturbNormal(in.worldPosition, geometryNormal, uv, mapN, faceDirection);
    }
    float ao = (flags & IV_VM_AO_MAP) != 0 ? (aoTex.sample(material, uv).r - 1.0) * mat.aoIntensity + 1.0 : 1.0;

    float3 toCamera = frame.cameraPosition - in.worldPosition;
    float3 v = normalize(toCamera);
    float3 dxy = max(abs(dfdx(geometryNormal)), abs(dfdy(geometryNormal)));
    roughness = min(max(roughness, 0.0525) + max(max(dxy.x, dxy.y), dxy.z), 1.0);
    metalness = saturate(metalness);

    float3 diffuseColor = base.rgb * (1.0 - metalness);
    float3 specularColor = mix(float3(0.04), base.rgb, metalness);
    float specularF90 = 1.0;

    float shadow = vmSunShadow(frame, shadowMap, in.worldPosition, geometryNormal);
    float3 sunIrradiance = saturate(dot(n, frame.sunDirection)) * frame.sunColor * shadow;
    float3 directDiffuse = sunIrradiance * diffuseColor * IV_RECIPROCAL_PI;
    float3 directSpecular = sunIrradiance * vmBRDF_GGX(frame.sunDirection, v, n, specularColor, specularF90, roughness);
    for (uint i = 0; i < frame.lightCount; i++) {
        IVLight light = lights[i];
        float3 lVector = light.position - in.worldPosition;
        float d = length(lVector);
        float3 l = lVector / max(d, 1e-5);
        float attenuation = vmDistanceAttenuation(d, light.distance, light.decay);
        if (light.kind == IV_LIGHT_SPOT) attenuation *= smoothstep(light.coneCos, light.penumbraCos, dot(l, light.direction));
        if (attenuation <= 0.0) continue;
        float3 irradiance = saturate(dot(n, l)) * light.color * attenuation;
        directDiffuse += irradiance * diffuseColor * IV_RECIPROCAL_PI;
        directSpecular += irradiance * vmBRDF_GGX(l, v, n, specularColor, specularF90, roughness);
    }

    float3 hemiIrradiance = mix(frame.hemiGroundColor, frame.hemiSkyColor, 0.5 * n.y + 0.5);
    float3 indirectDiffuse = hemiIrradiance * diffuseColor * IV_RECIPROCAL_PI;
    float envIntensity = frame.environmentIntensity;
    float3 r = normalize(mix(reflect(-v, n), n, roughness * roughness));
    float3 radiance = sampleEnvironment(environment, r, roughness * frame.environmentMaxLod, frame.environmentRotation) * envIntensity;
    float3 iblIrradiance = IV_PI * sampleEnvironment(environment, n, frame.environmentMaxLod, frame.environmentRotation) * envIntensity;
    float dotNV = saturate(dot(n, v));
    float2 fab = vmDFGApprox(dotNV, roughness);
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
    // three's ambient occlusion: indirect diffuse by the map, indirect specular by computeSpecularOcclusion.
    indirectDiffuse *= ao;
    float specularOcclusion = saturate(pow(dotNV + ao, exp2(-16.0 * roughness - 1.0)) - 1.0 + ao);
    indirectSpecular *= specularOcclusion;

    float3 color = directDiffuse + indirectDiffuse + directSpecular + indirectSpecular;
    if (frame.fogDensity > 0.0) {
        float d = frame.fogDensity * in.viewZ;
        float factor = 1.0 - exp(-d * d);
        if (frame.fogHeightFalloff > 0.0) {
            factor *= max(exp(-max(in.worldPosition.y - frame.fogBaseHeight, 0.0) * frame.fogHeightFalloff), 0.25);
        }
        color = mix(color, frame.fogColor, factor);
    }
    out.color = float4(color, base.a);
    out.normal = float4(normalize((frame.view * float4(n, 0.0)).xyz) * 0.5 + 0.5, 1.0);
    out.metalRough = (flags & IV_VM_KEEP_OUT_OF_REFLECTIONS) != 0 ? float2(0.0, 1.0) : float2(metalness, roughness);
    return out;
}

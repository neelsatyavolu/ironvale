// Shared by the M9 effect shaders (FX*.metal, Weather*.metal): the effect uniforms, the scene's fog
// (engine.ts applyFog, as MapPBR.metal), sprite-sheet UVs, the unit quad, and three's
// MeshStandardMaterial lighting for the lit effects (decals, casings, grenade bodies).
#ifndef IRONVALE_FX_COMMON_H
#define IRONVALE_FX_COMMON_H
#include <metal_stdlib>
#include "ShaderTypes.h"
#include "Common.h"
using namespace metal;

// Buffer and texture slots, clear of the map's (ShaderTypes.h, MapSurface.h).
#define FX_BUFFER_UNIFORMS 16
#define FX_BUFFER_INSTANCES 17
#define FX_BUFFER_EXTRA 18
#define FX_BUFFER_GEOMETRY 19
#define FX_TEXTURE_ATLAS 24
#define FX_TEXTURE_MASK 25

// Mirrors FXUniforms in IronvaleFX/GPU/FXLayer.swift (float4 rows only).
struct FXUniforms {
    float4 clock;        // x effect time (src/fx/shared.ts FxEnv.time), y fade power, z alpha test, w 1 = additive
    float4 wind;         // xyz
    float4 sunDirection; // xyz, toward the sun
    float4 sunLight;     // rgb, sunlight a particle scatters
    float4 ambientLight; // rgb, sky light a particle scatters
    float4 a;            // per program (rain: centre, w indoors; banks: centre, w indoors; motes: centre)
    float4 b;            // per program (rain: fall)
    float4 c;            // per program (mask span in x)
};

struct FXOut {
    float4 color [[color(0)]];
};

// The camera's world-space right and up (cameraWorldMatrix columns 0 and 1): the view matrix's rows.
static inline float3 fxCameraRight(constant IVFrameUniforms &frame) { return float3(frame.view[0][0], frame.view[1][0], frame.view[2][0]); }
static inline float3 fxCameraUp(constant IVFrameUniforms &frame) { return float3(frame.view[0][1], frame.view[1][1], frame.view[2][1]); }

// PlaneGeometry(1, 1) as two triangles: uv per vertex (position = uv - 0.5).
static inline float2 fxQuadUV(uint vid) {
    const float2 corners[6] = { float2(0, 1), float2(0, 0), float2(1, 1), float2(0, 0), float2(1, 0), float2(1, 1) };
    return corners[vid % 6];
}

// The sheet cell's uv as three computes it, turned into Metal's top-down t.
static inline float2 fxSheetUV(float cell, float grid, float2 uv) {
    float column = cell - grid * floor(cell / grid);
    float row = floor(cell / grid);
    float v = 1.0 - (row + (1.0 - uv.y)) / grid;
    return float2((column + uv.x) / grid, 1.0 - v);
}

static inline float fxViewZ(constant IVFrameUniforms &frame, float3 world) { return -(frame.view * float4(world, 1.0)).z; }

// engine.ts applyFog (as MapPBR.metal's fog block).
static inline float3 fxFog(constant IVFrameUniforms &frame, float3 color, float3 world, float viewZ) {
    if (frame.fogDensity <= 0.0) return color;
    float d = frame.fogDensity * viewZ;
    float factor = 1.0 - exp(-d * d);
    if (frame.fogHeightFalloff > 0.0) {
        float above = max(world.y - frame.fogBaseHeight, 0.0);
        factor *= max(exp(-above * frame.fogHeightFalloff), 0.25);
    }
    float3 fogColor = frame.fogColor;
    if (frame.fogSunTintStrength > 0.0) {
        float towardSun = pow(max(dot(normalize(world - frame.cameraPosition), frame.sunDirection), 0.0), 5.0);
        fogColor = mix(fogColor, frame.fogSunTint, towardSun * frame.fogSunTintStrength);
    }
    return mix(color, fogColor, factor);
}

static inline float fxSmooth(float e0, float e1, float x) { return smoothstep(e0, e1, x); }

// ---- three's PhysicalLightingModel for MeshStandardMaterial (MapPBR.metal, without the map programs) ----

static inline float3 fxFSchlick(float3 f0, float f90, float dotVH) {
    float fresnel = exp2((-5.55473 * dotVH - 6.98316) * dotVH);
    return f0 * (1.0 - fresnel) + f90 * fresnel;
}

static inline float3 fxBRDF(float3 l, float3 v, float3 n, float3 f0, float roughness) {
    float alpha = roughness * roughness;
    float3 h = normalize(l + v);
    float dotNL = saturate(dot(n, l)), dotNV = saturate(dot(n, v)), dotNH = saturate(dot(n, h)), dotVH = saturate(dot(v, h));
    float a2 = alpha * alpha;
    float gv = dotNL * sqrt(a2 + (1.0 - a2) * dotNV * dotNV);
    float gl = dotNV * sqrt(a2 + (1.0 - a2) * dotNL * dotNL);
    float vis = 0.5 / max(gv + gl, 1e-6);
    float denom = dotNH * dotNH * (a2 - 1.0) + 1.0;
    float d = IV_RECIPROCAL_PI * a2 / (denom * denom);
    return fxFSchlick(f0, 1.0, dotVH) * vis * d;
}

static inline float fxShadow(constant IVFrameUniforms &frame, depth2d<float> shadowMap, float3 worldPos, float3 normal) {
    if (frame.shadowEnabled == 0.0) return 1.0;
    float4 clip = frame.shadowViewProjection * float4(worldPos + normal * frame.shadowNormalBias, 1.0);
    float3 ndc = clip.xyz / clip.w;
    float2 uv = float2(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    if (any(uv < 0.0) || any(uv > 1.0) || ndc.z < 0.0 || ndc.z > 1.0) return 1.0;
    constexpr sampler cmp(coord::normalized, filter::linear, address::clamp_to_edge, compare_func::less_equal);
    float depth = ndc.z + frame.shadowBias;
    float2 texel = 1.0 / float2(shadowMap.get_width(), shadowMap.get_height());
    float sum = 0.0;
    for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++) sum += shadowMap.sample_compare(cmp, uv + float2(x, y) * texel, depth);
    return sum / 9.0;
}

static inline float3 fxStandard(constant IVFrameUniforms &frame, device const IVLight *lights, texture2d<float> environment,
                                depth2d<float> shadowMap, float3 base, float metalness, float roughnessIn, float3 n,
                                float3 geometryNormal, float3 worldPos, bool receiveShadow) {
    float3 v = normalize(frame.cameraPosition - worldPos);
    float3 dxy = max(abs(dfdx(geometryNormal)), abs(dfdy(geometryNormal)));
    float roughness = min(max(roughnessIn, 0.0525) + max(max(dxy.x, dxy.y), dxy.z), 1.0);
    float3 diffuseColor = base * (1.0 - metalness);
    float3 specularColor = mix(float3(0.04), base, metalness);
    float shadow = receiveShadow ? fxShadow(frame, shadowMap, worldPos, geometryNormal) : 1.0;
    float3 irradiance = saturate(dot(n, frame.sunDirection)) * frame.sunColor * shadow;
    float3 directDiffuse = irradiance * diffuseColor * IV_RECIPROCAL_PI;
    float3 directSpecular = irradiance * fxBRDF(frame.sunDirection, v, n, specularColor, roughness);
    for (uint i = 0; i < frame.lightCount; i++) {
        IVLight light = lights[i];
        float3 lVector = light.position - worldPos;
        float d = length(lVector);
        float3 l = lVector / max(d, 1e-5);
        float attenuation = 1.0 / max(pow(d, light.decay), 0.01);
        if (light.distance > 0.0) { float x = saturate(1.0 - pow(d / light.distance, 4.0)); attenuation *= x * x; }
        if (light.kind == IV_LIGHT_SPOT) attenuation *= smoothstep(light.coneCos, light.penumbraCos, dot(l, light.direction));
        if (attenuation <= 0.0) continue;
        float3 li = saturate(dot(n, l)) * light.color * attenuation;
        directDiffuse += li * diffuseColor * IV_RECIPROCAL_PI;
        directSpecular += li * fxBRDF(l, v, n, specularColor, roughness);
    }
    float3 indirectDiffuse = mix(frame.hemiGroundColor, frame.hemiSkyColor, 0.5 * n.y + 0.5) * diffuseColor * IV_RECIPROCAL_PI;
    float envIntensity = frame.environmentIntensity;
    float3 r = normalize(mix(reflect(-v, n), n, roughness * roughness));
    float3 radiance = sampleEnvironment(environment, r, roughness * frame.environmentMaxLod, frame.environmentRotation) * envIntensity;
    float3 iblIrradiance = IV_PI * sampleEnvironment(environment, n, frame.environmentMaxLod, frame.environmentRotation) * envIntensity;
    float dotNV = saturate(dot(n, v));
    const float4 c0 = float4(-1.0, -0.0275, -0.572, 0.022), c1 = float4(1.0, 0.0425, 1.04, -0.04);
    float4 rr = roughness * c0 + c1;
    float a004 = min(rr.x * rr.x, exp2(-9.28 * dotNV)) * rr.x + rr.y;
    float2 fab = float2(-1.04, 1.04) * a004 + rr.zw;
    float3 FssEss = specularColor * fab.x + fab.y;
    float Ems = 1.0 - (fab.x + fab.y);
    float3 Favg = specularColor + (1.0 - specularColor) * 0.047619;
    float3 Fms = FssEss * Favg / (1.0 - Ems * Favg);
    float3 total = FssEss + Fms * Ems;
    float3 cosineIrradiance = iblIrradiance * IV_RECIPROCAL_PI;
    indirectDiffuse += diffuseColor * (1.0 - max(max(total.r, total.g), total.b)) * cosineIrradiance;
    float3 indirectSpecular = radiance * FssEss + Fms * Ems * cosineIrradiance;
    return directDiffuse + indirectDiffuse + directSpecular + indirectSpecular;
}

// MRT companions of a lit opaque effect (normal and metal/rough), as MapPBR writes them.
struct FXOpaqueOut {
    float4 color [[color(0)]];
    float4 normal [[color(1)]];
    float2 metalRough [[color(2)]];
};
#endif

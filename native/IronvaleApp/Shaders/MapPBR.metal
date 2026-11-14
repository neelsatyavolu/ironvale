// Generic PBR for map geometry (PLAN.md 3.3, 3.4): three's MeshStandardMaterial through
// PhysicalLightingModel, MeshBasicMaterial for unlit parts, sun shadow, punctual and hemisphere
// lights, image-based light from the prefiltered equirect chain, and the engine's fog.
// Ported from three r180 (node_modules/three/src/nodes/functions/PhysicalLightingModel.js,
// BSDF/*.js, lighting/*.js) and src/render/engine.ts (fog) at commit cbe0add.
// Map surface programs (colorNode, roughnessNode, opacityNode, normalNode, aoNode, emissiveNode)
// are chosen by the kProgram function constant and live in MapRailyard*.metal (MapSurface.h).
#include <metal_stdlib>
#include "ShaderTypes.h"
#include "Common.h"
#include "MapSurface.h"
#include "MapRailyardShelter.metal"
#include "MapRailyardLamps.metal"
#include "MapRailyardGround.metal"
#include "MapRailyardMaterials.metal"
#include "MapRailyardSurfaces.metal"
#include "MapRailyardContainerPaint.metal"
using namespace metal;

constant bool kAlphaTest [[function_constant(0)]];
/// IV_PROGRAM_* of MapSurface.h; IV_PROGRAM_NONE is the generic material.
constant uint kProgram [[function_constant(1)]];
/// aoNode is the Railyard sky visibility (shelter.ts), times the aoMap occlusion when there is one.
constant bool kSkyVisibility [[function_constant(2)]];
/// emissiveNode is diffuseColor x the Railyard lamp glow (lamps.ts lampLit).
constant bool kLampLit [[function_constant(3)]];
/// The mesh carries a per-instance livery colour (container paint).
constant bool kLivery [[function_constant(4)]];

constant bool kNormalProgram = kProgram == IV_PROGRAM_RY_ASPHALT || kProgram == IV_PROGRAM_RY_QUAY || kProgram == IV_PROGRAM_RY_WATER;
/// Programs whose colour node samples the colour texture (`texture(maps.color, uv())`) bound at IV_TEXTURE_PROGRAM.
constant bool kProgramColorTexture = kProgram == IV_PROGRAM_RY_CLADDING || kProgram == IV_PROGRAM_RY_CONTAINER;
/// Programs whose normal node normal-maps the texture bound at IV_TEXTURE_PROGRAM.
constant bool kProgramNormalTexture = kProgram == IV_PROGRAM_RY_ASPHALT || kProgram == IV_PROGRAM_RY_QUAY;
/// Programs that replace the albedo (three's colorNode); vertex colours still multiply in.
constant bool kOpacityProgram = kProgram == IV_PROGRAM_RY_PAINT || kProgram == IV_PROGRAM_RY_STAIN || kProgram == IV_PROGRAM_RY_CHAINLINK;
constant bool kProgramParams = kSkyVisibility || kLampLit;
constant bool kColorProgram = kProgram != IV_PROGRAM_NONE && kProgram != IV_PROGRAM_RY_WATER
    && kProgram != IV_PROGRAM_RY_STAIN && kProgram != IV_PROGRAM_RY_CHAINLINK;

struct MapVaryings {
    float4 position [[position]];
    float3 worldPosition;
    float3 worldNormal;
    float2 uv;
    float3 color;
    float viewZ;
    float3 localPosition;
    float3 localNormal;
    float3 livery;
};

static float4x4 instanceMatrix(constant IVDrawUniforms &draw, device const float4x4 *instances, uint iid) {
    return draw.instanced != 0 ? instances[iid] : float4x4(1.0);
}

vertex MapVaryings ivMapVertex(uint vid [[vertex_id]],
                               uint iid [[instance_id]],
                               device const packed_float3 *positions [[buffer(IV_BUFFER_POSITION)]],
                               device const packed_float3 *normals [[buffer(IV_BUFFER_NORMAL)]],
                               device const packed_float2 *uvs [[buffer(IV_BUFFER_UV)]],
                               device const packed_float3 *colors [[buffer(IV_BUFFER_COLOR)]],
                               device const float4x4 *instances [[buffer(IV_BUFFER_INSTANCES)]],
                               device const packed_float3 *liveries [[buffer(IV_BUFFER_LIVERY), function_constant(kLivery)]],
                               constant IVDrawUniforms &draw [[buffer(IV_BUFFER_DRAW)]],
                               constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]]) {
    float4x4 inst = instanceMatrix(draw, instances, iid);
    float3 local = float3(positions[vid]);
    float4 world = draw.model * (inst * float4(local, 1.0));
    // three's instance normal transform: divide by squared column lengths, then the instance 3x3.
    float3 n = float3(normals[vid]);
    if (draw.instanced != 0) {
        float3x3 m = float3x3(inst[0].xyz, inst[1].xyz, inst[2].xyz);
        n = m * (n / float3(dot(m[0], m[0]), dot(m[1], m[1]), dot(m[2], m[2])));
    }
    float3x3 nm = float3x3(draw.normalMatrix[0].xyz, draw.normalMatrix[1].xyz, draw.normalMatrix[2].xyz);
    MapVaryings out;
    out.position = frame.viewProjection * world;
    out.worldPosition = world.xyz;
    out.worldNormal = nm * n;
    out.uv = float2(uvs[vid]);
    out.color = draw.hasColor != 0 ? float3(colors[vid]) : float3(1.0);
    out.viewZ = (frame.view * world).z;
    out.localPosition = local;
    out.localNormal = float3(normals[vid]);
    out.livery = kLivery ? float3(liveries[iid]) : float3(1.0);
    return out;
}

vertex float4 ivShadowVertex(uint vid [[vertex_id]],
                             uint iid [[instance_id]],
                             device const packed_float3 *positions [[buffer(IV_BUFFER_POSITION)]],
                             device const float4x4 *instances [[buffer(IV_BUFFER_INSTANCES)]],
                             constant IVDrawUniforms &draw [[buffer(IV_BUFFER_DRAW)]],
                             constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]]) {
    float4x4 inst = instanceMatrix(draw, instances, iid);
    float4 world = draw.model * (inst * float4(float3(positions[vid]), 1.0));
    return frame.shadowViewProjection * world;
}

// ---- BSDFs (three: BSDF/F_Schlick.js, V_GGX_SmithCorrelated.js, D_GGX.js, DFGApprox.js) ----

static float3 F_Schlick(float3 f0, float f90, float dotVH) {
    float fresnel = exp2((-5.55473 * dotVH - 6.98316) * dotVH);
    return f0 * (1.0 - fresnel) + f90 * fresnel;
}

static float V_GGX_SmithCorrelated(float alpha, float dotNL, float dotNV) {
    float a2 = alpha * alpha;
    float gv = dotNL * sqrt(a2 + (1.0 - a2) * dotNV * dotNV);
    float gl = dotNV * sqrt(a2 + (1.0 - a2) * dotNL * dotNL);
    return 0.5 / max(gv + gl, 1e-6);
}

static float D_GGX(float alpha, float dotNH) {
    float a2 = alpha * alpha;
    float denom = dotNH * dotNH * (a2 - 1.0) + 1.0;
    return IV_RECIPROCAL_PI * a2 / (denom * denom);
}

static float3 BRDF_GGX(float3 l, float3 v, float3 n, float3 f0, float f90, float roughness) {
    float alpha = roughness * roughness;
    float3 h = normalize(l + v);
    float dotNL = saturate(dot(n, l));
    float dotNV = saturate(dot(n, v));
    float dotNH = saturate(dot(n, h));
    float dotVH = saturate(dot(v, h));
    return F_Schlick(f0, f90, dotVH) * V_GGX_SmithCorrelated(alpha, dotNL, dotNV) * D_GGX(alpha, dotNH);
}

static float2 DFGApprox(float dotNV, float roughness) {
    const float4 c0 = float4(-1.0, -0.0275, -0.572, 0.022);
    const float4 c1 = float4(1.0, 0.0425, 1.04, -0.04);
    float4 r = roughness * c0 + c1;
    float a004 = min(r.x * r.x, exp2(-9.28 * dotNV)) * r.x + r.y;
    return float2(-1.04, 1.04) * a004 + r.zw;
}

// three's getDistanceAttenuation (lighting/LightUtils.js).
static float distanceAttenuation(float d, float cutoff, float decay) {
    float falloff = 1.0 / max(pow(d, decay), 0.01);
    if (cutoff > 0.0) {
        float x = saturate(1.0 - pow(d / cutoff, 4.0));
        falloff *= x * x;
    }
    return falloff;
}

// three's tangent frame from screen derivatives (accessors/TangentUtils.js), built on the raw uv():
// three uploads flipY textures flipped, so its frame never sees the v flip our sampling applies. Metal's dfdy runs down
// the screen, the opposite of GL's, so both y derivatives are negated to keep the frame's hand.
static float3 perturbNormal(float3 p, float3 n, float2 uv, float3 mapN, float faceDirection) {
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

// 3x3 PCF over the hardware 2x2 compare (three's PCFShadowMap reads a 3x3 neighbourhood).
static float sunShadow(constant IVFrameUniforms &frame, depth2d<float> shadowMap, float3 worldPos, float3 normal) {
    if (frame.shadowEnabled == 0.0) return 1.0;
    float3 biased = worldPos + normal * (frame.shadowNormalBias);
    float4 clip = frame.shadowViewProjection * float4(biased, 1.0);
    float3 ndc = clip.xyz / clip.w;
    float2 uv = float2(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    if (any(uv < 0.0) || any(uv > 1.0) || ndc.z < 0.0 || ndc.z > 1.0) return 1.0;
    constexpr sampler cmp(coord::normalized, filter::linear, address::clamp_to_edge, compare_func::less_equal);
    float depth = ndc.z + frame.shadowBias;
    float2 texel = 1.0 / float2(shadowMap.get_width(), shadowMap.get_height());
    float sum = 0.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            sum += shadowMap.sample_compare(cmp, uv + float2(x, y) * texel, depth);
        }
    }
    return sum / 9.0;
}

// Runs the surface program's normal stage (geometry normal in, final normal out).
static void runNormalProgram(thread IVSurface &s) {
    switch (kProgram) {
    case IV_PROGRAM_RY_ASPHALT: ivRailyardAsphalt(s, true); break;
    case IV_PROGRAM_RY_QUAY: ivRailyardQuay(s, true); break;
    case IV_PROGRAM_RY_WATER: ivRailyardSeaWaterNormal(s); break;
    default: break;
    }
}

// Runs the colour, roughness and opacity stage (final normal in s.n).
static void runSurfaceProgram(thread IVSurface &s) {
    switch (kProgram) {
    case IV_PROGRAM_RY_ASPHALT: ivRailyardAsphalt(s, false); break;
    case IV_PROGRAM_RY_QUAY: ivRailyardQuay(s, false); break;
    case IV_PROGRAM_RY_FLOOR: ivRailyardFloor(s); break;
    case IV_PROGRAM_RY_WALL: ivRailyardWall(s); break;
    case IV_PROGRAM_RY_CLADDING: ivRailyardCladding(s); break;
    case IV_PROGRAM_RY_CONTAINER: ivRailyardContainerPaint(s); break;
    case IV_PROGRAM_RY_STEEL: ivRailyardSteel(s); break;
    case IV_PROGRAM_RY_HAZARD: ivRailyardHazard(s); break;
    case IV_PROGRAM_RY_WOOD: ivRailyardTimber(s); break;
    case IV_PROGRAM_RY_MATTE: ivRailyardMatte(s); break;
    case IV_PROGRAM_RY_CARTON: ivRailyardCardboard(s); break;
    case IV_PROGRAM_RY_WRAP: ivRailyardShrinkWrap(s); break;
    case IV_PROGRAM_RY_PAINT: ivRailyardRoadPaint(s); break;
    case IV_PROGRAM_RY_STAIN: ivRailyardOilStain(s); break;
    case IV_PROGRAM_RY_CHAINLINK: ivRailyardChainlink(s); break;
    default: break;
    }
}

/// Scene MRT of pipeline.ts (PostTypes.h): HDR colour, packNormalToRGB(normalView), (metalness, roughness).
/// Without the M9 post chain only attachment 0 has a format and the other two writes are dropped.
struct MapFragmentOut {
    float4 color [[color(0)]];
    float4 normal [[color(IV_SCENE_ATTACHMENT_NORMAL)]];
    float2 metalRough [[color(IV_SCENE_ATTACHMENT_METALROUGH)]];
};

fragment MapFragmentOut ivMapFragment(MapVaryings in [[stage_in]],
                              bool frontFacing [[front_facing]],
                              constant IVFrameUniforms &frame [[buffer(IV_BUFFER_FRAME)]],
                              constant IVMaterialUniforms &mat [[buffer(IV_BUFFER_MATERIAL)]],
                              constant IVLight *lights [[buffer(IV_BUFFER_LIGHTS)]],
                              constant float4 *programParams [[buffer(IV_BUFFER_PROGRAM_PARAMS), function_constant(kProgramParams)]],
                              texture2d<float> mapTex [[texture(IV_TEXTURE_MAP)]],
                              texture2d<float> normalTex [[texture(IV_TEXTURE_NORMAL)]],
                              texture2d<float> roughTex [[texture(IV_TEXTURE_ROUGHNESS)]],
                              texture2d<float> metalTex [[texture(IV_TEXTURE_METALNESS)]],
                              texture2d<float> aoTex [[texture(IV_TEXTURE_AO)]],
                              texture2d<float> emissiveTex [[texture(IV_TEXTURE_EMISSIVE)]],
                              texture2d<float> environment [[texture(IV_TEXTURE_ENVIRONMENT)]],
                              depth2d<float> shadowMap [[texture(IV_TEXTURE_SHADOW)]],
                              texture2d<float> programTex [[texture(IV_TEXTURE_PROGRAM)]]) {
    constexpr sampler material(filter::linear, mip_filter::linear, address::repeat, max_anisotropy(16));
    uint flags = mat.flags;
    float2 uv = (flags & IV_MAT_FLIP_Y) != 0 ? float2(in.uv.x, 1.0 - in.uv.y) : in.uv;
    float faceDirection = frontFacing ? 1.0 : -1.0;
    float3 geometryNormal = normalize(in.worldNormal) * faceDirection;

    // three: diffuseColor = (colorNode ?? color x map) x vertex colour; alpha x (opacityNode ?? opacity).
    float4 base = mat.baseColor;
    if ((flags & IV_MAT_MAP) != 0) base *= mapTex.sample(material, uv);

    IVSurface s;
    s.p = in.worldPosition;
    s.n = geometryNormal;
    s.localP = in.localPosition;
    s.localN = in.localNormal;
    s.uv = in.uv;
    s.uvDiagonalWidth = float2(fwidth(in.uv.x + in.uv.y), fwidth(in.uv.x - in.uv.y));
    s.viewDepth = -in.viewZ;
    s.time = frame.time;
    s.livery = in.livery;
    s.programTexel = kProgramColorTexture ? programTex.sample(material, uv) : float4(1.0);
    s.programNormal = geometryNormal;
    if (kProgramNormalTexture) {
        float3 mapN = programTex.sample(material, uv).xyz * 2.0 - 1.0;
        s.programNormal = perturbNormal(in.worldPosition, geometryNormal, in.uv, mapN, faceDirection);
    }
    s.materialColor = base.rgb;
    float roughness = mat.roughness;
    if ((flags & IV_MAT_ROUGHNESS_MAP) != 0) roughness *= roughTex.sample(material, uv).g;
    s.materialRoughness = roughness;
    s.color = base.rgb;
    s.opacity = base.a;
    s.roughness = roughness;

    // Final normal: the program's normal node, else the normal map, else the geometry normal.
    float3 n = geometryNormal;
    if (kNormalProgram) {
        s.normal = geometryNormal;
        runNormalProgram(s);
        n = s.normal;
    } else if ((flags & IV_MAT_NORMAL_MAP) != 0 && (flags & IV_MAT_UNLIT) == 0) {
        float3 mapN = normalTex.sample(material, uv).xyz * 2.0 - 1.0;
        mapN.xy *= mat.normalScale;
        n = perturbNormal(in.worldPosition, geometryNormal, in.uv, mapN, faceDirection);
    }
    s.n = n;
    s.normal = n;
    if (kProgram != IV_PROGRAM_NONE) runSurfaceProgram(s);
    // A vec3 colour node has alpha 1, so the map's alpha drops out; an opacity node replaces opacity.
    if (kColorProgram) base = float4(s.color, mat.baseColor.a);
    if (kOpacityProgram) base.a = (kColorProgram ? 1.0 : base.a / max(mat.baseColor.a, 1e-6)) * s.opacity;
    roughness = s.roughness;
    if ((flags & IV_MAT_VERTEX_COLORS) != 0) base.rgb *= in.color;
    if (kAlphaTest && base.a < mat.alphaTest) discard_fragment();

    float3 toCamera = frame.cameraPosition - in.worldPosition;
    float3 color;
    // MRT surface data: MeshBasicMaterial has the geometry normal and no metalness or roughness.
    float3 surfaceNormal = geometryNormal;
    float metalness = 0.0;
    if ((flags & IV_MAT_UNLIT) != 0) {
        color = base.rgb;
        roughness = 0.0;
    } else {
        float3 v = normalize(toCamera);
        surfaceNormal = n;

        metalness = mat.metalness;
        if ((flags & IV_MAT_METALNESS_MAP) != 0) metalness *= metalTex.sample(material, uv).b;
        // three: max(roughness, 0.0525) + geometryRoughness, capped at 1.
        float3 dxy = max(abs(dfdx(geometryNormal)), abs(dfdy(geometryNormal)));
        roughness = min(max(roughness, 0.0525) + max(max(dxy.x, dxy.y), dxy.z), 1.0);

        float3 diffuseColor = base.rgb * (1.0 - metalness);
        float3 specularColor = mix(float3(0.04), base.rgb, metalness);
        float specularF90 = 1.0;

        float3 directDiffuse = 0.0;
        float3 directSpecular = 0.0;

        // Sun.
        {
            float shadow = (flags & IV_MAT_RECEIVE_SHADOW) != 0 ? sunShadow(frame, shadowMap, in.worldPosition, geometryNormal) : 1.0;
            float3 l = frame.sunDirection;
            float3 irradiance = saturate(dot(n, l)) * frame.sunColor * shadow;
            directDiffuse += irradiance * diffuseColor * IV_RECIPROCAL_PI;
            directSpecular += irradiance * BRDF_GGX(l, v, n, specularColor, specularF90, roughness);
        }
        // Points and spots.
        for (uint i = 0; i < frame.lightCount; i++) {
            IVLight light = lights[i];
            float3 lVector = light.position - in.worldPosition;
            float d = length(lVector);
            float3 l = lVector / max(d, 1e-5);
            float attenuation = distanceAttenuation(d, light.distance, light.decay);
            if (light.kind == IV_LIGHT_SPOT) {
                attenuation *= smoothstep(light.coneCos, light.penumbraCos, dot(l, light.direction));
            }
            if (attenuation <= 0.0) continue;
            float3 irradiance = saturate(dot(n, l)) * light.color * attenuation;
            directDiffuse += irradiance * diffuseColor * IV_RECIPROCAL_PI;
            directSpecular += irradiance * BRDF_GGX(l, v, n, specularColor, specularF90, roughness);
        }

        // Hemisphere light -> indirect diffuse (Lambert).
        float hemiWeight = 0.5 * n.y + 0.5;
        float3 hemiIrradiance = mix(frame.hemiGroundColor, frame.hemiSkyColor, hemiWeight);
        float3 indirectDiffuse = hemiIrradiance * diffuseColor * IV_RECIPROCAL_PI;

        // Image-based light (three: getIBLRadiance / getIBLIrradiance and computeMultiscattering).
        float envIntensity = frame.environmentIntensity * mat.envMapIntensity;
        float3 r = reflect(-v, n);
        r = normalize(mix(r, n, roughness * roughness));
        float3 radiance = sampleEnvironment(environment, r, roughness * frame.environmentMaxLod, frame.environmentRotation) * envIntensity;
        float3 iblIrradiance = IV_PI * sampleEnvironment(environment, n, frame.environmentMaxLod, frame.environmentRotation) * envIntensity;

        float dotNV = saturate(dot(n, v));
        float2 fab = DFGApprox(dotNV, roughness);
        float3 FssEss = specularColor * fab.x + specularF90 * fab.y;
        float Ess = fab.x + fab.y;
        float Ems = 1.0 - Ess;
        float3 Favg = specularColor + (1.0 - specularColor) * 0.047619;
        float3 Fms = FssEss * Favg / (1.0 - Ems * Favg);
        float3 singleScattering = FssEss;
        float3 multiScattering = Fms * Ems;
        float3 totalScattering = singleScattering + multiScattering;
        float3 cosineWeightedIrradiance = iblIrradiance * IV_RECIPROCAL_PI;
        float3 diffuse = diffuseColor * (1.0 - max(max(totalScattering.r, totalScattering.g), totalScattering.b));
        float3 indirectSpecular = radiance * singleScattering + multiScattering * cosineWeightedIrradiance;
        indirectDiffuse += diffuse * cosineWeightedIrradiance;

        // three: aoNode (or aoMap) scales indirect diffuse and, through specular occlusion, indirect specular.
        bool hasAO = (flags & IV_MAT_AO_MAP) != 0 || kSkyVisibility;
        if (hasAO) {
            float ao = (flags & IV_MAT_AO_MAP) != 0 ? (aoTex.sample(material, uv).r - 1.0) * mat.aoMapIntensity + 1.0 : 1.0;
            if (kSkyVisibility) ao *= ivRailyardSkyVisibility(in.worldPosition, programParams);
            indirectDiffuse *= ao;
            indirectSpecular *= saturate(pow(dotNV + ao, exp2(-16.0 * roughness - 1.0)) - 1.0 + ao);
        }

        float3 emissive = mat.emissive;
        if ((flags & IV_MAT_EMISSIVE_MAP) != 0) emissive *= emissiveTex.sample(material, uv).rgb;
        if (kLampLit) emissive = base.rgb * ivRailyardLampGlow(in.worldPosition, n, programParams);
        color = directDiffuse + indirectDiffuse + directSpecular + indirectSpecular + emissive;
    }

    if ((flags & IV_MAT_FOG) != 0 && frame.fogDensity > 0.0) {
        // engine.ts applyFog: exp2 density on view depth, thinned with height, tinted toward the sun.
        float d = frame.fogDensity * in.viewZ;
        float factor = 1.0 - exp(-d * d);
        if (frame.fogHeightFalloff > 0.0) {
            float above = max(in.worldPosition.y - frame.fogBaseHeight, 0.0);
            factor *= max(exp(-above * frame.fogHeightFalloff), 0.25);
        }
        float3 fogColor = frame.fogColor;
        if (frame.fogSunTintStrength > 0.0) {
            float towardSun = pow(max(dot(normalize(-toCamera), frame.sunDirection), 0.0), 5.0);
            fogColor = mix(fogColor, frame.fogSunTint, towardSun * frame.fogSunTintStrength);
        }
        color = mix(color, fogColor, factor);
    }
    MapFragmentOut out;
    out.color = float4(color, base.a);
    out.normal = float4(normalize((frame.view * float4(surfaceNormal, 0.0)).xyz) * 0.5 + 0.5, 1.0);
    out.metalRough = float2(metalness, roughness);
    return out;
}

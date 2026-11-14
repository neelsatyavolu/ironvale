// Generic PBR for map geometry (PLAN.md 3.3, 3.4): three's MeshStandardMaterial through
// PhysicalLightingModel, MeshBasicMaterial for unlit parts, sun shadow, punctual and hemisphere
// lights, image-based light from the prefiltered equirect chain, and the engine's fog.
// Ported from three r180 (node_modules/three/src/nodes/functions/PhysicalLightingModel.js,
// BSDF/*.js, lighting/*.js) and src/render/engine.ts (fog) at commit cbe0add.
// Map surface programs (colorNode, roughnessNode, opacityNode, normalNode, aoNode, emissiveNode)
// are chosen by the kProgram function constant and live in Map<Name>*.metal (MapSurface.h).
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
#include "MapHeadworksSurfaces.metal"
#include "MapHeadworksMaterials.metal"
#include "MapHeadworksDecals.metal"
#include "MapHeadworksLamps.metal"
#include "MapHeadworksRange.metal"
#include "MapRangeMaterials.metal"
#include "MapHarborSurfaces.metal"
#include "MapHarborWater.metal"
#include "MapHarborGlow.metal"
#include "MapHarborCapes.metal"
#include "MapHarborBoats.metal"
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
/// IV_AO_* of MapSurface.h: the aoNode of the maps after Railyard (times the aoMap occlusion when there is one).
constant uint kAOProgram [[function_constant(5)]];
/// IV_EMISSIVE_* of MapSurface.h: their emissiveNode (diffuseColor x a map light term).
constant uint kEmissiveProgram [[function_constant(6)]];

constant bool kRailyardProgram = kProgram != IV_PROGRAM_NONE && kProgram < 100u;
constant bool kNormalProgram = kProgram == IV_PROGRAM_RY_ASPHALT || kProgram == IV_PROGRAM_RY_QUAY || kProgram == IV_PROGRAM_RY_WATER
    || kProgram == IV_PROGRAM_HW_PAVING || kProgram == IV_PROGRAM_HW_ROAD || kProgram == IV_PROGRAM_HW_WATER
    || kProgram == IV_PROGRAM_HB_COBBLES || kProgram == IV_PROGRAM_HB_LOUVRED || kProgram == IV_PROGRAM_HB_LEAFY
    || kProgram == IV_PROGRAM_HB_SEA;
/// The Harbor boats read their per-vertex paint and lettering uv.
constant bool kBoat = kProgram == IV_PROGRAM_HB_BOAT;
/// Programs whose colour node samples the colour texture (`texture(maps.color, uv())`) bound at IV_TEXTURE_PROGRAM.
constant bool kProgramColorTexture = kProgram == IV_PROGRAM_RY_CLADDING || kProgram == IV_PROGRAM_RY_CONTAINER
    || kProgram == IV_PROGRAM_HW_CONCRETE || kProgram == IV_PROGRAM_HW_CONCRETE_ROUND || kProgram == IV_PROGRAM_HW_PAVING
    || kProgram == IV_PROGRAM_HW_ROAD;
/// Programs whose normal node normal-maps the texture bound at IV_TEXTURE_PROGRAM.
constant bool kProgramNormalTexture = kProgram == IV_PROGRAM_RY_ASPHALT || kProgram == IV_PROGRAM_RY_QUAY;
/// Programs whose normal node mixes the material's own normal map (normalMap(texture(maps.normal))).
constant bool kProgramMaterialNormal = kProgram == IV_PROGRAM_HW_PAVING || kProgram == IV_PROGRAM_HW_ROAD
    || kProgram == IV_PROGRAM_HB_COBBLES;
/// Programs with an opacity node.
constant bool kOpacityProgram = kProgram == IV_PROGRAM_RY_PAINT || kProgram == IV_PROGRAM_RY_STAIN || kProgram == IV_PROGRAM_RY_CHAINLINK
    || kProgram == IV_PROGRAM_HW_STAIN || kProgram == IV_PROGRAM_HW_RUNOFF || kProgram == IV_PROGRAM_HW_LINE || kProgram == IV_PROGRAM_HW_TYRES
    || kProgram == IV_PROGRAM_HB_STAIN_DECAL || kProgram == IV_PROGRAM_HB_TREE_SHADOW || kProgram == IV_PROGRAM_HB_HAZE
    || kProgram == IV_PROGRAM_HB_BOAT;
/// Programs with their own emission node (it replaces the material's emissive).
constant bool kEmissiveNodeProgram = kProgram == IV_PROGRAM_HB_LIT_ROOM || kProgram == IV_PROGRAM_HB_LAMP_GLASS
    || kProgram == IV_PROGRAM_HB_SEA;
/// Harbor's shadeLit: occlusion and bounce both read the street shade bake.
constant bool kHarborShade = kAOProgram == IV_AO_HB_SHADE || kEmissiveProgram == IV_EMISSIVE_HB_BOUNCE;
/// Programs with per-material arguments (scene.json programArgs).
constant bool kProgramArgs = kProgram >= 200u && kProgram < 300u;
/// Programs with a metalness node.
constant bool kMetalnessProgram = kProgram == IV_PROGRAM_HW_PAINT;
constant bool kProgramParams = kSkyVisibility || kLampLit || kAOProgram != IV_AO_NONE || kEmissiveProgram != IV_EMISSIVE_NONE
    || kProgram >= 100u;
/// Programs that replace the albedo (three's colorNode); vertex colours still multiply in.
constant bool kColorProgram = (kRailyardProgram && kProgram != IV_PROGRAM_RY_WATER && kProgram != IV_PROGRAM_RY_STAIN
                               && kProgram != IV_PROGRAM_RY_CHAINLINK)
    || (kProgram >= 100u && kProgram != IV_PROGRAM_HW_WATER && kProgram != IV_PROGRAM_HW_STAIN && kProgram != IV_PROGRAM_HW_RUNOFF
        && kProgram != IV_PROGRAM_HW_TYRES && kProgram != IV_PROGRAM_HB_LIT_ROOM && kProgram != IV_PROGRAM_HB_LAMP_GLASS
        && kProgram != IV_PROGRAM_HB_STAIN_DECAL && kProgram != IV_PROGRAM_HB_TREE_SHADOW && kProgram != IV_PROGRAM_HB_HAZE);

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
    float4 boatPaint;
    float2 boatDuv;
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
                               device const float4 *boatPaints [[buffer(IV_BUFFER_BOAT_PAINT), function_constant(kBoat)]],
                               device const packed_float2 *boatDuvs [[buffer(IV_BUFFER_BOAT_DUV), function_constant(kBoat)]],
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
    out.boatPaint = kBoat ? boatPaints[vid] : float4(1.0);
    out.boatDuv = kBoat ? float2(boatDuvs[vid]) : float2(0.0);
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
static void runNormalProgram(thread IVSurface &s, thread const IVProgramTextures &t) {
    switch (kProgram) {
    case IV_PROGRAM_RY_ASPHALT: ivRailyardAsphalt(s, true); break;
    case IV_PROGRAM_RY_QUAY: ivRailyardQuay(s, true); break;
    case IV_PROGRAM_RY_WATER: ivRailyardSeaWaterNormal(s); break;
    case IV_PROGRAM_HW_PAVING: ivHeadworksPaving(s, float3(0.2, 0.2, 0.193), 4.0, 0.1, true); break;
    case IV_PROGRAM_HW_ROAD: ivHeadworksPaving(s, float3(0.115, 0.118, 0.125), 6.0, 0.3, true); break;
    case IV_PROGRAM_HW_WATER: ivHeadworksWaterNormal(s); break;
    case IV_PROGRAM_HB_COBBLES: ivHarborCobbles(s, t, true); break;
    case IV_PROGRAM_HB_LOUVRED: ivHarborLouvred(s, t, true); break;
    case IV_PROGRAM_HB_LEAFY: ivHarborLeafy(s, t, true); break;
    case IV_PROGRAM_HB_SEA: ivHarborSeaNormal(s, t); break;
    default: break;
    }
}

// Runs the colour, roughness and opacity stage (final normal in s.n).
static void runSurfaceProgram(thread IVSurface &s, thread const IVProgramTextures &t, bool letteringFlipY) {
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
    // Headworks: materials.ts createMaterials (TILE_FORMED 1.8 for the round work; paving arguments).
    case IV_PROGRAM_HW_CONCRETE: ivHeadworksFormedConcrete(s, 0.0); break;
    case IV_PROGRAM_HW_CONCRETE_ROUND: ivHeadworksFormedConcrete(s, 1.8); break;
    case IV_PROGRAM_HW_PAVING: ivHeadworksPaving(s, float3(0.2, 0.2, 0.193), 4.0, 0.1, false); break;
    case IV_PROGRAM_HW_ROAD: ivHeadworksPaving(s, float3(0.115, 0.118, 0.125), 6.0, 0.3, false); break;
    case IV_PROGRAM_HW_PAINT: ivHeadworksCoatedSteel(s); break;
    case IV_PROGRAM_HW_STAINLESS: ivHeadworksBareSteel(s, false); break;
    case IV_PROGRAM_HW_GALVANISED: ivHeadworksBareSteel(s, true); break;
    case IV_PROGRAM_HW_MATTE: ivHeadworksMatte(s); break;
    case IV_PROGRAM_HW_HAZARD: ivHeadworksHazard(s); break;
    case IV_PROGRAM_HW_GRATING: ivHeadworksGrating(s); break;
    case IV_PROGRAM_HW_GLASS: ivHeadworksGlass(s); break;
    case IV_PROGRAM_HW_STAIN: ivHeadworksStain(s); break;
    case IV_PROGRAM_HW_RUNOFF: ivHeadworksRunOff(s); break;
    case IV_PROGRAM_HW_LINE: ivHeadworksLinePaint(s); break;
    case IV_PROGRAM_HW_TYRES: ivHeadworksTyreMarks(s); break;
    case IV_PROGRAM_HW_RANGE: ivHeadworksRange(s); break;
    case IV_PROGRAM_HW_RANGE_FLOOR: ivHeadworksRangeFloor(s); break;
    case IV_PROGRAM_RG_WET_CONCRETE: ivRangeWetConcrete(s); break;
    // Harbor: surfaces.ts factories (arguments in s.args), the sea, lamp pools, haze and boats.
    case IV_PROGRAM_HB_PLASTER: ivHarborPlaster(s, t); break;
    case IV_PROGRAM_HB_MASONRY: ivHarborMasonry(s, t, false); break;
    case IV_PROGRAM_HB_MASONRY_SLAB: ivHarborMasonry(s, t, true); break;
    case IV_PROGRAM_HB_COBBLES: ivHarborCobbles(s, t, false); break;
    case IV_PROGRAM_HB_ROOF_TILES: ivHarborRoofTiles(s, t); break;
    case IV_PROGRAM_HB_STAINED: ivHarborStained(s, t); break;
    case IV_PROGRAM_HB_PAINTED: ivHarborPainted(s, t); break;
    case IV_PROGRAM_HB_LOUVRED: ivHarborLouvred(s, t, false); break;
    case IV_PROGRAM_HB_LIT_ROOM: ivHarborLitRoom(s, t); break;
    case IV_PROGRAM_HB_LAMP_GLASS: ivHarborLampGlass(s); break;
    case IV_PROGRAM_HB_STRIPED: ivHarborStriped(s, t); break;
    case IV_PROGRAM_HB_SCUFFED: ivHarborScuffed(s, t); break;
    case IV_PROGRAM_HB_STAIN_DECAL: ivHarborStainDecal(s, t); break;
    case IV_PROGRAM_HB_HILLSIDE: ivHarborHillside(s, t); break;
    case IV_PROGRAM_HB_TREE_SHADOW: ivHarborTreeShadow(s); break;
    case IV_PROGRAM_HB_LEAFY: ivHarborLeafy(s, t, false); break;
    case IV_PROGRAM_HB_SEA: ivHarborSea(s, t); break;
    case IV_PROGRAM_HB_GLOW: ivHarborGlow(s, t); break;
    case IV_PROGRAM_HB_HAZE: ivHarborHaze(s); break;
    case IV_PROGRAM_HB_BOAT: ivHarborBoat(s, t, letteringFlipY); break;
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
                              texture2d<float> programTex [[texture(IV_TEXTURE_PROGRAM)]],
                              texture2d<float> grimeTex [[texture(IV_TEXTURE_GRIME)]],
                              texture2d<float> shadeTex [[texture(IV_TEXTURE_SHADE)]],
                              texture2d<float> wavesTex [[texture(IV_TEXTURE_WAVES)]],
                              texture2d<float> letteringTex [[texture(IV_TEXTURE_LETTERING)]],
                              constant float *programArgs [[buffer(IV_BUFFER_PROGRAM_ARGS), function_constant(kProgramArgs)]]) {
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
    } else if (kProgramMaterialNormal && (flags & IV_MAT_NORMAL_MAP) != 0) {
        float3 mapN = normalTex.sample(material, uv).xyz * 2.0 - 1.0;
        s.programNormal = perturbNormal(in.worldPosition, geometryNormal, in.uv, mapN, faceDirection);
    }
    s.rows = kProgramParams ? programParams : nullptr;
    s.args = kProgramArgs ? programArgs : nullptr;
    s.mapTexel = (flags & IV_MAT_MAP) != 0 ? mapTex.sample(material, uv) : float4(1.0);
    s.armTexel = (flags & IV_MAT_ROUGHNESS_MAP) != 0 ? roughTex.sample(material, uv) : float4(1.0);
    s.cameraPosition = frame.cameraPosition;
    s.view = float3x3(frame.view[0].xyz, frame.view[1].xyz, frame.view[2].xyz);
    s.geometryNormal = geometryNormal;
    s.boatPaint = in.boatPaint;
    s.boatDuv = in.boatDuv;
    s.emissive = 0.0;
    IVProgramTextures programTextures = { grimeTex, shadeTex, wavesTex, letteringTex };
    float metalness = mat.metalness;
    if ((flags & IV_MAT_METALNESS_MAP) != 0) metalness *= metalTex.sample(material, uv).b;
    s.metalness = metalness;
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
        runNormalProgram(s, programTextures);
        n = s.normal;
    } else if ((flags & IV_MAT_NORMAL_MAP) != 0 && (flags & IV_MAT_UNLIT) == 0) {
        float3 mapN = normalTex.sample(material, uv).xyz * 2.0 - 1.0;
        mapN.xy *= mat.normalScale;
        n = perturbNormal(in.worldPosition, geometryNormal, in.uv, mapN, faceDirection);
    }
    s.n = n;
    s.normal = n;
    if (kProgram != IV_PROGRAM_NONE) runSurfaceProgram(s, programTextures, (flags & IV_MAT_FLIP_Y) != 0);
    // A vec3 colour node has alpha 1, so the map's alpha drops out; an opacity node replaces opacity.
    if (kColorProgram) base = float4(s.color, mat.baseColor.a);
    if (kOpacityProgram) base.a = (kColorProgram ? 1.0 : base.a / max(mat.baseColor.a, 1e-6)) * s.opacity;
    roughness = s.roughness;
    if (kMetalnessProgram) metalness = s.metalness;
    if ((flags & IV_MAT_VERTEX_COLORS) != 0) base.rgb *= in.color;
    if (kAlphaTest && base.a < mat.alphaTest) discard_fragment();

    float3 toCamera = frame.cameraPosition - in.worldPosition;
    float3 color;
    // MRT surface data: MeshBasicMaterial has the geometry normal and no metalness or roughness.
    float3 surfaceNormal = geometryNormal;
    if ((flags & IV_MAT_UNLIT) != 0) {
        color = base.rgb;
        roughness = 0.0;
        metalness = 0.0;
    } else {
        float3 v = normalize(toCamera);
        surfaceNormal = n;

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
        // three (MaterialProperties.js materialEnvIntensity): envMapIntensity applies only to a material's
        // own envMap; under the scene environment every material takes scene.environmentIntensity.
        float envIntensity = frame.environmentIntensity;
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
        HBShadeTerms street;
        if (kHarborShade) street = hbShadeTerms(in.worldPosition, n, programParams, shadeTex);
        bool hasAO = (flags & IV_MAT_AO_MAP) != 0 || kSkyVisibility || kAOProgram != IV_AO_NONE;
        if (hasAO) {
            float ao = (flags & IV_MAT_AO_MAP) != 0 ? (aoTex.sample(material, uv).r - 1.0) * mat.aoMapIntensity + 1.0 : 1.0;
            if (kSkyVisibility) ao *= ivRailyardSkyVisibility(in.worldPosition, programParams);
            if (kAOProgram == IV_AO_HW_SKY_VISIBILITY) ao *= ivHeadworksSkyVisibility(in.worldPosition, programParams);
            if (kAOProgram == IV_AO_HB_SHADE) ao *= street.ambient;
            indirectDiffuse *= ao;
            indirectSpecular *= saturate(pow(dotNV + ao, exp2(-16.0 * roughness - 1.0)) - 1.0 + ao);
        }

        float3 emissive = mat.emissive;
        if ((flags & IV_MAT_EMISSIVE_MAP) != 0) emissive *= emissiveTex.sample(material, uv).rgb;
        if (kLampLit) emissive = base.rgb * ivRailyardLampGlow(in.worldPosition, n, programParams);
        if (kEmissiveProgram == IV_EMISSIVE_HW_LAMP_GLOW) emissive = base.rgb * ivHeadworksLampGlow(in.worldPosition, n, programParams);
        if (kEmissiveProgram == IV_EMISSIVE_HB_BOUNCE) emissive = base.rgb * street.bounce * HB_BOUNCE;
        if (kEmissiveNodeProgram) emissive = s.emissive;
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

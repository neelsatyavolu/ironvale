// Surface programs (PLAN.md 3.4): the hand-ported TSL colour, roughness, opacity, normal and
// occlusion nodes of map materials, chosen per pipeline by the `kProgram` function constant in
// MapPBR.metal. Each program lives in the .metal file named after its TSL source file:
//   src/maps/railyard/materials.ts       MapRailyardMaterials.metal
//   src/maps/railyard/ground.ts          MapRailyardGround.metal
//   src/maps/railyard/surfaces.ts        MapRailyardSurfaces.metal
//   src/maps/railyard/container-paint.ts MapRailyardContainerPaint.metal
//   src/maps/railyard/shelter.ts         MapRailyardShelter.metal
//   src/maps/railyard/lamps.ts           MapRailyardLamps.metal
//   src/maps/railyard/sky.ts             SkyRailyard.metal
//   src/maps/headworks/surfaces.ts       MapHeadworksSurfaces.metal
//   src/maps/headworks/materials.ts      MapHeadworksMaterials.metal
//   src/maps/headworks/decals.ts         MapHeadworksDecals.metal
//   src/maps/headworks/lamps.ts          MapHeadworksLamps.metal
//   src/maps/headworks/range.ts          MapHeadworksRange.metal
//   src/maps/headworks/sky.ts            SkyHeadworks.metal
//   src/render/materials.ts (wetness)    MapRangeMaterials.metal
//   src/maps/harbor/grime.ts             MapHarborGrime.metal
//   src/maps/harbor/shade.ts             MapHarborShade.metal
//   src/maps/harbor/surfaces.ts          MapHarborSurfaces.metal
//   src/maps/harbor/water.ts             MapHarborWater.metal
//   src/maps/harbor/glow.ts              MapHarborGlow.metal
//   src/maps/harbor/capes.ts             MapHarborCapes.metal
//   src/maps/harbor/boats.ts             MapHarborBoats.metal
//   src/maps/harbor/sky.ts               SkyHarbor.metal
// The program files are static inline and #included by MapPBR.metal so they inline into the
// specialised fragment function (external calls spill IVSurface to the stack).
// Program ids must match SurfaceProgram in IronvaleMapRender/SurfacePrograms.swift.
#ifndef IRONVALE_MAP_SURFACE_H
#define IRONVALE_MAP_SURFACE_H
#include <metal_stdlib>
using namespace metal;

#ifndef IV_SHADER_FN
/// Static helpers of the #included shader files; unused ones are expected in a standalone compile.
#define IV_SHADER_FN static inline __attribute__((unused))
#endif

#define IV_PROGRAM_NONE 0u
#define IV_PROGRAM_RY_ASPHALT 1u
#define IV_PROGRAM_RY_QUAY 2u
#define IV_PROGRAM_RY_FLOOR 3u
#define IV_PROGRAM_RY_WALL 4u
#define IV_PROGRAM_RY_CLADDING 5u
#define IV_PROGRAM_RY_CONTAINER 6u
#define IV_PROGRAM_RY_STEEL 7u
#define IV_PROGRAM_RY_HAZARD 8u
#define IV_PROGRAM_RY_WOOD 9u
#define IV_PROGRAM_RY_MATTE 10u
#define IV_PROGRAM_RY_CARTON 11u
#define IV_PROGRAM_RY_WRAP 12u
#define IV_PROGRAM_RY_PAINT 13u
#define IV_PROGRAM_RY_STAIN 14u
#define IV_PROGRAM_RY_CHAINLINK 15u
#define IV_PROGRAM_RY_WATER 16u
// Headworks (100 - 199), named "headworks.<name>" by the exporter.
#define IV_PROGRAM_HW_CONCRETE 100u
#define IV_PROGRAM_HW_CONCRETE_ROUND 101u
#define IV_PROGRAM_HW_PAVING 102u
#define IV_PROGRAM_HW_ROAD 103u
#define IV_PROGRAM_HW_PAINT 104u
#define IV_PROGRAM_HW_STAINLESS 105u
#define IV_PROGRAM_HW_GALVANISED 106u
#define IV_PROGRAM_HW_MATTE 107u
#define IV_PROGRAM_HW_HAZARD 108u
#define IV_PROGRAM_HW_GRATING 109u
#define IV_PROGRAM_HW_GLASS 110u
#define IV_PROGRAM_HW_WATER 111u
#define IV_PROGRAM_HW_STAIN 112u
#define IV_PROGRAM_HW_RUNOFF 113u
#define IV_PROGRAM_HW_LINE 114u
#define IV_PROGRAM_HW_TYRES 115u
#define IV_PROGRAM_HW_RANGE 116u
#define IV_PROGRAM_HW_RANGE_FLOOR 117u
// Harbor (200 - 299), named "harbor.<name>"; the factory families read their arguments from
// scene.json programArgs (IVSurface.args), in the order programs-harbor.ts lists them.
#define IV_PROGRAM_HB_PLASTER 200u       // tint rgb, mean luma, wear
#define IV_PROGRAM_HB_MASONRY 201u       // tint rgb, mean luma
#define IV_PROGRAM_HB_MASONRY_SLAB 202u  // tint rgb, mean luma, slab x, slab z
#define IV_PROGRAM_HB_COBBLES 203u       // 1 - coverage
#define IV_PROGRAM_HB_ROOF_TILES 204u    // tint rgb
#define IV_PROGRAM_HB_STAINED 205u       // tint rgb, mean luma
#define IV_PROGRAM_HB_PAINTED 206u       // tint rgb
#define IV_PROGRAM_HB_LOUVRED 207u       // tint rgb
#define IV_PROGRAM_HB_LIT_ROOM 208u
#define IV_PROGRAM_HB_LAMP_GLASS 209u    // tint rgb, peak
#define IV_PROGRAM_HB_STRIPED 210u       // stripe rgb, repeat
#define IV_PROGRAM_HB_SCUFFED 211u       // tint rgb
#define IV_PROGRAM_HB_STAIN_DECAL 212u
#define IV_PROGRAM_HB_HILLSIDE 213u
#define IV_PROGRAM_HB_TREE_SHADOW 214u
#define IV_PROGRAM_HB_LEAFY 215u         // dark rgb, light rgb, grain
#define IV_PROGRAM_HB_SEA 216u
#define IV_PROGRAM_HB_GLOW 217u
#define IV_PROGRAM_HB_HAZE 218u
#define IV_PROGRAM_HB_BOAT 219u
// Test range (300 - 399).
#define IV_PROGRAM_RG_WET_CONCRETE 300u

/// Occlusion programs (function constant 5) and emission programs (6) of the maps after Railyard,
/// whose own sky visibility and lamp pools keep function constants 2 and 3.
#define IV_AO_NONE 0u
#define IV_AO_HW_SKY_VISIBILITY 1u
#define IV_AO_HB_SHADE 2u
#define IV_EMISSIVE_NONE 0u
#define IV_EMISSIVE_HW_LAMP_GLOW 1u
#define IV_EMISSIVE_HB_BOUNCE 2u

/// Buffer and texture slots beyond ShaderTypes.h's, used only by the map programs.
#define IV_BUFFER_LIVERY 9
#define IV_BUFFER_PROGRAM_PARAMS 10
#define IV_TEXTURE_PROGRAM 8
/// Map-wide program textures (scene.json programTextures), bound once per scene pass.
#define IV_TEXTURE_GRIME 9
#define IV_TEXTURE_SHADE 10
#define IV_TEXTURE_WAVES 11
#define IV_TEXTURE_LETTERING 12
/// Per-material program arguments (scene.json programArgs), floats.
#define IV_BUFFER_PROGRAM_ARGS 11
/// Per-vertex attributes of the Harbor boats: paint (float4) and lettering uv (float2).
#define IV_BUFFER_BOAT_PAINT 12
#define IV_BUFFER_BOAT_DUV 13

/// Railyard program parameters (float4 rows), packed by RailyardProgramParams.swift from
/// scene.json `programParams` (written by native/Tools/map-export/page/programs.ts).
#define IV_RY_SUN_IN_SKY 0     // xyz sun direction in the sky texture's frame, w glow count
#define IV_RY_WAREHOUSE_A 1    // west, east, north, south
#define IV_RY_WAREHOUSE_B 2    // eaves, ridge, door west, door east
#define IV_RY_MEZZANINE 3      // east, north, south, top
#define IV_RY_OFFICE_A 4       // west, east, north, south
#define IV_RY_OFFICE_B 5       // height
#define IV_RY_GLOWS 6          // per glow: (at, strength), (linear colour, reach), (down, facing x, facing z, has facing)
#define IV_RY_MAX_GLOWS 32

/// Headworks rows, written by native/Tools/map-export/page/programs-headworks.ts.
#define IV_HW_COUNTS 0         // house count, lamp count, sky panorama gain
#define IV_HW_HDRI_SUN 1       // xyz sun in the sky image's own frame
#define IV_HW_FOG 2            // linear fog colour
#define IV_HW_SUN_COLOR 3      // linear SUN_COLOR
#define IV_HW_SUN_DIRECTION 4  // xyz level sun direction
#define IV_HW_RANGE_FOG 5      // linear FOG_COLOR
#define IV_HW_HOUSES 6         // per house: (x0, x1, z0, z1), (height); then per lamp:
                               // (glow position, high), (linear colour), (wall normal x, z)

/// Harbor rows (programs-harbor.ts).
#define IV_HB_SHADE_GRID 0     // x0, z0, width, depth of the shade bake in metres
#define IV_HB_HEIGHTS 1        // HEIGHT_RANGE, HEIGHT_FLOOR, TERRACE_Y
#define IV_HB_ALLEY 2          // x0, x1, stepsFromZ, risers x tread
#define IV_HB_RAMP 3           // x0, x1, z0, z1
#define IV_HB_TIER_Z 4         // street tiers: north edges
#define IV_HB_TIER_Y 5         //               heights
#define IV_HB_SKY 6            // HDRI sun azimuth, elevation, panorama gain
#define IV_HB_WATER 7          // QUAY_EDGE, WATER_Y, boat DRAFT, jetty count
#define IV_HB_MOLE 8           // x1, z1
#define IV_HB_SLIPWAY 9        // x0, x1, z1
#define IV_HB_JETTIES 10       // per jetty: x, width, length, head

/// Test range rows (programs-range.ts).
#define IV_RG_WETNESS 0        // wetness, puddle scale

/// What a program reads and writes. Inputs are set by ivMapFragment; outputs start at the
/// generic material's values (three's materialColor, materialRoughness, materialAO, ...).
struct IVSurface {
    float3 p;                 // positionWorld
    float3 n;                 // normalWorld: the geometry normal in a normal program, the final one elsewhere
    float3 localP;            // positionGeometry
    float3 localN;            // normalLocal
    float2 uv;                // uv(), as the geometry stores it
    float2 uvDiagonalWidth;   // fwidth(uv.x + uv.y), fwidth(uv.x - uv.y)
    float viewDepth;          // -positionView.z
    float time;
    float3 livery;            // per-instance livery colour (container paint)
    float4 programTexel;      // texture(maps.color, uv()) for programs whose colour node samples one
    float3 programNormal;     // normalMap(texture(maps.normal)) for programs whose normal node uses one
    float3 materialColor;     // color x map
    float materialRoughness;  // roughness x roughnessMap.g
    constant float4 *rows;    // scene.json programRows (maps after Railyard)
    constant float *args;     // scene.json programArgs of this material
    float4 mapTexel;          // texture(maps.color, uv()), the material's own colour map (1 without one)
    float4 armTexel;          // texture(maps.arm, uv()) through the roughness slot (1 without one)
    float3 cameraPosition;
    float3x3 view;            // world to view rotation, for normals built in view space
    float3 geometryNormal;    // normalView before any normal node, in world space
    float4 boatPaint;         // attribute('paint') of the Harbor boats
    float2 boatDuv;           // attribute('duv') of the Harbor boats
    // Outputs.
    float3 color;
    float opacity;
    float roughness;
    float3 normal;
    float metalness;          // starts at metalness x metalnessMap.b; metalness programs replace it
    float3 emissive;          // emission programs (lit rooms, lamp glass, the sea's scatter)
};

/// The map-wide textures the Harbor programs sample.
struct IVProgramTextures {
    texture2d<float> grime;
    texture2d<float> shade;
    texture2d<float> waves;
    texture2d<float> lettering;
};

/// three's color(hex): an sRGB hex code as linear RGB.
IV_SHADER_FN float3 ivHexColor(uint hex) {
    float3 c = float3((hex >> 16) & 0xffu, (hex >> 8) & 0xffu, hex & 0xffu) / 255.0;
    return select(pow((c + 0.055) / 1.055, 2.4), c / 12.92, c <= 0.04045);
}

/// WGSL smoothstep, defined for reversed edges too (Metal's is not).
IV_SHADER_FN float ivSmoothstep(float low, float high, float x) {
    float t = clamp((x - low) / (high - low), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}


/// soak() of ground.ts on the textured ground materials.
struct IVSoak {
    float damp;
    float puddleScale;
    float cover;
    float tone;
};

#endif

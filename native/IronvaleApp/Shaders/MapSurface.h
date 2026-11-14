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

/// Buffer and texture slots beyond ShaderTypes.h's, used only by the map programs.
#define IV_BUFFER_LIVERY 9
#define IV_BUFFER_PROGRAM_PARAMS 10
#define IV_TEXTURE_PROGRAM 8

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
    // Outputs.
    float3 color;
    float opacity;
    float roughness;
    float3 normal;
};


/// soak() of ground.ts on the textured ground materials.
struct IVSoak {
    float damp;
    float puddleScale;
    float cover;
    float tone;
};

#endif

// M7a soldier shader types (shared by Swift and Shaders/Soldier.metal). Included from ShaderTypes.h.
// The soldier pass binds IVFrameUniforms at IV_BUFFER_FRAME and the environment and sun shadow map
// at IV_TEXTURE_ENVIRONMENT and IV_TEXTURE_SHADOW, like the map pass, so it can share its encoder.
#ifndef IRONVALE_SOLDIER_TYPES_H
#define IRONVALE_SOLDIER_TYPES_H

#include <simd/simd.h>

/// Vertex and fragment buffer indices for the soldier pipelines (9 and up: clear of the map's 0-8).
#define IV_SOLDIER_BUFFER_POSITION 9
#define IV_SOLDIER_BUFFER_NORMAL 10
#define IV_SOLDIER_BUFFER_UV 11
#define IV_SOLDIER_BUFFER_JOINTS 12
#define IV_SOLDIER_BUFFER_WEIGHTS 13
#define IV_SOLDIER_BUFFER_INSTANCES 14
#define IV_SOLDIER_BUFFER_PALETTE 15
#define IV_SOLDIER_BUFFER_MATERIAL 16

/// Texture indices: colour (sRGB), normal, packed cloth mask / roughness / metalness.
#define IV_SOLDIER_TEXTURE_COLOR 0
#define IV_SOLDIER_TEXTURE_NORMAL 1
#define IV_SOLDIER_TEXTURE_ORM 2

/// One drawn soldier body or rifle.
typedef struct {
    simd_float4x4 model;      // body: root transform (feet, yaw); rifle: root x gun transform
    uint32_t paletteOffset;   // first joint matrix of this body in the palette buffer
    uint32_t team;            // 0 alpha, 1 bravo
    uint32_t _pad0;
    uint32_t _pad1;
} IVSoldierInstance;

/// rig.ts teamMaterial: colorNode = mix(base, tint * luma(base) * gain, cloth * amount).
typedef struct {
    simd_float4 tint[2];      // linear tint colour x gain in rgb, amount in a; per team
    simd_float2 normalScale;  // three's normalScale (y negated for derivative tangents, GLTFLoader)
    float roughness;          // material factors (the packed map's G and B multiply these)
    float metalness;
    uint32_t teamTint;        // 1 body, 0 rifle
    uint32_t _pad0;
    uint32_t _pad1;
    uint32_t _pad2;
} IVSoldierMaterial;

#endif

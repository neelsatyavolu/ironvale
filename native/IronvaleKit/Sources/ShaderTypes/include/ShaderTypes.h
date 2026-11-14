// Structs shared between Swift and MSL. Keep this header C and MSL compatible:
// only <simd/simd.h> types, no Swift- or Metal-only constructs.
// simd_float3 and MSL float3 are both 16 bytes with 16-byte alignment, so layouts match.
#ifndef IRONVALE_SHADER_TYPES_H
#define IRONVALE_SHADER_TYPES_H

#include <simd/simd.h>

typedef struct {
    simd_float4 color;
    float time;
    float _pad0;
    float _pad1;
    float _pad2;
} IVClearUniforms;

// ---- M3 renderer (PLAN.md 3.3) ----

/// Maximum punctual lights (point and spot) the forward pass loops over.
#define IV_MAX_LIGHTS 16

/// Buffer indices shared by the map vertex and fragment functions.
#define IV_BUFFER_POSITION 0
#define IV_BUFFER_NORMAL 1
#define IV_BUFFER_UV 2
#define IV_BUFFER_COLOR 3
#define IV_BUFFER_INSTANCES 4
#define IV_BUFFER_DRAW 5
#define IV_BUFFER_FRAME 6
#define IV_BUFFER_MATERIAL 7
#define IV_BUFFER_LIGHTS 8

/// Texture indices for the map fragment function.
#define IV_TEXTURE_MAP 0
#define IV_TEXTURE_NORMAL 1
#define IV_TEXTURE_ROUGHNESS 2
#define IV_TEXTURE_METALNESS 3
#define IV_TEXTURE_AO 4
#define IV_TEXTURE_EMISSIVE 5
#define IV_TEXTURE_ENVIRONMENT 6
#define IV_TEXTURE_SHADOW 7

/// IVMaterialUniforms.flags bits.
#define IV_MAT_MAP (1u << 0)
#define IV_MAT_NORMAL_MAP (1u << 1)
#define IV_MAT_ROUGHNESS_MAP (1u << 2)
#define IV_MAT_METALNESS_MAP (1u << 3)
#define IV_MAT_AO_MAP (1u << 4)
#define IV_MAT_EMISSIVE_MAP (1u << 5)
#define IV_MAT_VERTEX_COLORS (1u << 6)
#define IV_MAT_UNLIT (1u << 7)
#define IV_MAT_FOG (1u << 8)
#define IV_MAT_FLIP_Y (1u << 9)
#define IV_MAT_RECEIVE_SHADOW (1u << 10)
#define IV_MAT_DOUBLE_SIDED (1u << 11)
#define IV_MAT_BACK_SIDE (1u << 12)

/// IVLight.kind values.
#define IV_LIGHT_POINT 0u
#define IV_LIGHT_SPOT 1u

/// Per-frame constants: camera, sun, sky, fog and shadow. One copy per frame in flight.
typedef struct {
    simd_float4x4 viewProjection;
    simd_float4x4 view;
    simd_float4x4 inverseViewProjection;
    simd_float4x4 shadowViewProjection;
    simd_float3 cameraPosition;
    float time;
    simd_float3 sunDirection;     // toward the sun, normalised
    float environmentIntensity;   // scene.environmentIntensity (skyIntensity x sky light)
    simd_float3 sunColor;         // linear colour x intensity
    float backgroundIntensity;    // scene.backgroundIntensity
    simd_float3 fogColor;         // linear
    float fogDensity;             // 0 disables fog
    simd_float3 fogSunTint;       // linear
    float fogSunTintStrength;
    simd_float3 hemiSkyColor;     // linear colour x intensity
    float fogHeightFalloff;
    simd_float3 hemiGroundColor;  // linear colour x intensity
    float fogBaseHeight;
    float environmentRotation;    // hdriRotation, radians
    float environmentMaxLod;      // last roughness level of the prefiltered environment
    float shadowBias;
    float shadowNormalBias;
    float shadowTexelWorld;       // world size of one shadow texel
    float shadowEnabled;          // 0 or 1
    uint32_t lightCount;
    float _pad0;
} IVFrameUniforms;

/// One punctual light, in world space.
typedef struct {
    simd_float3 position;
    float distance;               // cut-off distance, 0 = none
    simd_float3 color;            // linear colour x intensity
    float decay;
    simd_float3 direction;        // spot: from target toward the light, normalised
    float coneCos;
    uint32_t kind;
    float penumbraCos;
    float _pad0;
    float _pad1;
} IVLight;

/// Per-draw constants.
typedef struct {
    simd_float4x4 model;
    simd_float4x4 normalMatrix;   // inverse-transpose of model's upper 3x3, in a 4x4
    uint32_t instanced;
    uint32_t hasColor;
    uint32_t _pad0;
    uint32_t _pad1;
} IVDrawUniforms;

/// Generic PBR material (three's MeshStandardMaterial / MeshBasicMaterial parameters).
typedef struct {
    simd_float4 baseColor;        // linear rgb, opacity in a
    simd_float3 emissive;         // linear colour x emissiveIntensity
    float roughness;
    simd_float2 normalScale;
    float metalness;
    float alphaTest;
    float aoMapIntensity;
    float envMapIntensity;
    uint32_t flags;
    float _pad0;
} IVMaterialUniforms;

/// Final pass: tone map, encode and vignette.
typedef struct {
    float exposure;
    float vignetteInner;
    float vignetteOuter;
    float vignetteStrength;
} IVPostUniforms;

/// Environment prefilter (one roughness level of the equirect mip chain).
typedef struct {
    float roughness;
    uint32_t sampleCount;
    float sourceWidth;
    uint32_t level;
} IVPrefilterUniforms;

#endif

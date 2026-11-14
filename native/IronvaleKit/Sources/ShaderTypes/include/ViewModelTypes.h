// M9 first-person view-model shader types (Swift IronvaleViewModel/ViewModelRenderer.swift and
// Shaders/ViewModel.metal). The view-model pass draws inside the map's scene and sun shadow passes,
// which bind IVFrameUniforms at IV_BUFFER_FRAME, the lights at IV_BUFFER_LIGHTS and the environment
// and shadow map at IV_TEXTURE_ENVIRONMENT and IV_TEXTURE_SHADOW (ShaderTypes.h).
#ifndef IRONVALE_VIEWMODEL_TYPES_H
#define IRONVALE_VIEWMODEL_TYPES_H

#include <simd/simd.h>

/// Buffer indices (17 and up: clear of the map's 0-8 and 10-13 and the soldiers' 9-16).
#define IV_VM_BUFFER_POSITION 17
#define IV_VM_BUFFER_NORMAL 18
#define IV_VM_BUFFER_UV 19
#define IV_VM_BUFFER_JOINTS 20
#define IV_VM_BUFFER_WEIGHTS 21
#define IV_VM_BUFFER_DRAW 22
#define IV_VM_BUFFER_PALETTE 23
#define IV_VM_BUFFER_MATERIAL 24

/// Texture indices: base colour (sRGB), normal, packed occlusion/roughness/metalness, occlusion.
#define IV_VM_TEXTURE_COLOR 0
#define IV_VM_TEXTURE_NORMAL 1
#define IV_VM_TEXTURE_METALROUGH 2
#define IV_VM_TEXTURE_AO 3

/// IVViewModelMaterial.flags bits.
#define IV_VM_COLOR_MAP (1u << 0)
#define IV_VM_NORMAL_MAP (1u << 1)
#define IV_VM_METALROUGH_MAP (1u << 2)
#define IV_VM_AO_MAP (1u << 3)
#define IV_VM_UNLIT (1u << 4)
#define IV_VM_KEEP_OUT_OF_REFLECTIONS (1u << 5)

/// IVViewModelMaterial.finish values: how colour, roughness and metalness are made.
#define IV_VM_FINISH_STANDARD 0u   // glTF factors x maps (guns-a, m24, holo body, arms)
#define IV_VM_FINISH_TUNED 1u      // guns-c-materials.ts tunedFinish
#define IV_VM_FINISH_M7 2u         // m7-materials.ts m7Finish
#define IV_VM_FINISH_RETICLE 3u    // guns-c-optic.ts reticleMaterial (collimated dot and ring)

/// One draw: a gun mesh node or the skinned arms. Matrices are in camera space before the
/// view-model depth compression (`depthScale` multiplies camera-space z after them, rig.ts root.scale.z).
typedef struct {
    simd_float4x4 model;          // mesh -> camera space (identity for the skinned arms: the palette is)
    simd_float4x4 normalMatrix;   // inverse transpose of model's 3x3
    simd_float4x4 cameraToWorld;  // the scene camera's world transform
    float depthScale;
    uint32_t skinned;
    uint32_t _pad0;
    uint32_t _pad1;
} IVViewModelDraw;

typedef struct {
    simd_float4 baseColor;        // linear rgb, opacity
    simd_float2 normalScale;
    float roughness;
    float metalness;
    float aoIntensity;
    uint32_t flags;
    uint32_t finish;
    float _pad0;
    // Tuned (guns-c) and M7 finishes: tint (linear) and their tweak numbers.
    simd_float4 tint;             // rgb tint, a unused
    simd_float4 lift;             // tuned: metalLift, polymerLift, roughness, roughnessBias
    simd_float4 rough;            // tuned: scratchGloss, minRoughness, maxRoughness, metalness
    simd_float4 noise;            // wear, noiseScale, rub, mottle (M7)
    // Reticle (radians): dot, ring, ringWidth, gain.
    simd_float4 reticle;
} IVViewModelMaterial;

#endif

// M9 post chain types (PLAN.md 3.3), shared by Swift (IronvaleRender/Post) and Shaders/Post*.metal.
// Included from ShaderTypes.h. Same layout rules: <simd/simd.h> types only.
#ifndef IRONVALE_POST_TYPES_H
#define IRONVALE_POST_TYPES_H

#include <simd/simd.h>

/// Scene MRT layout (src/render/pipeline.ts mrt({output, normal, metalrough})): every pipeline that
/// draws into the scene pass declares these formats; see-through ones mask attachments 1 and 2.
#define IV_SCENE_ATTACHMENT_NORMAL 1      // rgba8Unorm, packNormalToRGB(normalView)
#define IV_SCENE_ATTACHMENT_METALROUGH 2  // rg8Unorm, (metalness, roughness)

/// Camera and frame data every post pass reads. Matrices are column-major; view space looks down -Z.
typedef struct {
    simd_float4x4 projection;                   // as rendered (jittered when the temporal pass is on)
    simd_float4x4 inverseProjection;
    simd_float4x4 cameraWorld;                  // view -> world
    simd_float4x4 view;                         // world -> view
    simd_float4x4 viewProjectionNoJitter;       // this frame, without jitter
    simd_float4x4 previousViewProjectionNoJitter;
    simd_float4x4 shadowViewProjection;         // world -> sun shadow clip (depth 0..1, near..far)
    simd_float3 cameraPosition;
    float near;
    simd_float2 sceneSize;                      // scene pass size in pixels
    float far;
    float time;
    simd_float2 jitterUV;                       // the projection's sub-pixel offset this frame, in uv units
    uint32_t frameIndex;
    float _pad0;
} IVPostView;

/// GTAONode uniforms (three r187 examples/jsm/tsl/display/GTAONode.js).
typedef struct {
    simd_float2 resolution;        // AO target size
    float radius;
    float thickness;
    float temporalDirection;       // _temporalRotations[frame % 6] / 360, or 0
    float temporalOffset;          // _spatialOffsets[frame % 4], or 1
    float scale;                   // pow(ao, scale)
    float halfResolution;          // 1 when the AO target is smaller than the depth buffer
    uint32_t samples;              // 8 or 12 (3 directions, ceil(samples / 3) steps)
    float _pad0;
    float _pad1;
    float _pad2;
} IVGTAOParams;

/// SSRNode uniforms (blur mode: stochastic false, reflectNonMetals true).
typedef struct {
    simd_float2 resolution;        // SSR target size
    float maxDistance;
    float thickness;
    float intensity;
    float maxLuminance;
    float quality;
    float _pad0;
} IVSSRParams;

/// boxBlur.js (SSR roughness mips).
typedef struct {
    float separation;
    int32_t size;
    float _pad0;
    float _pad1;
} IVBoxBlurParams;

/// GodraysNode uniforms (directional light).
typedef struct {
    simd_float4 planes[6];         // xyz = -frustum plane normal, w = -constant: dot(p, xyz) + w > 0 outside
    float density;                 // already divided by 100
    float maxDensity;
    float distanceAttenuation;
    float shadowNear;
    float shadowFar;
    uint32_t raymarchSteps;
    simd_float2 resolution;        // godrays target size
} IVGodraysParams;

/// BilateralBlurNode uniforms.
typedef struct {
    simd_float2 invSize;
    simd_float2 direction;
    float sigmaColorFactor;        // -0.5 / sigmaColor^2
    uint32_t kernelSize;           // sigma * 2 + 3
    float _pad0;
    float _pad1;
    float coefficients[12];
} IVBilateralParams;

/// BloomNode uniforms: high pass, one separable blur level, or the composite.
typedef struct {
    simd_float2 invSize;
    simd_float2 direction;
    float threshold;
    float smoothWidth;
    float strength;
    float radius;
    uint32_t kernelTaps;           // number of (offset, weight) pairs
    float centerWeight;
    float _pad0;
    float _pad1;
    simd_float4 offsetsWeights[6]; // xy = (offset, weight) of tap 2i, zw = tap 2i + 1
} IVBloomParams;

/// Scene composite of pipeline.ts: AO, SSR and sun in-scatter on the HDR colour.
typedef struct {
    simd_float3 shaftColor;        // linear sunColor x sunIntensity x 0.22
    float volumetric;
    float shaftFadeStart;          // 110 m
    float shaftFadeEnd;            // 320 m
    float ssrMips;                 // blur mip count - 1 (5)
    uint32_t flags;                // IV_POST_* bits
} IVPostCompositeParams;

/// TRAANode uniforms the frame view does not carry (Shaders/PostTRAA.metal).
typedef struct {
    simd_float4x4 previousCameraWorld;          // last frame's view -> world
    simd_float4x4 previousInverseProjection;    // last frame's, as rendered (jittered)
    uint32_t restart;                           // 1: no history yet (first frame, or a resize)
    uint32_t subpixelCorrection;                // TRAANode.useSubpixelCorrection
    float _pad0;
    float _pad1;
} IVTRAAParams;

/// Final display pass: renderOutput (ACES Filmic + sRGB), vignette, film grain.
typedef struct {
    float exposure;
    float vignetteInner;
    float vignetteOuter;
    float vignetteStrength;
    float grainIntensity;          // 0 disables film()
    float time;
    uint32_t flags;                // IV_POST_BLOOM
    float _pad0;
} IVPostOutputParams;

#define IV_POST_AO (1u << 0)
#define IV_POST_SSR (1u << 1)
#define IV_POST_GODRAYS (1u << 2)
#define IV_POST_BLOOM (1u << 3)

#endif

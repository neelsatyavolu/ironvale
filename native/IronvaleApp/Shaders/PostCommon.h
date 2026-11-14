// Helpers shared by the M9 post passes (Shaders/Post*.metal). Header only.
// The scene depth is reverse-Z (near 1, far 0, cleared to 0); three's post nodes read standard
// depth, so their getViewPosition / perspectiveDepthToViewZ / isBackgroundDepth become the
// reverse-Z forms below. uv has v = 0 at the top, as three's WebGPU backend.
#ifndef IRONVALE_POST_COMMON_H
#define IRONVALE_POST_COMMON_H
#include <metal_stdlib>
#include "ShaderTypes.h"
using namespace metal;

struct PostVaryings {
    float4 position [[position]];
    float2 uv;
};

constexpr sampler ivPostLinear(filter::linear, address::clamp_to_edge);
constexpr sampler ivPostNearest(filter::nearest, address::clamp_to_edge);

static inline bool ivIsBackground(float depth) { return depth <= 0.0; }

/// View-space z (negative in front of the camera) of a reverse-Z depth value.
static inline float ivViewZ(float depth, float near, float far) {
    float a = near / (far - near);
    float b = near * far / (far - near);
    return -b / (depth + a);
}

/// three getViewPosition: uv + depth -> view-space position through the inverse projection.
static inline float3 ivViewPosition(float2 uv, float depth, float4x4 inverseProjection) {
    float4 clip = float4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
    float4 v = inverseProjection * clip;
    return v.xyz / v.w;
}

/// three getScreenPositionFromClip.
static inline float2 ivScreenFromClip(float4 clip) {
    float2 ndc = clip.xy / clip.w;
    return float2(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

/// three getScreenPosition.
static inline float2 ivScreenPosition(float3 viewPosition, float4x4 projection) {
    return ivScreenFromClip(projection * float4(viewPosition, 1.0));
}

/// three luminance() with linear Rec. 709 coefficients (ColorManagement working space).
static inline float ivLuminance(float3 c) { return dot(c, float3(0.2126729, 0.7151522, 0.0721750)); }

/// three interleavedGradientNoise.
static inline float ivInterleavedGradientNoise(float2 p) {
    return fract(52.9829189 * fract(dot(p, float2(0.06711056, 0.00583715))));
}

/// three rand().
static inline float ivRand(float2 uv) {
    return fract(sin(dot(uv, float2(12.9898, 78.233))) * 43758.5453);
}

// three r187 nodes/display/ToneMappingFunctions.js acesFilmicToneMapping (columns of three's
// row-major mat3 literals).
static inline float3 ivRRTAndODTFit(float3 c) {
    float3 a = c * (c + 0.0245786) - 0.000090537;
    float3 b = c * (0.983729 * c + 0.4329510) + 0.238081;
    return a / b;
}

static inline float3 ivACESFilmic(float3 color, float exposure) {
    const float3x3 input = float3x3(float3(0.59719, 0.07600, 0.02840),
                                    float3(0.35458, 0.90834, 0.13383),
                                    float3(0.04823, 0.01566, 0.83777));
    const float3x3 output = float3x3(float3(1.60475, -0.10208, -0.00327),
                                     float3(-0.53108, 1.10813, -0.07276),
                                     float3(-0.07367, -0.00605, 1.07602));
    color = color * exposure / 0.6;
    color = output * ivRRTAndODTFit(input * color);
    return saturate(color);
}

static inline float3 ivLinearToSRGB(float3 c) {
    return select(1.055 * pow(c, 1.0 / 2.4) - 0.055, c * 12.92, c <= 0.0031308);
}
#endif

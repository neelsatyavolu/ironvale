// The per-pixel math of three's TRAA (three r187 examples/jsm/tsl/display/TRAANode.js and
// examples/jsm/tsl/utils/TAAUtils.js), used by PostTRAA.metal. Header only, and it includes nothing but
// metal_stdlib so IronvaleRenderTests can compile it on its own and check it against the TS values
// (native/Tools/m3-parity/fixtures/traa.json).
// Depths here are three's standard perspective depth (0 near, 1 far); the native scene depth is
// reverse-Z, and 1 - reverse-Z depth is exactly the standard depth of the same projection.
#ifndef IRONVALE_POST_TRAA_H
#define IRONVALE_POST_TRAA_H
#include <metal_stdlib>
using namespace metal;

/// TRAANode defaults.
constant float IV_TRAA_DEPTH_THRESHOLD = 0.0005;  // depthThreshold
constant float IV_TRAA_EDGE_DEPTH_DIFF = 0.001;   // edgeDepthDiff
constant float IV_TRAA_MAX_VELOCITY = 128.0;      // maxVelocityLength (pixels)
constant float IV_TRAA_MIN_WEIGHT = 0.05;         // the minimum weight of the current frame
constant float IV_TRAA_SUBPIXEL_WEIGHT = 0.25;    // subpixel correction's share of that weight

/// three luminance() with the working colour space's coefficients (ColorManagement, Rec. 709).
static inline float ivTRAALuminance(float3 c) { return dot(c, float3(0.2126, 0.7152, 0.0722)); }

/// TAAUtils clipAABB: history clipped toward the centre of the [minColor, maxColor] box.
static inline float4 ivTRAAClipAABB(float4 currentColor, float4 historyColor, float4 minColor, float4 maxColor) {
    float3 pClip = (maxColor.rgb + minColor.rgb) * 0.5;
    float3 eClip = (maxColor.rgb - minColor.rgb) * 0.5 + 1e-7;
    float4 vClip = historyColor - float4(pClip, currentColor.a);
    float3 vUnit = vClip.xyz / eClip;
    float3 absUnit = abs(vUnit);
    float maxUnit = max(absUnit.x, max(absUnit.y, absUnit.z));
    return maxUnit > 1.0 ? float4(pClip, currentColor.a) + vClip / maxUnit : historyColor;
}

/// TAAUtils flickerReduction: the blend of current and history, each weighted down by its luminance.
static inline float4 ivTRAAFlickerReduction(float4 currentColor, float4 historyColor, float currentWeight) {
    float4 compressedCurrent = currentColor * (1.0 / (max(currentColor.r, max(currentColor.g, currentColor.b)) + 1.0));
    float4 compressedHistory = historyColor * (1.0 / (max(historyColor.r, max(historyColor.g, historyColor.b)) + 1.0));
    float luminanceCurrent = ivTRAALuminance(compressedCurrent.rgb);
    float luminanceHistory = ivTRAALuminance(compressedHistory.rgb);
    float weightCurrent = currentWeight / (luminanceCurrent + 1.0);
    float weightHistory = (1.0 - currentWeight) / (luminanceHistory + 1.0);
    return (currentColor * weightCurrent + historyColor * weightHistory) / max(weightCurrent + weightHistory, 0.00001);
}

/// TRAANode subpixelCorrection: how far (0 to 1) the velocity is from whole pixels.
static inline float ivTRAASubpixelCorrection(float2 velocityUV, float2 textureSize) {
    float2 velocityTexel = velocityUV * textureSize;
    float2 phase = abs(fract(velocityTexel));
    float2 weight = max(phase, 1.0 - phase);
    return (1.0 - weight.x * weight.y) / 0.75;
}

/// TRAANode resolve: motion in pixels over maxVelocityLength, saturated.
static inline float ivTRAAMotionFactor(float2 uv, float2 historyUV, float2 textureSize) {
    return saturate(length((uv - historyUV) * textureSize) / IV_TRAA_MAX_VELOCITY);
}

/// TRAANode resolve: the weight of the current frame (1 without valid history).
static inline float ivTRAACurrentWeight(float2 offsetUV, float2 textureSize, float motionFactor, bool hasValidHistory,
                                        bool useSubpixelCorrection) {
    float weight = IV_TRAA_MIN_WEIGHT;
    if (useSubpixelCorrection) weight += ivTRAASubpixelCorrection(offsetUV, textureSize) * IV_TRAA_SUBPIXEL_WEIGHT;
    return hasValidHistory ? saturate(weight + motionFactor) : 1.0;
}

/// TRAANode resolve: the variance clipping gamma, mix(0.5, 1, (1 - motionFactor)^2).
static inline float ivTRAAVarianceGamma(float motionFactor) {
    float still = 1.0 - motionFactor;
    return mix(0.5, 1.0, still * still);
}

/// TRAANode resolve: history is used when its uv is on screen and the pixel is not disoccluded,
/// except on depth edges.
static inline bool ivTRAAHasValidHistory(float2 historyUV, float closestDepth, float farthestDepth, float previousDepth) {
    bool isValidUV = all(historyUV >= 0.0) && all(historyUV <= 1.0);
    bool isEdge = farthestDepth - closestDepth > IV_TRAA_EDGE_DEPTH_DIFF;
    bool isDisocclusion = closestDepth - previousDepth > IV_TRAA_DEPTH_THRESHOLD;
    return isValidUV && (isEdge || !isDisocclusion);
}

/// three viewZToPerspectiveDepth (standard depth, 0 at near, 1 at far).
static inline float ivTRAAViewZToPerspectiveDepth(float viewZ, float near, float far) {
    return ((near + viewZ) * far) / ((far - near) * viewZ);
}
#endif

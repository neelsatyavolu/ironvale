// TRAA resolve, ported from three r187 examples/jsm/tsl/display/TRAANode.js (setup's resolve()) and
// examples/jsm/tsl/utils/TAAUtils.js, as src/render/pipeline.ts (commit 1aca0b7) uses it: on the HDR
// composite at the scene (render-scale x dynamic) size, before bloom. The per-pixel math is in PostTRAA.h.
// Differences from the web, none of which change the result:
// - The web reads a velocity MRT target at the closest texel; the map is static, so the motion is
//   reprojected here from that texel's depth with this and last frame's unjittered view-projections
//   (what three's VelocityNode computes for a static object), in uv units.
// - The web resolves into one target and copies it and the scene depth into the history afterwards;
//   here the resolve writes the history colour and the depth copy as two attachments of a ping-ponged
//   pair (PostTargets.traaHistory, traaDepth), so there are no copies.
// - Depth is reverse-Z: 1 - depth is the standard depth three's thresholds are tuned for.
// One deliberate difference: the centre beauty sample is clamped with max(0) like the neighbours, so a
// NaN in the scene colour (seen on Harbor, see PLAN.md 3.3) cannot enter the history.
#include <metal_stdlib>
#include "ShaderTypes.h"
#include "PostCommon.h"
#include "PostTRAA.h"
using namespace metal;

struct TRAAOut {
    float4 color [[color(0)]];  // the resolve, also next frame's history
    float depth [[color(1)]];   // the scene depth (reverse-Z), next frame's previous depth
};

static inline uint2 ivTRAAClampTexel(float2 p, uint2 size) {
    return uint2(clamp(int2(floor(p)), int2(0), int2(size) - 1));
}

fragment TRAAOut ivTRAAFragment(PostVaryings in [[stage_in]],
                                constant IVPostView &view [[buffer(0)]],
                                constant IVTRAAParams &params [[buffer(1)]],
                                texture2d<float> beauty [[texture(0)]],
                                depth2d<float> depthTex [[texture(1)]],
                                texture2d<float> history [[texture(2)]],
                                texture2d<float> previousDepthTex [[texture(3)]]) {
    uint2 size = uint2(beauty.get_width(), beauty.get_height());
    float2 textureSize = float2(size);
    float2 uv = in.uv;
    float2 positionTexel = in.position.xy;  // uv x textureSize

    // TAAUtils sampleCurrentDepth: the closest and farthest depth of the 3 x 3 neighbourhood.
    float closestDepth = 2.0;
    float2 closestPositionTexel = float2(0.0);
    float closestRaw = 0.0;
    float farthestDepth = -1.0;
    float centreRaw = 0.0;
    for (int x = -1; x <= 1; ++x) {
        for (int y = -1; y <= 1; ++y) {
            float2 neighbor = positionTexel + float2(x, y);
            float raw = depthTex.read(ivTRAAClampTexel(neighbor, size));
            float depth = 1.0 - raw;
            if (x == 0 && y == 0) centreRaw = raw;
            if (depth < closestDepth) {
                closestDepth = depth;
                closestPositionTexel = neighbor;
                closestRaw = raw;
            }
            if (depth > farthestDepth) farthestDepth = depth;
        }
    }

    // The velocity at the closest texel (current uv minus previous uv), as offsetUV.
    float2 closestUV = (floor(closestPositionTexel) + 0.5) / textureSize;
    float3 closestView = ivViewPosition(closestUV, closestRaw, view.inverseProjection);
    float4 closestWorld = view.cameraWorld * float4(closestView, 1.0);
    float2 offsetUV = ivScreenFromClip(view.viewProjectionNoJitter * closestWorld)
        - ivScreenFromClip(view.previousViewProjectionNoJitter * closestWorld);
    float2 historyUV = uv - offsetUV;

    // TAAUtils samplePreviousDepth: last frame's depth at historyUV, as a depth in this frame's view.
    // After a restart the web's history depth is a fresh (zero) texture: standard depth 0.
    float previousRaw = params.restart != 0 ? 1.0 : previousDepthTex.sample(ivPostNearest, historyUV).r;
    float3 previousView = ivViewPosition(historyUV, previousRaw, params.previousInverseProjection);
    float3 previousWorld = (params.previousCameraWorld * float4(previousView, 1.0)).xyz;
    float viewZ = (view.view * float4(previousWorld, 1.0)).z;
    float previousDepth = ivTRAAViewZToPerspectiveDepth(viewZ, view.near, view.far);

    bool hasValidHistory = ivTRAAHasValidHistory(historyUV, closestDepth, farthestDepth, previousDepth);

    // max(0) as TRAANode does for the neighbours ("to prevent NaN values from propagating"), here for the
    // centre too: one non-finite scene texel would otherwise live on in the history and bloom would spread
    // it over the frame. No change for any finite, non-negative colour.
    float4 currentColor = max(beauty.sample(ivPostLinear, uv), 0.0);
    // After a restart the web's history is a copy of the beauty buffer.
    float4 historyColor = params.restart != 0 ? beauty.sample(ivPostLinear, historyUV) : history.sample(ivPostLinear, historyUV);

    float motionFactor = ivTRAAMotionFactor(uv, historyUV, textureSize);
    float currentWeight = ivTRAACurrentWeight(offsetUV, textureSize, motionFactor, hasValidHistory,
                                              params.subpixelCorrection != 0);

    // Variance clipping (TRAANode varianceClipping), in TRAANode's neighbour order.
    const int2 offsets[8] = { int2(-1, -1), int2(-1, 1), int2(1, -1), int2(1, 1), int2(1, 0), int2(0, -1), int2(0, 1),
                              int2(-1, 0) };
    float4 moment1 = currentColor;
    float4 moment2 = currentColor * currentColor;
    for (int i = 0; i < 8; ++i) {
        float4 neighbor = max(beauty.read(ivTRAAClampTexel(positionTexel + float2(offsets[i]), size)), 0.0);
        moment1 += neighbor;
        moment2 += neighbor * neighbor;
    }
    float4 mean = moment1 / 9.0;
    float4 deviation = sqrt(max(moment2 / 9.0 - mean * mean, 0.0)) * ivTRAAVarianceGamma(motionFactor);
    float4 minColor = mean - deviation;
    float4 maxColor = mean + deviation;
    float4 clippedHistory = ivTRAAClipAABB(clamp(mean, minColor, maxColor), historyColor, minColor, maxColor);

    TRAAOut out;
    out.color = ivTRAAFlickerReduction(currentColor, clippedHistory, currentWeight);
    out.depth = centreRaw;
    return out;
}

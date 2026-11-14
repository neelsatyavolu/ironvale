// Screen-space reflections, ported from three r187 examples/jsm/tsl/display/SSRNode.js in the mode
// src/render/pipeline.ts uses (commit 1aca0b7): stochastic false (one mirror ray, roughness
// softened by the blur mips in PostBoxBlur.metal), reflectNonMetals true, binaryRefine false,
// no environment, no history; half resolution, maxDistance 14, thickness 0.35, intensity 0.8.
// The output alpha is the world distance to the hit, as SSRNode writes it; pipeline.ts adds
// reflection.rgb * reflection.a. Background pixels are discarded (target cleared to 0).
// Speed-up with the same result: ivSSRDepthBoundsFragment keeps the nearest depth of each
// IV_SSR_BLOCK^2 block of depth texels, and the march jumps over the steps that stay inside a block
// while the ray is in front of that nearest surface (or the block is all background), since none of
// those steps can pass the hit test.
#include <metal_stdlib>
#include "ShaderTypes.h"
#include "PostCommon.h"
using namespace metal;

#define IV_SSR_BLOCK 16

/// Nearest (reverse-Z: largest) depth of each IV_SSR_BLOCK x IV_SSR_BLOCK block of the scene depth.
fragment float ivSSRDepthBoundsFragment(PostVaryings in [[stage_in]], depth2d<float> depthTex [[texture(0)]]) {
    // 2 x 2 gathers; past the right and bottom edges clamp_to_edge repeats texels of this block.
    float2 origin = floor(in.position.xy) * IV_SSR_BLOCK;
    float2 invSize = 1.0 / float2(depthTex.get_width(), depthTex.get_height());
    float4 nearest = 0.0;
    for (int y = 0; y < IV_SSR_BLOCK; y += 2) {
        for (int x = 0; x < IV_SSR_BLOCK; x += 2) {
            nearest = max(nearest, depthTex.gather(ivPostNearest, (origin + float2(x, y) + 1.0) * invSize));
        }
    }
    return max(max(nearest.x, nearest.y), max(nearest.z, nearest.w));
}

/// Last step index j >= i whose depth texel (nearest sampling) stays in block `block` along one axis,
/// for texel coordinate a + b j; conservative (may undershoot by one step, never overshoots).
static float lastStepInBlock(float a, float b, float block) {
    if (b > 0.0) return floor((block * IV_SSR_BLOCK + IV_SSR_BLOCK - a) / b - 0.01);
    if (b < 0.0) return floor((block * IV_SSR_BLOCK - a) / b - 0.01);
    return INFINITY;
}

static float pointToLineDistance(float3 p, float3 a, float3 b) {
    return length(cross(p - a, p - b)) / length(b - a);
}

static float pointPlaneDistance(float3 p, float3 planePoint, float3 planeNormal) {
    float d = -dot(planeNormal, planePoint);
    return dot(planeNormal, p) + d;
}

static float3 sampleNormal(texture2d<float> normalTex, float2 uv) {
    return normalize(normalTex.sample(ivPostLinear, uv).rgb * 2.0 - 1.0);
}

fragment float4 ivSSRFragment(PostVaryings in [[stage_in]],
                              constant IVPostView &view [[buffer(0)]],
                              constant IVSSRParams &params [[buffer(1)]],
                              texture2d<float> colorTex [[texture(0)]],
                              depth2d<float> depthTex [[texture(1)]],
                              texture2d<float> normalTex [[texture(2)]],
                              texture2d<float> metalRoughTex [[texture(3)]],
                              texture2d<float> boundsTex [[texture(4)]]) {
    float2 resolution = params.resolution;
    float2 depthSize = float2(depthTex.get_width(), depthTex.get_height());
    float2 uvPos = (floor(in.uv * depthSize) + 0.5) / depthSize;
    float depth = depthTex.sample(ivPostNearest, uvPos);
    if (ivIsBackground(depth)) discard_fragment();

    float3 viewPosition = ivViewPosition(uvPos, depth, view.inverseProjection);
    float3 worldPosition = (view.cameraWorld * float4(viewPosition, 1.0)).xyz;
    float3 viewNormal = sampleNormal(normalTex, in.uv);
    float3 viewIncidentDir = normalize(viewPosition);
    float metalness = metalRoughTex.sample(ivPostLinear, in.uv).r;

    float3 viewReflectDir = normalize(reflect(viewIncidentDir, viewNormal));
    float3 finalSampleWeight = float3(metalness);

    float maxReflectRayLen = params.maxDistance / max(dot(-viewIncidentDir, viewNormal), 1e-4);
    float3 d1viewPosition = viewPosition + viewReflectDir * maxReflectRayLen;
    if (d1viewPosition.z > -view.near) {
        float t = (-view.near - viewPosition.z) / viewReflectDir.z;
        d1viewPosition = viewPosition + viewReflectDir * t;
    }
    float2 d0 = uvPos * resolution;
    float2 d1 = ivScreenPosition(d1viewPosition, view.projection) * resolution;

    // Clip the ray to the screen so every step lands on a visible texel.
    float2 extent = d1 - d0;
    float2 exitT = float2(extent.x >= 0.0 ? resolution.x - d0.x : d0.x,
                          extent.y >= 0.0 ? resolution.y - d0.y : d0.y) / max(abs(extent), 1e-6);
    float clipT = min(min(exitT.x, exitT.y), 1.0);
    if (clipT < 1.0) {
        d1 = d0 + extent * clipT;
        d1viewPosition = mix(viewPosition / viewPosition.z, d1viewPosition / d1viewPosition.z, clipT)
            / mix(1.0 / viewPosition.z, 1.0 / d1viewPosition.z, clipT);
    }
    float xLen = d1.x - d0.x;
    float yLen = d1.y - d0.y;
    int totalStep = max(int(trunc(max(abs(xLen), abs(yLen)) * clamp(params.quality, 0.0, 1.0))), 1);
    float2 stepVec = float2(xLen, yLen) / float(totalStep);
    float2 invResolution = 1.0 / resolution;
    float2 uvPixelStepX = float2(invResolution.x, 0.0);
    float recipVPZ = 1.0 / viewPosition.z;
    float recipD1VPZ = 1.0 / d1viewPosition.z;

    bool foundHit = false;
    float2 hitUvS = 0.0;
    float hitD = 0.0;
    // Depth texel of step j: texelBase + texelStep j (before flooring).
    float2 texelBase = d0 * invResolution * depthSize;
    float2 texelStep = stepVec * invResolution * depthSize;
    for (int i = 1; i < totalStep; i++) {
        float s = float(i) / float(totalStep);
        float2 xy = d0 + stepVec * (s * float(totalStep));
        if (xy.x < 0.0 || xy.x > resolution.x || xy.y < 0.0 || xy.y > resolution.y) break;
        float2 uvS = xy * invResolution;

        float2 texel = floor(uvS * depthSize);
        if (all(texel >= 0.0) && all(texel < depthSize)) {
            float2 block = floor(texel / IV_SSR_BLOCK);
            float last = min(min(lastStepInBlock(texelBase.x, texelStep.x, block.x),
                                 lastStepInBlock(texelBase.y, texelStep.y, block.y)), float(totalStep - 1));
            if (last > float(i)) {
                float nearest = boundsTex.read(uint2(block)).r;
                bool skip = ivIsBackground(nearest);
                if (!skip) {
                    float nearestZ = ivViewZ(nearest, view.near, view.far);
                    float rayZi = 1.0 / (recipVPZ + s * (recipD1VPZ - recipVPZ));
                    float rayZl = 1.0 / (recipVPZ + (last / float(totalStep)) * (recipD1VPZ - recipVPZ));
                    // A relative margin keeps the skip conservative under fast-math rounding.
                    skip = min(rayZi, rayZl) > nearestZ + 1e-3 * abs(nearestZ);
                }
                if (skip) {
                    i = int(last);
                    continue;
                }
            }
        }

        float d = depthTex.sample(ivPostNearest, uvS);
        float vZ = ivViewZ(d, view.near, view.far);
        float viewReflectRayZ = 1.0 / (recipVPZ + s * (recipD1VPZ - recipVPZ));
        if (!ivIsBackground(d) && viewReflectRayZ <= vZ) {
            float3 vP = ivViewPosition(uvS, d, view.inverseProjection);
            float away = pointToLineDistance(vP, viewPosition, d1viewPosition);
            float3 vPNeighbor = ivViewPosition(uvS + uvPixelStepX, d, view.inverseProjection);
            float minThickness = (vPNeighbor.x - vP.x) * 3.0;
            float tk = max(minThickness, params.thickness);
            if (away <= tk) {
                float3 vN = sampleNormal(normalTex, uvS);
                if (dot(viewReflectDir, vN) >= 0.0) continue;
                if (pointPlaneDistance(vP, viewPosition, viewNormal) > params.maxDistance) break;
                foundHit = true;
                hitUvS = uvS;
                hitD = d;
                break;
            }
        }
    }

    float4 output = 0.0;
    if (foundHit) {
        float3 vP = ivViewPosition(hitUvS, hitD, view.inverseProjection);
        float distancePointPlane = pointPlaneDistance(vP, viewPosition, viewNormal);
        if (distancePointPlane <= params.maxDistance) {
            float3 hitWorldPosition = (view.cameraWorld * float4(vP, 1.0)).xyz;
            float worldDistance = distance(worldPosition, hitWorldPosition);
            float3 reflectColor = colorTex.sample(ivPostLinear, hitUvS).rgb;
            float ratio = 1.0 - distancePointPlane / params.maxDistance;
            float attenuation = ratio * ratio;
            float fresnelCoe = (dot(viewIncidentDir, viewReflectDir) + 1.0) / 2.0;
            output = float4(reflectColor * finalSampleWeight * attenuation * fresnelCoe, worldDistance);
        }
    }
    float lum = max(ivLuminance(output.rgb), 1e-4);
    output.rgb *= min(params.maxLuminance / lum, 1.0);
    output.rgb *= params.intensity;
    return max(output, 0.0);
}

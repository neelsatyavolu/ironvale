// Screen-space reflections, ported from three r187 examples/jsm/tsl/display/SSRNode.js in the mode
// src/render/pipeline.ts uses (commit 1aca0b7): stochastic false (one mirror ray, roughness
// softened by the blur mips in PostBoxBlur.metal), reflectNonMetals true, binaryRefine false,
// no environment, no history; half resolution, maxDistance 14, thickness 0.35, intensity 0.8.
// The output alpha is the world distance to the hit, as SSRNode writes it; pipeline.ts adds
// reflection.rgb * reflection.a. Background pixels are discarded (target cleared to 0).
// Speed-up with the same result: ivSSRDepthBoundsKernel keeps the nearest depth of each
// IV_SSR_BLOCK^2 block of depth texels, and the march jumps over the steps that stay inside a block
// while the ray is in front of that nearest surface (or the block is all background), since none of
// those steps can pass the hit test. A second level (ivSSRCoarseBoundsKernel, IV_SSR_COARSE^2 texels)
// lets long rays over open ground jump four blocks at a time.
// Second speed-up with the same result: a pixel's reflection is weighted by its metalness, so a
// non-metal pixel writes zero colour and only its alpha (hit distance) can matter, through the blur
// mips and the composite's trilinear sample, which multiply the filtered colour by the filtered
// alpha. Those reach at most 25 SSR texels (16 for the last mip's bilinear footprint, 9 for its box
// taps), so a pixel with no metal within 50 SSR texels (100 scene texels) can never change the
// composite. ivSSRMetalMaskKernel marks the IV_SSR_COARSE blocks with metal within two blocks (at
// least 128 scene texels) and the march runs only there; elsewhere the pixel writes the cleared 0.
#include <metal_stdlib>
#include "ShaderTypes.h"
#include "PostCommon.h"
using namespace metal;

#define IV_SSR_BLOCK 16
#define IV_SSR_COARSE 64

/// Nearest (reverse-Z: largest) depth of each IV_SSR_BLOCK x IV_SSR_BLOCK block of the scene depth:
/// one threadgroup per block, one thread per texel (clamped at the right and bottom edges), reduced
/// across SIMD groups.
/// Also the largest metalness of the block into `metal` (for ivSSRMetalMaskKernel).
kernel void ivSSRDepthBoundsKernel(depth2d<float, access::read> depthTex [[texture(0)]],
                                   texture2d<float, access::write> bounds [[texture(1)]],
                                   texture2d<float, access::read> metalRoughTex [[texture(2)]],
                                   texture2d<float, access::write> metal [[texture(3)]],
                                   uint2 block [[threadgroup_position_in_grid]],
                                   uint2 local [[thread_position_in_threadgroup]],
                                   uint lane [[thread_index_in_simdgroup]],
                                   uint simdIndex [[simdgroup_index_in_threadgroup]],
                                   uint simdCount [[simdgroups_per_threadgroup]]) {
    threadgroup float2 partial[32];
    uint2 last = uint2(depthTex.get_width(), depthTex.get_height()) - 1;
    uint2 texel = min(block * IV_SSR_BLOCK + local, last);
    float d = depthTex.read(texel);
    // Background texels keep the MRT clear value (metalness 0.5); the SSR pass's bilinear metalness
    // sample only mixes one in next to a surface texel, so only those count.
    float m = metalRoughTex.read(texel).r;
    if (ivIsBackground(d) && m > 0.0) {
        bool nearSurface = false;
        for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
                uint2 t = uint2(clamp(int2(texel) + int2(x, y), int2(0), int2(last)));
                nearSurface = nearSurface || !ivIsBackground(depthTex.read(t));
            }
        }
        if (!nearSurface) m = 0.0;
    }
    float nearest = simd_max(d);
    float metalness = simd_max(m);
    if (lane == 0) partial[simdIndex] = float2(nearest, metalness);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (simdIndex == 0) {
        float2 p = lane < simdCount ? partial[lane] : float2(0.0);
        nearest = simd_max(p.x);
        metalness = simd_max(p.y);
        if (lane == 0) {
            bounds.write(float4(nearest), block);
            metal.write(float4(metalness), block);
        }
    }
}

/// Nearest depth of each IV_SSR_COARSE^2 block: the largest of the 4 x 4 IV_SSR_BLOCK blocks under it.
kernel void ivSSRCoarseBoundsKernel(texture2d<float, access::read> bounds [[texture(0)]],
                                    texture2d<float, access::write> coarse [[texture(1)]],
                                    uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= coarse.get_width() || gid.y >= coarse.get_height()) return;
    const uint ratio = IV_SSR_COARSE / IV_SSR_BLOCK;
    uint2 last = uint2(bounds.get_width(), bounds.get_height()) - 1;
    float nearest = 0.0;
    for (uint y = 0; y < ratio; y++) {
        for (uint x = 0; x < ratio; x++) nearest = max(nearest, bounds.read(min(gid * ratio + uint2(x, y), last)).r);
    }
    coarse.write(float4(nearest), gid);
}

/// Whether any IV_SSR_BLOCK block within two IV_SSR_COARSE blocks of coarse block `gid` has metal
/// (1) or not (0): the SSR march runs only in marked coarse blocks (see the header).
kernel void ivSSRMetalMaskKernel(texture2d<float, access::read> metal [[texture(0)]],
                                 texture2d<float, access::write> mask [[texture(1)]],
                                 uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= mask.get_width() || gid.y >= mask.get_height()) return;
    const int ratio = IV_SSR_COARSE / IV_SSR_BLOCK;
    int2 size = int2(metal.get_width(), metal.get_height());
    int2 lo = max(int2(gid) * ratio - 2 * ratio, 0);
    int2 hi = min(int2(gid) * ratio + 3 * ratio, size);
    float any = 0.0;
    for (int y = lo.y; y < hi.y; y++) {
        for (int x = lo.x; x < hi.x; x++) any = max(any, metal.read(uint2(x, y)).r);
    }
    mask.write(float4(any > 0.0 ? 1.0 : 0.0), gid);
}

/// Last step index j >= i whose depth texel (nearest sampling) stays in block `block` (of `size`
/// texels) along one axis, for texel coordinate a + b j; conservative (may undershoot by one step,
/// never overshoots).
static float lastStepInBlock(float a, float b, float block, float size) {
    if (b > 0.0) return floor((block * size + size - a) / b - 0.01);
    if (b < 0.0) return floor((block * size - a) / b - 0.01);
    return INFINITY;
}

/// Whether the march can jump from step i to `last` (the last step inside the `size`-texel block of
/// `texel`) because the ray stays in front of the block's nearest surface or the block is background.
static bool canSkip(texture2d<float> bounds, float size, float2 texel, float i, float totalStep, float2 texelBase,
                    float2 texelStep, float recipVPZ, float recipD1VPZ, constant IVPostView &view, thread float &last) {
    float2 block = floor(texel / size);
    last = min(min(lastStepInBlock(texelBase.x, texelStep.x, block.x, size),
                   lastStepInBlock(texelBase.y, texelStep.y, block.y, size)), totalStep - 1.0);
    if (last <= i) return false;
    float nearest = bounds.read(uint2(block)).r;
    if (ivIsBackground(nearest)) return true;
    float nearestZ = ivViewZ(nearest, view.near, view.far);
    float rayZi = 1.0 / (recipVPZ + (i / totalStep) * (recipD1VPZ - recipVPZ));
    float rayZl = 1.0 / (recipVPZ + (last / totalStep) * (recipD1VPZ - recipVPZ));
    // A relative margin keeps the skip conservative under fast-math rounding.
    return min(rayZi, rayZl) > nearestZ + 1e-3 * abs(nearestZ);
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
                              texture2d<float> boundsTex [[texture(4)]],
                              texture2d<float> coarseTex [[texture(5)]],
                              texture2d<float> metalMaskTex [[texture(6)]]) {
    float2 resolution = params.resolution;
    float2 depthSize = float2(depthTex.get_width(), depthTex.get_height());
    float2 uvPos = (floor(in.uv * depthSize) + 0.5) / depthSize;
    // No metal near this pixel: its output cannot reach the composite (see the header).
    uint2 coarseBlock = min(uint2(floor(in.uv * depthSize)) / IV_SSR_COARSE,
                            uint2(metalMaskTex.get_width(), metalMaskTex.get_height()) - 1);
    if (metalMaskTex.read(coarseBlock).r == 0.0) discard_fragment();
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
            float last;
            if (canSkip(coarseTex, IV_SSR_COARSE, texel, float(i), float(totalStep), texelBase, texelStep, recipVPZ,
                        recipD1VPZ, view, last)
                || canSkip(boundsTex, IV_SSR_BLOCK, texel, float(i), float(totalStep), texelBase, texelStep, recipVPZ,
                           recipD1VPZ, view, last)) {
                i = int(last);
                continue;
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

// Ground-truth ambient occlusion, ported from three r187 examples/jsm/tsl/display/GTAONode.js
// (used by src/render/pipeline.ts at commit 1aca0b7: radius 0.6, thickness 1.2, 8 or 12 samples,
// half resolution below ultra, temporal rotation when TRAA is on). Writes into an r8Unorm target
// cleared to 1; background pixels are discarded, as the web's isBackgroundDepth().discard().
#include <metal_stdlib>
#include "ShaderTypes.h"
#include "PostCommon.h"
using namespace metal;

// generateMagicSquareNoise(5): per texel, (cos, sin) of 2 pi i / 25 packed into bytes, row-major.
constant uchar2 kMagicSquareNoise[25] = {
    {46, 225}, {220, 214}, {220, 40}, {46, 29}, {24, 52},
    {239, 188}, {195, 19}, {166, 6}, {8, 80}, {73, 242},
    {255, 127}, {135, 0}, {1, 111}, {103, 252}, {250, 159},
    {103, 2}, {1, 143}, {135, 254}, {166, 248}, {250, 95},
    {8, 174}, {24, 202}, {195, 235}, {239, 66}, {73, 12}};

/// The noise DataTexture sampled with repeat wrapping and nearest filtering.
static float3 magicSquareNoise(float2 noiseUv) {
    int2 texel = int2(floor(fract(noiseUv) * 5.0));
    texel = clamp(texel, 0, 4);
    uchar2 v = kMagicSquareNoise[texel.y * 5 + texel.x];
    return float3(float2(v) / 255.0, 127.0 / 255.0);
}

static bool isValidSample(float2 uv, float2 centerTexel, float2 size) {
    float2 texel = floor(uv * size);
    return uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0 && any(texel != centerTexel);
}

fragment float ivGTAOFragment(PostVaryings in [[stage_in]],
                              constant IVPostView &view [[buffer(0)]],
                              constant IVGTAOParams &params [[buffer(1)]],
                              depth2d<float> depthTex [[texture(0)]],
                              texture2d<float> normalTex [[texture(1)]]) {
    float2 uv = in.uv;
    // Half resolution: the nearest of the four texels under the pixel (reverse-Z: the largest).
    float depth;
    if (params.halfResolution > 0.0) {
        float4 g = depthTex.gather(ivPostNearest, uv);
        depth = max(max(g.x, g.y), max(g.z, g.w));
    } else {
        depth = depthTex.sample(ivPostNearest, uv);
    }
    if (ivIsBackground(depth)) discard_fragment();

    float2 depthSize = float2(depthTex.get_width(), depthTex.get_height());
    float2 centerTexel = floor(uv * depthSize);
    float3 viewPosition = ivViewPosition(uv, depth, view.inverseProjection);
    float3 viewNormal = normalize(normalTex.sample(ivPostLinear, uv).rgb * 2.0 - 1.0);
    float radius = params.radius;
    float invRadius = 1.0 / radius;
    float3 viewDir = normalize(-viewPosition);
    float4 clipPosition = view.projection * float4(viewPosition, 1.0);

    // three samples the noise at (uv.x, 1 - uv.y) x resolution / 5 on a bottom-up uv.
    float2 noiseUv = float2(uv.x, 1.0 - uv.y) * (params.resolution / 5.0);
    float3 randomVec = magicSquareNoise(noiseUv) * 2.0 - 1.0;
    float3 tangent = normalize(float3(randomVec.xy, 0.0));
    float3 bitangent = float3(-tangent.y, tangent.x, 0.0);
    float3x3 kernelMatrix = float3x3(tangent, bitangent, float3(0.0, 0.0, 1.0));

    int directions = params.samples < 30 ? 3 : 5;
    int steps = int(ceil(float(params.samples) / float(directions)));
    float invSteps = 1.0 / float(steps);
    float ao = 0.0;

    float noiseJitterIdx = params.temporalDirection * 0.02;
    // screenCoordinate is the pixel position in the AO target (fragment coordinates).
    float stepJitter = ivInterleavedGradientNoise(in.position.xy + params.temporalOffset)
        + ivRand((uv + noiseJitterIdx) * 2.0 - 1.0);

    for (int i = 0; i < directions; i++) {
        float angle = float(i) / float(directions) * M_PI_F + params.temporalDirection;
        float3 sampleDir = kernelMatrix * float3(cos(angle), sin(angle), 0.0);
        float4 clipDirRadius = view.projection * float4(sampleDir, 0.0) * radius;
        float3 sliceBitangent = normalize(cross(sampleDir, viewDir));
        float3 sliceTangent = cross(sliceBitangent, viewDir);
        float3 projNRaw = viewNormal - sliceBitangent * dot(viewNormal, sliceBitangent);
        float projNLen = length(projNRaw);
        float3 projN = projNRaw / max(projNLen, 0.0001);
        float nSin = dot(projN, sliceTangent);
        float nCos = clamp(dot(projN, viewDir), 0.0, 1.0);
        float angleN = (nSin >= 0.0 ? 1.0 : -1.0) * acos(nCos);
        float3 tangentToNormalInSlice = cross(projN, sliceBitangent);
        float cosHorizon = dot(viewDir, tangentToNormalInSlice);
        float2 cosHorizons = float2(cosHorizon, -cosHorizon);

        for (int j = 0; j < steps; j++) {
            float t = (float(j) + 1.0 + stepJitter) * invSteps;
            float sampleDist = t * t;
            float4 clipOffset = clipDirRadius * sampleDist;

            float2 sx = ivScreenFromClip(clipPosition + clipOffset);
            float3 deltaX = ivViewPosition(sx, depthTex.sample(ivPostNearest, sx), view.inverseProjection) - viewPosition;
            float lenX = length(deltaX);
            float sHX = dot(viewDir, deltaX) / max(lenX, 0.0001);
            float distFacX = min(lenX * invRadius, 1.0);
            if (isValidSample(sx, centerTexel, depthSize) && abs(deltaX.z) < params.thickness) {
                cosHorizons.x = mix(max(cosHorizons.x, sHX), cosHorizons.x, distFacX * distFacX);
            }

            float2 sy = ivScreenFromClip(clipPosition - clipOffset);
            float3 deltaY = ivViewPosition(sy, depthTex.sample(ivPostNearest, sy), view.inverseProjection) - viewPosition;
            float lenY = length(deltaY);
            float sHY = dot(viewDir, deltaY) / max(lenY, 0.0001);
            float distFacY = min(lenY * invRadius, 1.0);
            if (isValidSample(sy, centerTexel, depthSize) && abs(deltaY.z) < params.thickness) {
                cosHorizons.y = mix(max(cosHorizons.y, sHY), cosHorizons.y, distFacY * distFacY);
            }
        }
        float hPos = acos(clamp(cosHorizons.y, -1.0, 1.0));
        float hNeg = -acos(clamp(cosHorizons.x, -1.0, 1.0));
        float termPos = -cos(hPos * 2.0 - angleN) + nCos + hPos * 2.0 * nSin;
        float termNeg = -cos(hNeg * 2.0 - angleN) + nCos + hNeg * 2.0 * nSin;
        ao += projNLen * (termPos + termNeg) * 0.25;
    }
    ao = clamp(ao / float(directions), 0.0, 1.0);
    return pow(ao, params.scale);
}

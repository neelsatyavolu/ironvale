// Shadow-map light shafts, ported from three r187 examples/jsm/tsl/display/GodraysNode.js for a
// directional light, with the settings of src/render/pipeline.ts at commit 1aca0b7 (48 steps on
// high, 32 on medium; density (0.012 + fog density x 1.6) x shaft boost; max density
// 0.25 + 0.5 volumetric; distance attenuation 1.5). Half resolution, rgba8Unorm target cleared to 1:
// r = in-scatter, a = scene depth (three's standard depth; only r is read downstream).
// The view ray is clipped to the sun's shadow box, then marched against the shadow map.
#include <metal_stdlib>
#include "ShaderTypes.h"
#include "PostCommon.h"
using namespace metal;

static float sdPlane(float3 p, float4 plane) { return dot(p, plane.xyz) + plane.w; }

static float intersectRayPlane(float3 origin, float3 direction, float4 plane) {
    return -sdPlane(origin, plane) / dot(plane.xyz, direction);
}

/// three inShadow for a directional light: (amount in shadow, shadow-camera distance). `clip` is the
/// sample's shadow clip position; the shadow camera is orthographic (w = 1), so the march interpolates
/// it between the clip positions of the ray's ends instead of transforming every sample.
static float2 inShadow(float4 clip, constant IVGodraysParams &params, depth2d<float> shadowMap) {
    float3 ndc = clip.xyz / clip.w;
    float3 coord = float3(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5, ndc.z);
    float2 output = float2(1.0, 0.0);
    if (all(coord >= 0.0) && all(coord <= 1.0)) {
        constexpr sampler cmp(filter::linear, address::clamp_to_edge, compare_func::less_equal);
        float lit = shadowMap.sample_compare(cmp, coord.xy, coord.z);
        // three's perspectiveDepthToViewZ, applied to the orthographic shadow depth as upstream does.
        float n = params.shadowNear, f = params.shadowFar;
        float viewZ = (n * f) / ((f - n) * coord.z - f);
        output = float2(1.0 - lit, -viewZ);
    }
    return output;
}

fragment float4 ivGodraysFragment(PostVaryings in [[stage_in]],
                                  constant IVPostView &view [[buffer(0)]],
                                  constant IVGodraysParams &params [[buffer(1)]],
                                  depth2d<float> depthTex [[texture(0)]],
                                  depth2d<float> shadowMap [[texture(1)]]) {
    float depth = depthTex.sample(ivPostNearest, in.uv);
    float3 viewPosition = ivViewPosition(in.uv, depth, view.inverseProjection);
    float3 worldPosition = (view.cameraWorld * float4(viewPosition, 1.0)).xyz;
    float3 cameraPosition = view.cameraPosition;

    float inBoxDist = -10000.0;
    for (int i = 0; i < 6; i++) inBoxDist = max(inBoxDist, sdPlane(cameraPosition, params.planes[i]));

    float3 startPosition = cameraPosition;
    bool earlyOut = false;
    if (inBoxDist < 0.0) {
        for (int i = 0; i < 6; i++) {
            if (sdPlane(worldPosition, params.planes[i]) > 0.0) {
                float3 direction = worldPosition - cameraPosition;
                float t = intersectRayPlane(cameraPosition, direction, params.planes[i]);
                worldPosition = cameraPosition + t * direction;
            }
        }
    } else {
        float3 direction = worldPosition - cameraPosition;
        float minT = 10000.0;
        for (int i = 0; i < 6; i++) {
            float t = intersectRayPlane(cameraPosition, direction, params.planes[i]);
            if (t < minT && t > 0.0) minT = t;
        }
        if (minT == 10000.0) {
            earlyOut = true;
        } else {
            startPosition = cameraPosition + (minT + 0.001) * direction;
            float endInBoxDist = -10000.0;
            for (int i = 0; i < 6; i++) endInBoxDist = max(endInBoxDist, sdPlane(worldPosition, params.planes[i]));
            if (endInBoxDist >= 0.0) {
                float minT2 = 10000.0;
                for (int i = 0; i < 6; i++) {
                    if (sdPlane(worldPosition, params.planes[i]) > 0.0) {
                        float t = intersectRayPlane(startPosition, direction, params.planes[i]);
                        if (t < minT2 && t > 0.0) minT2 = t;
                    }
                }
                if (minT2 < distance(worldPosition, startPosition)) worldPosition = startPosition + minT2 * direction;
            }
        }
    }

    float4 output = float4(0.0, 0.0, 0.0, 1.0);
    if (!earlyOut) {
        float illum = 0.0;
        float noise = ivInterleavedGradientNoise(in.position.xy);
        // raymarchSteps is a uint uniform, so steps / 8 is an integer division.
        float samplesFloat = round(float(params.raymarchSteps) + float(params.raymarchSteps / 8 + 2) * noise);
        uint samples = uint(samplesFloat);
        float span = distance(startPosition, worldPosition) * params.density;
        float4 clipStart = view.shadowViewProjection * float4(startPosition, 1.0);
        float4 clipEnd = view.shadowViewProjection * float4(worldPosition, 1.0);
        for (uint i = 0; i < samples; i++) {
            float2 shadowInfo = inShadow(mix(clipStart, clipEnd, float(i) / samplesFloat), params, shadowMap);
            float shadowAmount = 1.0 - shadowInfo.x;
            illum += shadowAmount * span * pow(1.0 - shadowInfo.y / params.shadowFar, params.distanceAttenuation);
        }
        illum /= samplesFloat;
        output = float4(float3(clamp(1.0 - exp(-illum), 0.0, params.maxDensity)), 1.0 - depth);
    }
    return output;
}

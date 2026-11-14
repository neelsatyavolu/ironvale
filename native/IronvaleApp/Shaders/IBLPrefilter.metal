// Load-time environment prefilter (PLAN.md 3.3: compute fallback until asset-bake ships baked
// IBL). Writes one level of an equirect mip chain: level i holds the GGX-filtered radiance for
// roughness i / (levels - 1), using importance sampling from the source's mipmaps
// (filtered importance sampling, Krivanek and Colbert 2007). three's PMREM blurs differently;
// this is visual parity, not bit parity.
#include <metal_stdlib>
#include "ShaderTypes.h"
#include "Common.h"
using namespace metal;

static float2 hammersley(uint i, uint n) {
    return float2(float(i) / float(n), float(reverse_bits(i)) * 2.3283064365386963e-10);
}

kernel void ivPrefilterEnvironment(texture2d<float> source [[texture(0)]],
                                   texture2d<float, access::write> target [[texture(1)]],
                                   constant IVPrefilterUniforms &u [[buffer(0)]],
                                   uint2 gid [[thread_position_in_grid]]) {
    uint w = target.get_width(), h = target.get_height();
    if (gid.x >= w || gid.y >= h) return;
    float2 uv = (float2(gid) + 0.5) / float2(w, h);
    // Inverse of ivEquirectUV with no rotation (the chain is stored in texture space).
    float az = (uv.x - 0.5) * 2.0 * IV_PI;
    float el = (0.5 - uv.y) * IV_PI;
    float3 n = float3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
    float3 up = abs(n.y) < 0.999 ? float3(0, 1, 0) : float3(1, 0, 0);
    float3 tx = normalize(cross(up, n));
    float3 ty = cross(n, tx);
    float alpha = max(u.roughness * u.roughness, 1e-3);
    float a2 = alpha * alpha;
    float texelSolidAngle = 4.0 * IV_PI / (u.sourceWidth * u.sourceWidth * 0.5);
    constexpr sampler s(filter::linear, mip_filter::linear, s_address::repeat, t_address::clamp_to_edge);
    float3 sum = 0.0;
    float weight = 0.0;
    for (uint i = 0; i < u.sampleCount; i++) {
        float2 xi = hammersley(i, u.sampleCount);
        float cosTheta = sqrt((1.0 - xi.y) / (1.0 + (a2 - 1.0) * xi.y));
        float sinTheta = sqrt(1.0 - cosTheta * cosTheta);
        float phi = 2.0 * IV_PI * xi.x;
        float3 hl = float3(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);
        float3 hv = normalize(tx * hl.x + ty * hl.y + n * hl.z);
        float3 l = 2.0 * dot(n, hv) * hv - n;
        float nl = dot(n, l);
        if (nl <= 0.0) continue;
        // pdf of l = D * NoH / (4 VoH) with V = N, so NoH = VoH: pdf = D / 4.
        float d = (a2 - 1.0) * cosTheta * cosTheta + 1.0;
        float D = a2 / (IV_PI * d * d);
        float sampleSolidAngle = 1.0 / (float(u.sampleCount) * D * 0.25 + 1e-6);
        float lod = max(0.5 * log2(sampleSolidAngle / texelSolidAngle) + 1.0, 0.0);
        sum += source.sample(s, ivEquirectUV(l, 0.0), level(lod)).rgb * nl;
        weight += nl;
    }
    target.write(float4(sum / max(weight, 1e-6), 1.0), gid);
}

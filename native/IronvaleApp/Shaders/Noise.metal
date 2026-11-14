// MaterialX Perlin noise and the TSL hash, ported once for every map program (PLAN.md 3.4).
// Source: three r187 node_modules/three/src/nodes/materialx/MaterialXNoise.js (itself a port of
// MaterialX's mx_noise.glsl) and node_modules/three/src/nodes/math/Hash.js, at commit cbe0add.
// Header-style: every function is static inline and this file is #included where it is used
// (MapPBR.metal, SkyRailyard.metal), so the noise inlines into the shader instead of being an
// external call; compiled on its own it emits nothing.
// Integer arithmetic follows the WGSL three emits: int <-> uint conversions keep the bits.
#ifndef IRONVALE_NOISE_METAL
#define IRONVALE_NOISE_METAL
#include <metal_stdlib>
using namespace metal;
#ifndef IV_SHADER_FN
/// Static helpers of the #included shader files; unused ones are expected in a standalone compile.
#define IV_SHADER_FN static inline __attribute__((unused))
#endif

IV_SHADER_FN uint mxRotl32(uint x, int k) { return (x << uint(k)) | (x >> uint(32 - k)); }

IV_SHADER_FN uint mxBjFinal(uint a, uint b, uint c) {
    c ^= b; c -= mxRotl32(b, 14);
    a ^= c; a -= mxRotl32(c, 11);
    b ^= a; b -= mxRotl32(a, 25);
    c ^= b; c -= mxRotl32(b, 16);
    a ^= c; a -= mxRotl32(c, 4);
    b ^= a; b -= mxRotl32(a, 14);
    c ^= b; c -= mxRotl32(b, 24);
    return c;
}

IV_SHADER_FN uint mxHash(int x, int y) {
    uint seed = 0xdeadbeefu + (2u << 2u) + 13u;
    return mxBjFinal(seed + uint(x), seed + uint(y), seed);
}

IV_SHADER_FN uint mxHash(int x, int y, int z) {
    uint seed = 0xdeadbeefu + (3u << 2u) + 13u;
    return mxBjFinal(seed + uint(x), seed + uint(y), seed + uint(z));
}

IV_SHADER_FN uint3 mxHashVec3(int x, int y, int z) {
    uint h = mxHash(x, y, z);
    return uint3(h & 0xFFu, (h >> 8u) & 0xFFu, (h >> 16u) & 0xFFu);
}

IV_SHADER_FN float mxFade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

IV_SHADER_FN float mxFloorFrac(float x, thread int &i) {
    i = int(floor(x));
    return x - float(i);
}

IV_SHADER_FN float mxNegateIf(float v, bool b) { return b ? -v : v; }

IV_SHADER_FN float mxGradient(uint hash, float x, float y) {
    uint h = hash & 7u;
    float u = h < 4u ? x : y;
    float v = 2.0 * (h < 4u ? y : x);
    return mxNegateIf(u, (h & 1u) != 0u) + mxNegateIf(v, (h & 2u) != 0u);
}

IV_SHADER_FN float mxGradient(uint hash, float x, float y, float z) {
    uint h = hash & 15u;
    float u = h < 8u ? x : y;
    float v = h < 4u ? y : ((h == 12u || h == 14u) ? x : z);
    return mxNegateIf(u, (h & 1u) != 0u) + mxNegateIf(v, (h & 2u) != 0u);
}

IV_SHADER_FN float3 mxGradient3(uint3 hash, float x, float y, float z) {
    return float3(mxGradient(hash.x, x, y, z), mxGradient(hash.y, x, y, z), mxGradient(hash.z, x, y, z));
}

template <typename T>
IV_SHADER_FN T mxBilerp(T v0, T v1, T v2, T v3, float s, float t) {
    float s1 = 1.0 - s;
    return (1.0 - t) * (v0 * s1 + v1 * s) + t * (v2 * s1 + v3 * s);
}

template <typename T>
IV_SHADER_FN T mxTrilerp(T v0, T v1, T v2, T v3, T v4, T v5, T v6, T v7, float s, float t, float r) {
    float s1 = 1.0 - s, t1 = 1.0 - t, r1 = 1.0 - r;
    return r1 * (t1 * (v0 * s1 + v1 * s) + t * (v2 * s1 + v3 * s)) + r * (t1 * (v4 * s1 + v5 * s) + t * (v6 * s1 + v7 * s));
}

IV_SHADER_FN float ivMxNoise(float2 p) {
    int X, Y;
    float fx = mxFloorFrac(p.x, X);
    float fy = mxFloorFrac(p.y, Y);
    float u = mxFade(fx), v = mxFade(fy);
    float result = mxBilerp(mxGradient(mxHash(X, Y), fx, fy),
                            mxGradient(mxHash(X + 1, Y), fx - 1.0, fy),
                            mxGradient(mxHash(X, Y + 1), fx, fy - 1.0),
                            mxGradient(mxHash(X + 1, Y + 1), fx - 1.0, fy - 1.0), u, v);
    return 0.6616 * result;
}

IV_SHADER_FN float ivMxNoise(float3 p) {
    int X, Y, Z;
    float fx = mxFloorFrac(p.x, X);
    float fy = mxFloorFrac(p.y, Y);
    float fz = mxFloorFrac(p.z, Z);
    float u = mxFade(fx), v = mxFade(fy), w = mxFade(fz);
    float result = mxTrilerp(mxGradient(mxHash(X, Y, Z), fx, fy, fz),
                             mxGradient(mxHash(X + 1, Y, Z), fx - 1.0, fy, fz),
                             mxGradient(mxHash(X, Y + 1, Z), fx, fy - 1.0, fz),
                             mxGradient(mxHash(X + 1, Y + 1, Z), fx - 1.0, fy - 1.0, fz),
                             mxGradient(mxHash(X, Y, Z + 1), fx, fy, fz - 1.0),
                             mxGradient(mxHash(X + 1, Y, Z + 1), fx - 1.0, fy, fz - 1.0),
                             mxGradient(mxHash(X, Y + 1, Z + 1), fx, fy - 1.0, fz - 1.0),
                             mxGradient(mxHash(X + 1, Y + 1, Z + 1), fx - 1.0, fy - 1.0, fz - 1.0), u, v, w);
    return 0.9820 * result;
}

IV_SHADER_FN float3 ivMxNoiseVec3(float3 p) {
    int X, Y, Z;
    float fx = mxFloorFrac(p.x, X);
    float fy = mxFloorFrac(p.y, Y);
    float fz = mxFloorFrac(p.z, Z);
    float u = mxFade(fx), v = mxFade(fy), w = mxFade(fz);
    float3 result = mxTrilerp(mxGradient3(mxHashVec3(X, Y, Z), fx, fy, fz),
                              mxGradient3(mxHashVec3(X + 1, Y, Z), fx - 1.0, fy, fz),
                              mxGradient3(mxHashVec3(X, Y + 1, Z), fx, fy - 1.0, fz),
                              mxGradient3(mxHashVec3(X + 1, Y + 1, Z), fx - 1.0, fy - 1.0, fz),
                              mxGradient3(mxHashVec3(X, Y, Z + 1), fx, fy, fz - 1.0),
                              mxGradient3(mxHashVec3(X + 1, Y, Z + 1), fx - 1.0, fy, fz - 1.0),
                              mxGradient3(mxHashVec3(X, Y + 1, Z + 1), fx, fy - 1.0, fz - 1.0),
                              mxGradient3(mxHashVec3(X + 1, Y + 1, Z + 1), fx - 1.0, fy - 1.0, fz - 1.0), u, v, w);
    return 0.9820 * result;
}

IV_SHADER_FN float ivMxFractalNoise(float3 p, int octaves, float lacunarity, float diminish) {
    float result = 0.0;
    float amplitude = 1.0;
    for (int i = 0; i < octaves; i++) {
        result += amplitude * ivMxNoise(p);
        amplitude *= diminish;
        p *= lacunarity;
    }
    return result;
}

IV_SHADER_FN float ivTslHash(float seed) {
    // WGSL u32(f32) truncates toward zero and saturates; Metal leaves out-of-range values undefined.
    uint s = uint(clamp(seed, 0.0, 4294967040.0));
    uint state = s * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    uint result = (word >> 22u) ^ word;
    return float(result) * (1.0 / 4294967296.0);
}
/// worldNoise(scale) of src/maps/railyard/surfaces.ts: 0 - 1 noise fixed in world space.
IV_SHADER_FN float ivWorldNoise(float3 p, float scale) { return ivMxNoise(p * scale) * 0.5 + 0.5; }
#endif  // IRONVALE_NOISE_METAL

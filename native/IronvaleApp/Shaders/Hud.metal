// The in-match HUD (PLAN.md 3.9), drawn last into the frame. Replaces the DOM/SVG/Canvas2D HUD of
// src/ui/hud/*.ts and src/ui/styles/{hud,reticle,scope,minimap,hud-extras,hud-grenade}.css at cbe0add.
// One instanced quad per item; the fragment shader evaluates the item's shape (rect, MTSDF glyph, arc,
// disc, segment, triangle, minimap raster, scope, vignette) in points. Colours are straight sRGB and
// blend in sRGB space like a browser composites. hudGrade reads the frame through framebuffer fetch for
// the low-health desaturation (CSS saturate()) and the dead dim.
// Item layout must match IronvaleUI/HUD/HUDRenderer.swift `HUDRenderer.GPUItem` (96 bytes).
#include <metal_stdlib>
using namespace metal;

struct HudItem {
    float4 rect;   // x, y, w, h in points
    float4 color;  // straight sRGB + alpha
    float4 p0;
    float4 p1;
    float4 p2;
    uint4 kind;    // x: kind
};

struct HudUniforms {
    float2 viewport;   // points
    float pointScale;  // pixels per point
    float time;
};

enum HudKind : uint {
    kRect = 0, kGlyph = 1, kArc = 2, kDisc = 3, kSegment = 4, kTriangle = 5, kMinimap = 6, kScope = 7, kVignette = 8, kRing = 9
};

struct HudVaryings {
    float4 position [[position]];
    float2 point;
    uint item [[flat]];
};

vertex HudVaryings hudVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                             const device HudItem *items [[buffer(0)]],
                             constant HudUniforms &u [[buffer(1)]]) {
    float2 corner = float2(vid & 1, (vid >> 1) & 1);
    HudItem item = items[iid];
    float2 p = item.rect.xy + corner * item.rect.zw;
    HudVaryings out;
    out.position = float4(p.x / u.viewport.x * 2.0 - 1.0, 1.0 - p.y / u.viewport.y * 2.0, 0.0, 1.0);
    out.point = p;
    out.item = iid;
    return out;
}

static float coverage(float d, float aa) { return clamp(0.5 - d / aa, 0.0, 1.0); }

static float median3(float3 v) { return max(min(v.r, v.g), min(max(v.r, v.g), v.b)); }

static float segmentDistance(float2 p, float2 a, float2 b) {
    float2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
}

static float edge(float2 p, float2 a, float2 b) { return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x); }

/// Signed distance to a triangle (negative inside), either winding.
static float triangleDistance(float2 p, float2 a, float2 b, float2 c) {
    float d = min(min(segmentDistance(p, a, b), segmentDistance(p, b, c)), segmentDistance(p, c, a));
    float e0 = edge(p, a, b), e1 = edge(p, b, c), e2 = edge(p, c, a);
    bool inside = (e0 >= 0 && e1 >= 0 && e2 >= 0) || (e0 <= 0 && e1 <= 0 && e2 <= 0);
    return inside ? -d : d;
}

/// CSS radial-gradient colour stops at positions t (0..1) over distance r, as straight colour + alpha.
static float4 stops3(float r, float t0, float4 c0, float t1, float4 c1, float t2, float4 c2) {
    if (r <= t0) return c0;
    if (r <= t1) return mix(c0, c1, (r - t0) / max(t1 - t0, 1e-6));
    if (r <= t2) return mix(c1, c2, (r - t1) / max(t2 - t1, 1e-6));
    return c2;
}

// Browsers interpolate gradients in premultiplied space; these helpers keep that.
static float4 premul(float4 c) { return float4(c.rgb * c.a, c.a); }

fragment float4 hudFragment(HudVaryings in [[stage_in]],
                            const device HudItem *items [[buffer(0)]],
                            constant HudUniforms &u [[buffer(1)]],
                            texture2d<float> atlas [[texture(0)]],
                            texture2d<float> layout [[texture(1)]],
                            sampler linearSampler [[sampler(0)]]) {
    HudItem item = items[in.item];
    float2 p = in.point;
    float aa = 1.0 / u.pointScale;  // one pixel, in points
    float alpha = 0.0;
    float4 color = item.color;
    switch (item.kind.x) {
    case kRect: {
        float2 c = item.rect.xy + item.rect.zw * 0.5;
        float2 q = abs(p - c) - item.rect.zw * 0.5 + item.p0.x;
        float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - item.p0.x;
        alpha = item.p0.x > 0.0 ? coverage(d, aa) : 1.0;
        break;
    }
    case kGlyph: {
        // p0: atlas uv rect; p1.x: screen pixels per SDF unit, p1.y: blur radius (points) for shadows, p1.z: dilation (points).
        float2 t = (p - item.rect.xy) / item.rect.zw;
        float2 uv = mix(item.p0.xy, item.p0.zw, t);
        float4 s = atlas.sample(linearSampler, uv);
        float blur = item.p1.y;
        if (blur > 0.0) {
            // Shadows read the true distance (alpha) so they spread smoothly.
            float d = (s.a - 0.5) * item.p1.x / u.pointScale + item.p1.z;
            alpha = smoothstep(-blur, blur, d);
        } else {
            float d = (median3(s.rgb) - 0.5) * item.p1.x / u.pointScale + item.p1.z;
            alpha = clamp(d / aa + 0.5, 0.0, 1.0);
        }
        break;
    }
    case kArc:
    case kRing: {
        // p0: centre xy, radius, half width. p1: start, end angle (radians clockwise from up) for arcs, butt caps.
        float2 v = p - item.p0.xy;
        float d = abs(length(v) - item.p0.z) - item.p0.w;
        alpha = coverage(d, aa);
        if (item.kind.x == kArc) {
            float angle = atan2(v.x, -v.y);
            float mid = (item.p1.x + item.p1.y) * 0.5;
            float halfSpan = (item.p1.y - item.p1.x) * 0.5;
            float delta = angle - mid;
            delta -= 2.0 * M_PI_F * floor((delta + M_PI_F) / (2.0 * M_PI_F));
            float over = (abs(delta) - halfSpan) * length(v);
            alpha *= coverage(over, aa);
        }
        break;
    }
    case kDisc: {
        float d = length(p - item.p0.xy) - item.p0.z;
        alpha = coverage(d, aa);
        break;
    }
    case kSegment: {
        // p0: a, b. p1.x: half width, p1.y: 1 for round caps, 0 for butt/square handled by the caller's endpoints.
        float d = segmentDistance(p, item.p0.xy, item.p0.zw) - item.p1.x;
        alpha = coverage(d, aa);
        break;
    }
    case kTriangle: {
        float d = triangleDistance(p, item.p0.xy, item.p0.zw, item.p1.xy) - item.p1.z;
        alpha = coverage(d, aa);
        break;
    }
    case kMinimap: {
        // p0: centre xy, radius. p1: texture u = dot(p1.xy, point) + p1.z ... as a 2x3 matrix in p1 and p2.
        float d = length(p - item.p0.xy) - item.p0.z;
        float inside = coverage(d, aa);
        float2 uv = float2(dot(item.p1.xy, p) + item.p1.z, dot(item.p2.xy, p) + item.p2.z);
        if (any(uv < 0.0) || any(uv > 1.0)) return float4(0.0);
        // The raster holds the painted layout, premultiplied, CELL_PIXELS texels per cell.
        float4 texel = layout.sample(linearSampler, uv);
        return texel * inside * item.color.a;
    }
    case kScope: {
        // p0.xy: centre, p0.z: lens radius (points). Mask, field-stop shade and colour fringe from scope.css.
        float r = length(p - item.p0.xy);
        float lens = item.p0.z;
        float4 tube = float4(3.0 / 255.0, 3.0 / 255.0, 3.0 / 255.0, 1.0);
        float mask = smoothstep(lens - 0.75, lens + 0.75, r);
        float t = r / lens;
        float4 shade = stops3(t, 0.964, float4(tube.rgb, 0.0), 0.988, float4(tube.rgb, 0.6), 1.0, tube);
        float4 blue = float4(70.0 / 255.0, 130.0 / 255.0, 1.0, 0.0);
        float4 amber = float4(1.0, 150.0 / 255.0, 50.0 / 255.0, 0.0);
        float4 fringe;
        if (t < 0.966) fringe = blue;
        else if (t < 0.975) fringe = mix(premul(blue), premul(float4(blue.rgb, 0.3)), (t - 0.966) / 0.009);
        else if (t < 0.982) fringe = mix(premul(float4(blue.rgb, 0.3)), premul(blue), (t - 0.975) / 0.007);
        else if (t < 0.988) fringe = mix(premul(blue), premul(float4(amber.rgb, 0.26)), (t - 0.982) / 0.006);
        else if (t < 0.995) fringe = mix(premul(float4(amber.rgb, 0.26)), premul(amber), (t - 0.988) / 0.007);
        else fringe = float4(0.0);
        if (t < 0.966) fringe = float4(0.0);
        // Composite: shade over picture, fringe over that (inside the lens only), then the mask on top.
        float4 inner = premul(shade);
        inner = fringe + inner * (1.0 - fringe.a);
        inner *= step(t, 1.0);
        float4 outer = premul(tube) * mask;
        return outer + inner * (1.0 - outer.a);
    }
    case kVignette: {
        // radial-gradient(ellipse at center, rgba(96,8,4,0) 46%, rgba(96,8,4,0.4) 80%, rgba(64,4,2,0.82) 100%)
        // "ellipse at center" is farthest-corner: the ellipse through the corners, same aspect as the box.
        float2 halfView = u.viewport * 0.5;
        float2 v = (p - halfView) / (halfView * M_SQRT2_F);
        float r = length(v);
        float4 c0 = premul(float4(96.0, 8.0, 4.0, 0.0) / float4(255.0, 255.0, 255.0, 1.0));
        float4 c1 = premul(float4(96.0 / 255.0, 8.0 / 255.0, 4.0 / 255.0, 0.4));
        float4 c2 = premul(float4(64.0 / 255.0, 4.0 / 255.0, 2.0 / 255.0, 0.82));
        float4 g = r <= 0.46 ? c0 : r <= 0.8 ? mix(c0, c1, (r - 0.46) / 0.34) : r <= 1.0 ? mix(c1, c2, (r - 0.8) / 0.2) : c2;
        return g * item.color.a;
    }
    }
    float a = color.a * alpha;
    return float4(color.rgb * a, a);
}

struct HudGrade {
    float saturation;  // CSS saturate(): 1 untouched
    float dim;         // alpha of rgba(9, 9, 8, a) over the scene
};

vertex float4 hudGradeVertex(uint vid [[vertex_id]]) {
    float2 uv = float2((vid << 1) & 2, vid & 2);
    return float4(uv * 2.0 - 1.0, 0.0, 1.0);
}

/// Reads the frame in place (Apple GPU framebuffer fetch): CSS saturate() matrix, then the dead dim.
fragment float4 hudGradeFragment(float4 position [[position]], float4 scene [[color(0)]], constant HudGrade &g [[buffer(0)]]) {
    float s = g.saturation;
    float3x3 m = float3x3(
        float3(0.213 + 0.787 * s, 0.213 - 0.213 * s, 0.213 - 0.213 * s),
        float3(0.715 - 0.715 * s, 0.715 + 0.285 * s, 0.715 - 0.715 * s),
        float3(0.072 - 0.072 * s, 0.072 - 0.072 * s, 0.072 + 0.928 * s));
    float3 c = clamp(m * scene.rgb, 0.0, 1.0);
    c = mix(c, float3(9.0, 9.0, 8.0) / 255.0, g.dim);
    return float4(c, scene.a);
}

# Porting map: render-fx-core

Scope: `src/render`, `src/fx`, `src/core`, `src/platform`, `src/dev`, `src/main.ts`
(41 files, 6,653 lines). Target: macOS app in Swift 6.4 + Metal, cross-play with the
browser build.

Correction to the brief: the web build has **no custom GLSL**. It uses
`three/webgpu` (`WebGPURenderer`, WebGL2 fallback through `?webgl`) and builds every
shader as a **TSL node graph** in TypeScript. Each shader below has to be rewritten by
hand in MSL. No GLSL can be carried across.

---

## 1. Purpose and structure

### src/main.ts (84)
Boot. Reads `?view=` (dev viewer), otherwise `Game.create(canvas, debugSettings())`
(`main.ts:23`). `?autostart&map=&bots=&pose=` starts a match with no menu (`main.ts:27-44`).
`?q=` picks a tier and `?no=ssr,ao,godrays,bloom,aa,grain,shadows` turns effects off
(`main.ts:53-74`). Exposes `window.__ironvale` for tests and screenshots.

### src/render (806)
| File | Lines | Responsibility |
|---|---|---|
| `engine.ts` | 374 | `Engine`: renderer, `Scene`, `PerspectiveCamera(75, 1, 0.04, 900)` (`:44`), sun `DirectionalLight` with a PCF shadow map, a texel-snapped shadow frustum that follows the camera (`:342-366`), fog node (`:183-206`), IBL from an equirect HDR plus an optional backdrop (`:145-165`), the frame loop with clamped dt (`:318-330`), resize and pixel ratio (`:332-339`), a warm-up that forces pipeline compiles (`:252-276`), and the rule for rebuilding the pipeline when graphics settings change (`:208-232`). |
| `pipeline.ts` | 214 | The post frame graph: MRT scene pass (output, packed view normal, metal/rough, velocity) -> GTAO -> SSR -> godrays (shadow-map raymarch) + bilateral blur -> TRAA -> bloom -> ACES tone map (`renderOutput`) -> FXAA -> vignette -> film grain (`:57-204`). |
| `dynamic-resolution.ts` | 138 | A controller with no rendering in it: steps render scale down by 0.05 when frames run long and probes back up, with backoff (`:15-137`). Ports 1:1 to Swift. |
| `materials.ts` | 80 | `pbrMaterial` (MeshStandard with color/normal/ARM/rough/AO maps) and `flatMaterial`; procedural "wetness" puddles built from `mx_noise_float` (MaterialX Perlin) on world XZ (`:71-80`). |

### src/core (936)
| File | Lines | Responsibility |
|---|---|---|
| `settings.ts` | 355 | Settings schema, quality presets (`:80-139`), GPU-name tier pick (`:155-161`), control presets (`:163-184`), defaults (`:186-191`), validation and merge of the stored JSON (`:201-273`), `SettingsStore` (immutable update + listeners) under localStorage key `ironvale.settings.v1` (`:193`). |
| `input.ts` | 287 | Maps actions to `KeyboardEvent.code` bindings (`:4-96`), pressed/held/released sets, pointer-lock look deltas with spike rejection (600 px) and optional smoothing (`:183-200`), and wheel gesture debouncing (`:257-277`). |
| `assets.ts` | 252 | Manifest-driven loader (`assets/*.json` glob): HDR (RGBE), sky JPG panorama with downscale, PBR texture sets with 1k/2k tiers, glTF models, raw audio `ArrayBuffer`s. |
| `random.ts` | 21 | `seededRandom` (mulberry32) and `hashString` (FNV-1a). **Cross-play critical**, see section 4. |
| `events.ts` | 21 | A typed `EventBus` (Map of Sets; `emit` iterates a copy). |

### src/platform (97)
| File | Lines | Responsibility |
|---|---|---|
| `pointer.ts` | 89 | `PointerGrab` interface plus `BrowserPointerGrab` (Pointer Lock API, `unadjustedMovement` for raw input, retry on refusal). The comment at `:1-6` says an earlier Mac WKWebView shell froze and hid the cursor natively. |
| `index.ts` | 8 | `createPointerGrab(element)` factory, the single place where the platform is chosen. |

### src/dev (101)
`viewer.ts`: `/?view=<path>` model viewer. Loads `*.view.ts` modules through `import.meta.glob`, uses an ultra-tier Engine, a fixed lighting setup (`:47-61`) and an orbit or exact camera from URL params.

### src/fx (4,435)
| File | Lines | Responsibility |
|---|---|---|
| `index.ts` | 106 | `createEffects(ctx)`: builds two `ParticlePool`s (lit, 1536; additive glow, 640, `:19-21`), Rings, Decals, Tracers and Weather. Updates the modules in order and then flushes the pools (`:59-66`). |
| `shared.ts` | 195 | `FxEnv` (effect clock uniform, wind by weather `:40-44`, sun and ambient light for particles, `sunAt` line-of-sight probe), `RENDER_ORDER` (`:23-32`), `leaveSurfaceDataAlone` (MRT alpha-0 trick `:158-172`), `randRange` / `randomInCone` (Math.random). |
| `pool.ts` | 62 | `RingPool` slot allocator, `DirtyRange` (partial GPU upload), `scaledCount` (density with a stochastic remainder). |
| `particles.ts` | 262 | GPU particles. A 20-float instance stride written once at birth; the vertex shader evaluates closed-form drag + gravity + wind motion (`:210-217`), billboard or velocity-stretched quads, sprite-atlas UVs, fade-in, near fade and a fade-out power (`:194-262`). |
| `rings.ts` | 135 | Expanding surface rings (rain splashes, water), 12-float stride, capacity 320. |
| `tracers.ts` | 163 | Bullet streaks flown in the vertex shader (12-float stride, cap 96); additive HDR colour `vec3(20,11,4)*brightness` (`:159`). |
| `tracer-math.ts` | 27 | Visible speed and streak length; which local shots get tracers (every 3rd, or every 4th pellet). |
| `decals.ts` | 135 | Bullet holes as `InstancedMesh` (cap 200), MeshStandard with polygon offset -2/-4, 36 s hold + 4 s fade, early retirement when the pool wraps. |
| `decal-sheet.ts` | 126 | Canvas2D procedural bullet-hole atlas (4x4 cells of 128 px), seeded. |
| `flash-sheet.ts` | 69 | Canvas2D muzzle-flash atlas (2x2 cells of 256 px), seeded. |
| `textures.ts` | 315 | Canvas2D procedural particle sprite sheet (4x4 cells of 128 px) and drawing helpers (blob, value noise, spike, etc.). |
| `muzzle.ts` | 387 | Muzzle flash quads (3 per flash, 8 flashes), 3 pooled `PointLight`s kept at intensity 0 so materials never recompile (`:131-135`), barrel heat and lingering smoke. |
| `impacts.ts` / `impact-emitters.ts` | 110 / 355 | Surface-specific impact recipes (dust, chips, sparks, splashes) that use `SURFACE_LOOKS`, with distance-based LOD. |
| `surfaces.ts` | 32 | Per-surface albedo, dustiness and decal kind. |
| `blood.ts` | 105 | Small mist and drops on a combatant hit. |
| `casings.ts` / `casing-physics.ts` | 201 / 115 | Instanced cylinders; CPU bounce sim with world raycasts (`CASING_TUNING` `:17-23`). Cosmetic only. |
| `grenade.ts`, `grenade-blast.ts`, `grenade-arc.ts` | 137 / 265 / 155 | Grenade bodies, blast particles and scorch decals, camera shake (`grenade.ts:121-134`), and an aim-preview ribbon from `weapons/grenade-math.predictArc` (`grenade-arc.ts:82`). |
| `nearmiss.ts` | 99 | A streak plus disturbed air where a bullet passes close to the local player. |
| `weather.ts` | 182 | Rain, mist and motes; a 32x32 roof-mask probe budget; rain splash rings (420/s). |
| `rain.ts` | 147 | 7000 streaks wrapped in a 26x16x26 m box around the camera, entirely in the vertex shader (`:101-145`), and culled by the roof-mask texture. |
| `mist.ts` | 243 | Fog banks (56) and dust motes (520), seeded placement, roof-masked. |
| `roof-mask.ts` | 127 | A toroidally wrapped height grid that follows the player (uploaded as a repeating texture). |
| `demo.ts` / `demo-config.ts` | 328 / 46 | Dev demos (`&fxdemo=`, `&fxslow=`, `&fxweapon=`). |

---

## 2. Interfaces

### Depended on by other subsystems
- **`Engine`** (`render/engine.ts`), through `GameContext.engine` (`game/contracts.ts:548`): `scene`, `camera`, `sun`, `onFrame(cb) -> unsubscribe` (used by game, ballistics, player-weapons, HUD minimap and extras, fx), `setFov`, `setLighting(lighting, env, backdrop)`, `setSkyLight`, `applyGraphics`, `start/stop`, `warmUp`, `renderOnce`, `frameTimeMs`, `renderScale`, `isWebGPU`.
- **`pbrMaterial` / `flatMaterial`**: every map and model builder (maps/harbor, railyard, headworks, range, weapons/models, characters).
- **`SettingsStore`, `GraphicsSettings`, `Difficulty`, `QualityTier`, `graphicsForTier`, `CONTROL_PRESETS`**: ui/settings screens, `net/events.ts:6,88` (Difficulty is on the wire), ai/difficulty.
- **`Input`, `Action`, `BINDING_PRESETS`**: player/controller, weapons/intent, ui/keys, ui/screens/controls-ref.
- **`Assets`, `PbrMaps`**: maps, weapons, characters, audio (sound `ArrayBuffer`s).
- **`EventBus<GameEvents>`**: every system. fx only listens.
- **`seededRandom` / `hashString`**: `game/game.ts:214` (map build RNG), `ai/manager.ts:67`, `audio/graph.ts:100`, `maps/harbor/*`, `maps/headworks/kit.ts:33`.
- **`createEffects`** implements `EffectsSystem` (`contracts.ts:419-424`): `enterMap`, `leaveMap`, `update(dt)`, `dispose`.

### What this group depends on
- `world/types` (`LightingSetup`, `MapInstance`, `Weather`, `Surface`, `RayHit`, `InteriorZone`) and `World.lineOfSight` / raycast (fx `sunAt`, casings, roof mask, weather splashes).
- `game/contracts` (`GameContext`, `GameEvents`: `shotFired`, `bulletTrace`, `bulletImpact`, `combatantHit`, `nearMiss`, grenade events).
- `weapons/grenade-math` (`GRENADE`, `predictArc`, `blastShake`).
- `game/game` (main.ts only).

---

## 3. Three.js and browser APIs, with native equivalents

### Renderer, scene and frame
| Web | Native |
|---|---|
| `THREE.WebGPURenderer` + `renderer.init()` (`engine.ts:93-101`) | `MTLCreateSystemDefaultDevice`, `MTKView` (or `CAMetalLayer` + `CADisplayLink` from `NSView.displayLink(target:selector:)`) |
| `setAnimationLoop` (`engine.ts:238`) | `MTKViewDelegate.draw(in:)` or a CADisplayLink callback; triple-buffered with a `DispatchSemaphore(3)` |
| `THREE.Timer` getDelta/getElapsed | `CACurrentMediaTime()` / `targetTimestamp` from the display link |
| `setPixelRatio(devicePixelRatio * scale)`, `setSize` | `view.drawableSize` fixed at full backing scale; render internal targets at `scale` and upscale with **MetalFX Spatial** (or Temporal, which can replace TRAA) |
| `Scene`/`Object3D` graph, `renderOrder`, `frustumCulled`, `onBeforeRender` | A Swift scene layer: flat render lists of `RenderItem`s (mesh, material, transform, sort key); CPU frustum culling; transparent items sorted by `RENDER_ORDER` and then by depth |
| `PerspectiveCamera` (standard depth) | Own `Camera` struct with a simd projection. Use **reverse-Z** with a float depth target (near 0.04, far 900 is a 22,500:1 ratio, so Z precision matters) |
| `trackTimestamp` GPU timing | `MTLCounterSampleBuffer` / `commandBuffer.gpuStartTime/gpuEndTime` |
| `renderer.compileAsync` and the warm-up frames (`engine.ts:252-276`) | Build all `MTLRenderPipelineState`s up front from a material permutation table, or use a `MTLBinaryArchive` / Metal 4 pipeline harvesting. This removes the warm-up hack |
| `backend.device.queue.onSubmittedWorkDone` | `commandBuffer.waitUntilCompleted()` / `addCompletedHandler` |

### Materials and shaders (TSL to MSL)
| Web | Native |
|---|---|
| `MeshStandardNodeMaterial` (54 uses repo-wide) | One MSL PBR uber-shader matching three's `PhysicalLightingModel`: GGX/Smith with Schlick Fresnel, Lambert diffuse, multi-scatter energy compensation (three uses `DFGApprox`), with function constants for the map set (color, normal, ARM, rough, AO), tint, and a wetness branch |
| `MeshPhysicalNodeMaterial` (2), `MeshBasicNodeMaterial` (26), `LineBasicNodeMaterial` (2), `SpriteNodeMaterial` (1) | Physical: clearcoat/transmission subset as needed. Basic: an unlit shader permutation |
| `scene.environment` equirect + three's automatic PMREM | Precompute a prefiltered cubemap (GGX mip chain) + irradiance SH + a BRDF LUT in a compute pass at map load. Must match `environmentIntensity` and `environmentRotation` (`engine.ts:148-154`) |
| `scene.background` equirect, `backgroundIntensity` x 1.5 for a tone-mapped backdrop (`engine.ts:24,153`) | A full-screen sky pass sampling the equirect by view direction, drawn at depth = far |
| `fog(color, densityFogFactor)` with sun tint and height falloff (`engine.ts:183-206`) | An MSL function applied in forward shaders: `f = 1 - exp(-(density*dist)^2)` (three's `densityFogFactor` is exp-squared), times `max(exp(-falloff*max(y-base,0)), 0.25)`, colour mixed toward `sunTint` by `pow(max(dot(viewDir, sunDir),0),5)*strength` |
| `mx_noise_float` (`materials.ts:72-73`) | Port the MaterialX `mx_perlin_noise_float` to MSL. The output only needs to look the same, not match bit for bit |
| `instancedBufferAttribute(buffer,'vec4',stride,offset)` | Pass an `MTLBuffer` of instance structs and index it with `[[instance_id]]` (`struct Particle { float4 origin; float4 vel; float4 shape; float4 color; float4 phys; }`) |
| `InstancedInterleavedBuffer.addUpdateRange` / `DirtyRange` | Shared-storage `MTLBuffer`; write only the dirty range in place. With triple buffering, a ring of 3 buffers, or write-once slots guarded by birth time (safe because a slot is only overwritten once the pool wraps) |
| `InstancedMesh.setMatrixAt` | Instance-transform `MTLBuffer` |
| `positionNode` / `colorNode` overrides | Custom vertex/fragment functions per effect (particles, rings, tracers, rain, mist banks, motes, muzzle flash, decals, casings, grenade arc) |
| `alphaTest` | `discard_fragment()` |
| `polygonOffset` (-2/-4) | `setDepthBias(_:slopeScale:clamp:)` |
| `AdditiveBlending`, `NormalBlending`, `transparent`, `depthWrite:false` | `MTLRenderPipelineColorAttachmentDescriptor` blend factors; `MTLDepthStencilState` with write disabled |
| `PointLight` x3 (muzzle) + `HemisphereLight`, `SpotLight` elsewhere | A small fixed light array in a uniform buffer (max ~8 punctual lights). Three's physically correct `distance=10, decay=2` falloff: `pow(saturate(1 - (d/r)^4), 2) / d^2` |
| `CanvasTexture` from Canvas2D drawing (`textures.ts`, `decal-sheet.ts`, `flash-sheet.ts`) | Port the drawing code to CoreGraphics (`CGContext` radial gradients and paths) at startup, **or** bake the three atlases to PNG once from the browser and ship them. Baking is recommended because they are seeded and deterministic, so the PNGs are exact |
| `DataTexture` (roof mask, Float32 heights) | `MTLTexture` `.r32Float` with `.repeat` addressing, `replace(region:)` on version change |

### Post pipeline (`pipeline.ts`), pass by pass
| TSL node | Metal |
|---|---|
| `pass(scene,camera)` + `mrt({output, normal: packNormalToRGB(normalView), metalrough: vec2, velocity})` (`:75-88`), normal as `UnsignedByteType` (`:103-105`) | One render pass, 4 colour attachments: `rgba16Float` colour, `rgba8Unorm` normal (packed `n*0.5+0.5`), `rg8Unorm` metal/rough, `rg16Float` velocity, and `depth32Float`. Opaque first, then transparents |
| Per-attachment `BlendMode` + `leaveSurfaceDataAlone` (`shared.ts:158-172`, `pipeline.ts:84-87`) | Metal supports per-attachment blend natively: give transparent pipelines blending on attachments 1-3 and write alpha 0 there, **or simpler**, set the `writeMask = []` for attachments 1-3 in transparent pipeline states. That needs no alpha trick and has no WebGL fallback quirk |
| `ao()` GTAONode, half res unless ultra, radius 0.6, thickness 1.2, 8/12 samples, temporal (`:111-120`) | Compute GTAO in MSL (port three's GTAONode, or use the XeGTAO reference), then a denoise. Multiply into colour |
| `ssr()` half res, maxDistance 14, thickness 0.35, intensity 0.8, reflectNonMetals (`:122-139`) | Compute or fragment hierarchical-Z SSR. Port SSRNode's linear march for parity first |
| `godrays(depth, camera, sun)` + `bilateralBlur` (`:141-166`) | A half-res raymarch against the sun shadow map (32/48 steps); bilateral blur; composite with the near-field fade 110 to 320 m (`:207-208`) |
| `traa()` (`:168-172`) | A TAA resolve with velocity + neighbourhood clamp, **or MetalFX Temporal Scaler**, which also handles dynamic resolution. Needs a sub-pixel jittered projection |
| `bloom(color, 0.22*mapBloom, 0.6, 1.0)` (`:174-179`) | Three's UnrealBloom-style mip chain: threshold, 5 levels of separable blur, composite |
| `renderOutput` (ACES Filmic, exposure; `engine.ts:104,160`) | An MSL `ACESFilmicToneMapping` matching three's fitted curve (the RRT+ODT fit with the `1/0.6` input scale), then linear to sRGB |
| `fxaa()` (`:183-187`) | FXAA 3.11 fragment pass |
| Vignette `mix(1,0.78,smoothstep(0.35,0.85,len(uv-0.5)))` + `film(display, 0.055)` (`:189-192`) | The final full-screen pass, written to the drawable (`bgra8Unorm_srgb` or `bgra10_xr` for EDR) |
| Sun shadow: `PCFShadowMap`, bias -0.0005, normalBias 0.04, ortho ±55 m, far 320 (`engine.ts:77-85`); texel snapping (`:342-366`); every other frame on low (`:29,344-349`) | `depth32Float` shadow texture, a depth-only pass with a `sample_compare` PCF kernel. Port the snapping math as is. Consider cascades later (the web build has a single 110 m square) |

### Browser and platform
| Web | Native |
|---|---|
| Pointer Lock + `movementX/Y` (`pointer.ts`) | `CGAssociateMouseAndMouseCursorPosition(0)` + `NSCursor.hide()`; deltas from `NSEvent.deltaX/Y` on `.mouseMoved/.leftMouseDragged`, or GameController `GCMouse.mouseInput.mouseMovedHandler` for raw unaccelerated deltas (maps to `rawInput`) |
| `KeyboardEvent.code` strings | `NSEvent.keyCode` (virtual keycodes) mapped to the **same code strings** so that bindings and settings JSON stay shared. Or use `GCKeyboard` `GCKeyCode` |
| `wheel` with `ctrlKey` pinch | `NSEvent.scrollingDeltaY`, `hasPreciseScrollingDeltas`, `momentumPhase` (better than the 180 ms quiet heuristic); `magnify` events for pinch |
| `blur`/`visibilitychange` releaseAll (`input.ts:136-137`) | `NSApplication.didResignActiveNotification`, `NSWindow.didMiniaturizeNotification` |
| `localStorage` (`settings.ts:334-340`) | `UserDefaults` holding the **same JSON string** under `ironvale.settings.v1`, so `parseSettings` logic ports unchanged |
| `WEBGL_debug_renderer_info` GPU name (`settings.ts:343-355`) | `MTLDevice.name` (for example "Apple M2"); feed it to the same `tierForGpu` regex |
| `URLSearchParams` dev switches | Launch arguments / `UserDefaults` argument domain (`-q low -no ssr,ao`) |
| `fetch`, `TextureLoader`, `HDRLoader`, `GLTFLoader`, `createImageBitmap` resize | `MTKTextureLoader` (PNG/JPG, `.SRGB` option, mip generation), a small RGBE `.hdr` decoder to `rgba16Float` (or preconvert to KTX2/EXR), glTF via **ModelIO** (`MDLAsset` loads glTF on recent macOS) or a Swift glTF loader such as GLTFKit2, plus `vImage` for sky downscale |
| `import.meta.glob` of `assets/*.json` | Bundle the JSON files as resources; decode with `Codable` |
| `console.warn` | `os.Logger` |
| DOM error notice (`main.ts:76-84`) | An `NSAlert` or SwiftUI overlay |

---

## 4. Cross-play-critical behaviour

Nearly everything in this group is **cosmetic** and local: effects, post, settings,
input feel. Cosmetic randomness (`Math.random` in `shared.ts:175-195`, `decals.ts:74`,
`grenade-blast.ts:175`, `weather.ts:147`, `muzzle.ts:185`) can use any RNG natively.
The items below are the exceptions that must match.

1. **mulberry32 `seededRandom`** (`core/random.ts:2-11`). It must be bit-exact. It seeds
   map building (`game/game.ts:214` -> `maps/headworks/kit.ts:33,38,42`,
   `maps/harbor/scatter.ts:146-149` place crates with `addCase`, which may add
   **collision**), so any divergence moves cover between the web and native peers. It also seeds bot
   AI (`ai/manager.ts:67`, host-side) and audio reverb (cosmetic). A Swift port:
   ```swift
   struct Mulberry32 { var state: UInt32
     mutating func next() -> Double {
       state &+= 0x6D2B_79F5; var t = state
       t = (t ^ (t >> 15)) &* (t | 1)
       t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
       return Double(t ^ (t >> 14)) / 4_294_967_296.0 } }
   ```
   JS `Math.imul` is a wrapping 32-bit multiply (`&*`). `t + imul(...)` followed by `^`
   is wrapping addition modulo 2^32. `>>>` is a logical shift (UInt32 `>>`). The seed is
   `seed >>> 0`, so negative JS seeds become `UInt32(truncatingIfNeeded:)`. **The number
   and order of `random()` calls in every map builder must be identical**. That
   requirement belongs to the maps group, but this group owns the primitive. Add golden
   tests: the first 1,000 outputs for seeds 0, 0x7a1 and `hashString("range")`.
2. **FNV-1a `hashString`** (`core/random.ts:14-21`) iterates **UTF-16 code units**
   (`charCodeAt`). In Swift, iterate `text.utf16`, not `unicodeScalars` or `utf8`.
   The offset is `0x811c9dc5` and the prime `0x01000193` with `&*`. Map ids are ASCII
   today, so the risk is low, but the code should do it correctly.
3. **Difficulty enum strings on the wire**: `'recruit' | 'regular' | 'veteran' | 'elite'`
   (`core/settings.ts:10`, validated at `net/events.ts:88,151`). The Swift `enum
   Difficulty: String` must use these raw values.
4. **Frame dt clamp** `MAX_FRAME_DT = 0.05` (`render/engine.ts:23,321`). `Game.frame(dt)` is
   variable-step (`game/game.ts:316-343`), so the simulation (player, weapons, grenades,
   host-run bots) is fed the engine's clamped dt. The native loop must clamp the same way.
   Exact per-frame equality is not required because the sim is not lockstep, but the
   clamp changes behaviour under hitches: under 20 fps the simulation runs slow.
   Recommendation: keep the clamp, and drive the sim from the display-link timestamp
   delta, not wall-clock `Date`.
5. **Look sensitivity units**: "degrees per 1000 px of pointer travel" (`settings.ts:37-38`)
   in CSS pixels (`input.ts:182`). Native deltas are in points, which match CSS px at
   default zoom. The units must stay the same so that shared settings and aim feel line
   up. Only competitive fairness depends on this, not the protocol.
6. **Grenade aim arc** uses `weapons/grenade-math.predictArc` (`fx/grenade-arc.ts:82`). It is
   display only, but it must show the same path the simulated grenade will take, so it
   has to call the native port of that integrator (owned by the weapons group).
7. **Settings JSON format** (`settings.ts:193,250-273`) is not on the wire. Keep it
   identical so that one parser and one test suite cover both builds.
8. **Tracer visibility rules** (`fx/tracer-math.ts:10-27`): every 3rd local shot, every
   4th pellet, bots always. These are cosmetic but visible to the other player, so match
   them for consistent readability.

Nothing in this group sends packets, and the signaling and peer protocol is out of scope here.

---

## 5. Proposed Swift module layout

```
IronvaleNative/
  Packages/
    IVCore/                     // pure Swift, no Apple GUI deps, unit-testable on Linux too
      Random.swift              // Mulberry32, fnv1a(utf16)  <- golden tests vs JS
      EventBus.swift            // EventBus<Event> (typed enum events), unsubscribe tokens
      Settings.swift            // GraphicsSettings, ControlSettings, ..., QualityPreset,
                                // tierForGpu, parseSettings(json:), SettingsStore (@Observable)
      Bindings.swift            // Action enum, BindingPresets with web code strings
      DynamicResolution.swift   // 1:1 port
    IVPlatform/
      InputSystem.swift         // final class InputSystem: held/pressed/released, consumeLook
      KeyCodeMap.swift          // NSEvent.keyCode -> "KeyW" etc.
      PointerGrab.swift         // protocol PointerGrab; MacPointerGrab (CGAssociate..., GCMouse)
      AppLifecycle.swift        // focus loss -> releaseAll
    IVAssets/
      AssetManifest.swift       // Codable AssetEntry, tier fallback rules
      AssetStore.swift          // actor AssetStore: textures, HDR, glTF (ModelIO/GLTFKit2), audio data
      RGBELoader.swift
    IVRender/
      Renderer.swift            // final class Renderer: MTLDevice, queue, frame semaphore, MTKViewDelegate
      FrameLoop.swift           // dt clamp 0.05, frameMs EMA, onFrame callbacks
      Camera.swift, Scene.swift // RenderItem lists, transforms, culling, render-order sort
      Materials/                // PBRMaterial (function-constant permutations), UnlitMaterial
      Lighting/                 // SunShadow (snapping, interval), IBLBaker (PMREM compute), Fog, PunctualLights
      Post/                     // FrameGraph, GBufferPass, GTAOPass, SSRPass, GodraysPass,
                                // TAAPass | MetalFXTemporal, BloomPass, ToneMapPass, FXAAPass, FinalPass
      Shaders/*.metal           // PBR.metal, Sky.metal, Shadow.metal, Post/*.metal, FX/*.metal
      PipelineCache.swift       // all PSOs prebuilt; MTLBinaryArchive
    IVFX/
      FxEnv.swift
      GPUParticlePool.swift     // instance buffer, RingPool, DirtyRange
      Rings.swift, Tracers.swift, Decals.swift, Muzzle.swift, Impacts.swift, ImpactEmitters.swift,
      Blood.swift, Casings.swift, CasingPhysics.swift, Grenade*.swift, NearMiss.swift,
      Weather.swift, Rain.swift, Mist.swift, RoofMask.swift, Surfaces.swift, TracerMath.swift
      Atlases/                  // baked sprite/decal/flash PNGs (or CoreGraphics generators)
    IVDev/
      ModelViewer.swift         // launch arg -view <id>
  App/
    IronvaleApp.swift           // @main, NSWindow + MTKView host, launch args (-autostart -map -q -no)
```

Key types: `Renderer`, `FrameLoop`, `RenderScene`, `PBRMaterial`, `SunShadow`,
`IBLEnvironment`, `PostChain` (rebuilt when `GraphicsSettings` structural fields change,
the same rule as `engine.ts:220-231`), `GPUParticlePool`, `EffectsSystem` (protocol),
`SettingsStore`, `InputSystem`, `PointerGrab`, `Mulberry32`.

Swift 6 concurrency: rendering and the sim run on `@MainActor`, the same model as the
web's single thread. `AssetStore` is an `actor` for async loads. GPU buffers are
`@unchecked Sendable` wrappers.

---

## 6. Risks, unknowns, estimate

**Risks**
- **Visual parity with three's lighting model.** Matching PMREM, the `PhysicalLightingModel`
  energy compensation, ACES and the fog formula exactly is fiddly. Golden-image comparison
  against `?autostart&pose=` screenshots (the hook already exists in `main.ts:27-44`) is
  the right harness. Expect tuning time.
- **Most geometry is procedural TypeScript** (82 `CylinderGeometry`, 41 Box, 27 Torus,
  Lathe, Extrude, `RoundedBoxGeometry`, `BufferGeometryUtils.mergeGeometries` repo-wide).
  The renderer needs either Swift ports of three's geometry generators (exact vertex order
  matters only for the look) or an **offline export** of built scenes to glTF/USD from a
  headless run of the web build. Export is far cheaper but goes stale as the web build
  evolves. Collision must still match (maps and world groups).
- **The post nodes are big.** GTAO, SSR, TRAA, Godrays and Bloom are each a few hundred
  lines of three addon code to reimplement. MetalFX Temporal can stand in for TRAA plus
  dynamic resolution and is likely faster than the web path.
- **The MRT alpha trick** (`leaveSurfaceDataAlone`) becomes the simpler per-attachment
  `writeMask` approach. This must be applied to every transparent pipeline, or AO and SSR
  show sprite-shaped artifacts.
- **Canvas2D atlases.** CoreGraphics anti-aliasing differs from browser canvas. Baking PNGs
  avoids that, but adds a build step that must rerun when the web atlas code changes.
- **Map-RNG call order** (section 4.1) is a cross-group risk. It breaks silently: the two
  peers see different cover.
- **Input feel.** The trackpad heuristics (wheel debounce, look smoothing, spike rejection)
  were tuned to browser event cadence. Native `NSEvent` arrives at a different cadence,
  with precise deltas and momentum phases, so it needs retuning while keeping the same
  setting units.
- **Unknown:** whether the web build will move to cascaded shadows or new post nodes while
  the port is in progress. The web "keeps evolving", so the port needs a parity checklist
  tied to `pipeline.ts` and `engine.ts` diffs.
- **Unknown:** whether the native build must load the same `assets/*.json` manifests and the
  `public/assets/dl` tree directly. Recommended: yes, through a symlinked or copied
  resource bundle step.

**Difficulty:** high for render (a full forward PBR renderer plus 8 post passes plus IBL
baking), medium for fx (about 12 small custom shaders, mostly vertex-driven closed forms
that translate directly to MSL), and low for core and platform.

**Effort (one experienced Metal engineer):**
| Piece | Days |
|---|---|
| IVCore (random with golden tests, settings, event bus, dynamic res) | 3 |
| IVPlatform (input, key map, pointer grab, lifecycle) | 4 |
| IVAssets (manifest, textures, RGBE, glTF via ModelIO/GLTFKit2) | 5 |
| Renderer core (device, loop, scene lists, camera, PBR uber-shader, fog, sky, punctual lights) | 12 |
| Shadows + IBL/PMREM baking | 6 |
| Post: G-buffer MRT, GTAO, SSR, godrays + blur, TAA/MetalFX, bloom, ACES, FXAA, final | 15 |
| FX: particle pool, rings, tracers, decals, muzzle, impacts, blood, casings, grenade, rain, mist, roof mask, weather, atlases | 14 |
| Dev viewer, launch args, golden-image parity harness, tuning | 6 |
| **Total** | **~65 days** |

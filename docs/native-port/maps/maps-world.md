# Porting map: maps-world (`src/maps`, `src/world`)

Scope: 99 files, 16,163 lines. `src/maps` holds four maps written as TypeScript
procedures that build a Three.js scene graph and register collision triangles.
`src/world` holds the shared types, a few geometry helpers and the
BVH-backed collision world that every other gameplay system queries.

Summary of the finding: **no map is stored as data**. Each map is code that runs
at load time. It reads constant tables, draws from a seeded RNG, and emits two
outputs: render geometry (merged per material), and collision triangles fed to
`CollisionWorld`. The plan for the native client keeps that split. Collision and
gameplay metadata, the parts that affect cross-play, are **exported from the web
code into a shared binary/JSON map package**. The visible level is exported as
geometry, but its TSL materials are rewritten in Metal by hand.

---

## 1. Purpose and structure

### 1.1 `src/world` (480 lines)

| File | Lines | Responsibility |
|---|---|---|
| `world/types.ts` | 171 | Contracts: `Surface` (14 kinds, `types.ts:4-18`), `RayHit`, `CapsuleMoveResult`, `World` interface (`:42-73`), `SpawnPoint` (`:75-79`, yaw 0 looks down -Z), `FogSetup`, `LightingSetup` (`:97-119`), `Weather`, `ReverbPreset`, `AmbienceLayer`, `InteriorZone`, `MapInstance` (`:146-163`), `MapMeta` (`:165-171`). |
| `world/collision.ts` | 259 | `CollisionWorld implements World`: one merged triangle soup plus a separate "boundary" soup, each in a `three-mesh-bvh` `MeshBVH`. Raycast, line of sight, ground height, capsule move-and-slide, capsule fit test, surface lookup per triangle. |
| `world/geometry.ts` | 50 | `tiledBox`, `tiledGround` (world-scaled UVs), `enableShadows`. Used by `range` and the railyard kit. |

### 1.2 `src/maps` (15,683 lines)

| Path | Files / lines | Responsibility |
|---|---|---|
| `maps/registry.ts` | 1 / 36 | `MapModule` contract (`meta` + `build(ctx)`), lazy `LOADERS` for `range`, `harbor`, `headworks`, `railyard` (`:18-23`), menu list `PLAYABLE_MAPS` (`:26-30`), `loadMapModule` (`:32-36`). |
| `maps/range/index.ts` | 1 / 99 | Developer test map: plane, 14 random boxes from `ctx.random` (`:27-33`), shed, material probes, stairs. Colliders come from the meshes themselves through `addColliderObject`. |
| `maps/harbor/` | 41 / 7,120 | Mediterranean fishing town at golden hour. Largest map. |
| `maps/railyard/` | 30 / 4,973 | Container and rail yard in rain at dusk. |
| `maps/headworks/` | 24 / 3,455 | Point-symmetric mountain water works at winter noon. Its collision is pure plan data. |

Every map follows the same pattern, with its own kit:

- **Plan / layout** (pure data, unit tested): `railyard/plan.ts` (218), `harbor/layout.ts` (103), `headworks/plan.ts` (288). Holds bounds, spawns, building footprints and, in headworks, every solid.
- **Kit** (build helper): `railyard/kit.ts` (238) + `builder.ts` (108), `harbor/kit.ts` (300, `Batch` + `Colliders`), `headworks/kit.ts` (254) + `builder.ts` (108). Bakes geometry into world space, merges one mesh per material (`railyard/kit.ts:165-174`), registers box colliders (`railyard/kit.ts:121-142`, `harbor/kit.ts:169-212`).
- **Materials / surfaces** (TSL node graphs): `*/materials.ts`, `*/surfaces.ts`, `harbor/grime.ts`, `railyard/container-paint.ts`, `headworks/decals.ts`, and others. 22 files import `three/tsl`.
- **Lighting**: `*/lighting.ts` export a `LIGHTING: LightingSetup` constant plus point, spot and hemisphere lights and per-frame flicker.
- **Sky / backdrop**: `*/sky.ts`, `*/backdrop.ts`: TSL sky dome and unreachable scenery.
- **Builders and dressing**: everything else (buildings, cranes, boats, props, clutter, decals, signs).

Per-map file inventory (lines):

- **harbor**: props 348, surfaces 367, posters 310, kit 300, backdrop 294, scatter 295, facade 284, dressing 281, house 275, boats 273, ground 262, boat-fittings 261, buildings 249, materials 234, clutter 211, water 210, shade 200, wall-detail 186, hull 168, cafe 160, index 155, interiors 149, capes 140, boat-parts 133, signs 111, church-front 106, trees 105, sky 104, layout 103, grime 100, shade-grid 100, street-life 91, hull-shape 78, greenery 71, wires 67, pieces 66, lighting 59, glow 56, arch 55, sprays 53, jetties 50.
- **railyard**: props 364, warehouse 300, materials 245, kit 238, dressing 233, office 228, plant 226, plan 218, rail 198, ship 196, surfaces 196, layout 194, containers 185, cranes 156, shapes 154, lighting 162, clutter 142, forklift 142, index 135, facades 133, container-paint 120, trailer 113, lamps 111, builder 108, markings 96, ground 87, sky 86, extras 81, lettering 78, shelter 48.
- **headworks**: surfaces 303, plan 288, kit 254, structures 234, tanks 218, plant 165, ground 169, range 160, parts 154, decals 152, materials 114, machines 119, house 111, services 111, builder 108, backdrop 104, colliders 103, fittings 103, index 94, shell 94, lighting 90, lamps 82, sky 71, frame 54.

### 1.3 How maps are defined: code vs data

| Map | Collision source | Random dependence | Exportability |
|---|---|---|---|
| headworks | **Pure data.** `registerColliders` (`headworks/colliders.ts:85-103`) reads `BLOCKS`, `DRUMS`, `RAMPS`, `RAILS`, `BRIDGE` from `plan.ts:253-256`. Point symmetry is generated by `turnBlock`/`turnDrum`/... (`plan.ts:244-249`). Registered **before** any visual build (`headworks/index.ts:38`). | None for colliders. `kit.random` is visual only (`plant.ts:146`). | Trivial: the plan is already JSON-shaped. |
| railyard | Mixed. Container stacks come from `planContainers(ctx.random)` (`plan.ts:91-174`), planned first so dressing never shifts it (`railyard/index.ts:44`). The rest are `kit.box(..., {surface})` / `kit.collide` calls spread over the builders (`containers.ts:150`, `warehouse.ts:297`, `clutter.ts:27-132`, `lighting.ts:61`, `facades.ts:108`, and others). | Yes, but detail-invariant: code draws from the stream and then decides whether to skip (`containers.ts:142-145`, `dressing.ts:183-185, 195-203`, `warehouse.ts:282-287`). | Needs a recording `World`, but the result is stable. |
| harbor | Code. `Colliders.box/span/shape/quad/boundary` (`harbor/kit.ts:169-212`) called from ~15 builder files, often at random offsets or sizes (`clutter.ts:68-82`, `scatter.ts:273-275`, `props.ts:201-210`). | Yes, **and it depends on the detail setting** (see §4.3). | Needs a recording `World`, and the result differs by detail preset today. |
| range | Mesh-derived (`addColliderObject`). | 14 random boxes (`range/index.ts:27-33`). | Trivial. Dev only. |

**Can map definitions be shared as data?** Yes for everything gameplay needs.
Collision triangles, surfaces, boundary, bounds, spawns, interiors, lighting
constants, weather, reverb and ambience are all deterministic outputs of
`build()`, so a headless export can capture them. The visible level cannot be
shared as plain data: it is 22 files of TSL shader graphs plus 2D-canvas
textures. That half has to be ported, not exported (§5.3).

---

## 2. Interfaces

### 2.1 What other subsystems depend on

| Consumer | Uses |
|---|---|
| `game/game.ts:190-260` | `loadMapModule`, `PLAYABLE_MAPS`, `new CollisionWorld()`, `module.build({assets, world, detailDensity, random: seededRandom(hashString(mapId))})` (`:210-215`), `world.build()` (`:216`), `map.root`, `map.lighting`, `map.dispose`. Spawning: `game.ts:489-491`. Exposes `capsuleFits` to other systems (`:542`). |
| `game/contracts.ts:571-578` | `MapBuildContext { assets, world, detailDensity, random() }`. |
| `player/controller.ts:224,244-245,315` | `moveCapsule`, `bounds`, `groundHeight(..., 500)`, `raycast` for crouch headroom. |
| `net/session.ts:588-615` | `playerSpawns`, `enemySpawns` (duel order matters), `capsuleFits` with `BODY_RADIUS 0.34`, `BODY_HEIGHT 1.8`, `SIDE_STEP 1.6` (`:49-51`). |
| `net/match.ts:541` | `world.raycast` for remote bullet impact marks. |
| `net/remote-soldier.ts:259` | `world.raycast` down for remote footstep surface. |
| `net/rules.ts:13` | `pickDuelSpawn` over spawn positions. |
| `ai/navgrid.ts:233,363`, `ai/manager.ts:136-224`, `ai/spawn.ts`, `ai/body.ts` | Nav grid built from raycasts and `capsuleFits` over `map.bounds` (0.6 m grid from `BOUNDS.min`; see the `railyard/plan.ts:37-41` comment). Enemy spawns. Host only. |
| `weapons/grenade-math.ts:96,182` | `raycast` for bounces, `lineOfSight` for blast damage. |
| `game/combat.ts`, `fx/*`, `fx/casing-physics.ts` | Raycasts, `Surface` for decals and particles, `Weather` for rain. |
| `audio/*` (8 files) | `ReverbPreset`, `AmbienceLayer`, `InteriorZone`, `Surface` for foley. |
| `render/engine.ts`, `render/pipeline.ts` | `LightingSetup` (HDRI, sun, fog, exposure, volumetric, bloom), `InteriorZone.skyLight`. |
| `ui/hud/minimap.ts` | `MapInstance` (bounds). |
| `net/events.ts:103,148` | Map id on the wire: `/^[a-z0-9-]{1,24}$/`. |

### 2.2 What this group depends on

- `three/webgpu` (86 files), `three/tsl` (22 files), `three/addons/utils/BufferGeometryUtils.js` (`mergeGeometries`, `mergeVertices`; 7 files), `three-mesh-bvh` (`collision.ts:13`).
- `core/assets.ts`: `assets.pbr(id)`, `.model(id)` (glTF group), `.hdri(id)`, `.sky(id)`, `.texture(id)`.
- `core/random.ts`: `seededRandom` (mulberry32) and `hashString` (FNV-1a). Five harbor files also make local streams with fixed seeds (`backdrop.ts:235`, `cafe.ts:133`, `street-life.ts:73`, `materials.ts:129,140,205`, `wall-detail.ts:169`).
- `render/materials.ts`: `pbrMaterial`, `flatMaterial` (range and the kits).
- `game/contracts.ts`: `MapBuildContext`.
- DOM: `document.createElement('canvas')` + 2D context for text atlases, and `performance.now()` (§3).

---

## 3. Three.js / browser API to Apple equivalents

| Web API (where) | Native equivalent |
|---|---|
| `THREE.Vector3/Matrix4/Quaternion/Euler/Box3/Matrix3/MathUtils` (everywhere) | `simd` (`SIMD3<Float>`, `simd_float4x4`, `simd_quatf`). Build-time maths in `Double` (`SIMD3<Double>`, `simd_double4x4`) to match JS float64, stored as `Float`. |
| `BufferGeometry`, `BufferAttribute`, `Float32BufferAttribute`, `toNonIndexed`, `computeVertexNormals` | Plain `[SIMD3<Float>]` arrays into `MTLBuffer`. A `MeshData` struct (positions, normals, uv, color, index). |
| `BoxGeometry`, `CylinderGeometry`, `PlaneGeometry`, `SphereGeometry`, `TorusGeometry`, `LatheGeometry`, `CircleGeometry`, `ConeGeometry`, `IcosahedronGeometry`, `RingGeometry`, `CapsuleGeometry`, `ExtrudeGeometry`+`Shape`, `ShapeGeometry`, `TubeGeometry`+`CatmullRomCurve3` | No need to port if the render geometry is exported (§5.3). Porting them by hand would mean reproducing Three's exact vertex order. `ModelIO` `MDLMesh` primitives do **not** match Three's triangulation. |
| `mergeGeometries`, `mergeVertices` (addons) | Done offline by the exporter, or a small Swift `GeometryMerge`. |
| `Mesh`, `Group`, `Object3D`, `InstancedMesh`, `InstancedBufferAttribute` | Own scene structs plus Metal instanced draws (`drawIndexedPrimitives(...instanceCount:)`). |
| `MeshStandardNodeMaterial`, `MeshBasicNodeMaterial`, `MeshStandardMaterial` + TSL node graphs (`positionWorld`, `normalWorld`, `mx_noise_float`, `mx_fractal_noise_float`, `hash`, `smoothstep`, `texture`, `time`, `cameraPosition`, `materialAO`, `diffuseColor`, `instancedBufferAttribute`, `attribute`, `transformNormalToView`) | Hand-written Metal Shading Language functions in an uber-PBR shader with per-material "surface programs" as function constants. Port the MaterialX noise (`mx_noise_float`, `mx_fractal_noise_float`) to MSL exactly (visual only, not cross-play). |
| `DataTexture`, `RGBAFormat`, `RepeatWrapping`, `ClampToEdgeWrapping`, `LinearFilter`, `LinearMipmapLinearFilter`, `SRGBColorSpace` | `MTLTexture` + `MTLSamplerDescriptor`. Procedural textures (wave slopes `harbor/water.ts:14-50`, grime noise `harbor/grime.ts`, shade bake) are computed on the CPU in Swift or a Metal compute kernel. |
| `CanvasTexture` + `document.createElement('canvas')` + `getContext('2d')`, `fillText`, `font` (`railyard/lettering.ts:42-56`, `headworks/decals.ts:108-132`, `harbor/signs.ts:44-76`, `boats.ts:31-44`, `posters.ts:68-276`, `sprays.ts:11-14`) | CoreGraphics `CGContext` + CoreText (`CTLineDraw`). Fonts named in CSS stacks ("Arial Narrow", Georgia, Helvetica Neue) exist on macOS. Simpler: export the rendered atlases as PNG from the browser (§5.3). |
| `PointLight`, `SpotLight`, `HemisphereLight` | Entries in a light list for the forward/clustered lighting pass. |
| `DoubleSide`, `BackSide`, `AdditiveBlending` | `MTLRenderPipelineDescriptor` cull mode and blend state. |
| `GLTFLoader` (through `core/assets`: barrels, crates, benches, propane) | `ModelIO` `MDLAsset` does not read glTF (USD/OBJ/Alembic only). Use **GLTFKit2**, or convert `.glb` to `.usdz` offline with Reality Converter / `usdzconvert`. |
| Equirect HDR (`hdri-*`) via `assets.hdri` | Load `.hdr` with `ImageIO` (`CGImageSource` reads Radiance HDR) or pre-convert to `.exr` / KTX2 cubemaps. Prefiltering for IBL is done in a Metal compute pass. |
| `three-mesh-bvh` `MeshBVH` (`raycastFirst`, `shapecast`, `ExtendedTriangle.closestPointToSegment`, `getNormal`) | Hand-written Swift BVH (SAH or centre split, leaf size 8) with Möller–Trumbore raycast and segment–triangle closest point. Metal ray tracing (`MTLAccelerationStructure`) suits visual ray queries but **not** gameplay, which needs CPU results the same frame. Embree is not available on Apple Silicon without a port. |
| `performance.now()` (`harbor/shade.ts:88-89`, time-budgeted shade bake) | `ContinuousClock` / `DispatchTime`. Better: run the bake on a background `Task`, or ship it precomputed in the package. |
| `import()` lazy map modules (`registry.ts:18-23`) | Map packages loaded from the app bundle by id. |

---

## 4. Cross-play-critical behaviour

The netcode is shooter-authoritative: each machine simulates its own player
against its own `CollisionWorld`, sends poses and shot results, and only uses
the world locally for impact marks, footstep surfaces, grenade copies and spawn
checks (`net/match.ts:537-542`, `net/remote-soldier.ts:259`). The collision
world is therefore **not** lockstep, but it must be the **same geometry** on both
machines. If it differs, one player walks through, stands on or shoots through
something the other sees as solid, grenades bounce differently, and duel spawn
checks disagree.

### 4.1 Map selection and RNG seeding

- Map id travels in the match config: `net/events.ts:20,148` (regex `events.ts:103`). The native client must ship packages for exactly `railyard`, `harbor`, `headworks` (and `range` for dev) and reject unknown ids the same way (`net/session.ts:191,431`).
- Seed: `seededRandom(hashString(config.mapId))` (`game/game.ts:214`).
- `hashString` is FNV-1a 32-bit over **UTF-16 code units** (`core/random.ts:14-21`): `0x811c9dc5`, `Math.imul(h, 0x01000193)`, `>>> 0`. In Swift: iterate `mapId.utf16`, use `&*` on `UInt32`.
- `seededRandom` is mulberry32 (`core/random.ts:2-11`): `state += 0x6d2b79f5`; `t = imul(t ^ t>>>15, t|1)`; `t ^= t + imul(t ^ t>>>7, t|61)`; returns `((t ^ t>>>14) >>> 0) / 2^32`. In Swift: `UInt32` with `&+`, `&*`, `>>`, and `Double(x) / 4294967296.0`. This is bit-exact and easy to port. Golden-vector tests are required.
- Local fixed-seed streams in harbor (§2.2) use the same function.

Exporting the collision soup means the native client never re-runs the RNG for
collision. The RNG port is still needed for any procedural visuals generated
natively, and as a check: hash the exported soup and compare.

### 4.2 Collision constants and behaviour (`world/collision.ts`)

| What | Value / location |
|---|---|
| Surface enum order (stored as a byte per vertex) | `collision.ts:16-31`, mirrors `types.ts:4-18`. The order is part of the package format. |
| Sub-step cap | `MAX_STEP_FRACTION = 0.5` (`:34`), `MAX_SUBSTEPS = 6` (`:35`), `steps = min(6, max(1, ceil(travel / (radius*0.5))))` (`:165`). |
| Ground threshold | `GROUND_NORMAL_Y = 0.55` (`:37`), applied to the push direction (`:188`). |
| BVH | `targetLeafSize: 8` (`:99`, `:114`). Default split strategy is CENTER. Leaf size only affects speed; results are order-dependent only in the capsule solver (below). |
| Raycast | Double-sided, `raycastFirst(ray, DoubleSide, 0, max)` (`:123`). Normal flipped to face the shooter (`:127`). |
| Line of sight | Shortened by 0.02 m (`:143`); `< 1e-4` distance counts as visible (`:141`). Ignores boundary. |
| Ground height | Default `maxDrop = 50` (`:146`); ignores boundary. |
| Capsule | Segment from `y+r` to `y+max(r, h-r)` (`:171-172`). Each triangle closer than `r` pushes the segment by `r - d` along `(capPoint - triPoint)`, or the face normal when degenerate (`:182-190`). Velocity loses its into-surface component (`:192-193`). Main BVH first, then boundary (`:197-198`). Ground surface probe: ray from `y+r` down `r+0.4` (`:206-209`). |
| Capsule fit | Lifted 0.05 m (`:217`), strict `< radius` (`:227`), checks both BVHs (`:229`). |
| Surface lookup | First vertex of the face via the BVH-reordered index (`:232-235`). Default `'concrete'`. |

**Ordering hazard.** The capsule solver resolves each penetrating triangle
*immediately* and moves the segment before testing the next one
(`collision.ts:189-190`). The final position therefore depends on the order in
which `three-mesh-bvh` visits triangles, which follows its tree layout
(CENTER split, leaf size 8, its own traversal order). A Swift BVH with a
different layout gives slightly different results at corners with several
contacts. Movement is not lockstep, so this only shows up as a feel difference.
It is not a desync. For exact parity, the exporter can also serialise the
`MeshBVH` (it supports `MeshBVH.serialize`) so Swift walks the same tree in the
same order. Recommended for v1: walk the serialized tree.

### 4.3 Detail density changes harbor collision (existing bug, blocks parity)

`detailDensity` is a per-player graphics setting: presets 0.35 / 0.6 / 0.85 / 1
(`core/settings.ts:93,107,121,135`) and a slider (`ui/screens/settings.ts:140`).
It goes into `MapBuildContext` (`game.ts:213`). The kits say "only decoration
without colliders may depend on it" (`railyard/kit.ts:34`). Railyard follows that
rule. **Harbor does not**:

- `harbor/props.ts:168-169` `keep()` trims lists by `min(1, density + 0.15)`. Then `keep(BARREL_CLUSTERS, 4)` (`:201`) registers a collider per barrel (`:210`), and `keep(POT_HEAPS, 4)` (`:237`) registers one per heap (`:247`). At the low preset that is 4 of 6 barrel clusters and 4 of 7 pot heaps; at high it is all of them.
- `harbor/clutter.ts:138-139,163-174`: `keep(NET_HEAPS, 5)` (5 of 9 at low), each with a `'foliage'` collider sized by `random()`.
- `harbor/dressing.ts:61`: `count = 12 + round(34 * density)` draws from the shared stream. Every random-sized collider registered after `addDressing` (`harbor/index.ts:83`) then gets different numbers: fish-box stacks `clutter.ts:68-82`, pallet stacks `scatter.ts:273-275`, sack piles `scatter.ts:133-140`, bucket rows `scatter.ts:206-218`.
- The `keep()` trims also change how many draws are taken, which shifts the stream further.

So two **web** players on different presets already get different harbor
collision today. A native client can only match one of them. Fixes, all in web
code (out of scope for this task, where `src/` is read-only):

1. Make harbor follow the railyard rule: draw from the stream first, then skip (`railyard/dressing.ts:183-185`), and never gate a collider on density.
2. Or give visual-only scatter its own seeded stream (as `street-life.ts:73` already does) and register colliders from full lists.
3. Then the exporter bakes collision at any density and gets the same bytes. Until then, export at `detailDensity = 1` and treat that as canonical.

Headworks is safe: all colliders are registered from the plan before any random
draw (`headworks/index.ts:38`). The density-scaled counts in `headworks/ground.ts:160` and `tanks.ts:88` are visual only.

### 4.4 Spawns

- Order matters: duel picks from `[...playerSpawns, ...enemySpawns]`, the host takes index 0, and the guest takes `pickDuelSpawn` (farthest from the opponent; `net/session.ts:591-598`, `net/rules.ts:13-17`). Co-op guest takes `playerSpawns[1]`, or steps ±1.6 m sideways from `[0]` using `capsuleFits` (`session.ts:601-614`).
- Units differ by map: railyard and headworks store yaw in **degrees** and convert with `DEG` (`railyard/index.ts:25-31`, `headworks/index.ts:20-26`), with y fixed at `SPAWN_LIFT = 0.05`. Harbor stores **radians** and explicit y (`harbor/layout.ts:71-91`, `LOW = 0.05`, `FACE_WEST = π/2`). The exported package must hold the final values (radians, metres).
- Spawn tables: `railyard/plan.ts:186-218`, `harbor/layout.ts:81-100`, `headworks/plan.ts:265-288` (enemy[0] is the point-mirror of player[0], `:278-279`).

### 4.5 Bounds, interiors and other gameplay metadata

- Bounds: `railyard/plan.ts:54`, `harbor/layout.ts:62`, `headworks/plan.ts:92`. Bots and the 0.6 m nav grid derive from them (host side).
- Interiors (reverb, `skyLight`): `railyard/index.ts:101-104`, `harbor/index.ts:117-122` (`INTERIOR_BOXES`, skyLight 0.32), `headworks/index.ts:75-79`.
- Boundary triangles (block bodies, not bullets): `railyard/kit.ts:132-135`, `harbor/kit.ts:186-193`, `headworks/colliders.ts:102` (handrails).
- `CollisionWorld.bounds` is the box of all non-boundary triangles (`collision.ts:101-102`). The player respawn-on-fall uses it (`player/controller.ts:244-245`).

### 4.6 Floating point

Build maths runs in JS float64 (`Math.sin/cos/atan2`, `Matrix4.compose`), and
`bakePositions` stores Float32 (`collision.ts:245-258`). Darwin libm and V8 can
differ by 1 ulp in `sin`/`cos`, which can flip a float32 rounding. This is the
main reason to **export** triangles rather than regenerate them natively.

### 4.7 Map versioning

`PROTOCOL_VERSION = 4` (`net/wire.ts:3`) does not cover map content. The web
maps keep changing (recent commits: "map glitch pass on Railyard, Harbor and
Headworks"). Recommend adding a `mapHash` (SHA-256 of the exported collision
blob) to the match config, so a native client with a stale package refuses
the match instead of playing on different geometry. This is a web protocol change.

---

## 5. Proposed Swift module layout

### 5.1 Shared map package (the cross-play contract)

A new exporter, written **outside** `src/`, e.g. `tools/map-export/` run with
Vitest or Playwright against the real web build. It calls each `MapModule.build()`
with a recording `World` and `detailDensity: 1`, then writes:

```
MapPackages/<id>/
  meta.json        id, name, tagline, bounds, spawns {player, enemy} (radians),
                   weather, reverb, interiors[], ambience[], lighting (LightingSetup, colours as hex),
                   surfaceTable (ordered list), sourceCommit, collisionSha256
  collision.bin    header + Float32 xyz triangles + UInt8 surface per triangle
  boundary.bin     Float32 xyz triangles
  bvh.bin          optional: MeshBVH.serialize() output for traversal-order parity
  render/          per-material merged meshes (glTF or a custom .ivmesh), instanced sets
                   with per-instance matrices and colours, light list,
                   baked canvas atlases (PNG), baked harbor shade map (PNG)
```

Both clients could load `meta.json`. The web client keeps its code path, and
the exporter runs in CI so a web map change regenerates packages and fails CI if
the hash changed without the native package being updated.

### 5.2 Swift modules

| Module | Key types | Notes |
|---|---|---|
| `IronvaleCore` (shared) | `SeededRandom` (mulberry32), `fnv1a32(_:)` | Golden tests against JS output. |
| `IronvaleWorld` | `enum Surface: UInt8` (fixed order), `struct RayHit`, `struct CapsuleMoveResult`, `protocol CollisionQuerying`, `final class CollisionWorld: Sendable` (`raycast`, `lineOfSight`, `groundHeight`, `moveCapsule`, `capsuleFits`, `bounds`), `struct TriangleBVH` (flat node array, leaf 8, optional loader for serialized `MeshBVH`), `ClosestPoint.segmentTriangle` | Pure Swift + simd, no Metal. Immutable after build, so safe across actors. Port `three-mesh-bvh`'s `closestPointToSegment` exactly. |
| `IronvaleMapData` | `struct MapPackage: Decodable`, `MapMeta`, `SpawnPoint`, `LightingSetup`, `FogSetup`, `InteriorZone`, `AmbienceLayer`, `Weather`, `ReverbPreset`, `MapRegistry` (`playable: [MapEntry]` in menu order: railyard, harbor, headworks) | Validates `collisionSha256` on load. |
| `IronvaleMapRender` | `MapScene` (static batches, instanced sets, lights), `MaterialLibrary` (one MSL surface program per web material), `SkyDome`, `ProceduralTextures` (wave map, grime noise, shade bake), `TextAtlas` (CoreText) | Metal 4. Sun shadow cascades, IBL from HDRI. |
| `IronvaleMaps` | `protocol MapRuntime { func update(dt:elapsed:viewer:) }`, `RailyardRuntime` (lamp flicker, beacons: `railyard/index.ts:105-108`), `HarborRuntime` (boat bob `boats.ts:260-264`, water time, interior lamps, shade bake), `HeadworksRuntime` (none) | Small hand ports of each map's `update`. |
| `MapExportTool` (TS, in `tools/`) | Recording `World`, scene serializer | Not Swift. Lives outside `src/`. |

### 5.3 Render half

- **Geometry**: export, don't re-author. After `kit.finish()` / `batch.build()`, the scene graph holds roughly one merged mesh per material plus a handful of `InstancedMesh`es. Serialising it is mechanical (GLTFExporter supports `EXT_mesh_gpu_instancing`, or write a custom flat format).
- **Materials**: about 22 TSL files hold per-map surface logic (puddles and wet sheen in `railyard/ground.ts`, container run-off in `container-paint.ts`, grime and shade in `harbor/grime.ts`/`shade.ts`, water in `harbor/water.ts`, board-formed concrete in `headworks/surfaces.ts`). Each needs an MSL port and a visual comparison. This is the bulk of the work.
- **Canvas textures**: render them in the browser during export and save PNGs. That avoids font and layout differences between Canvas 2D and CoreText.
- **Harbor shade bake**: raycasts against the collision world over `SHADE_GRID` (`harbor/shade-grid.ts`, `shade.ts:88-89`). It is deterministic, so bake it once at export.

---

## 6. Risks, unknowns, effort

### Risks

1. **Harbor collision depends on graphics detail (§4.3).** This is a real parity bug among web clients today. Cross-play on harbor cannot be exact until the web side is fixed. High.
2. **Map drift.** The web maps keep changing. Without an exporter in CI and a `mapHash` in the handshake, native packages go stale quietly. High.
3. **Capsule solver order dependence (§4.2).** Different feel at corners unless the BVH traversal order is reproduced. Medium. Mitigation: load the serialized `MeshBVH`.
4. **TSL → MSL volume.** Visual parity across 22 node-graph files plus `render/materials.ts`. Medium-high effort, low cross-play risk.
5. **glTF in Swift.** ModelIO does not read glTF. Use GLTFKit2 or convert offline. Low.
6. **HDRI rotation conventions.** `hdriRotation` assumes Three's equirect mapping and "rotating by r moves azimuth a to a − r" (`railyard/lighting.ts:31`). Easy to get mirrored. Low-medium.
7. **Unknown**: whether `three-mesh-bvh` reorders the index in place (it does by default; `collision.ts:100` reads the index after the BVH build). Store a surface byte per triangle in the package to avoid the question.
8. **Unknown**: exact triangle counts per map (not measured here). The exporter should report them. The BVH is expected to be well under 1M triangles, which is fine for a CPU BVH.

### Difficulty and estimate

| Work item | Days |
|---|---|
| Exporter (recording `World`, meta/collision/boundary/BVH writer, CI hash check), run in a real browser | 5 |
| `IronvaleCore` RNG/hash + golden tests | 0.5 |
| `IronvaleWorld` BVH, raycast, LOS, ground height, capsule move/fit + parity tests against JS fixtures (port `tests/world/collision.test.ts`) | 5 |
| `IronvaleMapData` package loader + registry | 1.5 |
| Render geometry export + Metal static/instanced loading | 4 |
| Material/shader ports: railyard (~6 days), harbor (~8, incl. water, grime, glow, shade), headworks (~5) | 19 |
| Sky/backdrop, lights, IBL rotation, procedural textures, map runtimes (flicker, boats, water) | 4 |
| Visual comparison pass per map at three window sizes | 3 |
| **Total** | **~42 days** |

Difficulty: **High** overall. Gameplay-relevant parts (collision, spawns,
metadata) are **Medium** once exported. The visual half is large but mechanical.
The harbor detail-density bug is a web-side prerequisite, not a porting task.

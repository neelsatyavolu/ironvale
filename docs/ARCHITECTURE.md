# Ironvale architecture

Ironvale is a small first-person shooter with realistic rendering and sound. It
runs in the browser (Three.js r187, WebGPU with an automatic WebGL2 fallback).
Single-player against bots,
plus a two-player peer-to-peer mode.

Visual target: `docs/reference/` holds frames from the reference video. The look
comes from a low sun with volumetric shafts, wet reflective ground, restrained
bloom, a detailed gun and gloved arms in view, and a minimal HUD.

## Layout

| Path | Owner | Purpose |
| --- | --- | --- |
| `src/core/` | core | settings, input, asset loader, events, seeded random |
| `src/render/` | core | `Engine` (renderer, sun, frame loop), post pipeline, material helpers |
| `src/world/` | core | collision world (BVH), shared map and surface types, geometry helpers |
| `src/game/` | core | `contracts.ts` (all shared interfaces), `Game`, combat registry, hit volumes |
| `src/player/` | core | first-person body and camera |
| `src/weapons/` | weapons | weapon data, ballistics, the player's weapon handling and view model |
| `src/weapons/models/` | gun models | one module per gun, plus first-person arms |
| `src/audio/` | audio | spatial audio engine |
| `src/fx/` | effects | muzzle flash, tracers, impacts, decals, casings, weather |
| `src/ai/` | bots | navigation, perception, behaviour, difficulty |
| `src/characters/` | characters | third-person soldier body |
| `src/ui/` | interface | menus, settings screens, HUD |
| `src/maps/<id>/` | one per map | level geometry, lighting, spawns |
| `src/net/` | network | two-player sync |
| `assets/*.json` | everyone | asset manifests, one file per owner |
| `tests/` | everyone | vitest unit tests, mirrored by area: `tests/<area>/*.test.ts` |

Work only inside the paths you own. Core files are read-only for everyone
else. If a contract is missing something you need, do not edit it: build
against what exists, and list the change you want in your final report.

## Rules that keep parallel work compatible

- Import Three from `three/webgpu` and shader nodes from `three/tsl`. Never
  from `three` directly, and never use `ShaderMaterial`, `onBeforeCompile` or
  GLSL strings: they do not run on WebGPU. Use node materials
  (`MeshStandardNodeMaterial`, `SpriteNodeMaterial`, ...) and TSL.
- Units are metres, seconds, radians. Y is up. Yaw 0 looks down -Z.
- Subsystems talk through `GameContext` and the event bus (`GameEvents` in
  `src/game/contracts.ts`). Audio and effects subscribe to events; gameplay
  code emits events and never calls audio or effects for gunfire, impacts or
  footsteps.
- Grenades follow the same split. `ctx.weapons.grenade` is the one in the
  player's hand (count, aiming, where a throw would start), `ctx.grenades`
  flies the thrown ones and applies the blast, and the pure maths both use
  (and the preview arc) is `src/weapons/grenade-math.ts`. Effects and audio
  react to `grenadeThrown`, `grenadeBounced` and `grenadeExploded`.
- Each subsystem's `index.ts` exports the factory that `src/game/game.ts`
  already imports (`createAudio`, `createEffects`, `createBots`,
  `createBallistics`, `createPlayerWeapons`, `weaponAssets`, `createInterface`).
  Keep those names and signatures. Systems must not touch other systems in
  their constructor; `ctx.audio`, `ctx.ballistics` and `ctx.map` are ready by
  the time `enterMap` or `update` runs.
- No per-frame allocation in hot paths: reuse vectors, pool particles and
  sounds. The frame budget is 16.6 ms on a MacBook and bots, effects and audio
  share about 4 ms of it.
- Everything visible must respect the quality settings in
  `settings.value.graphics` (`detailDensity`, `particleDensity`, tier). Read
  settings live; do not cache them at construction.
- Shadows: set `castShadow` and `receiveShadow` on meshes that need them. One
  sun shadow map covers about 55 m around the player. Extra lights do not cast
  shadows.
- Immutable data for settings, snapshots and definitions (`readonly` fields,
  spread to change). Per-frame simulation state (vectors, particles) may be
  mutated in place.
- No `console.log`. Use `console.warn` or `console.error` for real problems.
- Files stay under 400 lines where practical; split by concern.
- Prose in the interface and docs is plain and direct.

## Assets

All downloaded assets are CC0 or CC-BY, listed in a manifest under `assets/`,
and fetched to `public/assets/dl/` by `npm run assets` (git-ignored). Add your
own manifest file (`assets/sounds.json`, `assets/map-harbor.json`, ...) with
this shape:

```json
{ "assets": [ {
  "id": "pbr-cobble-01", "kind": "pbr", "license": "CC0",
  "source": "https://polyhaven.com/a/...", "credit": "only for CC-BY",
  "files": {
    "color@1k": { "url": "https://...", "path": "pbr/cobble_01/diff_1k.jpg" },
    "normal@1k": { "url": "https://...", "path": "pbr/cobble_01/nor_gl_1k.jpg" },
    "arm@1k": { "url": "https://...", "path": "pbr/cobble_01/arm_1k.jpg" }
  } } ] }
```

Kinds and file roles: `hdri` (`hdr@1k`, `hdr@2k`), `pbr` (`color`, `normal`,
`arm` or `rough` + `ao`, each `@1k` and `@2k`), `texture` (`color`), `model`
(`gltf`, plus any other keys for the `.bin` and textures it references, stored
beside it), `sound` (`audio`). Ids are unique across all manifests; prefix them
by kind and owner (`snd-`, `pbr-`, `hdri-`, `mdl-`). Verified sources are in
`docs/research/*.json`. Normal maps must be the OpenGL (`nor_gl`) variant.

Files that need processing before use (sliced and normalised audio, converted
or compressed models) are committed under `public/assets/local/` and listed
with `{ "path": "sounds/m4a1-shot-1.mp3", "local": true }` and no `url`. Keep
the script that produced them under `scripts/` so the result is reproducible,
keep raw downloads in a git-ignored `.cache/` folder, and keep processed files
small. Every CC-BY entry needs a `credit` line with the title, author,
licence and source address; the Credits screen (`src/ui/credits-model.ts`) is
built from the manifests. After changing a manifest run
`node scripts/credits.mjs` to rewrite `CREDITS.md`; a test fails if it is stale.

Load with `ctx.assets.preload(ids)`, then read with `assets.pbr(id)`,
`assets.hdri(id)`, `assets.model(id)`, `assets.sound(id)` (an `ArrayBuffer`).
`pbrMaterial(assets.pbr(id), options)` in `src/render/materials.ts` builds a
standard material and supports `wetness` for rain-soaked surfaces.
`tiledBox` and `tiledGround` in `src/world/geometry.ts` make geometry whose
UVs keep texel density constant.

Keep the total download reasonable: 1k textures on the low and medium tiers,
2k on high and ultra, compressed audio (ogg or mp3) rather than wav where the
source offers it.

## Running and checking your work

A dev server is already running at `http://127.0.0.1:5311` with hot reload. Do
not start another one and do not stop it.

- `npm run typecheck` must pass for the files you own. Other agents are
  editing in parallel, so ignore errors that are only in paths you do not own
  and never edit those files to silence them.
- `npm test` runs vitest. Put pure logic (ballistics maths, navigation,
  state machines, falloff curves) under test; write the test first.
- `npm run assets` downloads anything new in the manifests.
- `npm run shot -- --out <name> --params "<query>" [--wait ms] [--size WxH]`
  renders a real frame on the GPU through headless Chrome and writes
  `shots/<name>.png`. It prints page errors and warnings: fix every one that
  comes from your code. Look at the image with the Read tool and compare it
  with the reference frames. Use a name prefixed with your area.
  - In game: `--params "map=range&bots=0&pose=x,y,z,yawDeg,pitchDeg"` starts a
    match with no menu and puts the camera there (y is feet height).
    `&q=low|medium|high|ultra` picks a quality tier and
    `&no=ssr,ao,godrays,bloom,aa,grain,shadows` switches effects off.
  - Model viewer: add a `something.view.ts` file next to your code that
    default-exports a `Viewable` (see `src/dev/viewer.ts`), then
    `--params "view=weapons/models/m4a1&yaw=35&pitch=15&dist=1.2"`.
- `window.__ironvale.game` is the `Game` instance in the page, for scripted
  checks through Playwright if you need one. Do not use the shared Playwright
  or Chrome DevTools MCP browsers; other agents are using the machine. Write a
  small script under `scripts/dev/<area>-*.mjs` modelled on `scripts/shot.mjs`
  instead.

Do not commit, and do not run `git` commands that change the tree. The lead
integrates and commits.

## Frame order

`Game.frame` runs, in order: player body, player weapons, bots, effects, map
update, match rules, then audio, then input end-of-frame. The engine then
updates the sun shadow and draws.

## Post pipeline

Scene pass with MRT (colour, normals, metal/rough, velocity), GTAO, screen-space
reflections, sun light shafts, TRAA, bloom, ACES tone mapping, FXAA on the low
tier, vignette and grain. Each stage is switched by the graphics settings and
the frame graph is rebuilt when they change. Transparent and additive effects
render in the scene pass; give them `depthWrite = false`.

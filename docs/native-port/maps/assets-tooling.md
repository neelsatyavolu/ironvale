# Porting map: assets and tooling

Scope: `public/assets/`, the manifests in `assets/*.json` (the source of truth for `public/assets`), `scripts/`, `vite.config.ts`, `tests/`, `CREDITS.md`.

Target: native macOS app, Swift 6.4 + Metal, cross-play with the web build. The web build keeps evolving, so the native app treats `assets/*.json` and `public/assets/local/**` as **upstream inputs**. It never forks them.

Nothing under `src/`, `signaling/`, `public/` or `tests/` is changed by this plan.

---

## 1. Purpose and structure

### 1.1 What this group does

This group has no runtime game logic. It does three jobs:

1. **Holds the shipped content.** That covers models, PBR texture sets, HDR skies, sounds, menu thumbnails and weapon picker art, plus the JSON manifests that name each file, its licence and its credit.
2. **Builds that content offline.** Node scripts download the sources (Poly Haven, Sketchfab via the Objaverse mirror, Freesound, OpenGameArt). They also process the guns and the soldier with gltf-transform, sharp and meshoptimizer, and synthesise or cut the audio with ffmpeg.
3. **Holds the behavioural spec of the game in tests.** There are 889 vitest cases in 94 files. A large share of them encode rules that the native simulation has to reproduce to stay compatible.

### 1.2 Asset inventory (measured on disk, 2026-11-13)

`public/assets` is 246 MB on disk. Of that, 192 MB is referenced by a manifest. The other ~54 MB in `dl/` is orphaned (see 1.4).

| Dir | Tracked in git? | Files | Size | Content |
|---|---|---|---|---|
| `public/assets/local/sounds` | yes | 295 | 8.8 MB | MP3, 44.1 kHz, mono or stereo, CBR via libmp3lame (`scripts/audio/dsp-core.mjs:58-59`, `-write_xing 1`, no ID3) |
| `public/assets/local/guns` | yes | 7 | 7.2 MB | GLB: `arms.glb` (skinned, 56 nodes, 1 skin, 0 clips), `m24`, `m249`, `m4a1`, `m7`, `mp5`, `scarh` (rigid, one node per moving part) |
| `public/assets/local/characters` | yes | 2 | 1.9 MB | `soldier.glb` (1 skinned mesh, 44 nodes, 9 clips: idle, walk, jog, run, crouchIdle, crouchWalk, crouchJog, death, deathFront), `carbine.glb` (third-person rifle) |
| `public/assets/weapons` | yes | 6 | 200 KB | WebP picker images, loaded by URL (`src/ui/hud/picker.ts:51`) |
| `public/assets/thumbs` | yes | 3 | 616 KB | JPG map thumbnails (`src/ui/screens/menu.ts:51`, `src/game/game.ts:182`) |
| `public/assets/dl/hdri` | **no** (`.gitignore`: `public/assets/dl`) | 18 | 102 MB | Radiance `.hdr` at 1k (~1.4 MB) and 2k (~5.5 MB), plus 8192×4096 tone-mapped sky JPGs (4–22 MB each) |
| `public/assets/dl/pbr` | no | 102 | 109 MB | JPG sets: `diff`, `nor_gl` (OpenGL-convention normals), `arm` (AO/rough/metal packed in R/G/B), each at 1k and some at 2k |
| `public/assets/dl/models` | no | 52 | 17 MB | Poly Haven `.gltf` + `.bin` + external JPG/PNG textures |

Manifest-referenced bytes by kind and tier:

| Kind | 1k tier | 2k tier | Tier-independent |
|---|---|---|---|
| hdri (`.hdr`) | 5.7 MB | 22.1 MB | — |
| hdri `sky` JPG (2k tier only, `src/core/assets.ts:170`) | — | 50.1 MB | — |
| pbr | 26.6 MB | 58.0 MB | — |
| model (glb/gltf/bin/textures) | — | — | 21.1 MB |
| sound | — | — | 8.6 MB |

Manifest entries by file:

| Manifest | Lines | Entries | Kinds | Licences |
|---|---|---|---|---|
| `assets/sounds.json` | 3558 | 295 | sound | 281 CC0, 14 CC-BY 4.0 |
| `assets/guns-c.json` | 69 | 5 | model (arms, m4a1, m249, m7, scarh) | CC-BY 4.0 |
| `assets/guns-a.json` | 17 | 1 | model (mp5) | CC-BY 4.0 |
| `assets/guns-b.json` | 12 | 1 | model (m24) | CC-BY 4.0 |
| `assets/characters.json` | 30 | 2 | model (soldier, carbine) | CC-BY 4.0 |
| `assets/map-harbor.json` | 296 | 11 | 1 hdri, 7 pbr, 3 model | CC0 |
| `assets/map-railyard.json` | 292 | 11 | 1 hdri, 6 pbr, 4 model | CC0 |
| `assets/map-headworks.json` | 120 | 4 | 1 hdri, 3 pbr | CC0 |
| `assets/manifest.json` | 55 | 2 | test hdri + concrete pbr (range map) | CC0 |

### 1.3 Compression and formats actually used

I parsed the JSON chunk of every glTF/GLB in the repo.

- **There is no Draco (`KHR_draco_mesh_compression`), no meshopt (`EXT_meshopt_compression`), no KTX2/Basis (`KHR_texture_basisu`) and no `KHR_mesh_quantization`.** The only extension in use is `EXT_texture_webp`. All GLBs in `local/` mark it as *required*, except `m7.glb`, which has no textures (9 flat-colour materials).
- The Poly Haven `.gltf` files use no extensions. They reference external `.bin` and JPG files, and PNG for alpha (fern, grass).
- meshoptimizer appears only offline, as `MeshoptSimplifier.simplify` in `scripts/process-soldier.mjs:780`. Nothing it produces needs a decoder.
- Textures: JPEG (Poly Haven), WebP inside GLBs (sharp, quality 80–94), PNG (2 alpha maps), Radiance RGBE `.hdr` (6 skies × 2 tiers).
- Audio: MP3 only. Loop points for 10+ ambience and loop files are in the generated `src/audio/sound-meta.json`, and each starts at `LOOP_ROLL = 0.3` s (`scripts/audio/dsp-synth.mjs:6`).

**Consequence for native:** the decoder surface is small. A conforming glTF 2.0 core reader, ImageIO (JPEG, PNG and WebP are all native on macOS 11+), a Radiance HDR reader, and AVFoundation/AudioToolbox for MP3 cover everything. No third-party decompression library is required.

### 1.4 Manifest/disk drift

62 files on disk are not in any manifest. They include `hdri/kiara_5_noon_*`, `hdri/kloofendal_misty_morning_*`, `models/fern_02`, `grass_medium_01` and `rock_moss_set_01`, the `pbr/forest_leaves_02`, `forrest_ground_01`, `mossy_rock`, `mossy_stone_wall`, `pine_bark`, `rocky_trail_02` and `weathered_brown_planks` sets, plus the 9 `thumbs/` and `weapons/` files, which are referenced by URL rather than through a manifest. The native bundle step must therefore be **manifest-driven** plus an explicit allowlist for `thumbs/` and `weapons/`. It must not copy the directory wholesale. Copying the directory would ship about 54 MB of dead data and assets that nothing credits.

### 1.5 Scripts (`scripts/`, about 13.4k lines)

| File(s) | Lines | Responsibility | Native relevance |
|---|---|---|---|
| `fetch-assets.mjs` | 75 | Merges `assets/*.json`, rejects duplicate ids (`:20`), downloads non-`local` files into `public/assets/dl` with 6-way concurrency and skip-if-present (`:35-53`) | **Reuse as is.** The Xcode build phase runs `npm run assets` first, or a Swift port of these 75 lines. |
| `credits.mjs` | 21 | Writes `CREDITS.md` through `src/ui/credits-model.ts`. Fails if a non-CC0 entry has no `credit` (`:15-19`) | Native Credits screen ports `credits-model.ts` (158 lines). See §4.4. |
| `build-site.mjs` | 17 | `vite build`, then moves `dist` to `out/play` beside `site/` | Not ported |
| `fetch-guns-b.mjs`, `process-arms.mjs`, `process-gun-*.mjs` (7 files), `process-gun-a-common.mjs`, `lib/guns-*.mjs` (6) | ~2,330 | Rebuild source GLBs into one node per moving part in "gun space" (metres, barrel −Z, +Y up, origin at the pistol grip, `process-gun-a-common.mjs:1-7`). Textures go to WebP via `textureCompress` | **Not ported.** Native consumes their committed output. The gun-space convention and the node names are the contract (§2.1). |
| `process-soldier.mjs` | 1068 | Atlases materials, retargets Quaternius clips onto the soldier rig, foot-locks, bakes `soldier.glb` and **generates `src/characters/clip-meta.ts`** | Not ported. Native must parse `clip-meta.ts` (generated TS) or keep it in step (§2.3). |
| `process-audio.mjs` + `audio/*` (14 files) | ~1,690 | Downloads recordings, applies recipes (cut, layer, synthesise), encodes MP3 at 44.1 kHz, **writes `assets/sounds.json`, `src/audio/sound-meta.json`, `docs/audio-report.md`**. `audio/verify-licences.mjs` (50) checks the sources. | Not ported. Native reads its outputs. |
| `shot.mjs` | 58 | Playwright screenshot of the dev server | Model for a native screenshot harness |
| `dev/*` (~100 files) | ~9,000 | Playwright probes: map checks, perf benches, AI, `net-*.mjs` two-browser duel/coop harness (`dev/net-lib.mjs:1-2`), `net-signal.mjs` signaling-worker conformance | **`net-duel.mjs`, `net-coop.mjs`, `net-signal.mjs` and `net-lib.mjs` are the template for a cross-play interop harness** (one browser plus one native peer). Everything else is web-only. |

### 1.6 `vite.config.ts` (8 lines)

- `base: './'` (`:4`). All runtime URLs are relative, and `import.meta.env.BASE_URL` prefixes the asset roots (`src/core/assets.ts:44-45`). Native equivalent: `Bundle.main.resourceURL` plus `assets/dl/` or `assets/local/`.
- `build.target: 'es2022'` and `chunkSizeWarningLimit` (`:5`): web only.
- `server.host 127.0.0.1` (`:6`). The dev harnesses expect port 5311 (`package.json` `dev` script). An interop harness needs the web peer on it.
- `test: { environment: 'node', include: ['tests/**/*.test.ts', 'src/**/*.test.ts'] }` (`:7`). Some tests live beside the code in `src/`, so the native test inventory must also scan `src/**/*.test.ts`.
- Vite-specific features used by `src/`: `import.meta.glob` with `eager: true` on `assets/*.json` (`src/core/assets.ts:51`, `src/weapons/view/registry.ts:16`) and on `../models/*.gun.ts` (plugin-style discovery, `registry.ts:11`). Native needs a build-time manifest merge, and an explicit registry instead of the globs.

### 1.7 Tests (`tests/`, 11,035 lines, 94 files, 889 cases)

| Area | Files / lines | Covers (src module) |
|---|---|---|
| `net/` | 13 / 1,363 | protocol, session, rules, limits, interp, clock, invite, invite-link, room (signaling), signaling, chat |
| `weapons/` (excluding models) | 11 / 2,165 | ballistics, machine, math, recoil, grenade-math, grenades, aim, assist, switching, loadout, view, grenade-hand |
| `weapons/models/` | 15 / 2,232 | Gun GLB geometry and layout, read through `@gltf-transform` (`guns-c-glb.ts`, `guns-b.fixture.ts`) |
| `ai/` | 13 / 1,363 | navgrid, pathfinder, perception, cover, spawn, roles, difficulty, botweapon, marksman, blackboard, water, simulation |
| `maps/` | 7 / 919 | railyard plan and seeds, harbor layout, headworks plan and fairness |
| `characters/` | 9 / 980 | retarget, IK, locomotion, death, reactions, pose, LOD, gun-hold |
| `audio/` | 5 / 463 | curves, layers, voices, variation, impulse |
| `fx/` | 5 / 369 | casing physics, tracer math, pool, roof mask, demo config |
| `ui/` | 11 / 612 | credits-model, damage, killfeed, minimap-model, keys, settings-model, format… |
| `core/`, `game/`, `world/`, `render/`, `platform/` | 5 / 462 | settings, hitbox, collision, dynamic resolution, pointer |

---

## 2. Interfaces

### 2.1 What other subsystems depend on in this group

**Manifest schema** (`src/core/assets.ts:6-33`):

```
AssetKind = 'hdri' | 'pbr' | 'model' | 'sound' | 'texture'
AssetFile  { url?, path, local? }        // local → public/assets/local, else public/assets/dl
AssetEntry { id, kind, license, source, credit?, files: Record<role, AssetFile> }
```

File roles are `hdr@1k|2k`, `sky`, `color|normal|arm|rough|ao@1k|2k`, `gltf`, `audio`. Any other key is a glTF side file that must sit beside the `.gltf` (`assets.ts:19-24`).

**Assets API** (`src/core/assets.ts:64-252`), used by 24 src files:

- `preload(ids, onProgress)` (`:98`): de-duplicated, parallel.
- `hdri(id)` (`:110`): equirect `DataTexture`, `EquirectangularReflectionMapping`. `sky(id)` (`:119`) is non-null only on the 2k tier.
- `pbr(id)` gives `{color (sRGB), normal, arm, roughness, ao}` (`:123`, maps from `:230-239`, `RepeatWrapping`, anisotropy from settings).
- `model(id)` returns a deep clone sharing geometry and materials (`:128`). `gltf(id)` returns the raw GLTF for skins and clips (`:132`).
- `sound(id)` (`:136`) returns the **raw MP3 `ArrayBuffer`**. Decoding happens in `src/audio/index.ts:252` through `decodeAudioData`.
- `texture(id)` (`:140`), `idsWithPrefix(prefix)` (`:94`; used by `src/audio/catalog.ts:89` to group `snd-*` takes by stripping a numeric suffix), `manifest` (`:85`, for credits), `has(id)` (`:89`).
- Tier selection with fallback: `role@tier`, then `role@otherTier`, then the bare `role` (`:242-245`).
- Sky downscale to `skyMaxWidth` (default 4096, `:81`, `:211-228`) through `createImageBitmap`.
- The error text points at `npm run assets` (`:158`).

**Consumers** (counts of `assets.*(` calls): map materials and sky (`maps/{harbor,railyard,headworks}/materials.ts`, `sky.ts`, `props.ts`), `characters/rig.ts` (soldier GLTF and clips), `weapons/models/*.gun.ts` and `arms.ts`, `audio/index.ts` and `catalog.ts`, `ui/screens/credits.ts`, `ai/manager.ts`, `game/game.ts:175` (constructs `Assets(graphics.textures, graphics.anisotropy, skyWidth)`).

**Content contracts** that native code must honour exactly:

- **Gun GLBs.** One node per moving part (trigger, bolt carrier, charging handle, magazine, belt cover…) in gun space (`process-gun-a-common.mjs:3-7`). Gun modules look nodes up by name. The node lists are pinned by `tests/weapons/models/{m4a1,m249,m7,scarh,m24,mp5}.test.ts`.
- **Soldier GLB.** The skeleton bone names, and the clip names listed in §1.2. `src/characters/clip-meta.ts` (generated, 1.7 KB) carries per-clip metadata that `characters/locomotion.ts` and `death.ts` use (tests `characters/death.test.ts`, `locomotion.test.ts`).
- **Sound ids.** The `snd-<group>-<n>` naming. Variation picks among numbered takes (`tests/audio/variation.test.ts:6-43`). `src/audio/sound-meta.json` loop points are in seconds.
- **`nor_gl`** normal maps use OpenGL +Y. Metal shaders must not flip green.
- **`arm`** packing: R = AO, G = roughness, B = metalness (`assets.ts:38`).

### 2.2 What this group depends on

- **Network, at build time:** `dl.polyhaven.org`, `huggingface.co/datasets/allenai/objaverse` (`fetch-guns-b.mjs:11`, `process-arms.mjs:16`), Freesound and OpenGameArt (`scripts/audio/sources.mjs`).
- **npm dev dependencies** (`package.json`): `@gltf-transform/*` 4.5, `sharp` 0.35, `meshoptimizer` (used by `process-soldier.mjs:24`, not listed in package.json), `playwright` 1.65, `vitest` 5.1, `vite` 8.3, `typescript` 7.0.
- **System:** `ffmpeg` at `/opt/homebrew/bin/ffmpeg` (`scripts/audio/dsp-core.mjs:7`).
- **`src/` imports from scripts:** `credits.mjs` imports `src/ui/credits-model.ts`, and `process-soldier.mjs` imports `src/characters/retarget.ts` (Node ≥ 22.18 type-stripping).

### 2.3 Generated files living in `src/` (watch these)

| File | Generator | Native handling |
|---|---|---|
| `src/audio/sound-meta.json` | `process-audio.mjs` | Copy into the bundle at build time and decode with `Codable` |
| `src/characters/clip-meta.ts` | `process-soldier.mjs` | Either a tiny build-time extractor (regex or `node -e 'import(...)'` to JSON), or a check that fails the build when its hash changes. Do not hand-port it. |
| `assets/sounds.json` | `process-audio.mjs` | Read at build time like the other manifests |
| `CREDITS.md` | `credits.mjs` | Native credits come from the manifests, not from this file |

---

## 3. Browser and Three.js APIs and their native equivalents

| Web API (where) | Native equivalent |
|---|---|
| `import.meta.glob('../../assets/*.json', {eager})` (`assets.ts:51`, `weapons/view/registry.ts:16`) | Build phase: merge `assets/*.json`, check unique ids (same rule as `fetch-assets.mjs:20`), and emit `Manifest.json` into Resources. At runtime, `JSONDecoder` into `[AssetEntry]`. |
| `import.meta.env.BASE_URL` + `assets/dl/`, `assets/local/` (`assets.ts:44-45`) | `Bundle.main.url(forResource:)` under a `Assets/{dl,local}` folder reference |
| `fetch(url).arrayBuffer()` for sounds (`assets.ts:202-204`) | `Data(contentsOf:)` or direct `AVAudioFile(forReading:)` |
| `THREE.TextureLoader` (JPEG, PNG) (`assets.ts:73`, `:233`) | `MTKTextureLoader` with `.SRGB` true for `color` and false for data maps, `.generateMipmaps`, `.textureStorageMode .private`. Better: offline-transcode to ASTC or BC7 with mips (§5.3). |
| `colorSpace = SRGBColorSpace / NoColorSpace` (`assets.ts:234`) | `MTLPixelFormat.*_sRGB` against linear formats |
| `wrapS/T = RepeatWrapping`, `anisotropy` (`assets.ts:235-237`) | `MTLSamplerDescriptor` with `.repeat` and `maxAnisotropy = settings` |
| `HDRLoader` (Radiance RGBE) (`assets.ts:3`, `:167`) | ImageIO may decode `.hdr` (`public.radiance`), **to verify on macOS 27**. Fallback: a ~120-line RGBE+RLE decoder to `rgba16Float`. Preferred: offline-convert to a prefiltered cubemap or a KTX/`.metaltexture` RGBA16F with mips. |
| `EquirectangularReflectionMapping` (`assets.ts:168`, `:174`) | Compute pass: equirect to cubemap, then GGX prefilter and irradiance SH (replaces Three's PMREM) |
| `createImageBitmap(..., resizeWidth, imageOrientation:'flipY')` (`assets.ts:216-221`) | `CGImageSourceCreateThumbnailAtIndex` with `kCGImageSourceThumbnailMaxPixelSize = 4096`, or do it offline. Mind the flip: Metal's texture origin is top-left. |
| `GLTFLoader` (+ WebP via the browser) (`assets.ts:2`, `:198`; `weapons/models/lib/guns-c-raw.view.ts:14`) | **Custom `GLTFReader`** (glTF 2.0 core: accessors, buffer views, nodes, meshes, skins, animations with LINEAR/STEP; images via ImageIO, which decodes WebP), or **GLTFKit2** (MIT). ModelIO cannot read glTF. |
| `GLTF.scene.clone(true)` (`assets.ts:129`) | Value-type `ModelInstance` that shares `MTLBuffer`s and materials, with per-instance transforms |
| `AnimationClip` and skinning (consumed in `characters/rig.ts`) | `AnimationClip { channels: [Channel(nodeIndex, path, times, values)] }`, CPU or compute-shader palette skinning |
| `AudioContext.decodeAudioData(mp3)` (`audio/index.ts:252`, `audio/graph.ts:56`) | `AVAudioFile` into `AVAudioPCMBuffer` at 44.1 kHz float32. Played through `AVAudioEngine` with `AVAudioPlayerNode` and `AVAudioEnvironmentNode` or a custom mixer (audio group). |
| `ConvolverNode` impulse generated with `seededRandom(hashString(preset))` (`audio/graph.ts:100`) | `AVAudioUnitReverb` will not match. A partitioned FFT convolver (vDSP) fed by the same generated impulse matches. Port `src/audio/impulse.ts` together with `core/random.ts`. |
| Google Fonts `<link>` (`src/ui/index.ts:30`, `:54`) | Bundle Newsreader, Geist and Geist Mono TTF/OTF (OFL) in Resources and register them with `ATSApplicationFontsPath` |
| `<img src=assets/weapons/*.webp>` and `assets/thumbs/*.jpg` | `NSImage(contentsOf:)` (WebP is supported by ImageIO) |
| vitest | Swift Testing (`import Testing`, `@Test`, `#expect`) in `IronvaleCoreTests` |
| Playwright harnesses | A native `--headless-bot`/`--script` launch mode plus Node driving the web peer, for interop |
| `@gltf-transform` in tests (`tests/weapons/models/guns-c-glb.ts`, `guns-b.fixture.ts`) | The same `GLTFReader` running in tests. Golden values come from running the TS tests (§4.5). |

---

## 4. Cross-play-critical behaviour

The assets themselves are **not** cross-play critical. Colliders are hand-placed boxes in map code (`src/maps/harbor/props.ts:189-347`, `src/maps/railyard/props.ts:29-58`, `:85-261`, `src/maps/harbor/boats.ts:256`), not derived from mesh geometry, and hitboxes are analytic (`tests/game/hitbox.test.ts:8-36`). Different texture or model decoders therefore cannot desync play.

What this group owns that **is** critical:

### 4.1 Asset ids are part of the wire and match contract

- Weapon ids (`'m24'`, `'m4a1'`…) are encoded in the binary player state, and decoding rejects unknown ids (`tests/net/protocol.test.ts:96-101`, weapon byte at `byteLength - 3`). Weapon availability in the native build must equal `WEAPON_IDS`, whether or not a model asset loads. Note that `weapons/view/registry.ts:35-37` already falls back to a primitive gun when assets are missing. That behaviour must not change the id set.
- `mapId` seeds the map RNG: `seededRandom(hashString(config.mapId))` (`src/game/game.ts:214`). Map ids (`harbor`, `railyard`, `headworks`, `range`) must be byte-identical strings.

### 4.2 RNG and hashing (`src/core/random.ts:1-21`)

- `seededRandom` is mulberry32 (`:2-11`). The port needs exact `UInt32` wrapping arithmetic: `&+`, `&*` (for `Math.imul`), `>>` on `UInt32`, and output `Double(x) / 4294967296`.
- `hashString` is FNV-1a over **UTF-16 code units** (`text.charCodeAt(i)`, `:16-17`). Swift must iterate `text.utf16`, not `.utf8` or `.unicodeScalars`.
- Seeds in use: `hashString(mapId)` (`game/game.ts:214`), `hashString('ironvale-bots')` (`ai/manager.ts:67`), `hashString(preset)` for reverb impulses (`audio/graph.ts:100`), plus fixed seeds for cosmetics (`fx/rain.ts:64`, `fx/textures.ts:294`, `fx/decal-sheet.ts:110`, `maps/harbor/*`).
- Tests that pin determinism: `tests/maps/railyard.test.ts:63-71` (same seed gives the same plan, and *solid* containers are seed-independent so colliders never move), `tests/weapons/math.test.ts:112` (`sampleCone` repeatable), `tests/weapons/recoil.test.ts` (`seededRandom(1)`, `(5)`).
- **Gotcha for the maps group:** `detailDensity` (a per-user graphics setting) is passed into `module.build` next to the shared `random` (`game/game.ts:212-214`; `maps/harbor/props.ts:157` destructures `random` and `density`). If density changes how many draws happen before a collider-bearing placement, two peers on different settings already diverge on web. The native port must copy the same call order exactly. Write a golden test: dump collider boxes per map, per density, from TS, and compare them in Swift.

### 4.3 Protocol constants pinned by tests

- `PROTOCOL_VERSION = 4` (`src/net/wire.ts:3`). A mismatch makes the session fail with `error: 'version'` (`tests/net/session.test.ts:65-66`).
- The binary player state is at most 40 bytes (`protocol.test.ts:76-77`), little-endian `Float32` position at offset 11 (`:91`), yaw wrapped and health clamped (`:80-84`), non-finite or out-of-map values rejected (`:88-92`).
- Bot snapshot: count byte at offset 11 must match the length (`:123-126`).
- Shot: a pellet count cap and a unit direction check (`:158-159`).
- Ping and pong layouts (`:166-169`).
- Fuzz rules: never throw, never return non-finite values (`:173-189`), and reject every truncation of a real message (`:193-196`).
- JSON events: unknown fields dropped (`:233-235`), `duelBot` defaults to `'none'` for older hosts (`:238-241`), name sanitising (`:244-246`, `tests/net/limits.test.ts:8-18`: 16 characters, markup and control characters stripped).
- Anti-cheat gates in `limits.test.ts:27-91`: maximum damage per hit (headshot at point blank), token bucket for hits and shots at the weapon RPM, pellets counted as one shot, bolt-action rate.
- Room codes: 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (`limits.test.ts:97`, `scripts/dev/net-signal.mjs:11`, `tests/net/room.test.ts:14`, `:60`).
- Duel bot ownership and teams (`tests/net/rules.test.ts:5-21`, `session.test.ts:73`).
- Clock sync uses the minimum round trip, error bounded by half the asymmetry (`tests/net/clock.test.ts:19-49`). Interpolation includes the respawn snap and the extrapolation cap (`tests/net/interp.test.ts:26-138`).
- Signaling message whitelist and ICE parsing: at most 6 TURN servers (`tests/net/signaling.test.ts:6-59`). Server-side admission is 404/409 (`room.test.ts:32-37`).

### 4.4 Credits (a licence obligation, not a protocol)

`tests/ui/credits-model.test.ts:72-88` checks that every CC-BY entry has a credit line with its source URL, that only CC0 and CC-BY 4.0 are allowed (`:77`), and that `CREDITS.md` matches the generator (`:88`). Native must render the same groups from the same manifests by porting `src/ui/credits-model.ts` (158 lines, no imports). Reuse the TS test expectations as Swift tests.

### 4.5 Tests worth porting to Swift, by priority

Port each as Swift Testing with **golden vectors exported from the TS implementation** (a small `node --experimental-strip-types` script that writes JSON fixtures into the native repo). Hand-transcribing literals invites drift.

| Priority | Tests | Why |
|---|---|---|
| P0, wire | `net/protocol.test.ts` (305), `net/session.test.ts` (79), `net/limits.test.ts` (134), `net/rules.test.ts` (27), `net/signaling.test.ts` (63), `net/invite.test.ts` (90), `net/invite-link.test.ts` (23), `net/chat.test.ts` (40), `net/clock.test.ts` (78), `net/interp.test.ts` (142) | A byte or rule mismatch breaks cross-play. Add a cross-encoder test: TS encodes, Swift decodes, and the reverse. |
| P0, determinism | `core/random` (no direct test; add one), `maps/railyard.test.ts:63-71`, `weapons/math.test.ts:72-118` (`sampleCone`) | Same seed, same output, bit for bit |
| P1, combat rules | `weapons/math.test.ts` (falloff, zones, RPM to interval), `weapons/ballistics.test.ts` (350: travel time beyond 80 m, near-miss 1.2 m, pellets), `weapons/machine.test.ts` (381: fire modes, buffering, reloads, bolt and belt), `weapons/recoil.test.ts`, `weapons/grenade-math.test.ts` (202: throw velocity, bounce, about 15 m level throw, blast falloff), `weapons/grenades.test.ts` (217: authority — remote grenades do no damage and detonate on message), `game/hitbox.test.ts`, `world/collision.test.ts`, `weapons/switching`, `weapons/loadout` | Peers compute their own hits and damage. Rules must agree or kills look wrong. |
| P1, maps | `maps/railyard.test.ts`, `maps/headworks.test.ts`, `maps/headworks-fairness.test.ts`, `maps/harbor*.test.ts` | Spawns, bounds and colliders must match |
| P1, AI | `ai/*` (host-run duel bot is simulated on the host and streamed to the guest: `rules.test.ts:21`) | Behaviour parity matters when the native peer is host. Exact replication is not required. |
| P2 | `audio/variation`, `audio/curves`, `audio/layers`, `audio/voices`, `characters/*`, `fx/*`, `ui/*`, `render/dynamic-resolution`, `core/settings` | Feel and UX parity only |
| Skip or adapt | `weapons/models/*` (2,232 lines of GLB geometry checks via gltf-transform) | Keep running them in TS. In Swift, add one smoke test per GLB that the reader produces the expected node names and triangle counts. |

---

## 5. Proposed Swift layout

```
IronvaleNative/
  Packages/
    IronvaleAssets/            (SwiftPM)
      Manifest.swift           AssetKind, AssetFile, AssetEntry (Codable), ManifestStore (merge, unique ids, tier pick: role@tier → role@other → role)
      AssetStore.swift         actor AssetStore: preload(ids:progress:), hdri/sky/pbr/model/gltf/sound/texture; mirrors src/core/assets.ts
      GLTF/GLTFReader.swift    GLB container + JSON; accessors, nodes, meshes, materials, skins, animations; ext allowlist = [EXT_texture_webp]
      GLTF/GLTFModel.swift     ModelAsset (shared MTLBuffers), ModelInstance (value type, per-instance transforms), SkinAsset, AnimationClip
      Textures/TextureLoader.swift  MTKTextureLoader + ImageIO; sRGB vs linear; sampler cache (repeat, aniso)
      Textures/RadianceHDR.swift    RGBE decoder → rgba16Float (fallback if ImageIO lacks .hdr)
      Textures/EnvironmentBaker.metal  equirect→cube, GGX prefilter, irradiance SH
      Audio/SoundBank.swift    MP3 → AVAudioPCMBuffer cache; SoundMeta (loops) from sound-meta.json
      Credits/CreditsModel.swift    port of src/ui/credits-model.ts
    IronvaleCore/              (owned by other groups; listed for tests)
      Random.swift             Mulberry32, fnv1aUTF16 — shared, bit-exact
    IronvaleCoreTests/
      Fixtures/*.json          golden vectors exported from TS
      NetProtocolTests.swift, RandomTests.swift, WeaponRulesTests.swift, MapPlanTests.swift, CreditsTests.swift, GLTFSmokeTests.swift
  Tools/
    bundle-assets.swift (or .mjs)  Xcode Run Script: npm run assets → copy manifest-referenced files + thumbs/weapons allowlist → optional ASTC/BC7 transcode → emit Manifest.json, SoundMeta.json, ClipMeta.json
    export-goldens.mjs        runs TS modules, writes Fixtures/*.json (read-only use of src/)
    interop/                  fork of scripts/dev/net-lib.mjs: one Chrome peer + one native peer
```

Key types:

- `struct AssetEntry: Codable, Sendable { id, kind, license, source, credit?, files: [String: AssetFile] }`
- `enum TextureTier: String { case k1 = "1k", k2 = "2k" }`
- `actor AssetStore { func preload(_ ids: [String], progress: (Int, Int, String) -> Void) async throws; func pbr(_ id: String) throws -> PBRMaps; ... }`
- `struct PBRMaps { color: MTLTexture; normal, arm, roughness, ao: MTLTexture? }`
- `final class ModelAsset: Sendable { nodes: [NodeDesc]; meshes: [MeshGPU]; skins: [SkinAsset]; clips: [String: AnimationClip] }`
- `struct ModelInstance { let asset: ModelAsset; var nodeTransforms: [simd_float4x4] }`
- `struct Mulberry32 { var state: UInt32; mutating func next() -> Double }`
- `func fnv1a(_ s: String) -> UInt32 // over s.utf16`

### 5.3 Offline transcode (optional, a performance win)

The web keeps JPG and WebP. Native can transcode at bundle time, which leaves `public/` untouched:

- PBR and model textures: ASTC 6×6 (sRGB for colour) or BC7 with a full mip chain. That cuts GPU memory roughly 4–6× and removes runtime JPEG decode stalls.
- HDR: prebake per-map cubemaps (RGBA16F) and SH coefficients.
- 8k sky JPGs: downscale to 4096 to match `skyMaxWidth` (`assets.ts:81`), and BC6H or ASTC-HDR if wanted.
- Sounds: keep MP3, or pre-decode to CAF (LPCM or AAC) to drop decode time and get sample-accurate loops.

The bundle must stay byte-for-byte unaffected for gameplay. Only visual and audio fidelity can change.

---

## 6. Risks, unknowns, effort

### 6.1 Licensing for redistribution in an app bundle

- **CC-BY 4.0** covers 9 model entries and 14 sound entries: `"249 single shot.wav"` by Baelphazoar ×2, and the YleArkisto cobblestone footsteps ×12. Redistribution inside an app bundle is allowed, provided the in-app Credits screen carries the full attribution, licence link, source link and change notes. The manifests already hold the change notes (`CREDITS.md` lines 9–17). The native app must ship the same Credits screen.
  - CC BY 4.0 §2(a)(5)(B) forbids applying "effective technological measures" that restrict the licensed rights. macOS Developer ID and Mac App Store binaries are not FairPlay-encrypted, so the risk is low, but someone should confirm before an App Store submission and record the decision.
  - The models came from the **Objaverse mirror** of Sketchfab (`fetch-guns-b.mjs:11`). The licence that counts is the one on the Sketchfab page, so re-verify that each page still says CC BY 4.0 before shipping a native binary. Keep the check in the bundle script.
- **CC0** covers Poly Haven (21 texture sets and skies, 7 models), 252 Freesound sounds, 13 Free Firearm Sound Library sounds, and 16 synthesised sounds. These carry no obligation. The thanks lines are kept.
- **Fonts (OFL 1.1).** Newsreader, Geist and Geist Mono are currently pulled from Google Fonts at runtime (`src/ui/index.ts:30`). Bundling them is allowed. The OFL text must ship alongside them, and the fonts must not be sold on their own.
- **Libraries (MIT).** three.js and three-mesh-bvh are credited today. If the native renderer ports Three's shader code (the PBR BRDF, tone mapping such as AgX or ACES, PMREM, shadow filtering), or ports three-mesh-bvh's BVH build and traversal, the MIT notices **must stay** in the native Credits. Otherwise drop them and credit whatever native dependencies are added, for example GLTFKit2 (MIT).
- `tests/ui/credits-model.test.ts:77` pins "only CC0 and CC-BY 4.0". Keep the same gate in the native bundle step.

### 6.2 Technical risks and unknowns

1. **`public/assets/dl` is git-ignored.** A native CI build needs network access to Poly Haven, or a cache. Pin by checksum, because Poly Haven can revise files and the manifests carry no hashes. Add SHA-256 to a native-side lock file. Changing the manifests themselves is a web-side decision.
2. **Generated TS consumed as data.** `src/characters/clip-meta.ts` is TypeScript, not JSON. Extracting it needs Node at native build time, or a fragile parse. Unknown: is the format stable? Mitigation: hash it and fail the build loudly when it changes.
3. **glTF reader correctness.** Skinning (inverse bind matrices, joint order), animation sampling (LINEAR and STEP, quaternion slerp) and the node hierarchy must match Three's GLTFLoader closely enough that gun-part pivots and IK targets (`tests/weapons/models/arms-ik.test.ts`, `characters/ik.test.ts`) behave the same. Visual only, but large surface. GLTFKit2 (MIT) could cut the work. Verify that it accepts *required* `EXT_texture_webp`.
4. **Radiance `.hdr` decode.** It is not confirmed that ImageIO on macOS 27 reads `.hdr`. The fallback is cheap (an RGBE decoder).
5. **MP3 gapless and loop points.** LAME encoder delay and padding (~1105 samples) are carried in the Xing/LAME header (`-write_xing 1`). Chrome, Safari and AVAudioFile may each trim differently. The loop points (`sound-meta.json`, starting at 0.3 s) were tuned against Chrome. Expect 25 ms offsets. Fix by pre-decoding to CAF with the delay stripped and checking against the loop-seam analysis in `scripts/audio/measure.mjs`.
6. **The Vite glob plugin model** (`weapons/view/registry.ts:11-24`) discovers guns by file name. Native needs an explicit registry that must be kept in step by hand when the web adds a gun. Add a build check that compares `WEAPON_IDS` against the native registry.
7. **Web evolution drift.** The web version keeps changing. Every test-derived golden fixture must be regenerated from TS in CI (`export-goldens.mjs`), so a rule change on web fails native tests instead of silently desyncing.
8. **Bundle size.** The 2k tier is about 192 MB raw, most of it the 50 MB of 8k sky JPGs and the 58 MB of 2k PBR. With ASTC and mips the GPU footprint drops, but disk size is similar. Consider on-demand resources, or shipping only the 2k tier on Apple silicon.
9. **Test harness for interop.** There is no existing harness that drives a non-browser peer. `scripts/dev/net-lib.mjs` assumes two Chrome pages. A new harness is needed: Playwright drives the web peer, and the native app runs with a CLI flag that auto-joins a room code.

### 6.3 Effort

| Work item | Days |
|---|---|
| Manifest model, tier selection, bundle-assets build phase (manifest-driven copy, allowlist, licence gate, checksums) | 2 |
| `GLTFReader` (static, skinned, animations, WebP via ImageIO) + GPU upload + instancing; or GLTFKit2 integration and adaptation | 4 (2 with GLTFKit2) |
| Textures: MTKTextureLoader path, samplers, sRGB/linear, sky downscale; RGBE decoder; environment bake compute shaders | 3 |
| Optional ASTC/BC7 and cubemap offline transcode | 2 |
| SoundBank (MP3 decode, loop metadata), CAF predecode and loop verification | 1.5 |
| Credits model port, OFL fonts bundled and registered | 1 |
| Golden-fixture exporter + P0 Swift tests (protocol, session, limits, rules, signaling, invite, clock, interp, random) | 4 |
| P1 Swift tests (weapons, ballistics, grenades, hitbox, collision, maps) via fixtures | 4 |
| Interop harness (web peer via Playwright + native peer CLI mode) | 3 |
| **Total** | **~22.5 days** (about 20.5 with GLTFKit2, about 20.5 without the optional transcode) |

**Difficulty: medium.** The decoding surface is unusually small: no Draco, meshopt or KTX2. The hard parts are keeping native in step with an evolving web build (generated metadata, glob-discovered modules, rule changes) and porting the tests faithfully through golden fixtures rather than by hand.

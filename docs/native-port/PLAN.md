# Ironvale native port: plan

Status: authoritative plan for the Swift 6.4 + Metal macOS client. Written at commit `cbe0add` from the seven subsystem maps in `docs/native-port/maps/`. Where a map and the code disagree, the code was checked and this document follows the code. Where two maps disagree, this document makes the call and says so (section 11).

## 1. Goals and non-goals

Goals

1. A native macOS app that plays every mode the web build plays (solo skirmish and survival, co-op against host-run bots, duel with or without a bot teammate) on Railyard, Harbor and Headworks.
2. Cross-play with the browser build, in both directions and in both host roles, over the existing Cloudflare relay and the existing peer protocol (`PROTOCOL_VERSION = 4`, `src/net/wire.ts:3`).
3. Better performance than the browser on the same Mac: a stable 120 fps on ProMotion displays at the High preset on an M2-class machine, and an uncapped mode.
4. Automatic detection of drift. The web build keeps changing, so every rule the native client must share with it is extracted from the TypeScript by a tool and checked in CI. Nothing that matters for cross-play is copied by hand.

Non-goals

- No Windows, Linux, iOS or iPadOS. Apple Silicon (arm64) only for 1.0; an Intel slice is not planned.
- No lockstep, no dedicated server, no new netcode. The native client speaks the web protocol as it is.
- The web build is not replaced. It stays the reference implementation. When the two differ, the web build is right and the native client is fixed.
- No reimplementation of the signaling Worker. The native app is a client of the deployed relay.
- No new gameplay features in the native client before 1.0.
- No port of the web's developer viewers and demos: `src/dev/viewer.ts` (`?view=`), `src/fx/demo.ts` / `demo-config.ts` (`?fxdemo=`), `src/weapons/models/*.view.ts` and `src/characters/soldier.view.ts`, `?webgl`, `?gputime`, `?shafts=`. The `?autostart&map&bots&pose`, `?q=` and `?no=` switches in `src/main.ts` *are* ported, as launch arguments (`--autostart --map --bots --pose --q --no`), because the parity captures in section 7 need the same poses and the same effects switched off on both sides.
- No edits under `src/`, `signaling/`, `public/` or `tests/` as part of the port. The few web-side changes this plan needs are listed in section 6.4 as separate decisions for the owner.

## 2. Repository layout

All native code lives under `native/`. Nothing in the existing web tree moves.

```
native/
  IronvaleKit/                 SwiftPM package; all game code lives here
    Package.swift
    Sources/
      IronvaleCore/            mulberry32, fnv1aUTF16, JS-number helpers, simd math, event bus, settings model
      IronvaleContract/        weapon/grenade/hitbox/difficulty/role/limit tables, loaded from Contract JSON
      IronvaleWire/            binary + JSON codecs, sanitisers, room codes, invite codes, rate gates
      IronvaleWorld/           CollisionWorld, BVH (reads serialized MeshBVH), Surface
      IronvaleMapData/         map package loader, MapMeta, spawns, registry, SHA-256 check
      IronvaleSim/             Combat, hitbox, GameEvent, MatchRules, PlayerController, weapons sim, grenades, Game
      IronvaleAI/              nav grid, pathfinding, cover, brain, squad, bot weapon, BotManager
      IronvaleNet/             PeerLink protocol, signaling client, ClockSync, SnapshotBuffer, MatchSync, NetSession
      IronvaleTransportWebRTC/ WebRTCPeerLink (the only target that links WebRTC)
      IronvaleAssets/          manifest, IVM model reader, textures, RGBE, sound bank, credits model
      IronvalePlatform/        input (GCMouse, NSEvent), pointer capture, lifecycle, key-code map
      IronvaleRender/          device, frame loop, scene lists, PBR, IBL, shadows, fog, post chain
      IronvaleMapRender/       map scenes, per-map surface programs, sky, map runtimes
      IronvaleCharacters/      pose/clip math, IK, gun hold, skinned soldier draw
      IronvaleViewModel/       first-person rig, gun view, arms IK, view-model pass
      IronvaleFX/              particles, tracers, decals, muzzle, casings, weather
      IronvaleAudio/           MixCore DSP, voice pool, convolver, HRTF lanes, event handlers
      IronvaleUI/              SwiftUI screens, Metal HUD, MSDF text
      ShaderTypes/             C target: structs shared between Swift and MSL
      ivpeer/                  executable: headless native net peer for interop tests
    Tests/                     one Swift Testing target per module, fed by Contract fixtures
  IronvaleApp/
    IronvaleApp.xcodeproj      one macOS app target; depends on the local IronvaleKit package
    App/                       @main, window, composition root (about 300 lines; everything else is in the package)
    Shaders/                   all .metal files, compiled by Xcode into default.metallib
    Resources/                 bundled fonts (OFL), Info.plist, entitlements
  Contract/                    generated, committed: JSON tables + golden fixtures + contract.lock
  MapPackages/                 generated, committed: per-map meta.json + collision/boundary/bvh binaries (render data is git-ignored, rebuilt)
  Tools/
    contract-export/           Node + tsx: imports src/ read-only, writes Contract/
    map-export/                Vite entry + Playwright: runs each map build() in Chrome, writes MapPackages/
    asset-bake/                Node: glTF/GLB/WebP/JPG/HDR/MP3 -> IVM models, PNG/ASTC, cubemaps, CAF
    interop/                   Node reference peer, Playwright web-vs-native harness, local relay launcher
  ci/                          scripts the CI workflow calls
```

Why shaders sit in the app target: `swift build` does not compile `.metal` sources, Xcode does. Keeping MSL in the app target means `swift build` and `swift test` stay fast and GPU-free, and the renderer receives an `MTLLibrary` from the app. Struct layouts shared with MSL live in the `ShaderTypes` C target so both sides use one definition.

Why one Xcode project with almost no code: project files merge badly when several agents work in parallel. All code goes into the package, where adding a file needs no project edit.

### Module dependency graph

```
IronvaleCore
 ├─ IronvaleContract
 │    └─ IronvaleWire
 ├─ IronvaleWorld
 │    └─ IronvaleMapData
 ├─ IronvalePlatform
 └─ IronvaleAssets (Metal, ImageIO, AVFoundation)

IronvaleSim      ← Core, Contract, World, MapData
IronvaleAI       ← Sim, World, Contract
IronvaleNet      ← Wire, Sim                     (PeerLink is a protocol; no WebRTC here)
IronvaleTransportWebRTC ← Net, WebRTC.xcframework
IronvaleRender   ← Core, Assets, ShaderTypes
IronvaleMapRender, IronvaleFX, IronvaleCharacters, IronvaleViewModel ← Render (+ Sim for state, MapData for scenes)
IronvaleAudio    ← Sim (events), Assets, World (occlusion rays)
IronvaleUI       ← Render, Sim, Net (lobby state), Assets, Platform
ivpeer           ← Net, TransportWebRTC, Sim, AI, MapData        (no Render, no Audio, no UI)
IronvaleApp      ← everything
```

Rules: nothing below `IronvaleRender` imports Metal. `IronvaleSim`, `IronvaleAI`, `IronvaleNet` and everything they depend on must build and test on a headless CI runner. That is what makes `ivpeer` possible.

## 3. Key technical decisions

### 3.1 Platform baseline

- Deployment target macOS 26, arm64 only. Swift 6 language mode with complete strict concurrency.
- Metal 3-style API (`MTLRenderCommandEncoder`, `MTLComputeCommandEncoder`) as the baseline. Metal 4 command structures are adopted later only where profiling shows a gain. MetalFX is used from day one (3.3).

### 3.2 Frame loop and threading

- A `CAMetalLayer` in an `NSView`, driven by `CAMetalDisplayLink` on the main run loop, with `preferredFrameRateRange` up to the display maximum (120 Hz on ProMotion). Triple buffering with a semaphore of 3.
- Uncapped mode (a setting): `displaySyncEnabled = false` and the loop runs on a dedicated high-priority thread. Default is display-linked VRR.
- One serial game loop on the main actor: input, network inbox, simulation, render encoding, in that order, once per frame. This keeps the single-threaded ordering the TypeScript relies on (stale-callback guards, `shotFired` before its `bulletTrace`s, deaths flushed at frame end).
- Variable timestep with `dt = min(dt, 0.05)` exactly as `src/render/engine.ts:23`. A fixed step is not adopted, because the peer's `WeaponGate` slack was tuned against the web's variable step.
- Off the main actor: map package load and BVH build, nav grid build (the `CollisionWorld` is immutable and `Sendable`), asset decoding, the audio render thread, and WebRTC/Network.framework callbacks, which are forwarded into an `AsyncStream` and drained by the game loop at frame start.
- Gameplay math in `SIMD3<Double>` to match JS float64; narrowed to `Float` only at the render boundary and where the wire uses float32.

### 3.3 Renderer

- Forward+ PBR renderer with a G-buffer side output, matching the web frame graph (`src/render/pipeline.ts`): one pass with 4 colour attachments (`rgba16Float` colour, `rgba8Unorm` normal, `rg8Unorm` metal/rough, `rg16Float` velocity) and `depth32Float` with reverse-Z. Transparent pipelines set `writeMask = []` on attachments 1 to 3 instead of the web's alpha-0 trick.
- Post: GTAO (compute, half res) → SSR (linear march first, as three's `SSRNode`) → shadow-map godrays + bilateral blur → bloom (mip chain) → ACES Filmic (three's fitted curve) → FXAA → vignette and grain. TRAA and dynamic resolution are replaced by **MetalFX Temporal**, with a jittered projection and the velocity attachment.
- Lighting matches three's `PhysicalLightingModel`: GGX/Smith/Schlick, Lambert diffuse, `DFGApprox` multi-scatter. IBL: equirect HDR → prefiltered cube mip chain + SH irradiance + BRDF LUT, baked offline by `asset-bake` per map, with a compute fallback at load. Sun: single 110 m texel-snapped PCF shadow, ported as is; cascades are out of scope.
- Fog: exp-squared with height falloff and sun tint, as `engine.ts:183-206`.
- All pipeline states are built at load from a permutation table and cached in an `MTLBinaryArchive`. The web's warm-up frames go away.

### 3.4 Shader strategy

There is no GLSL to port: every web shader is a TSL node graph. Each is rewritten by hand in MSL:

- One PBR uber-shader. Per-material surface logic (puddles, run-off, grime, board-formed concrete, water, holo reticle, team tint) becomes a "surface program" selected by function constants. One MSL file per web TSL file, named after it, with a header comment citing the source file and commit. This makes "web changed `railyard/ground.ts`, what do I update" a grep.
- MaterialX noise (`mx_noise_float`, `mx_fractal_noise_float`) is ported once into `Shaders/Noise.metal`. Visual parity only.
- About 12 FX shaders (particles, rings, tracers, rain, mist, decals, muzzle, casings, grenade arc) are small vertex-driven closed forms and translate directly.
- Canvas2D textures (lettering, signs, posters, decal and flash sheets) are not redrawn natively. `map-export` renders them in Chrome and saves PNGs.

### 3.5 Models and glTF

Decision: no runtime glTF loader. `Tools/asset-bake` converts every model offline into one native container, IVM (flat little-endian binary: vertex streams, indices, node tree, skins with inverse bind matrices, animation clips, material parameters, texture references). The Swift reader is a few hundred lines with no dependencies.

Reasons: the assets use only core glTF 2.0 plus a required `EXT_texture_webp`, and no Draco, meshopt, KTX2 or quantization (measured in the assets map); `@gltf-transform` is already a dev dependency; and the map-export tool already produces glTF for the level geometry, so one path covers guns, arms, soldier, Poly Haven props and map scenes. WebP textures are decoded at bake time; textures ship as ASTC 6x6 with mips (sRGB for colour), with a PNG fallback build flag. `src/characters/clip-meta.ts` and `src/audio/sound-meta.json` are converted to JSON by `contract-export`.

Not every model is a glTF file. Parts of the guns are built procedurally at runtime: the M24 scope, rings, bipod and furniture (`src/weapons/models/lib/m24-*`, Lathe and Extrude geometry), the optics in `guns-c-optic.ts`, and the fallback gun. `asset-bake` cannot see these. They are captured the same way as map geometry: a `gun-export` entry in `Tools/map-export` builds each `GunModule` (discovered through the same `import.meta.glob`) in Chrome after its GLB has loaded, and writes the finished `GunModel` scene graph (with its socket and anchor nodes) through `GLTFExporter`, which `asset-bake` then converts to IVM. This is what the weapons map recommends; porting Lathe and Extrude to Swift is not planned. The TSL materials on those parts are still hand-ported (3.4).

The asset bundle step is manifest-driven (`assets/*.json` plus an explicit allowlist for `thumbs/` and `weapons/`), never a directory copy, and it enforces the CC0 / CC-BY 4.0 licence gate and SHA-256 pins on the git-ignored `dl/` tree.

### 3.6 Collision and BVH

- `map-export` captures the exact collision triangle soup, per-triangle surface byte and boundary soup from each map's `build()`, plus `MeshBVH.serialize()` output for both BVHs.
- The Swift `TriangleBVH` reads the serialized `three-mesh-bvh` layout and walks it in the same order. This matters because the capsule solver resolves penetrations one triangle at a time (`world/collision.ts:189-190`), so results depend on visit order. Walking the same tree gives identical movement, not just similar movement.
- All constants are ported exactly: `MAX_STEP_FRACTION 0.5`, `MAX_SUBSTEPS 6`, `GROUND_NORMAL_Y 0.55`, ground probe `r + 0.4`, `capsuleFits` lift 0.05, LOS shortened 0.02 m, `groundHeight` default `maxDrop 50`, boundary blocks bodies but not rays.
- Metal ray tracing is not used for gameplay queries. They must return on the CPU in the same frame.

### 3.7 Maps

Gameplay data is exported, never regenerated. Each map package holds `meta.json` (bounds, spawns in radians and metres in the original order, interiors, lighting, weather, reverb, ambience, surface table, source commit), `collision.bin`, `boundary.bin`, `bvh.bin`, `collisionSha256`, and a git-ignored `render/` directory (merged per-material meshes as IVM, instance sets, light list, baked atlases, harbor shade map). The mulberry32 and FNV-1a ports exist for bots, impulse reverb and check tests, not to rebuild maps.

Harbor is exported at `detailDensity = 1` until the web fixes the density dependency (6.4, W1).

Detail density is a continuous user setting on the web (`graphics.detailDensity`, 0.35 / 0.6 / 0.85 / 1 by preset, any value in 0..1 allowed, `src/core/settings.ts:93-214`) and is passed into every map `build()` (`src/game/game.ts:213`). Render data is exported once, at density 1. `map-export` tags each instance in a scatter set with the draw it came from, and the native client thins visual-only instance sets at load by a seeded per-instance threshold against the setting. Collision never changes with the setting. This keeps the setting meaningful without exporting a package per density (open question Q3).

The `range` developer map (`src/maps/range/index.ts`) is exported too, as a fourth package. It is flat, cheap and trivially checkable, so it is the first map M2, M3 and M4 bring up, and a web dev build (`import.meta.env.DEV`) accepts `range` as a match map (`session.ts:245`), so layer 3 and 4 interop runs can use it. It is never shown in the native menu.

The list of maps a peer may choose is not versioned by `PROTOCOL_VERSION`. When the web adds a map, a web host can pick it and a native guest fails with the existing `unknown-map` error (`session.ts:431-434`). `contract-export` therefore writes `PLAYABLE_MAPS` (`src/maps/registry.ts:26-30`) into `Contract/maps.json`, and `map-export --check` fails when that list names a map with no package. The native lobby shows "this map needs an update" instead of a bare error.

### 3.8 Audio

Decision: a custom DSP core (`MixCore`) inside one `AVAudioSourceNode`, mirroring the Web Audio graph: 44 voices with biquad low-pass, gain and equal-power pan; sample-accurate start offsets for propagation delay; per-sample parameter ramps matching `setTargetAtTime`; two crossfading partitioned-FFT convolvers (Accelerate vDSP) fed by the seeded impulse generator; limiter and soft clip on the master.

Stock AVAudioEngine nodes cannot do sample-accurate starts, short time-constant automation or convolution, and the simpler player-node path clicks on voice steals. The render block is allocation-free and lock-free: state in `UnsafeMutablePointer` buffers owned by the render thread, commands over an SPSC ring.

Staging: equal-power panning and no convolution first (M8a), then convolution and HRTF (M8b). HRTF uses 8 lanes into an `AVAudioEnvironmentNode` (`.HRTFHQ`); it will not sound identical to Chrome's, which is accepted. Sounds are pre-decoded to CAF with encoder delay stripped by `asset-bake`, so loop points are exact.

### 3.9 UI and HUD

- Menus, settings, lobby, credits, first-run, pause, end and loading: SwiftUI in an `NSHostingView` above the Metal view, shown only when the game is not taking input. Visual design copies the web CSS so the two builds look like one product.
- In-match HUD: a Metal pass at the end of the frame with an MSDF text atlas of Geist and Geist Mono (built offline with msdf-atlas-gen). Reticle, damage arcs, minimap, health bars, kill feed, scope mask, death panel, perf readout.
- Chat input and weapon picker: SwiftUI overlays, only while open.
- Fonts (Newsreader, Geist, Geist Mono) are bundled with their OFL text.

### 3.10 Input

- Pointer capture: `CGAssociateMouseAndMouseCursorPosition(false)` plus `NSCursor.hide()`; released on Esc, focus loss and window miniaturise.
- Mouse deltas: `GCMouse.mouseInput.mouseMovedHandler` when the existing "raw input" setting is on, `NSEvent` deltas otherwise.
- Keys: `NSEvent.keyCode` mapped to the browser's `KeyboardEvent.code` strings, so bindings JSON is identical in both builds.
- Sensitivity keeps the web unit (degrees per 1000 px). Trackpad heuristics are retuned for `NSEvent` cadence, using `momentumPhase` and magnify events.

### 3.11 WebRTC

Decision: Google libwebrtc as a binary xcframework through the `stasel/WebRTC` SwiftPM package, pinned to an exact version.

Reasons: it is Chrome's own stack, so ICE, DTLS, SCTP and negotiated data channels behave the same as the web peer; it supports TURN over TLS on 443, which Cloudflare TURN offers and strict networks need; and `RTCDataBuffer(isBinary:)` gives the text/binary frame distinction the `events` channel depends on. The 20 to 30 MB binary cost is small next to the assets. libdatachannel is the fallback only if libwebrtc blocks something.

Signaling uses Network.framework (`NWConnection` + `NWProtocolWebSocket`) because it exposes 4xxx close codes and custom headers. The relay's `Origin` allowlist (`ALLOWED_ORIGINS=https://ironvale.n3el.dev`) is satisfied by sending that Origin header explicitly. This needs no relay change.

#### 3.11.1 Connection details the native client must reproduce

These were checked against `src/net/transport.ts`, `ice.ts`, `signaling.ts`, `invite.ts`, `session.ts` and `signaling/src/{index,room}.ts`. Each becomes a field in `Contract/protocol.json` or a fixture.

- **Data channels.** Two negotiated channels, created by both sides before the offer: `state` id 0, `ordered: false, maxRetransmits: 0`; `events` id 1, ordered and reliable. `open` fires only when both are open. The `events` channel carries JSON as text frames and shots as binary frames; `state` carries only binary.
- **Receive limits.** Messages over 8192 bytes (or 8192 UTF-16 units for text) are dropped silently by the web receiver (`transport.ts:16`). On the reliable channel a silent drop is a desync, so the native sender asserts every event is at most `MAX_EVENT_CHARS` (2048) and every binary frame at most 8192 bytes, and the native receiver applies the same drop.
- **Send back-pressure.** Skip a `state` send when `bufferedAmount > 16384`; refuse an event when `bufferedAmount > 1_000_000`.
- **ICE servers.** `stun:stun.cloudflare.com:3478` and `stun:stun.l.google.com:19302`, plus up to 6 extra servers from a build-time JSON setting (the web's `VITE_ICE_SERVERS`, validated by `parseIceServers`), plus the relay's `/ice` TURN list. `/ice` is fetched (3 s timeout) **before** signaling opens, by both roles (`session.ts:302-308`). Requests to `/health` and `/ice` carry the same `Origin` header as the WebSocket.
- **Room codes offered only when reachable.** The web offers the room method only after `GET /health` answers within 2.5 s, cached 10 s. Native does the same.
- **Relay limits that bind the native client.** Each socket gets a 40-message burst refilling at 4 per second; exceeding it closes the socket with 4008 (`room.ts:13-22`). Room joins **and** `/ice` share one limiter of 30 per minute per IP (`wrangler.jsonc`). Relayed messages are at most 16,384 bytes and must be `offer`, `answer` or `candidate`.
- **Candidate count.** Chrome hides host addresses behind mDNS and gathers few candidates; libwebrtc on a Mac with VPN (`utun*`), AirDrop (`awdl*`), bridge and IPv6 temporary addresses can gather many more, and trickled TURN UDP/TCP/TLS candidates multiply that. Too many trickled candidates trip the 4008 flood close, and too many in a non-trickle offer push a manual invite over `MAX_CODE_CHARS` (6000) or the 12,000-byte SDP limit. The native `RTCConfiguration` uses `continualGatheringPolicy = .gatherOnce`, excludes loopback, `utun`, `awdl`, `llw` and link-local addresses, and caps trickled candidates at 24 per attempt. Layer 3 asserts the native side sends at most 24 candidates and that every native invite code is under 6000 characters.
- **mDNS candidates from Chrome.** Chrome's host candidates arrive as `<uuid>.local`. If the libwebrtc build cannot resolve them, two players on one LAN connect through server-reflexive or TURN candidates instead of directly. That is acceptable but must be measured (layer 4 runs one LAN scenario and records the selected candidate pair).
- **Room signaling.** `wss://<relay>/room/<CODE>?role=host|guest`. The relay sends `{type:'room', peer}` on admission and `{type:'peer', joined}` when the other side arrives or leaves. A refused join is accepted and then closed with `4000 + HTTP status` (4404 no room, 4409 full or code taken, 4410 expired); 4000 is also "room expired by alarm", 4001 "host left", 4008 "flooding". Origin, bad-code and rate-limit refusals happen **before** the upgrade (HTTP 403, 400, 429), which a browser sees as 1006 and reports as `signal-unreachable`. Native maps HTTP 429 to `rate-limited` (a small, deliberate improvement) and everything else to the same errors as `closeError` in `signaling.ts`. A host that gets 4409 retries with a fresh code up to 4 attempts in total. Room codes are 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, drawn from `SecRandomCopyBytes`.
- **Signaling ends at connection.** Both sides close the signaling socket (code 1000) as soon as both channels open (`session.ts:360-363`). A socket left open would be closed by the room's 10-minute alarm.
- **Manual codes.** `IVH1.` (offer) or `IVG1.` (answer) + URL-safe base64 without padding of the raw-DEFLATE (`CompressionStream('deflate-raw')`, no zlib header) SDP. Native uses `Compression.framework` with `COMPRESSION_ZLIB`, which is raw DEFLATE. Whitespace in pasted codes is stripped; decoded SDP must start with `v=0` and be printable ASCII. Non-trickle offers wait up to 4 s for gathering. A manual-code guest does not fail fast on an ICE `failed` state before opening (`acceptOffer(sdp, patient: true)`).
- **Timers.** 25 s connect timeout after the answer is sent or applied; pings every 250 ms for the first 8, then every 1 s; `ClockSync` keeps the lowest-RTT offset of the last 10 samples and smooths RTT by 0.2; 5 s peer timeout counted only while the match is running and not frozen; at most 256 match events queued before `MatchSync` exists.
- **Lifecycle events.** The web sends `away` on `visibilitychange` and `bye{reason:'left'}` on `pagehide`. Native sends `away:true` when the window is miniaturised, fully occluded (`NSWindow.occlusionState`) or the app is hidden, `away:false` on return, and `bye` from `applicationWillTerminate` and on window close. Like a hidden browser tab, a hidden native window stops its frame loop and therefore stops sending state; the web peer's 5 s timeout then applies exactly as it does between two browsers.
- **Invite links.** A native host's share link is the web URL `https://ironvale.n3el.dev/?join=CODE` (`inviteLink` in `room-code.ts`), never `ironvale://`, so a web friend can open it. `roomCodeFrom` parsing (accepts a bare code or any text containing `?join=`, `&join=` or `#join=`) is ported and fixture-tested.
- **Relay URL.** The deployed relay is `wss://ironvale-signal.n3el.dev` (from `wrangler.jsonc` routes). Native reads it from `Info.plist`, overridable with `--signal URL` and `--ice-servers JSON` launch arguments for the local relay in 5.4.

### 3.12 Settings and persistence

`UserDefaults` stores the same JSON strings as the web's `localStorage` (`ironvale.settings.v1`, `ironvale.net.v1` for the player name, `ironvale.firstRun.v1` for the first-run screen), parsed by a port of `parseSettings`. Settings fixtures from the web tests check round-trips. Quality tier detection feeds `MTLDevice.name` into the same `tierForGpu` regex.

### 3.13 Distribution

Developer ID signed and notarized, with Sparkle for updates. The native client must follow web protocol bumps within days, which the Mac App Store review cycle cannot guarantee. A `ironvale://join?code=` URL scheme opens invites; a universal link for `https://ironvale.n3el.dev/?join=` is optional (W5).

## 4. Effort-shaping facts from the maps

- Bots are host-authoritative and the guest only renders proxies, so AI does not need to be deterministic across builds. It still ships in every client because a guest takes over the bots when the host leaves.
- Hits are shooter-authoritative and the shooter sends resolved trace end points, so no gameplay RNG has to match. Weapon stats, hitbox volumes, eye heights and the damage formula must match exactly, because the receiver caps damage and rate-gates shots with them.
- The only RNG that must be bit-exact is mulberry32 seeded with FNV-1a over UTF-16 code units. Because map collision is exported, even that is only needed for bots, reverb impulses and tests.

## 5. Cross-play contract

### 5.1 What is the contract

The contract is everything one peer reads from the other or computes and expects the other to agree with:

| Area | Source of truth | Native copy |
|---|---|---|
| Protocol version, wire ids, size limits | `src/net/wire.ts` | `Contract/protocol.json` |
| Binary layouts (state 37 B, bots 12+20n, shot 23+12n, ping 10, pong 18, LE) | `src/net/protocol.ts` | `IronvaleWire.BinaryCodec`, checked by golden bytes |
| JSON events and validators, `NetMatchConfig` | `src/net/events.ts` | `IronvaleWire.EventCodec`, checked by golden valid/invalid samples |
| Sanitisers, damage cap, token buckets, `WeaponGate` | `src/net/limits.ts` | `IronvaleWire`, checked by fixtures |
| `WEAPON_IDS` order (wire index) | `src/weapons/models/api.ts:5` | `Contract/weapons.json` |
| Weapon and grenade defs | `src/weapons/defs.ts`, `grenades.ts`, `grenade-math.ts` | `Contract/weapons.json` |
| Hitbox volumes, body and eye heights | `src/game/hitbox.ts`, `src/player/controller.ts`, `src/net/remote-soldier.ts` | `Contract/bodies.json` |
| Difficulty and roles | `src/ai/difficulty.ts`, `src/ai/roles.ts` | `Contract/ai.json` |
| Duel, spawn and match rules | `src/net/rules.ts`, `session.ts`, `game.ts` | ported code, checked by fixtures |
| Map collision, spawns, bounds | each map's `build()` | `MapPackages/<id>/` |
| Signaling messages, close codes, room codes, invite codes | `src/net/signaling.ts`, `room-code.ts`, `invite.ts`, `signaling/src/room.ts` | `IronvaleNet` signaling client, checked by fixtures and interop |
| Data-channel setup, receive and back-pressure limits, ICE server list, manual-code format | `src/net/transport.ts`, `ice.ts`, `invite.ts` | `Contract/protocol.json` + 3.11.1, checked by fixtures and layer 3 |
| Relay limits (16 KB message, 40 burst / 4 per s, 10 min room, 30 joins per min per IP shared with `/ice`) | `signaling/src/room.ts`, `signaling/wrangler.jsonc` | `Contract/protocol.json`, checked by layer 3 against the unchanged relay code |
| Name and chat sanitisers (`\p{L}\p{N}` classes, UTF-16 slicing) | `src/net/limits.ts` | `IronvaleWire`, fixtures including non-BMP and combining characters |
| Map ids a peer may choose | `src/maps/registry.ts` `PLAYABLE_MAPS` (+ `range` in dev builds) | `Contract/maps.json` (3.7) |
| Timing (30 Hz state, 12 Hz bots, 100/170 ms delay, 250 ms extrapolation, 5 s timeout, 3 s countdown) | `match.ts`, `session.ts`, `interp.ts`, `proxies.ts` | `Contract/protocol.json` |

JS numeric semantics are part of the contract and live in `IronvaleCore.JS`: `jsRound` (halves toward +infinity, `floor(x + 0.5)`), truncated `%` via `fmod`, `wrapAngle`, `Math.imul` as `&*` on `UInt32`, string lengths as `.utf16.count`. The time base is a monotonic `Double` in milliseconds since app start, never epoch milliseconds (rejected above 1e12).

### 5.2 Shared data: extract, do not hand-copy, and do not move yet

Recommendation: the TypeScript stays the single source. `Tools/contract-export` imports the web modules read-only and writes canonical JSON into `native/Contract/`. The Swift client loads those tables as bundled resources at startup (they are small) rather than compiling generated Swift, so a data-only change needs no Swift code change. Map packages come from `Tools/map-export` the same way.

How the exporter runs: not plain `tsx`/Node. The web modules depend on Vite transforms: `import.meta.env` (`signaling.ts:86-87`, `ice.ts:57`, `session.ts:245`), `import.meta.glob` (gun discovery in `weapons/view/registry.ts:11`, asset manifests in `core/assets.ts:51`), and `three/webgpu`; some `*.view.ts` files read `location` at import time. The exporter and `Tools/interop/node-peer.mjs` therefore run under Vitest with their own config in `native/Tools/` that reuses the root Vite config's resolution (the same environment `tests/` already runs in), and import only non-view modules. `tsx` is not a dependency of the repository.

Moving the tables into shared JSON that the web also imports (for example `src/weapons/defs.json`) is not recommended now. It would touch the reference implementation for no gain while extraction already gives one source. Revisit only if extraction becomes fragile.

Drift guard, same repository, same pull request: CI runs `contract-export --check` and `map-export --check`. If regenerated output differs from what is committed in `native/Contract` or `native/MapPackages`, the PR fails with the diff. A web change that alters the contract therefore cannot merge without the native side being regenerated and its tests passing.

### 5.3 Versioning rules

1. `native/Contract/contract.lock` records `{protocolVersion, contractHash}`, where `contractHash` is SHA-256 of the canonical protocol, weapons, bodies and ai JSON. CI fails if `contractHash` changed and `PROTOCOL_VERSION` did not. In practice: any change to wire layouts, event fields that are removed or retyped, `WEAPON_IDS` order, or the cap-relevant weapon stats (`damage`, `headshotMultiplier`, `roundsPerMinute`, `pellets`) bumps `PROTOCOL_VERSION`. Adding an optional event field does not; unknown fields are dropped on both sides.
2. Native releases declare the single `PROTOCOL_VERSION` they speak. A mismatch ends in the existing `version` error; the native UI turns that into "update available" and Sparkle offers it.
3. Map content: each map package carries `collisionSha256`. Until W2 lands, a native client cannot tell when a web deploy changed a map, so map changes are caught at build time by `map-export --check` and shipped promptly. After W2 lands, the hash is exchanged in `loaded` and a mismatch refuses that one map instead of the whole protocol.

### 5.4 How compatibility is tested automatically

Four layers, cheapest first. Layers 1 to 3 run on every PR that touches `src/net`, `src/weapons`, `src/game`, `src/maps`, `src/world`, `src/ai`, `src/core/random.ts` or `native/`. Layer 4 runs nightly and gates milestones M5 onward.

1. **Golden fixtures (unit).** `contract-export` also runs the TS encoders, validators and pure functions and writes fixtures: golden bytes for every binary message including the truncation and fuzz cases from `tests/net/protocol.test.ts`; valid and invalid JSON for every event `t`; sanitiser inputs and outputs; token bucket and `WeaponGate` traces; mulberry32 and FNV-1a vectors; `damageAt` grids; grenade trajectories; `WeaponMachine` traces for scripted inputs; `PlayerController` positions over a scripted input stream on a box world and on each map; `pickDuelSpawn` cases; clock-sync and interpolation traces. Swift Testing consumes them. Tolerance: exact for bytes and integers, 1e-9 for float64 math, 1e-5 m for movement over collision.
2. **Reverse codec check.** A Swift test target writes everything it encodes to `Contract/out/swift-encoded.json`; `Tools/interop/verify-swift-encoded.mjs` decodes it with the real `src/net/protocol.ts` and `events.ts` and must reproduce the inputs. This catches encoder bugs that fixtures built from TS outputs cannot.
3. **Headless peer conformance.** A local relay runs from the unchanged `signaling/src` code with `wrangler dev`, using a test config at `native/Tools/interop/wrangler.interop.jsonc` whose `main` points at `../../../signaling/src/index.ts`. That config sets `ALLOWED_ORIGINS` to `http://localhost:5311,https://ironvale.n3el.dev` (the web dev page and the native client) and raises `JOIN_LIMITER` above the 30 per minute production limit, because a scenario suite from one address would otherwise be rate-limited; one dedicated scenario keeps the production limit and checks the native client reports `rate-limited`. The relay source is unchanged; only the binding values differ. `Tools/interop/node-peer.mjs` uses the web's `transport.ts`, `signaling.ts`, `protocol.ts` and `events.ts` over the `node-datachannel` RTCPeerConnection polyfill. `ivpeer` is the native counterpart. Scripted scenarios run in both host roles and with both the room and manual-code methods: connect, hello, lobby, ready, load, loaded, go, 10 s of 30 Hz state, shots that must all pass the peer's `WeaponGate`, hits under the cap, a death, a grenade, chat, away, bye. Each peer logs every accepted and rejected message as JSON; the test asserts zero rejections and matching event sequences.
4. **Full game, browser against native.** Built from `scripts/dev/net-lib.mjs` patterns: Playwright runs the real web build (Vite on port 5311, `?signal=` pointed at the local relay), and the native app runs with `--autojoin CODE --autopilot script.json`, an input script for deterministic movement and firing. Scenarios: duel on each map in both host roles, co-op with 8 bots in both host roles, host-leaves takeover, duel bot on each side. Assertions come from both sides' match logs: identical kill and death counts, final result, no rejected shots or hits, spawn choices equal to the TS rule. Screenshots are kept as artifacts.

## 6. Web-side requirements

### 6.1 None required to start

M0 to M5 and the Railyard and Headworks parts of M6 need no web change.

### 6.2 Process changes (no code under src/)

- CI workflow additions for 5.4 layers 1 to 3 and the nightly layer 4.
- The `PROTOCOL_VERSION` bump rule in 5.3, written into the repository's contributor notes.

### 6.3 Relay

None. The native client sends `Origin: https://ironvale.n3el.dev`. Adding `app://ironvale` to `ALLOWED_ORIGINS` is a cleaner option for the owner to choose later; it is a `wrangler.jsonc` variable, not code.

### 6.4 Minimal web code changes, in priority order (owner decisions, outside this port)

- **W1 (required before Harbor cross-play).** Harbor collision must not depend on `detailDensity`. Today `harbor/props.ts:168-247` and `harbor/clutter.ts:138-174` gate colliders on density, and `harbor/dressing.ts:61` shifts the shared RNG stream before later random-sized colliders. Web players on different presets already disagree about Harbor. Fix: draw from the stream first and decide visibility after, as `railyard/dressing.ts:183-185` does, or give visual-only scatter its own seeded stream. About a day of work, plus a web test asserting identical colliders at densities 0.35 and 1.
- **W2 (recommended before 1.0).** Add an optional `mapHash` (hex SHA-256 of the collision and boundary soups in canonical order) to the `loaded` event. Old peers drop the unknown field, so no version bump is needed. A host that sees a mismatch ends the load with a new `map-version` error. About 30 lines.
- **W3 (optional).** A `build` string in `hello` for diagnostics in the lobby.
- **W4 (optional).** `apple-app-site-association` on the web host so `?join=` links open the native app.

## 7. Milestones

Each milestone has one exit check that a script or test can verify. GPU timing and screenshot checks (M3, M7a, M8b, M9, M12) cannot run on hosted CI runners, which have no real Apple GPU; they run on a self-hosted Apple Silicon runner (M2-class or the owner's chosen reference Mac, see open question Q1) registered before M3, and their logs are uploaded as CI artifacts so "runs in CI" (section 10) still holds. Parity captures on both sides use the same launch switches: `?autostart&map=…&pose=…&q=high&no=grain,aa` on the web and the matching native arguments, Railyard captured with weather off, so animated grain, TRAA jitter and rain do not decide the score. "Parallel" lists what can run at the same time in separate agent lanes. Estimates are engineer-days.

| ID | Milestone | Depends on | Exit criterion | Days |
|---|---|---|---|---|
| M0 | Scaffolding | none | `swift build` and `swift test` pass in `native/IronvaleKit` with every module target stubbed; `xcodebuild -project native/IronvaleApp/IronvaleApp.xcodeproj -scheme Ironvale -destination 'platform=macOS,arch=arm64' build` succeeds; the app opens a window that clears through `CAMetalDisplayLink` and logs frame times; the CI workflow runs all three commands green. | 2 |
| M1 | Contract extraction and core codecs | M0 | `contract-export` writes all `Contract/*.json`; `contract-export --check` passes in CI; `IronvaleCore` (mulberry32, FNV-1a, JS helpers) and `IronvaleWire` (all binary and JSON codecs, sanitisers, gates, room and invite codecs) pass every fixture, including the golden bytes in the net map; the reverse codec check (5.4 layer 2) passes; the ported P0 net test cases pass. | 6 |
| M2 | Map export and collision | M0 | `map-export` produces packages for Range, Railyard, Headworks and Harbor (density 1), and the gun-export GLBs for all six guns, with stable SHA-256 across two runs; `IronvaleWorld` loads the serialized BVHs; on 10,000 recorded queries per map (raycast, LOS, groundHeight, moveCapsule over 120-step paths, capsuleFits) Swift matches TS: same hit or miss, same surface, positions within 1e-5 m; `tests/world/collision.test.ts` ported and passing. | 10 |
| M3 | Renderer bootstrap | M0, M2 (render export) | The app renders Railyard static geometry with the generic PBR shader, IBL, sun shadow, fog and ACES at 2560x1600 internal, at 120 fps or better at the 1 percent low on an M2-class Mac (frame-time log over a 60 s flythrough); screenshots at 5 fixed poses compared with the web's `?autostart&pose=` captures reach SSIM 0.85 or better (map-specific materials come in M9). | 12 |
| M4 | Offline playable sim | M1, M2, M3 | Solo on Range, Railyard and Headworks without bots: an `--autopilot` script walks, crouches, jumps, fires all six weapons, reloads, throws a grenade, dies and respawns, with a fallback gun model and a placeholder HUD, and the app's event log shows each of those GameEvents in order with no error; `PlayerController` scripted-input fixtures match within 1e-5 m on a box world and on each map; all ported weapons, grenade and hitbox test cases pass. | 12 |
| M5 | Net transport and lobby cross-play | M1 (code), M4 (for match start) | 5.4 layer 3 passes in CI for both host roles and both signaling methods through the local relay; a nightly scripted smoke test against the deployed relay (`ivpeer` host on the CI runner, Node reference peer as guest, room method) connects and exchanges 10 s of state, and a second run with ICE restricted to `turns:` candidates (`iceTransportPolicy = .relay`) also connects; the layer 3 candidate-count and invite-length assertions (3.11.1) pass. | 10 |
| M6 | Duel cross-play | M4, M5, M7a | 5.4 layer 4 duel scenario passes on Railyard and Headworks, native host and web host, to a 10-kill target, with zero rejected shots or hits and agreeing scores, 5 consecutive nightly runs. | 6 |
| M7a | Remote soldier visuals | M3 | The skinned soldier (IVM, GPU skinning, team tint, shadows, LOD) renders the remote player and bot proxies; pose, IK, locomotion, death and reactions test cases pass; 32 soldiers on screen cost under 2 ms GPU. | 8 |
| M7b | Bots and co-op cross-play | M4, M7a, M5 | Native solo skirmish with 8 bots on Railyard and Headworks; nav grid node counts and edge masks equal the TS fixture per map; 5.4 layer 4 co-op scenarios pass in both host roles, including host-leaves takeover and the duel bot on each side. | 14 |
| M8a | Audio core | M1, M4 | `MixCore` plays all GameEvent-driven sounds with equal-power pan, distance curves, delay and occlusion; for 20 scripted scenes, the per-voice parameter trace (sound id, start time including propagation delay, gain, pan, low-pass cutoff, occlusion) matches a trace that `contract-export` produces by driving the web `src/audio` handlers against a recording stub `AudioContext` (the pure modules `curves`, `layers`, `variation`, `voices` and `impulse` are already testable under Vitest, `tests/audio/`) within 1e-6 (the web cannot render these scenes offline without changes, so PCM comparison is not the gate; a Playwright capture of the web build with a listening comparison is kept as an artifact); no allocations on the render thread (malloc-hook test) and no overloads at a 128-frame buffer for 10 minutes. | 9 |
| M8b | Audio rooms and HRTF | M8a | Convolution reverb with crossfading slots and the seeded impulses (impulse fixtures match TS bit for bit); HRTF lanes; under 5 percent of one core during a 16-bot firefight. | 6 |
| M9 | Visual parity | M3, M7a | All map surface programs, sky and backdrops, the full post chain with MetalFX Temporal, all FX and the first-person view model with arms IK and reticle shaders are ported; per map, 5 poses reach SSIM 0.93 or better against web captures at the same preset; High preset holds 120 fps at the 1 percent low on an M2-class Mac at native resolution. | 40 |
| M10 | UI, HUD and settings | M4 (HUD), M5 (lobby) | Every screen and HUD element in the audio-ui inventory exists and is reachable by keyboard alone; settings JSON round-trips against the web settings fixtures; the credits model passes the ported credits test; the `ironvale://join` scheme and pasted `?join=` links both join a room; a native host's copied invite link is `https://ironvale.n3el.dev/?join=CODE` and opens the web lobby in a browser; the first-run, player-name and settings keys in 3.12 round-trip. | 22 |
| M11 | Harbor | M2, M9, W1 landed | Harbor exported at two densities gives identical collision bytes; Harbor added to the layer 4 duel and co-op scenarios, which pass 5 consecutive nightly runs. | 4 |
| M12 | Release | all | Notarized, Sparkle-updating build; all layer 4 scenarios green for 7 consecutive nights; the licence gate passes and the credits screen shows every CC-BY line; a 30-minute soak on each map shows no frame over 25 ms and no memory growth over 50 MB. | 6 |

### Parallel lanes

After M0, five lanes run at the same time with little contact:

- Lane A, contract and net: M1 → M5 → (M6, M7b network parts).
- Lane B, world and maps: M2 → M11 (and supports M4 movement).
- Lane C, renderer: M3 → M7a → M9 (the largest lane; M9 itself splits into four parallel sub-lanes: per-map materials, post chain, FX, view model).
- Lane D, audio: M8a → M8b, starting on fixtures from M1 and a stub event source before M4 lands.
- Lane E, UI: M10 SwiftUI screens start right after M0 against mock `LobbyState` and settings; the HUD joins after M4.

M4 is the convergence point of A, B and C. M6 and M7b are the first true cross-play gates. The critical path is M0 → M2 → M3 → M7a → M9 → M12, about 78 days with one engineer per lane.

## 8. Effort

The seven maps total about 251 days. Removing work counted more than once (RNG, glTF and asset loading, golden-test tooling, interop harness) and the glTF reader (replaced by the offline bake) leaves the milestone table in section 7 at about **167 engineer-days**. Adding about 25 percent for integration, parity tuning and harness upkeep gives **about 210 engineer-days**. With five parallel lanes, calendar time is about **16 to 18 weeks** to M12, bounded by Lane C.

Largest single items: visual parity (M9, 40 days), co-op bots (M7b, 14), renderer bootstrap and offline sim (12 each).

## 9. Top risks

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| 1 | Contract drift while the web keeps changing: weapon stats, `WEAPON_IDS`, event fields, map geometry | High / high | Extraction plus `--check` in CI on every PR (5.2); `contract.lock` forces `PROTOCOL_VERSION` bumps (5.3); Sparkle for fast native releases; nightly layer 4. |
| 2 | Harbor collision differs between web players today | Certain / high for Harbor | W1 before M11; until then Harbor cross-play is labelled experimental and the native build plays the density-1 collision. |
| 3 | Visual parity with three.js (PMREM, physical lighting, ACES, 22 TSL material files) takes longer than planned | High / medium | SSIM gates per milestone, one MSL file per TSL file, parity checklist tied to diffs in `pipeline.ts`, `engine.ts` and map material files. Visual mismatch never blocks cross-play. |
| 4 | Movement feel differs at corners (capsule solver order) | Medium / medium | Walk the serialized `MeshBVH` in the same order (3.6); M2 query fixtures. |
| 5 | Realtime audio under Swift 6 concurrency (allocation, locks, actors on the render thread) | Medium / medium | SPSC command ring, render-thread-owned buffers, malloc-hook test, staged M8a/M8b. |
| 6 | JS numeric edge cases (`Math.round`, `%`, UTF-16 lengths, epoch time) | Medium / high but cheap to catch | One `IronvaleCore.JS` module, fixtures that include halves, negatives and non-BMP text. |
| 7 | WebRTC interop details (text vs binary frames on `events`, negotiated ids, TURN) | Medium / high | libwebrtc for Chrome-identical behaviour; layer 3 tests assert zero dropped frames in both directions. |
| 8 | Unpinned `public/assets/dl` downloads change under the bake | Medium / low | SHA-256 lock file in `Tools/asset-bake`; CI caches the tree. |
| 9 | The relay's Origin rule or rate limits change on the web side | Low / high | Layer 3 runs against the real `signaling/` code; a nightly smoke test hits the deployed relay `/health` and `/ice` with the native client's headers. |
| 10 | CC-BY obligations in a distributed binary (Sketchfab-sourced models, DRM clause) | Low / medium | Licence gate in the bake, credits screen at M10, a recorded review before the first public release. |
| 11 | libwebrtc gathers far more ICE candidates than Chrome and trips the relay's 40-message flood close (4008) or the 6000-character manual code limit | Medium / high | Candidate filtering and a 24-candidate cap (3.11.1); layer 3 asserts the counts; one layer 4 scenario on a Mac with a VPN interface up. |
| 12 | A new web map or a web-only map in a dev build reaches a native guest | High over the port's life / low | `Contract/maps.json` and `map-export --check` (3.7); a clear "needs an update" message instead of a bare `unknown-map`. |
| 13 | GPU-bound exit checks have nowhere to run | Certain / medium | Self-hosted Apple Silicon runner before M3 (section 7). |

## 10. Working rules for agents on this port

- Never edit `src/`, `signaling/`, `public/` or `tests/`. Read them, import them from tools, and file web-side needs as W-items.
- Never hand-copy a constant that `contract-export` can extract. If it cannot extract something, extend the exporter.
- Every Swift file ported from TypeScript starts with a comment naming the source file and the commit it was ported from.
- A milestone is done only when its exit check runs in CI, not when it works locally.

## 11. Decisions where the maps disagreed

- glTF: the render map suggests ModelIO reads glTF and the world map says it does not; the assets map suggests a hand-written reader or GLTFKit2. Decision: neither at runtime. Offline bake to IVM (3.5).
- Module naming: the maps used `IV*`, `Ironvale*` and `IronvaleKit/IV*` prefixes. Decision: the single `Ironvale*` set in section 2. Weapons, player and game logic merge into `IronvaleSim` because they share one frame loop and one event bus.
- BVH: the world map offered either a fresh Swift BVH or the serialized `MeshBVH`. Decision: serialized `MeshBVH` from v1.
- Audio: the audio map offered a cheaper `AVAudioPlayerNode` path. Decision: the custom `MixCore` from the start, staged (3.8), because the cheap path clicks and would be thrown away.
- Shared data: the net map suggested moving tables into shared JSON as a later option. Decision: extraction only, no web change (5.2).
- TRAA and dynamic resolution: replaced by MetalFX Temporal rather than ported.

## 12. Critic notes

A completeness pass against the code at `cbe0add` (`src/net`, `signaling/src`, `src/maps/registry.ts`, `src/main.ts`, `src/core/settings.ts`, `src/weapons/models`, `src/audio`) changed this plan as follows.

Changes made
- Added 3.11.1, the connection details the plan left implicit: data-channel parameters, the 8192-byte silent receive drop, back-pressure limits, the STUN list and `/ice` fetch before signaling, the `/health` gate, the relay's close codes and the HTTP-level refusals that never reach a close code, the 4409 retry, raw-DEFLATE manual codes, timers, `away`/`bye` lifecycle mapping, the web-URL invite link, and the relay URL and launch overrides.
- Added the ICE candidate problem: libwebrtc on a Mac gathers many more candidates than Chrome, which can trip the relay's 40-burst flood close or overflow the 6000-character manual code. Filtering, a cap and layer 3 assertions added; risk 11.
- Added rows to the contract table for transport, relay limits, sanitisers and map ids.
- 3.7: the `range` developer map is exported and used for bring-up and interop; map ids are not covered by `PROTOCOL_VERSION`, so `PLAYABLE_MAPS` is exported and checked; detail density is a continuous setting the plan ignored, now handled by thinning visual instances.
- 3.5: procedural gun parts (M24 scope, optics, fallback gun) are not in any GLB; added a gun-export step through Chrome.
- 5.2: `contract-export` and the Node reference peer cannot run under plain `tsx`, because the web modules need Vite transforms (`import.meta.env`, `import.meta.glob`, `three/webgpu`); they now run under Vitest.
- 5.4 layer 3: the local relay needs a separate wrangler config with both origins and a higher join limit, otherwise the scenario suite rate-limits itself at 30 joins per minute (the limit is shared with `/ice`).
- Section 7: M5's manual check became a nightly scripted smoke test against the deployed relay, including a TURN-only run; GPU and screenshot checks get a self-hosted runner; parity captures use matching `?q=`/`?no=` switches and no weather; M4 is verified by an autopilot event log; M8a's "web captures" (which the web cannot produce offline) became a parameter trace from a stub `AudioContext`; M10 checks the share-link format and all three storage keys.
- 1: developer viewers and demos are named as non-goals; the `?autostart`, `?q=`, `?no=` switches are ported as launch arguments.
- 3.12: added the `ironvale.firstRun.v1` key.

Open questions for the owner
- Q1. Which Mac is the reference for the 120 fps gates, and can it be a self-hosted CI runner? Without one, the M3, M7a, M9 and M12 exit checks cannot run in CI.
- Q2. Origin: keep sending `Origin: https://ironvale.n3el.dev` from the native app, or add a native origin such as `app://ironvale` to `ALLOWED_ORIGINS` (a config change, 6.3)? Spoofing works but makes the native client indistinguishable from the site in relay logs and rate limits.
- Q3. Detail density: is per-instance thinning of a density-1 export acceptable, or must the native "Low" preset match the web's Low scene exactly? An exact match needs one render export per preset.
- Q4. Parity captures would be far more stable with a web switch that freezes the clock, water and lamp flicker (a small dev-only addition to `src/main.ts`, proposed as W5 if wanted). Without it, the SSIM targets in M3 and M9 may need lowering for Railyard and Harbor.
- Q5. Should the native client keep simulating and sending state while its window is hidden, so a web friend does not time it out after 5 s? The plan mirrors the web (a hidden tab stops too), which is the safe default.
- Q6. If the chosen libwebrtc build cannot resolve Chrome's `.local` mDNS candidates, LAN games between web and native go through STUN or TURN. Accept that, or budget work to enable mDNS resolution in a custom libwebrtc build?


## 13. Owner decisions (2026-11-13)

- Q1. The reference Mac is the owner's Apple M5 Max (64 GB, macOS 27.3). The repo has no CI yet. GPU timing and screenshot checks run locally through `native/ci/` scripts on that Mac, and every other check runs in `swift test`. Registering a self-hosted GitHub runner is deferred until the owner asks for it.
- Q2. Add a native origin (`app://ironvale`) to the relay's `ALLOWED_ORIGINS` instead of spoofing the site origin. This is W6, a one-line change in `signaling/` that is deployed with the owner's sign-off before M5. Until then, local layer 3 tests use the interop wrangler config, which allows both origins.
- Q3. Thinning one density-1 export per instance is accepted. The native Low preset does not need to match the web's Low scene exactly.
- Q4. Yes to W5, a dev-only web switch that freezes the clock, water and lamp flicker for parity captures. It lands with M3.
- Q5. A hidden native window keeps simulating and sending state, so web peers do not time it out after 5 s.
- Q6. Accepted. LAN games between web and native may go through STUN or TURN if libwebrtc cannot resolve `.local` candidates. No custom libwebrtc build.

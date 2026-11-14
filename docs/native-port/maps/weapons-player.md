# Porting map: weapons + player (`src/weapons`, `src/player`)

Scope: 64 files, 7,408 lines. Gameplay logic is 2,661 lines in `src/weapons/*.ts` plus 387 in `src/player/controller.ts`. The view model is 1,066 lines in `src/weapons/view/`. Gun and arms model builders are 3,294 lines in `src/weapons/models/`.

The native target is Swift 6 + Metal on macOS and must keep cross-play with the browser build. Nothing in this group runs a lockstep simulation. Hit registration is **shooter-authoritative**: the firing machine traces the shot, picks the zone, computes the damage and sends a `hit` event. The receiving machine only caps that damage and rate-limits it (`src/net/match.ts:567-610`, `src/net/limits.ts:30-95`). Because of this, cross-play needs **identical data and identical damage and hitbox formulas**, but it does not need bit-identical RNG or physics. The details are in section 4.

---

## 1. Purpose and structure

### 1a. Gameplay logic (port 1:1, pure Swift, no rendering)

| File | Lines | Responsibility |
|---|---:|---|
| `weapons/index.ts` | 27 | Facade: `createBallistics`, `createPlayerWeapons`, `weaponAssets`, re-exports `createGrenades`, `GRENADE_DEF`, `GRENADE_ID`, `buildGunModel`. |
| `weapons/defs.ts` | 203 | `WEAPON_DEFS`: the stat table for m4a1, mp5, m24, m249, m7 and scarh (damage, falloff, RPM, spread, recoil, mag and reserve, reload time, aim time and zoom, mobility). **Cross-play data.** |
| `weapons/models/api.ts` | 22 | `WEAPON_IDS` (ordered, and the order **is the wire index**), the `GunModule` and `BuildArms` contracts. |
| `weapons/loadout.ts` | 23 | `issuedWeapons(config)`: m7 and scarh only on veteran/elite, everything in duels. |
| `weapons/handling.ts` | 31 | Per-class lower/raise times, hip pose, sprint blend constants. |
| `weapons/math.ts` | 65 | `damageFalloff`, `zoneMultiplier`, `damageAt`, `shotInterval`, `sampleCone` (spread cone), `closestPointOnSegment`. **Hit-reg math.** |
| `weapons/ballistics.ts` | 178 | Shared hitscan for player and bots: cone sampling, `combat.raycast`, delayed landing beyond 80 m, near-miss whiz, casing events, damage application. |
| `weapons/machine.ts` | 231 | `WeaponMachine`: trigger, magazine and chamber state machine; fire-rate accounting; press buffer; action plans (reload/cycle/charge) advanced with marks. |
| `weapons/plans.ts` | 163 | Builds the reload, bolt-cycle and charge timelines (`ActionPlan` with fractional `Mark`s), cached per def. |
| `weapons/recoil.ts` | 126 | `RecoilModel` (kick per shot, heat climb, bloom, spread formula) and `ViewKickMirror` (predicts the view-kick delta for aim assist). |
| `weapons/aim.ts` | 128 | `AimState` (ADS blend, toggle latch) and `BreathSway` (scope sway and hold breath). |
| `weapons/assist.ts` | 220 | `AimAssist`: slowdown, pull and ADS snap toward visible enemies. |
| `weapons/steering.ts` | 129 | `ViewSteering`: separates the player's own look delta from recoil and assist, then applies sway and assist nudges. |
| `weapons/switching.ts` | 86 | `WeaponSwitch`: lower/raise state machine with reversible requests. |
| `weapons/intent.ts` | 98 | `IntentReader`: maps input actions or the scripted `DebugInput` to `WeaponIntent`. |
| `weapons/player-weapons.ts` | 405 | `PlayerWeaponsImpl`, the orchestrator. Runs intent → switch → grenade → sprint carry → ADS → stance → machine → recoil → steering → view rig. Implements `MachineSink` (fire, dryFire, stage, eject). |
| `weapons/grenades.ts` | 216 | `GRENADE_DEF` and `GrenadeSystem`: a pool of 4 flights, fixed 1/60 s step with accumulator, authoritative versus shown flights, blast damage. |
| `weapons/grenade-math.ts` | 189 | `GRENADE` constants, `throwVelocity`, `stepGrenade` (bounce/roll), `predictArc`, `blastDamage`, `blastDamageAt`, `blastShake`. |
| `weapons/grenade-throw.ts` | 74 | Throw origin and velocity from the camera, with a hand offset blocked by walls. |
| `weapons/grenade-hand.ts` | 69 | `GrenadeHand`: hold-to-aim, release-to-throw, `GRENADES_PER_MATCH = 1`. |
| `player/controller.ts` | 387 | `PlayerController`: look, recoil application and recovery, Quake-style ground/air acceleration plus friction, crouch, jump with coyote time, capsule move through `world.moveCapsule`, footsteps, regen, camera bob, landing dip, roll, FOV from zoom, `applyDamage`, death. |

### 1b. View model (rewrite on Metal; behaviour reference only)

| File | Lines | Responsibility |
|---|---:|---|
| `view/rig.ts` | 301 | `ViewRig`: gun and arms parented to the camera. Layered procedural pose (hip/ADS, bob, sway, sprint, lowered, reload, work, air drop, spring recoil), wall retraction, depth compression to a 54° view-model FOV via `root.scale.z` (rig.ts:51-52, 254, 266), `muzzleWorld`, `ejectionWorld`. |
| `view/gun-view.ts` | 116 | `GunView`: derives aim/hip holder poses from the model's `sight` anchor, barrel length, and hand targets. |
| `view/parts.ts` | 195 | `PartsAnimator`: bolt, slide, magazine, cover and trigger animation keyed to the machine's plan marks. |
| `view/poses.ts` | 53 | Pose offset tables (sprint, lowered, against wall, reload, work). |
| `view/motion.ts` | 55 | `clamp01`, `smoothstep`, `ramp`, `damp`, `Spring` (sub-stepped at 1/120 s). |
| `view/registry.ts` | 88 | `import.meta.glob` discovery of `models/*.gun.ts` and `arms.ts`; asset manifest gate; fallback. |
| `view/fallback.ts` | 258 | Primitive stand-in gun built from boxes and cylinders. |

### 1c. Models (asset pipeline and procedural parts)

| File(s) | Lines | Responsibility |
|---|---:|---|
| `models/{m4a1,mp5,m24,m249,m7,scarh}.gun.ts` | 306 | One `GunModule` per weapon: GLB id, layout, finishes, optics. |
| `models/arms.ts` | 270 | Skinned FP arms from `arms.glb` (`SkeletonUtils.clone`), two-bone IK per frame, fixed finger curls. |
| `models/materials.ts` | 57 | Shared TSL node materials (roughness broken up with `mx_noise_float`). |
| `models/lib/guns-a-*` | 345 | MP5 assembly from a processed GLB (`part_*` nodes, `anchor_*` empties). |
| `models/lib/guns-b-*` | 257 | M24 rig and magazine. |
| `models/lib/m24-*` | 901 | M24 scope, rings, bipod, furniture; procedural shapes (Lathe/Extrude); TSL materials. |
| `models/lib/guns-c-*` | 823 | M4A1/M249/M7/SCAR-H assembly, layouts, holo sight with a collimated reticle shader (`positionView`, `modelViewMatrix`), IK math, arm pose table. |
| `models/*.view.ts`, `lib/guns-c-raw.view.ts` | ~85 | Dev viewer pages. **Do not port.** |

Assets: `public/assets/local/guns/{m4a1,mp5,m24,m249,m7,scarh,arms}.glb` (448 KB to 1.9 MB each). All except `m7.glb` use `EXT_texture_webp`. `arms.glb` has one skin. The picker thumbnails are `public/assets/weapons/*.webp`. The manifests are `assets/guns-{a,b,c}.json`.

Tests: `tests/weapons/*.test.ts` has about 168 cases across machine, recoil, aim, assist, ballistics, math, grenades, switching, loadout and view, plus `tests/weapons/models/*`. These are the golden reference for the Swift port.

---

## 2. Interfaces

### Provided to other subsystems

| Consumer | Symbol | Where |
|---|---|---|
| `game/game.ts:19,126-128,250-260,327-335` | `createBallistics`, `createPlayerWeapons`, `createGrenades`, `issuedWeapons`, `weaponAssets`, `GRENADE_DEF`, plus `PlayerController` construction (`game.ts:115`) | Frame order: `player.update` → `weapons.update` → `player.setWeaponModifiers` → `grenades.update` → `bots.update` |
| `ai/bot.ts:5,121,287` | `WEAPON_DEFS` (scaled by `ai/difficulty.ts:161 scaledWeapon`), `ctx.ballistics.fire(..., spread)` | Bots fire through the same `Ballistics` |
| `net/match.ts:4-9` | `WEAPON_DEFS`, `GRENADES_PER_MATCH`, `GRENADE`, `GRENADE_DEF`, `closestPointOnSegment`, `WEAPON_IDS` | Validation and remote shot display |
| `net/protocol.ts:10`, `net/events.ts:8` | `WEAPON_IDS` (binary index and JSON enum) | Wire |
| `net/remote-soldier.ts:4` | `WeaponId` | |
| `fx/grenade-arc.ts:2`, `fx/grenade.ts:3` | `GRENADE`, `predictArc`, `blastShake` | Preview arc, blast shake |
| `ui/hud/picker.ts` | `RESERVED_NOTE`, loadout | Weapon picker |
| `ctx.player` (everyone) | `PlayerBody` (`contracts.ts:299-318`): `position`, `velocity`, `yaw`, `pitch`, `eyePosition`, `hitTest`, `applyDamage`, `crouching`, `sprinting`, `speed`, `onGround`, `indoors`, `lookYaw/lookPitch`, `addRecoil`, `nudgeView`, `respawn` | |
| `PlayerWeapons` (`contracts.ts:227-255`) | `current`, `loadout`, `aimBlend`, `zoom`, `scopedIn`, `spread`, `breath`, `blocksSprint`, `grenade`, `equip`, `issue`, `carries`, `resupply`, `restockGrenades`, `warmUp`, `update` | HUD, net state (`match.ts:257-262` sends `aiming = aimBlend > 0.5` and `reloading`) |

**Events emitted** (`GameEvents`, `contracts.ts:322+`): `shotFired`, `bulletTrace`, `bulletImpact`, `combatantHit`, `nearMiss`, `casingEjected`, `dryFire`, `weaponAction`, `weaponSwitch`, `aimChanged`, `grenadeThrown`, `grenadeBounced`, `grenadeExploded`, `playerHurt`, `died`, `spawned`, `jumped`, `landed`, `footstep`. The net layer builds its shot message from `shotFired` followed by N `bulletTrace` events, in that order (`match.ts:319-345`). **This ordering is load-bearing.**

### Consumed

- `GameContext` (`contracts.ts:547`): `engine.camera`, `engine.onFrame`, `engine.setFov`, `events`, `input` (`isDown`, `wasPressed`, `consumeLook`, `locked`), `settings.value.controls` (`sensitivity`, `adsSensitivity`, `invertY`, `adsToggle`, `aimAssist`, `preset`) and `settings.value.gameplay` (`fov`, `headBob`), `combat` (`raycast`, `get`, `all`, `enemiesOf`), `world` (`raycast`, `lineOfSight`, `moveCapsule`, `groundHeight`, `bounds`), `player`, `ballistics`, `grenades`, `map`, `time`, `assets`.
- `game/hitbox.ts hitTestHumanoid` (3-capsule humanoid, used by `PlayerController.hitTest`).
- `world/types.ts:42-73 World` (BVH-backed collision, owned by the world group).

---

## 3. Three.js and browser APIs, with Apple equivalents

| Web API | Used where | Swift/Metal equivalent |
|---|---|---|
| `Vector3`, `Quaternion`, `Matrix4`, `Euler('YXZ')`, `MathUtils` (`damp`, `lerp`, `clamp`, `degToRad`, `randFloat`, `randFloatSpread`) | Everywhere (109× `THREE.Vector3`, 43× `Quaternion`) | `simd` (`SIMD3<Float>` and `SIMD3<Double>`, `simd_quatf`, `simd_float4x4`). Write a small `MathKit` with `damp`, `smoothstep`, and Euler YXZ to quaternion. Use **Double** in gameplay sim to match JS float64; convert to Float at the render boundary. |
| `Object3D` / `Group` scene graph, `updateMatrixWorld`, `matrixWorld.decompose`, `traverse`, `getWorldPosition/Direction`, `applyQuaternion` | rig, gun-view, models | Own lightweight `Node` transform hierarchy (or RealityKit `Entity` if the render group picks it; Metal plus a custom graph is recommended). |
| `PerspectiveCamera` (fov, aspect, `rotation.order='YXZ'`) | controller.ts:96, 367-373 | Own `Camera` struct building a right-handed, -Z-forward view matrix and reverse-Z projection. |
| `Mesh`, `BufferGeometry`, `Float32BufferAttribute`, `Box/Cylinder/Sphere/Torus/Plane/Extrude/Lathe(Shape, Path)`, `RoundedBoxGeometry`, `BufferGeometryUtils.mergeGeometries` | fallback.ts, m24-*, guns-c-optic | `MTLBuffer` vertex/index buffers; port the primitive generators (or `MDLMesh` primitives, but you need exact dimensions). Extrude and Lathe need a hand port (about 300 lines). Alternative: **bake these procedural parts into the GLBs offline** with a Node script, which removes the need to port the generators (recommended). |
| `GLTFLoader` + `EXT_texture_webp` | guns-*-build, arms.ts | glTF loader: ModelIO cannot read glTF. Use **GLTFKit2** (Warren Moore, MIT, Metal-native) or a custom cgltf wrapper. WebP decode needs ImageIO, which supports WebP on macOS 11+, or pre-convert to KTX2/ASTC/PNG at build time. |
| `SkeletonUtils.clone`, `SkinnedMesh`, `Bone` | arms.ts | Own skinning: a joint-palette compute or vertex shader. Two-bone IK math (`guns-c-ik.ts`, 78 lines) ports directly to simd. |
| `MeshStandardNodeMaterial`, `MeshPhysicalNodeMaterial`, `MeshBasicNodeMaterial`, `LineBasicNodeMaterial` + TSL (`mx_noise_float`, `positionLocal`, `positionView`, `modelViewMatrix`, `mix`, `smoothstep`, `texture`, `uv`, `mrt`) | materials.ts, guns-*-materials, m7/m24-materials, guns-c-optic | Metal Shading Language PBR (shared with the render group) plus hand-ported functions: MaterialX `mx_noise_float` (Perlin) in MSL, and the collimated holo reticle fragment shader. These need visual parity, not bit parity. |
| `castShadow`, `receiveShadow`, `frustumCulled=false`, `raycast = noop` | gun-view.ts:68-75 | Render-group flags; the view model is excluded from culling and picking. |
| `import.meta.glob` (eager module discovery) and `console.warn` | view/registry.ts:11-21 | Static registry `[WeaponId: GunModuleSpec]`; `os.Logger`. |
| `Math.random` (no seeding) | ballistics.ts:35, recoil.ts:45, player-weapons.ts:337, controller.ts:121 | `SystemRandomNumberGenerator`, behind an injectable `RandomSource` protocol for tests. Not needed for cross-play (see 4.4). |
| Pointer lock and mouse delta (`input.consumeLook`, `input.locked`) | controller.ts:262, player-weapons.ts:221 | `NSEvent` raw deltas / `GCMouse.mouseInput.mouseMovedHandler`, `CGAssociateMouseAndMouseCursorPosition(false)` + `NSCursor.hide`. **Sensitivity units are degrees per 1000 px** (controller.ts:263-265). Calibrate the native "px" (points versus pixels, no OS acceleration) so a shared settings value feels the same. |
| `location.search`, `URLSearchParams` | `*.view.ts` only | Not ported. |
| `requestAnimationFrame` dt, capped at `MAX_FRAME_DT = 0.05` (`render/engine.ts:23,320-321`) | All `update(dt)` | `CADisplayLink` / `MTKView` with the same 50 ms cap. |

---

## 4. Cross-play-critical behaviour

### 4.1 Wire identifiers (must match byte-for-byte)

- **Weapon index on the wire = position in `WEAPON_IDS`** (`src/weapons/models/api.ts:5`: `['m4a1','mp5','m24','m249','m7','scarh']`). It is used by `protocol.ts:111-113` (`weaponIndex`), `:146` / `:158` (state byte 34), `:226` (bot snapshot byte 19+at), and `:253` / `:282` (shot byte 3). A web change that reorders or inserts in this list breaks cross-play. Generate the Swift enum from this file (section 5).
- Weapon id **strings** in JSON events (`net/events.ts:137-142`) and `GRENADE_SOURCE = 'grenade'`, which mirrors `GRENADE_ID` (`weapons/grenades.ts:5`, `net/events.ts:35`).
- `WeaponActionStage` strings: `contracts.ts:100-109` and the validation list in `net/events.ts:92-102` (`magOut`, `magIn`, `boltBack`, `boltForward`, `boltLift`, `boltClose`, `shellInsert`, `beltOpen`, `beltClose`). These are sent as `{t:'action'}` from `MachineSink.stage` (`player-weapons.ts:324-334` → `match.ts:347-350`).
- `HitZone` strings `head`, `torso` and `limb` (`contracts.ts:22`, `events.ts:89`).

### 4.2 Hit registration path (shooter-authoritative)

1. `PlayerWeaponsImpl.fire` (`player-weapons.ts:300-313`) passes the camera world direction, the muzzle from `rig.muzzleWorld`, and `recoil.spread(def, stance)` **before** `recoil.shot` updates bloom. Keep that order.
2. `Ballistics.fire` (`ballistics.ts:135-176`): **the local shooter traces from `camera.position`** (`:140`). That includes head bob, landing dip and strafe offset (`controller.ts:367-371`). Bots and remotes trace from the muzzle. Per pellet: `sampleCone` (`math.ts:40-56`, uniform over the disc, `angle = half*sqrt(r)`, tangent frame from +Y or +X), then `combat.raycast(origin, dir, def.range, shooter.id, shooter.team)` (friendly fire off), then emit `bulletTrace`.
3. Rounds beyond `INSTANT_RANGE = 80` m land after `distance / muzzleVelocity` seconds (`ballistics.ts:6,149-160`). The damage, and therefore the `hit` event sent over the network, is delayed by that flight time.
4. Damage: `damageAt = damage * falloff(distance) * zoneMult` (`math.ts:10-26`). Falloff is linear from `falloffStart` to `falloffEnd`, clamped at `falloffMin`. The zone multipliers are `headshotMultiplier` and `limbMultiplier`, with torso at 1.
5. Remote target: `RemoteSoldier.applyDamage` → `forwardDamage` sends `{t:'hit', amount: round(amount*100)/100, zone, p, d}` (`match.ts:411-423`).
6. Receiver: `capDamage(def, amount)` caps at `def.damage * max(1, headshotMultiplier)` (`limits.ts:31-39`). `WeaponGate` allows `roundsPerMinute/60 * 1.25 * pellets` per second with a burst of 0.75 s (`limits.ts:66-95`). Remote shots are also gated by `allowShot` (`match.ts:523`) and limited to `def.pellets` ends (`match.ts:532`).

**Consequence:** the native `WEAPON_DEFS` **must equal** the web table (`defs.ts:9-203`), especially `damage`, `headshotMultiplier`, `roundsPerMinute` and `pellets`. Otherwise one side clips the other's damage or drops its shots. `GRENADE_DEF` (`grenades.ts:12-42`) caps a blast hit at 200 (`damage = GRENADE.maxDamage`, multiplier 1).

### 4.3 Hitbox and body geometry (must match, or the two sides disagree on who was hit)

- `game/hitbox.ts:12-22`. This file belongs to the game group but this group depends on it. Standing: head 1.60–1.68 m r 0.125; torso 0.98–1.42 r 0.24; limb 0.14–0.90 r 0.20. Crouching: head 1.04–1.12; torso 0.56–0.90 r 0.25; limb 0.14–0.46 r 0.24. The first volume hit in list order wins (head before torso), and a ray starting inside a volume returns 0 (`hitbox.ts:63-64,79`).
- Player body: `RADIUS 0.34`, `STAND_HEIGHT 1.8`, `CROUCH_HEIGHT 1.2`, `STAND_EYE 1.64`, `CROUCH_EYE 1.08` (`player/controller.ts:10-14`). These are **duplicated** in `net/remote-soldier.ts:8-11` (eye and chest heights). Remote eye position drives the near-miss check, grenade reach validation (`match.ts:561-562`, `GRENADE_REACH = 8`) and muzzle sanity (`MUZZLE_REACH = 1.5`).
- The local eye height is damped, not snapped: `eye = damp(eye, target, 12, dt)` (`controller.ts:254-255`). The remote side uses the snapped value from the crouch flag, which is a small, accepted discrepancy.

### 4.4 RNG: no seeding, and none needed

All randomness is `Math.random`: cone samples (`ballistics.ts:35`), horizontal kick (`recoil.ts:45,51`), brass (`player-weapons.ts:337`, `ballistics.ts:79-80`) and the hurt jolt (`controller.ts:121`). The shooter sends the **resolved trace end points** (`protocol.ts:247-262`, `encodeShot`), so the receiver never re-samples. The Swift port can use any RNG. Do not try to reproduce JS RNG sequences.

### 4.5 Fire-rate and timing (observable by the peer's `WeaponGate`)

- `shotInterval = 60 / max(1, rpm)` (`math.ts:29-31`). The machine keeps at most one frame of negative cooldown credit: `cooldown = max(cooldown - dt, -dt)` (`machine.ts:120`). It loops `while` to fire several shots in one long frame (`machine.ts:142-153`). With dt capped at 50 ms, an 800 RPM gun can fire 1–2 shots per frame. The native frame loop must use the same cap, or a faster native rate could exceed the peer's 1.25× slack.
- `PRESS_BUFFER = 0.2` (`machine.ts:30`).
- Bolt cycle duration = `shotInterval` (m24: 60/42 ≈ 1.4286 s) (`plans.ts:77`). Reload durations: the full `reloadTime`, × `TACTICAL_FACTOR 0.78` when chambered, × `BOLT_TOP_UP_FACTOR 0.62` for a bolt gun that is chambered, and a charge of 0.45 s (`plans.ts:38-43, 81-121`). Mark fractions are in `plans.ts:58-63, 87-117`. Audio on the peer keys off the `action` events, so stage order matters.
- Ammo rule: a magazine reload keeps the chambered round (+1); belts do not (`machine.ts:89-92, 219-226`).

### 4.6 Grenade (owner-authoritative, peer flies a cosmetic copy)

- `GRENADE` (`grenade-math.ts:5-36`): fuse 2.5 s, throwSpeed 16, upBias 0.18, gravity 9.81, radius 0.045, restitution 0.35, friction 0.45, rollFriction 0.6, bounceSpeed 1, restSpeed 0.25, **step 1/60**, maxDamage 200, lethalDamage 100, lethalRadius 3, blastRadius 8, shakeRadius 32, maxArcPoints 152. `REST_NORMAL_Y 0.7`, `LOOKAHEAD_RADII 4`, `CONTACTS_PER_STEP 2`, `BLAST_LIFT 0.25` (`:39-44`).
- The peer rejects a throw with `|v| > 16 * 1.05` (`match.ts:50,559`), and more than `GRENADES_PER_MATCH = 1` (`grenade-hand.ts:2`, `match.ts:557`).
- Shown (non-authoritative) flights explode at the owner's reported position if that position is within `DETONATE_TOLERANCE = 6` m, or by themselves at fuse + 1.5 s (`grenades.ts:50-53,121-128,163`). Simulation drift is therefore tolerated. Fixed-step integration (`grenades.ts:135-146`, max 8 steps per frame) should still be ported exactly so arcs look the same.
- Blast damage: piecewise linear (`grenade-math.ts:167-174`), zero behind cover (`lineOfSight` from `blast + 0.25 y` to the chest), chest = feet + 0.75 × eye height (`grenades.ts:55,207-211`). It hits the thrower and the enemy side but not teammates (`grenades.ts:179`).

### 4.7 Movement and view (sent in state; not validated, but must feel identical and interpolate sanely)

- `player/controller.ts:15-30`: walk 4.2, sprint 6.4, crouch 2.1, aim factor 0.55, ground accel 48, air accel 6, friction 9.5 (`drop = max(speed,1.2)*9.5*dt`), gravity 17.5, jump 5.1, coyote 0.1 s, max pitch 86°, strides 1.55/2.1, regen after 5 s at 18/s. The per-weapon `mobility` multiplies max speed (`:202-203`).
- The order inside `update` matters: look → recoil recovery → wish direction → crouch → sprint gate → friction+accel or air accel → jump → gravity → `moveCapsule` → landing → out-of-world rescue → footsteps → regen → indoors → eye damp → camera (`controller.ts:169-257`).
- Yaw 0 looks down **-Z** and positive yaw turns **left**. Euler order is YXZ (`controller.ts:96,184,372`; `assist.ts:203-204`). The wire wraps yaw to (-π, π] and clamps pitch to ±π/2, scaled by 10000 (`protocol.ts:29,101-109,135-136`). Swift must use the same right-handed, Y-up, -Z-forward convention.
- Recoil application: the kick is applied at rate 38/s and `recovery` × kick returns at 6.5/s (`controller.ts:277-294`). This is mirrored in `ViewKickMirror` (`recoil.ts:81-82,107-120`). Both copies must stay in sync.
- The sprint gate requires `aimBlend < 0.3`, `forward > 0`, not crouching, on the ground, and `!blockSprint` (`controller.ts:193-200`). The net flags send `sprinting` and `aiming = aimBlend > 0.5` (`match.ts:257-258`).
- FOV: `fovForZoom` multiplies the tangent of half the FOV (`controller.ts:384-387`), blended by `smoothstep(aimBlend)`. ADS sensitivity = `lerp(1, adsSensitivity*zoom, aimBlend)` (`:264`).

### 4.8 Spread, recoil and assist (local feel, not cross-play, but the tests pin them)

`recoil.ts:13-30` (GROWTH_PER_SHOT 0.045, MAX_HEAT 9, hold 0.14 s, drain 14/s, AIMED_KICK 0.75, CROUCHED 0.8, BLOOM_PER_SHOT 0.16, recovery 5, AIMED_BLOOM 0.2, AIMED_MOVE 0.35, FULL_MOVE_SPEED 5, air 0.6/min 1). For scoped guns the stance `aimBlend` is squared (`player-weapons.ts:267`). Assist constants are at `assist.ts:33-50` (3°/6° cones, range 0.8–120 m, slow 0.4, pull 0.35, snap 0.6). Breath sway is at `aim.ts:56-63,110-111`.

---

## 5. Proposed Swift module layout

```
IronvaleKit (SwiftPM, platform-agnostic, no Metal imports)
├── IVMath            Vec3d = SIMD3<Double>, Quatd, Euler YXZ, damp/smoothstep/ramp, Spring, wrapAngle, RandomSource protocol
├── IVWeaponsData     WeaponID (enum, rawValue String, wireIndex from generated table), WeaponDef, RecoilProfile,
│                     WeaponClass/FireMode/ReloadStyle/CasingKind/WeaponActionStage/HitZone enums,
│                     WeaponDefs.table (GENERATED), GrenadeConstants (GENERATED), Handling table, Loadout.issued(...)
├── IVWeaponsSim      DamageMath (falloff, zone, damageAt, shotInterval, sampleCone, closestPointOnSegment),
│                     ActionPlan/Mark/Plans, WeaponMachine (+ MachineSink protocol, TriggerInput),
│                     RecoilModel, ViewKickMirror, AimState, BreathSway, AimAssist, ViewSteering,
│                     WeaponSwitch, IntentReader/WeaponIntent, GrenadeHand, GrenadeMath (stepGrenade, predictArc, blastDamage),
│                     GrenadeSystem (Grenades protocol), BallisticsSystem (Ballistics protocol), PlayerWeaponSystem
├── IVPlayer          PlayerController (PlayerBody protocol), PlayerConstants, fovForZoom
IronvaleRender (Metal)
├── ViewModel/        ViewRig, GunView, PartsAnimator, Poses, FallbackGun
├── GunAssets/        GunModuleSpec registry, GLTF import (GLTFKit2), anchor extraction, arms skinning + TwoBoneIK
└── Shaders/          GunPBR.metal (mx_noise roughness), HoloReticle.metal, ScopeLens.metal
```

Key types:

- `struct WeaponDef: Sendable, Codable, Equatable` holds a value copy of the table. `protocol Ballistics { func fire(shooter: any Combatant, weapon: WeaponDef, muzzle: Vec3d, direction: Vec3d, spread: Double?) }`.
- `final class WeaponMachine` keeps the same fields and exposes `step(dt:input:sink:)`. `protocol MachineSink: AnyObject { func fire(lastRound: Bool); func dryFire(); func stage(_: WeaponActionStage); func eject() }`.
- `struct ActionPlan { kind; duration; marks: [Mark]; handsFrom; handsTo }`, cached in a `[WeaponID: PlanSet]` dictionary (the web code caches by def identity; key by id plus a def hash because bots use scaled defs).
- `final class PlayerController: PlayerBody` takes an injected `CollisionWorld` protocol (`moveCapsule`, `raycast`, `lineOfSight`, `groundHeight`, `bounds`) and an `InputSource`.
- Isolation: run the whole sim on one `@MainActor` (or a dedicated game actor) frame loop. The classes are deliberately mutable, single-threaded objects, which mirrors the TS design. Under Swift 6 strict concurrency, mark them `@MainActor` (or the game actor) and keep `WeaponDef` and the constants as `Sendable` values. The user's "immutable by default" rule applies to data (defs, plans, events). The per-frame machines stay mutable for allocation-free 120 Hz updates, as in TS.
- **Codegen for parity:** add a build-time script (in the native repo, reading but never modifying `src/`) that runs `tsx` to import `WEAPON_DEFS`, `WEAPON_IDS`, `GRENADE`, `GRENADE_DEF`, `HANDLING`, the plan mark tables and the hitbox volumes, then emits `WeaponTables.generated.swift` plus a JSON fixture. CI fails if the generated file is stale. This is the single most important guard for cross-play as the web version evolves.
- **Golden tests:** port `tests/weapons/*.test.ts` to Swift Testing. Also dump JS outputs (`damageAt` grid, `blastDamage` curve, `stepGrenade` trajectories over a flat plane and a wall, `WeaponMachine` event traces for scripted inputs, `PlayerController` positions over a scripted input stream against a box world) into JSON fixtures and assert the Swift results match within 1e-9.

---

## 6. Risks, unknowns, difficulty and effort

### Risks

1. **Def and ID drift (high).** The web version "keeps evolving". Any change to `defs.ts`, `WEAPON_IDS` order, a new weapon, `GRENADE`, stages or hitbox volumes silently breaks cross-play: damage gets clipped, shots get dropped, or wire indices get mis-decoded (`protocol.ts:158` rejects unknown indices, and `weaponIndex` falls back to 0 = m4a1). Mitigations: codegen plus CI, and ideally a protocol version or def hash exchanged in the handshake (that belongs to the net group; recommend it).
2. **Local trace origin = rendered camera position** including bob, landing dip and strafe offset (`ballistics.ts:140`, `controller.ts:367-371`). If the native camera rig differs, aim feel differs. This is not a protocol break, but players will notice.
3. **Frame-rate dependence.** Most logic is dt-scaled with exponential damping, but the machine's one-frame credit, the coyote window and Quake accel are frame-rate sensitive. Native at 120 Hz behaves slightly differently from web at 60 Hz. Keep the 0.05 s cap. Consider a fixed 120 Hz sim step later, but then retest against the peer's `WeaponGate` (1.25× slack plus 0.75 s burst gives headroom).
4. **`world.moveCapsule` lives outside this group** (three-mesh-bvh capsule sweep with step-up). Player movement parity depends entirely on the world group's port. This is the biggest behavioural unknown for "same feel".
5. **Bots use `scaledWeapon(def, difficulty)`** (`ai/difficulty.ts:161`). The receiver caps bot hits with the unscaled `WEAPON_DEFS` (`match.ts:569`). If native bots host co-op, the native scaling must not exceed web caps.
6. **View model rendering** is the bulk of the line count: TSL node materials, a MaterialX noise port, the collimated holo reticle, the depth-compressed view model via `scale.z` (needs per-object projection handling, so normals and shadows must be checked in Metal), skinned arms with IK, and procedural Extrude/Lathe geometry for the M24 scope. Recommendation: bake procedural meshes into GLB offline, port only the materials and shaders, and keep the procedural motion code as is.
7. **WebP textures in GLB** (`EXT_texture_webp`). Decoding at load is fine via ImageIO, but converting to ASTC/BC7 KTX2 at build time is better for Metal.
8. **Mouse sensitivity units** (deg/1000 px) need calibration so shared settings feel equal. This is not cross-play critical.
9. **Event ordering assumptions** (`shotFired` before its `bulletTrace`s, deaths flushed at end of frame) must be preserved if the native event bus is reimplemented.
10. Unknown: whether the native app will also host survival/co-op bot matches. If so, `Ballistics` for bots and `GrenadeSystem` authority rules port as is, but bot AI is a separate group.

### Difficulty and effort

| Part | Difficulty | Days |
|---|---|---:|
| Data tables + codegen + CI parity check | Low | 1.5 |
| Math, ballistics, machine, plans, recoil, aim, switch, intent, grenade sim (about 1,900 lines, pure) | Low–medium | 4 |
| Steering + aim assist + kick mirror | Medium | 1.5 |
| `PlayerController` (needs the `CollisionWorld` port from the world group) | Medium | 2.5 |
| Port about 168 unit tests + JS-generated golden fixtures | Medium | 3 |
| View rig, gun view, parts animator, poses, springs (CPU side) | Medium | 3 |
| glTF loading (GLTFKit2), anchors and parts extraction for guns-a/b/c layouts | Medium–high | 3 |
| Skinned FP arms + two-bone IK | High | 3 |
| Materials: PBR noise roughness, holo reticle, scope lens, depth-compressed view-model pass | High | 4 |
| Procedural parts (M24 scope, rings, bipod; fallback gun): bake to GLB offline, or port the generators | Medium | 2 |
| Integration and feel tuning against the web build in live cross-play duels | Medium | 3 |
| **Total** | **Medium–high overall** (sim: low–medium; view model: high) | **~30.5** |

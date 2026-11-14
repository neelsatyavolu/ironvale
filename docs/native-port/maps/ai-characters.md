# Porting map: ai-characters (`src/ai`, `src/characters`)

Scope: enemy and teammate bots (senses, squad tactics, difficulty, navigation, cover) and the
third-person soldier body (clip sampling, procedural aim, arm IK, death, team tint) used for bots
and for the other network player. About 5,820 lines: `src/ai` 3,778, `src/characters` 2,042.
Tests that pin this behaviour: `tests/ai/*` (13 files) and `tests/characters/*` (8 files), 2,297
lines in all.

## 0. The finding that shapes the port

**Bots are host-authoritative. The AI never runs on both machines at once.** In co-op, and in a
duel with a bot teammate, only the host runs `BotManager`. The guest shows `BotProxies`
(`src/net/proxies.ts`) driven by 12 Hz bot snapshots:

- Only the host spawns bots: `src/game/game.ts:255` (`if (this.net.authority) this.bots.spawn(...)`).
- The host sends snapshots: `src/net/match.ts:226-230` (`BOT_INTERVAL = 1/12`, `match.ts:39`) and
  `sendBots`, `match.ts:268-292`.
- The guest receives `botSpawn` and creates a proxy: `match.ts:459-460`, `proxies.ts:51-63`.
- In a duel, `duelBotsHere` returns 1 only on the host: `src/net/rules.ts:43-45`.
- If the host leaves, the guest spawns fresh bots locally with `takeOver`, `game.ts:438-445`. Bot
  state is not migrated.

So **nothing in the brain, pathfinder, navgrid or RNG has to be bit-identical with the web
build.** A native host only has to produce bots whose wire output a web guest accepts and renders
correctly. A native guest only has to render a web host's bots. What is critical for cross-play is
the bot's outward contract: the snapshot fields and their conventions, ids, names, fire cadence,
damage numbers, hit volumes, team and uniform, and the visual reading of the pose flags. Section 4
lists each of these.

Gameplay parity (bots should feel the same in both builds) still argues for porting the AI almost
line for line, including the PRNG. That way the web tests can serve as golden fixtures.

---

## 1. Purpose and structure

### 1.1 `src/ai`: bots (3,778 lines)

| File | Lines | Responsibility |
|---|---:|---|
| `index.ts` | 23 | `createBots(ctx)` factory. The doc comment describes the architecture and the `?botdebug` flags. |
| `env.ts` | 25 | `BotEnv` interface shared by the brain, body and manager (ctx, grid, paths, squad, bots, `random`, `time`, `fogDensity`, `enemies`, `sweepBias`, `callout`, `transition`). |
| `manager.ts` | 406 | `BotManager implements BotSystem, BotEnv`. Builds the nav grid in time slices, spawns (spawn ranking, ring placement, roles, names, visual pool), the per-frame update (path budget, round-robin thinking, body update, corpse retire), hearing via game events, and stats. |
| `bot.ts` | 358 | `Bot extends BotBody implements Combatant`. Brain-written fields, facing and turn rate, firing (muzzle, line-of-sight fallback, spread), mate-in-line check, damage and death, and syncing the visual. Also exports `wrapAngle`. |
| `body.ts` | 254 | `BotBody`: capsule locomotion, path following, separation, stuck detection and repath, gravity, footstep events. Constants `BODY` and `SPEED`. |
| `brain.ts` | 188 | `think()` = `sense()` (sight cone, line of sight, reaction, pain, hearing, radio sharing), then `fight` or `chooseTactic` or `roam` (patrol, investigate, sweep). |
| `blackboard.ts` | 118 | `Squad`: shared last-known position, contact timing, tallies, push and flank caps, callout rate limits. `BotState` and `CalloutKind` unions. |
| `tactics.ts` | 182 | `fight()` per think, the `step()` state dispatch, and `chooseTactic()`, the ordered rule list. |
| `tactics-cover.ts` | 265 | Cover search with ray confirmation, peek and hide cycle, the peek-cell search, fallback and recovery. |
| `tactics-open.ts` | 141 | Strafe, hold, suppress, push, and flank (with a path-avoid disc). |
| `tactics-util.ts` | 58 | `flatDistance`, `tacticSeconds`, `lookAround`, `takeFireTurn` (the squad's concurrent-attacker cap), `canSeePoint`. |
| `difficulty.ts` | 169 | `DifficultyProfile` with 18 parameters for each of four levels, `DIFFICULTY_TREND`, and `scaledWeapon` (damage multiplier; snipers exempt). |
| `roles.ts` | 74 | `ROLES` (weapon, ranges, burst and pause, pushes and holds), `assignRoles(count)`, `botName(index)`. |
| `perception.ts` | 134 | `VISION` constants, `effectiveVisionRange` (fog, crouch, still or sprint), `inVisionCone`, `hearingRadius`, and `Awareness` (reaction and memory). |
| `aim.ts` | 56 | `AimModel`: settling spread, crossing-target penalty, moving penalty, flinch. |
| `marksman.ts` | 28 | `readyToFire` (scope-in delay) and `botShotSpread`. |
| `botweapon.ts` | 105 | `BotWeapon`: rate of fire with overshoot carry, bursts and pauses, magazine and reload. Pure timing. |
| `cover.ts` | 100 | `directionToward`, `coverAgainst` (8-direction low and high masks), `findCover` (scored scan of nearby cells, spacing). |
| `navgrid.ts` | 386 | `NavGrid`: multi-layer 0.6 m grid, 8-neighbour bitmask, 2-bit layer index per direction, cover masks, wet mask, `nearestNode`, Bresenham `walkLine`. `buildNavGrid` is a generator that samples the collision world. |
| `pathfinder.ts` | 384 | `PathHandle` (preallocated result), `Pathfinder` (time-sliced A* with a binary heap, octile heuristic, wet and avoid costs, halving-span smoothing), `PathQueue` (FIFO with a per-frame node budget). |
| `spawn.ts` | 49 | `orderSpawns` (spawns out of view first, furthest first), `assignSpawns` (capacity per spawn), `inViewCone`. |
| `debug.ts` | 275 | `?botdebug` overlay: path ribbons, cover and nav cell tiles, canvas-text sprites, transition log, `gridBytes`. Developer-only. |

**Bot control flow, per frame** (`manager.ts:254-299`):

1. `dt` is clamped to 0.1 s.
2. Every 0.5 s, the enemy list is refreshed from `combat.enemiesOf(team)`.
3. `squad.tally`.
4. `PathQueue.update(350)` expands A* nodes.
5. Up to 4 bots think, round-robin from `thinkCursor`. Each bot thinks roughly every 1/7 s with ±10% jitter, and the blackboard is re-tallied after each think.
6. Every bot runs `Bot.update(dt)`: move, face, shoot, sync the visual. A corpse is retired after 20 s.

**Navigation is a grid, not a navmesh.** Cell size 0.6 m, up to 4 floor layers per column
(`navgrid.ts:8-22`). The build has five passes (`navgrid.ts:205-360`):

1. Downward raycasts per column. A floor needs normal.y ≥ 0.6, 1.8 m of headroom and a capsule-fit probe (`moveCapsule` with zero velocity).
2. Straight E and S links, checked with `groundHeight` step sampling (4 samples, step ≤ 0.18 + 0.025).
3. Diagonals, only where both orthogonal routes meet (no corner cutting).
4. A flood fill from the spawns; cells it cannot reach get their edges zeroed.
5. Cover: horizontal rays at 1.15 m and 1.65 m in 8 directions, reaching 1.0 m (1.35 m diagonally).

The build yields every 256 nodes. The manager runs it in 8 ms slices with `setTimeout(0)` between
them (`manager.ts:137-147`).

### 1.2 `src/characters`: soldier body (2,042 lines)

| File | Lines | Responsibility |
|---|---:|---|
| `index.ts` | 18 | `soldierAssets()` returns `['mdl-char-soldier', 'mdl-char-carbine']`; `createSoldier(assets, team)`. |
| `soldier.ts` | 423 | `Soldier implements SoldierVisual`: skinned clone, team material, the carbine mesh, visibility LOD via `onBeforeRender`, state blends (crouch, aim, carry, pitch, reload), heading tracking, gait sampling and blending, death blend, chest and head and hips corrections, rifle hold and arm IK. |
| `rig.ts` | 197 | `SoldierRig`, built once per glTF and cached in a WeakMap: clip data, bone parents and offsets, rest rotations, arm calibration, finger curls, the TSL team-tint material, the carbine mesh. `TEAM_TINT`. |
| `skeleton.ts` | 107 | Forward kinematics over 22 clip bones in model space, a per-bone `adjust` quaternion, `measure` (the chest and head rotation the clip has applied), `setArm` (IK blend). |
| `pose.ts` | 131 | `Pose` (flat Float32 rotations plus hips), `buildClipData`, `sampleClip` (fixed 30 fps with index-and-nlerp sampling), `blendPose`, `steerBone`, nlerp along the shorter arc. |
| `locomotion.ts` | 138 | Gait speed bands and cross-fades, stride phase advanced by ground covered (cadence capped at 2.4 Hz), clips aligned on the foot strike, backpedal detection with hysteresis, hip yaw ≤ 55°. |
| `gun-hold.ts` | 165 | `CARBINE` grip and muzzle points; `GunHold` places the rifle from the right shoulder (READY, AIMED and CARRY poses, recoil, reload tilt, sway, sight-to-eye slide) and outputs both hand targets. |
| `ik.ts` | 159 | `calibrateArm` (rest frames, palm, forearm axis) and `solveArm` (two-bone IK with a pole and forearm twist share 0.55). `quatFromBasis`. |
| `death.ts` | 140 | `planDeath` (fall onto the back or the face, turn ≤ 70°), the `deathFrame` timeline (blend 0.16 s, IK release 0.14 s, turn 0.4 s), `GunDrop` (rifle falls, spins and lies flat). |
| `reactions.ts` | 107 | `Flinch` (envelope per hit zone, alternating side) and `Recoil` (0.095 s shudder with a fixed `sin(n*12.9898)` scatter). |
| `lod.ts` | 57 | Pose interval by visibility and distance (1, 2, 3 or 6 frames) and `VisibilityTracker`. |
| `clip-meta.ts` | 70 | Generated. Nine clips at 30 fps with durations, frames, gait speed and strike phase; `CLIP_BONES` (22); `ANKLE_HEIGHT`. |
| `carbine-meta.ts` | 15 | Generated. Carbine muzzle and butt points. |
| `retarget.ts` | 188 | Offline only, used by `scripts/process-soldier.mjs` to bake clips. **Not needed at runtime.** |
| `soldier.view.ts` | 127 | Dev viewer page (`?view=characters/soldier`). Port only as a debug scene. |

Assets: `public/assets/local/characters/soldier.glb` (1.67 MB) and `carbine.glb` (334 KB).
`scripts/process-soldier.mjs` bakes the clips and packs a cloth mask into the roughness map's red
channel (`rig.ts:189`).

---

## 2. Interfaces

### 2.1 What other subsystems consume

| Consumer | What it uses | Where |
|---|---|---|
| game | `createBots(ctx)` → `BotSystem {enterMap, leaveMap, spawn(count, team, difficulty), alive, grid, update, dispose}` | `src/game/game.ts:2,235,255,336,403,420,444,510`, contract `src/game/contracts.ts:428-439` |
| game | `soldierAssets()` for preloading | `game.ts:3,203` |
| game contracts | `NavGrid` type re-exported on `BotSystem.grid` | `contracts.ts:10` |
| UI minimap | `ctx.bots.grid`, which draws the map layout from walkable cells | `src/ui/hud/minimap.ts:263` |
| net (host) | Duck-typed `BotView`: `yaw`, `pitch`, `speed`, `watch`, `weaponDef`, `weapon.reloading`, plus `Combatant` | `src/net/match.ts:52-60, 268-292, 357-374` |
| net (guest) | `createSoldier(assets, uniform)` for proxies and the remote player | `src/net/proxies.ts:1,54`, `src/net/match.ts:2` |
| combat / ballistics | `Bot` as `Combatant` (`hitTest`, `applyDamage`, `eyePosition`, `position`, `velocity`, `crouching`, `team`, `alive`, `health`) | `contracts.ts:41-58` |
| audio / HUD | `botCallout` events (`spotted`, `reloading`, `hurt`, `death`), `weaponAction` stages, `footstep`, `died`, `spawned` | `manager.ts:331-337`, `bot.ts:324-351`, `body.ts:237-253` |
| tests and dev scripts | `game.bots.stats`; `window.__ironvaleBots` and `window.__soldiers` | `manager.ts:38-55,170`, `soldier.view.ts:61` |

`SoldierVisual` contract (`contracts.ts:442-469`): `root`, `muzzleWorld(v)`,
`setState({speed, crouching, aimPitch, aiming, firing, reloading})`, `die(direction)`, `revive()`,
`flinch(zone)`, `update(dt)`, `dispose()`.

### 2.2 What this group depends on

- **world** (`World`): `raycast(origin, dir, max)` → `{point, normal, distance, surface}` (surface `'water'` is read at `navgrid.ts:243`), `groundHeight(x, z, fromY, range)`, `moveCapsule(pos, vel, dt, radius, height)` → `{position, velocity, onGround, groundSurface}`, `lineOfSight(a, b)`, `bounds`. Uses: `navgrid.ts:5`, `body.ts:223`, `bot.ts:273-274`, `brain.ts:66-67`, `tactics-cover.ts:99-112`, `tactics-util.ts:57`, `manager.ts:218`.
- **game**: `GameContext` (`events`, `combat`, `ballistics`, `assets`, `engine.scene` and `engine.camera`, `player`, `map`, `world`), `hitTestHumanoid` (`src/game/hitbox.ts:30`, used at `bot.ts:166`).
- **weapons**: `WEAPON_DEFS` (`damage`, `weaponClass`, `mobility`, `roundsPerMinute`, `magazineSize`, `reloadTime`, `reloadStyle`, `scoped`, `spreadAim`, `spreadHip`, `loudness`, `id`).
- **core**: `seededRandom` and `hashString` (`src/core/random.ts:2-21`), `Difficulty` (`core/settings`), `Assets.gltf()` and `preload()`.
- **world/types**: `MapInstance` (`enemySpawns`, `playerSpawns`, `bounds`, `lighting.fog.density`), `SpawnPoint`, `Surface`.
- **render**: the Three scene graph, `SkinnedMesh`, TSL node materials, the frustum-cull callback.

---

## 3. Three.js and browser APIs, with native equivalents

| Web API | Where | Swift / Metal / Apple equivalent |
|---|---|---|
| `Vector3`, `MathUtils.clamp/damp/degToRad` | everywhere | `SIMD3<Float>` (or `SIMD3<Double>`; see §6). Small `clamp` and `damp` helpers (`damp = lerp(a, b, 1 - exp(-λ·dt))`, identical to Three's). |
| `Quaternion` (`multiply`, `premultiply`, `slerp`, `setFromEuler`, `setFromRotationMatrix`, `invert`, `angleTo`) | `skeleton.ts`, `soldier.ts`, `ik.ts`, `gun-hold.ts`, `death.ts` | `simd_quatf` and `simd_slerp`. **Euler order matters**: `'XYZ'` (soldier.ts:367-389) and `'YXZ'` (gun-hold.ts:88,130). Write an explicit `quat(eulerXYZ:)` / `quat(eulerYXZ:)` that matches Three's formulas. `simd` has no Euler constructor. Three's `premultiply(q)` = `q * self`. |
| `Matrix4.makeBasis` + `setFromRotationMatrix` | `ik.ts:62-67` | `simd_quatf(simd_float3x3(columns: (x, y, z)))`. |
| `Object3D`, `Group`, `getObjectByName`, `traverse`, `updateWorldMatrix`, `matrixWorld`, `applyMatrix4` | `soldier.ts`, `rig.ts`, `skeleton.ts` | Your own lightweight scene node, or plain structs. The soldier needs only: root transform (position, yaw), pivot yaw (death turn), 22 animated bone locals plus fixed finger locals, and the gun transform. |
| `SkeletonUtils.clone` + `SkinnedMesh` + `skeleton.dispose` | `soldier.ts:6,138-151,251` | One shared vertex and index buffer. Per instance: a bone-palette `MTLBuffer` (joint matrices × inverse bind). GPU skinning in a Metal vertex function (4 joints and weights per vertex). Instanced draw of all soldiers in one call. |
| `GLTFLoader` (`assets.gltf`), `gltf.animations[].tracks` | `rig.ts:73-107` | Either **GLTFKit2** (MIT, reads skins and animations) or, better, an **offline converter** (extend `scripts/process-soldier.mjs`, or add a Node script under a new `native/` dir) that emits a flat binary with the mesh, skin, rest pose, bone names and parents, and the clip arrays already in `frames × 22 × 4` layout. ModelIO has no reliable glTF skin support. |
| `MeshStandardNodeMaterial` + TSL `colorNode = mix(base, tint·luma·gain, cloth·amount)` | `rig.ts:175-197` | Metal PBR fragment function with team-tint uniforms `{color, gain, amount}`; cloth mask = `roughnessMap.r`. Luma weights (0.2126, 0.7152, 0.0722). |
| `mesh.onBeforeRender` (frustum-visible callback, perspective camera only) | `soldier.ts:153-159`, `lod.ts:41-57` | The renderer's CPU frustum cull writes `visibility.seen(distance)` for each soldier it draws in the main pass. Exclude the shadow pass. |
| `mesh.boundingSphere = Sphere((0, 0.9, 0), 2.4)` | `soldier.ts:67,152` | Fixed cull sphere per soldier instance. |
| `castShadow` / `receiveShadow` | `soldier.ts:149-150,163` | Draw soldiers into the shadow-map pass (skinned shadow vertex function). |
| `performance.now()` | `manager.ts:135-297` | `ContinuousClock` / `mach_absolute_time` (for stats only). |
| `setTimeout(0)` time slicing of a generator | `manager.ts:137-147` | Build the nav grid on a **background `Task`/thread** (needs a thread-safe read-only `World` query API), or keep the slice model with a resumable state machine and `Task.yield()`. A Swift generator equivalent is a struct with `mutating func step() -> Progress?`. |
| `URLSearchParams(location.search).get('botdebug')` | `manager.ts:109`, `soldier.view.ts:20` | Launch arguments, `UserDefaults`, or a debug menu. |
| `window.__ironvaleBots`, `window.__soldiers` | `manager.ts:170`, `soldier.view.ts:61` | Debug inspector or `os_log` dump. Optional. |
| `console.info` / `console.warn` | `debug.ts:76`, `manager.ts:156` | `Logger` (os). |
| `document.createElement('canvas')` + `CanvasTexture` + `Sprite` (debug labels) | `debug.ts:197-204` | Core Text into a `CGContext`, then `MTLTexture`, drawn as a billboard. Debug only. |
| `BufferGeometry` / line-ribbon overlay meshes (debug) | `debug.ts:60-97,225-238` | Dynamic vertex buffer with an unlit, depth-test-off pipeline. Debug only. |
| `Float32Array`, `Int32Array`, `Uint8Array`, `Uint16Array`, `Uint32Array` | navgrid, pathfinder, pose | `[Float]`, `[Int32]`, `[UInt8]`, `[UInt16]`, `[UInt32]`, or `UnsafeMutableBufferPointer` for hot loops (A*, sampling). |
| `Math.imul`, `>>> 0` (mulberry32 and FNV-1a) | `core/random.ts:2-21` | `UInt32` with wrapping `&*`, `&+`, `^`, `>>`. Divide by 4294967296 as `Double`. |
| `Math.hypot`, `atan2`, `exp`, `round`, `floor`, `%` | everywhere | Foundation. **JS `%` on negatives** keeps the sign, like Swift `truncatingRemainder`. **`Math.round(x)` rounds .5 toward +∞**; Swift `.rounded()` rounds .5 away from zero, so use `(x + 0.5).rounded(.down)` where it matters (`cover.ts:8`, `roles.ts`, `bot.ts:130-131`). |

---

## 4. Cross-play-critical behaviour

AI determinism is **not** required (see §0). These items are:

### 4.1 Bot snapshot contents (sourced here, encoded by net)

`src/net/match.ts:268-292` builds each `BotState` from a `Bot`. Wire format at
`src/net/protocol.ts:189-212`: 12-byte header, then 20 bytes per bot, at most 48 bots per
snapshot. The values this group must produce with **the same conventions**:

- `yaw`: radians, **yaw 0 faces −Z**, computed as `atan2(-dx, -dz)` (`bot.ts:235,239`) and wrapped to −π..π by `wrapAngle` (`bot.ts:355-358`). Encoded int16 × 10000.
- `pitch`: radians, up positive, clamped to ±60° (`PITCH_LIMIT`, `bot.ts:26,237`), smoothed with `damp(…, 10, dt)` (`bot.ts:248`). Encoded as whole degrees in an int8.
- `speed`: horizontal speed `hypot(vx, vz)` (`body.ts:73-75`). Encoded × 20 in a uint8 (max 12.75 m/s).
- flags: `crouching`; `aiming` = `watch === 'enemy'` (`match.ts:283`, and the same rule drives `pose.aiming` at `bot.ts:317`); `reloading` = `weapon.reloading`; `alive`.
- `weapon`: role weapon id (`roles.ts:25-31`: m4a1, mp5, m24, m249). The index into `WEAPON_IDS = ['m4a1','mp5','m24','m249','m7','scarh']` (`src/weapons/models/api.ts:5`) is on the wire.
- Position: feet position (`BotBody.position`), float32.
- Send rate 12 Hz (`match.ts:39`). Guest render delay `BOT_DELAY_MS = 170` (`proxies.ts:7`).

### 4.2 Ids and names

- Wire id = `combat.allocateId()` + `WIRE_BOT_BASE` (2) (`manager.ts:239`, `match.ts:275`, `net/wire.ts:4-7`). It must fit in a uint16 and be ≤ `MAX_WIRE_ID`. `MAX_NET_BOTS = 32` (`net/events.ts:104`).
- `botSpawn` event `{id, name, weapon, p, yaw}` (`match.ts:357-374`, `net/events.ts:68,210-216`). Names come from `botName(index)` (`roles.ts:65-74`): a 24-name list with a `" 2"`, `" 3"`… suffix per lap. The guest displays whatever name it is sent, so the list only needs to match for parity, not for protocol.

### 4.3 Fire cadence and shots

- A web guest gates each received shot by the weapon's rate of fire (`WeaponGate.allowShot`, `match.ts:520-523`). The native `BotWeapon` must never fire faster than `60 / roundsPerMinute` on average. It must also keep the **overshoot-carry** rule (`botweapon.ts:75-92`: `cooldown += interval`, floor `-dt`), or shots will be dropped on the guest. This is tested in `tests/ai/simulation.test.ts:174` ("never fires faster than the weapon allows").
- The shot muzzle comes from `visual.muzzleWorld()` (`bot.ts:270`), falling back to the eye when the muzzle is more than 1.5 m from it or behind a wall (`bot.ts:273-275`). The guest replays the shot from the muzzle in the message (`match.ts:526`), so an implausible muzzle shows up as wrong tracers on the web.
- Spread passed to ballistics is `max(aimSpread, weaponSpread)` (`marksman.ts:25-28`, `bot.ts:286-287`). The shot ends are resolved on the host.

### 4.4 Damage numbers

- Host-side damage = `WEAPON_DEFS[w].damage × DIFFICULTY[d].damageMultiplier`, except snipers (`difficulty.ts:161-169`). The shooter's machine decides hits (`match.ts:537`), so a native host must use the **same table** (`difficulty.ts:50-131`), or a web guest takes different damage from the same difficulty setting.
- Bot health = `profile.health` (70, 85, 100 or 100; `difficulty.ts:61,81,101,121`). A web guest's hits on host bots are forwarded and applied by the host (`proxies.ts:17`, `bot.ts:169-185`).
- No friendly fire from the same team: `bot.ts:172-173`.

### 4.5 Hit volumes and body dimensions

- `Bot.hitTest` = `hitTestHumanoid(position, crouching, …)` (`bot.ts:165-167`, owned by `src/game/hitbox.ts:30`). It is posture-only, independent of the animated skeleton. A web guest hit-tests proxies of host bots with the same function, so the native port must reproduce `hitbox.ts` exactly (game group).
- `BODY` (`body.ts:8-16`): radius 0.34, stand 1.8, crouch 1.2, eye 1.64 / 1.08, chest 1.2 / 0.75. These match the player and drive the eye position in line-of-sight checks and shot origins.

### 4.6 Duel bot side and uniform

- `duelBotSide(owner, role)`: team is alpha where the owner is the local player; the uniform is the owner's (host = alpha, guest = bravo) (`src/net/rules.ts:38-40`).
- The host spawns with `config.botTeam` (`game.ts:255,420`), set at `src/net/session.ts:523`.
- The bot respawns after `RESPAWN_SECONDS` when down (`game.ts:411-421`).
- The duel is scored by side (`game.ts:476-477`).
- The guest creates proxies with `createSoldier(assets, uniform)` (`proxies.ts:29,54`). `TEAM_TINT` (`rig.ts:57-60`: alpha `0x8f7d5e`, gain 1.75, amount 0.7; bravo `0x4f5a34`, gain 2.0, amount 0.92) must match so both players read sides the same way.

### 4.7 Visual reading of the pose (native guest showing a web host's bots, and vice versa)

`SoldierVisual.setState` must interpret the fields identically:

- Speed bands: `locomotion.ts:25-35`.
- Carry above 4.4 m/s when not aiming (`soldier.ts:28,262`).
- Aim hold 0.6 s after firing (`soldier.ts:26,259`).
- Reload cycle 2.3 s (`soldier.ts:58,265`).
- Pitch clamp 1.2 rad (`soldier.ts:55,264`).

These only affect looks, not protocol, but a visibly wrong carry or aim reads as a different game.

### 4.8 Seeds (parity, not protocol)

- Bot RNG: `seededRandom(hashString('ironvale-bots'))`, mulberry32 seeded with FNV-1a (`manager.ts:67`, `core/random.ts:2-21`). It is only ever consumed on the host. Port it exactly anyway, so `tests/ai/*` expectations port one-to-one.
- `Recoil.side = sin(shots × 12.9898) × 0.9` (`reactions.ts:100`) is a fixed sequence, cosmetic.

### 4.9 Navigation grid as minimap input

`BotSystem.grid` feeds the minimap layout (`minimap.ts:263`), and a guest in co-op also builds a
grid (`enterMap` always runs, `game.ts:235`). The grid build depends on `World.raycast`,
`groundHeight` and `moveCapsule` matching the web collision world. If the native collision world
differs, the minimap and bot reachability differ, but not the protocol.

---

## 5. Proposed Swift module layout

```
IronvaleAI/                      (Swift package target; no Metal dependency)
  Nav/
    NavGrid.swift               struct NavGrid (SoA arrays, neighbor, nodeAt, nearestNode, walkLine)
    NavGridBuilder.swift        struct NavGridBuilder: resumable step() over 5 passes; protocol NavWorld
    Pathfinder.swift            final class Pathfinder (heap, octile, avoid), PathHandle (fixed 48 points)
    PathQueue.swift             final class PathQueue (FIFO + node budget)
    Cover.swift                 enum CoverKind, func coverAgainst, struct CoverQuery, func findCover
  Brain/
    BotEnv.swift                protocol BotEnv
    Brain.swift                 func think(_:env:dt:), sense, roam, learn
    Tactics.swift               fight, chooseTactic, step
    TacticsCover.swift          startCover, inCover, hide, findPeek, startFallback, inFallback
    TacticsOpen.swift           strafe / hold / suppress / push / flank
    TacticsUtil.swift
    Squad.swift                 final class Squad (blackboard), enum BotState, enum CalloutKind
    Perception.swift            enum Vision, effectiveVisionRange, inVisionCone, hearingRadius, struct Awareness
  Combat/
    AimModel.swift              struct AimModel
    BotWeapon.swift             struct BotWeapon + BurstTiming
    Marksman.swift
  Data/
    Difficulty.swift            struct DifficultyProfile, static table, scaledWeapon(_:_:)
    Roles.swift                 enum BotRole, struct RoleDef, assignRoles, botName
    Spawn.swift                 orderSpawns, assignSpawns, inViewCone
  Bot/
    BotBody.swift               class BotBody (locomotion, footsteps)
    Bot.swift                   final class Bot: BotBody, Combatant
    BotManager.swift            final class BotManager: BotSystem, BotEnv
  Random/
    Mulberry32.swift            struct Mulberry32: RandomNumberGenerator; fnv1a(_:)

IronvaleCharacters/              (depends on IronvaleRender for GPU types)
  Anim/
    ClipData.swift              struct ClipData (frames x 22 x 4 Float), sampleClip, blendPose, steerBone
    Pose.swift                  struct Pose
    Locomotion.swift            GaitWeights, gaitWeights, advancePhase, clipTimeAtPhase, resolveHeading
    Reactions.swift             struct Flinch, struct Recoil
    Death.swift                 planDeath, deathFrame, struct GunDrop
    LOD.swift                   poseInterval, shouldPose, VisibilityTracker
  Rig/
    SoldierRig.swift            final class SoldierRig (shared: parents, offsets, rest, arms, fingers, clips)
    SoldierAsset.swift          loader for converted soldier/carbine binary (or GLTFKit2 adapter)
    IK.swift                    ArmSetup, calibrateArm, solveArm, quatFromBasis
    GunHold.swift               CARBINE points, struct GunHold
    Skeleton.swift              struct SkeletonState (modelQ, modelP, adjust), apply, measure, setArm
  Soldier.swift                 final class Soldier: SoldierVisual (CPU pose -> joint palette)
  SoldierRenderer.swift         Metal pipeline: skinned PBR + team tint + shadow variant, instanced
  Shaders/Soldier.metal

IronvaleAIDebug/                 (optional) BotDebugOverlay, label textures
```

Key protocols, shared with other groups:

- `protocol NavWorld { raycast, groundHeight, moveCapsule }`, a subset of `World`.
- `protocol Combatant`, `protocol SoldierVisual`, `protocol BotSystem`, mirroring `src/game/contracts.ts`.

Design notes:

- Keep the AI module **renderer-free**. `Bot.shoot` currently reads `visual.muzzleWorld()`, which ties the sim to a posed skeleton that LOD may not have refreshed for up to 6 frames. Natively, compute the muzzle from a sim-side `GunHold` evaluation, or keep the 1.5 m sanity fallback as is.
- Swift 6 strict concurrency: make the sim `@MainActor` (or a single `SimActor`). Make `NavGrid` an immutable `Sendable` value once built, so the build can run off the main thread.
- Preallocate everything as the TS does (`PathHandle` with fixed 48 points, the pooled `Soldier`s per team at `manager.ts:94,237,395-405`).

---

## 6. Risks, unknowns, difficulty and effort

### Risks

1. **Collision world parity** (owned by world/physics). The nav build and bot movement depend on `raycast`, `groundHeight`, `moveCapsule` and `lineOfSight` (BVH via three-mesh-bvh on the web). Differences change walkable cells, cover masks and stuck behaviour, but not the protocol. A test that builds the grid on the same map in both builds and compares node counts and edge masks would catch drift. The web has `tests/ai/navgrid.test.ts` and `water.test.ts` as models.
2. **Float precision.** JS works in doubles; `NavGrid.nodeY` and path points are Float32. Use `Double` for positions and timers in the sim to reproduce web tests exactly, or accept `Float` and loosen the test tolerances. Not a protocol issue (positions go out as float32).
3. **Rounding and modulo semantics**: `Math.round` (.5 toward +∞) in `directionToward` (`cover.ts:8`) and `bot.ts:130-131`; JS `%` in `wrapAngle` (`bot.ts:356`) and `nodeX` / `columnAt`. Easy to get subtly wrong.
4. **Muzzle coupling to the renderer** (`bot.ts:270`). Needs a decision; see §5.
5. **Skinned rendering from scratch.** Three gave cloning, skinning, a PBR node material and shadows for free. Natively you need a joint-palette upload, a skinning vertex shader, a team-tint fragment shader, a shadow variant and frustum-cull feedback for LOD. glTF ingestion is the main unknown; prefer an offline converter to avoid a runtime glTF dependency.
6. **Euler conventions and quaternion multiply order** (`'XYZ'` vs `'YXZ'`, `premultiply`). A mismatch makes poses look broken rather than failing loudly. Port `tests/characters/*` first (ik, gun-hold, pose, locomotion, death, reactions are all pure-math tests).
7. **Soldier always renders the carbine** whatever the weapon (`rig.ts:160`, `soldier.ts:161`). Marksmen and gunners show an M4 shape. Keep this for parity unless the web changes it.
8. **Web keeps evolving.** Recent commits touched bots, duels and weapons (`cbe0add`, `71ae079`, `31005af`, `0f462c3`). Difficulty, roles and marksman constants are the most likely to drift. Generate `Difficulty.swift` and `Roles.swift` from the TS sources with a script, or check them with a CI test, rather than copying by hand.
9. **Host takeover.** A native guest must be able to start running AI mid-match (`game.ts:438-445`), so the AI module must ship in every client, not only on hosts.

### Unknowns

- Whether the native renderer will expose a frustum-visibility callback per object (needed by LOD).
- Whether the native world/physics will offer a thread-safe query API (needed to build the nav grid off-thread).
- Whether `hitbox.ts` is ported by the game group with a shared test vector set.

### Difficulty and effort

| Part | Difficulty | Days |
|---|---|---:|
| Nav grid, builder, pathfinder, cover (+ port navgrid, pathfinder, cover and water tests) | Medium | 4 |
| Brain, tactics, squad, perception, aim, weapon, difficulty, roles, spawn (+ tests) | Medium | 4 |
| BotManager, BotBody, Bot, events, hearing, pooling, stats; snapshot field conventions | Medium | 2.5 |
| Pose, locomotion, reactions, death, LOD, IK, gun-hold math (+ characters tests) | Medium | 3 |
| Asset pipeline (offline glb → native binary), rig building, finger curls | Medium-high | 2.5 |
| Metal skinned PBR + team tint + shadow pass + instancing + LOD visibility hook | High | 4 |
| Cross-play verification (native host ↔ web guest bots; native guest ↔ web host bots; duel bot both ways) | Medium | 2 |
| Debug overlay (optional) | Low | 1 |
| **Total** | **Medium-high** | **~23** |

The AI port is mostly mechanical, because the code is already allocation-free, data-oriented and
well commented. The hard parts are the skinned-character rendering stack and keeping the
outward bot contract (§4) identical while the web version keeps changing.

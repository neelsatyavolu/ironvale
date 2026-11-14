# Porting map: net-game (`src/net`, `src/game`, `signaling/src`)

Target: native macOS app in Swift 6.4 + Metal that **cross-plays with the browser build**. The web build keeps evolving, so this document treats the TypeScript as the reference implementation and the wire format as a contract that both sides must keep in step.

Everything below was read from the code at commit `cbe0add`. Line references are `file:line`.

---

## 1. Purpose and structure

Two-player play (co-op against bots, or a 1v1 duel) over a direct WebRTC connection. A Cloudflare Worker relays only the WebRTC handshake. After the two data channels open, the relay socket is closed and all traffic is peer to peer. There is **no dedicated server and no lockstep**: each machine simulates its own player (and the host also runs the bots) and streams state to the other side.

### src/net (3,734 lines)

| File | Lines | Responsibility |
|---|---|---|
| `wire.ts` | 17 | Protocol version, wire-id ranges, hard limits shared by both codecs |
| `protocol.ts` | 345 | Binary codec: player state, bot snapshot, shot, ping, pong (little-endian `DataView`) |
| `events.ts` | 269 | JSON event union `NetEvent`, the validator `parseEvent`, and `encodeEvent` |
| `limits.ts` | 96 | Name and chat sanitising, damage cap, `TokenBucket`, per-weapon `WeaponGate` |
| `room-code.ts` | 44 | Six-character room codes, invite link `?join=` |
| `invite.ts` | 103 | Copy-and-paste codes: `IVH1.`/`IVG1.` + base64url(deflate-raw(SDP)) |
| `ice.ts` | 69 | STUN list, `VITE_ICE_SERVERS` parsing, TURN fetch from `/ice` |
| `signaling.ts` | 275 | `RoomSignaling` (WebSocket relay) and `ManualSignaling` (paste codes); `parseSignal` |
| `transport.ts` | 194 | `PeerLink`: one `RTCPeerConnection`, two negotiated data channels, backpressure |
| `clock.ts` | 64 | `ClockSync`: offset and RTT estimation from ping/pong |
| `interp.ts` | 167 | `SnapshotBuffer`: time-sorted ring buffer, interpolation and capped extrapolation |
| `remote-soldier.ts` | 276 | `RemoteSoldier`: a `Combatant` driven by snapshots (the other player, or a bot proxy) |
| `proxies.ts` | 125 | `BotProxies`: the guest's stand-ins for the host's bots |
| `match.ts` | 673 | `MatchSync`: per-match send/receive, hit and death authority, anti-cheat gates |
| `session.ts` | 708 | `NetSession`: lobby state machine, connect lifecycle, countdown, timeouts, peer loss |
| `rules.ts` | 45 | Duel spawn choice, duel result, duel-bot side |
| `api.ts` | 187 | Public types: `NetSystem`, `NetLobby`, `LobbyState`, `NetGameHooks`, `DEFAULT_NET_CONFIG` |
| `index.ts` | 20 | `createNet()` factory |

### src/game (1,338 lines)

| File | Lines | Responsibility |
|---|---|---|
| `contracts.ts` | 578 | Interfaces between all subsystems: `Combatant`, `GameEvents`, `WeaponDef`, `MatchConfig`, `MatchSnapshot`, `GameContext`, and more. Conventions are at `contracts.ts:5`: metres, seconds, radians, Y up, right-handed, **yaw 0 looks down -Z**. |
| `game.ts` | 606 | `Game`: owns the context, loads maps, runs the frame loop, applies match rules (lives, waves, duel scoring), emits `matchState` |
| `combat.ts` | 68 | `Combat`: combatant registry, id allocation, bullet raycast against world and bodies |
| `hitbox.ts` | 86 | `hitTestHumanoid`: three vertical capsules (head, torso, limb) |

### signaling/src (340 lines)

| File | Lines | Responsibility |
|---|---|---|
| `index.ts` | 146 | Worker entry: `/health`, `/ice` (Cloudflare TURN credentials), `/room/<code>` WebSocket to a Durable Object; `RoomObject` |
| `room.ts` | 194 | Pure room logic: admission, relay filter, per-socket token bucket, TTL, close codes |

The Swift app does **not** reimplement the Worker. It is a client of the deployed relay, `wss://ironvale-signal.n3el.dev` (`signaling/wrangler.jsonc` route). `signaling/src` is documented here only as the protocol counterpart.

---

## 2. Interfaces

### What other subsystems use from net

- `createNet(ctx, hooks): NetSystem` (`net/index.ts:18`). It is constructed in `Game` (`game.ts:132`).
- `NetSystem` (`api.ts:133-160`): `inMatch`, `authority`, `frozen`, `partner`, `partnerKills`, `hostMatch`, `snapshot()`, `enterMap()`, `matchLoaded()`, `leaveMap()`, `pickSpawn()`, `reportMatch()`, `update(dt, running)`, `dispose()`.
- `NetLobby` (`api.ts:99-122`) is used by the UI (`ui/index.ts`, `ui/screens/friend.ts`, `ui/hud/chat.ts`, `ui/hud/hud.ts`): `state`, `subscribe`, `roomCodesAvailable`, `host`, `join`, `acceptReply`, `setConfig`, `setReady`, `start`, `leave`, `setName`, `sendChat`, `onChat`.
- `NetSnapshot` is embedded in `MatchSnapshot.net` (`contracts.ts`, HUD).
- `duelResult` from `rules.ts` is used by `game.ts:374`.

### What net needs from the game (`NetGameHooks`, `api.ts:163-177`)

`weapons` (current weapon id, aim blend, reloading), `bots`, `listMaps()`, `startMatch(config)`, `endMatch(result)`, `waveStarted()`, `takeOver(enemies, wave)`, `kills`, `deaths`.

### What net reads from `GameContext`

- `ctx.player`: position, velocity, yaw, pitch, crouching, sprinting, alive, onGround, health, id, team, eyePosition.
- `ctx.combat`: `allocateId`, `add`, `remove`, `get`, `all`.
- `ctx.events`: listens to `shotFired`, `bulletTrace`, `weaponAction`, `weaponSwitch`, `spawned`, `died`, `grenadeThrown`, `grenadeExploded`, `combatantHit`. Emits those plus `bulletImpact`, `nearMiss`, `footstep`.
- `ctx.world`: `raycast`, `capsuleFits`.
- `ctx.grenades`: `launch(owner, origin, vel, authoritative=false)`, `detonate`.
- `ctx.engine.scene`: add and remove soldier visuals.
- `ctx.assets`: `createSoldier`.
- `ctx.settings`: default difficulty.

Bot fields are read by duck typing (`match.ts:53-60`, `BotView`): `yaw`, `pitch`, `speed`, `watch === 'enemy'` (sent as "aiming"), `weaponDef.id`, `weapon.reloading`, `name`. The Swift `Bot` type must expose these.

### What game depends on

Nearly everything: ai, audio, characters, core (assets, events, input, random, settings), fx, maps, player, render, ui, weapons, world. `contracts.ts` is the type hub. 93 files outside `src/game` import from it.

---

## 3. Browser and Three.js APIs and their Apple equivalents

| Used in | Web API | Swift / Apple equivalent |
|---|---|---|
| transport.ts | `RTCPeerConnection`, `createDataChannel({negotiated,id,ordered,maxRetransmits})`, `bufferedAmount`, ICE events | Google WebRTC framework (`RTCPeerConnection`, `RTCDataChannelConfiguration` with `isNegotiated`, `channelId`, `isOrdered`, `maxRetransmits`). See §5.4 |
| signaling.ts | `WebSocket` with custom close codes 4000-4429 | **Network.framework** `NWConnection` + `NWProtocolWebSocket.Options` (`setAdditionalHeaders` for `Origin`; close code arrives as `NWProtocolWebSocket.CloseCode.privateCode(UInt16)`). `URLSessionWebSocketTask` works too, but reading 4xxx close codes is awkward. |
| signaling.ts, ice.ts | `fetch` + `AbortController` timeout | `URLSession.data(for:)` with `timeoutInterval` (2.5 s for health, 3 s for ice) |
| invite.ts | `CompressionStream('deflate-raw')` / `DecompressionStream` | `Compression` framework, `COMPRESSION_ZLIB`. This is raw RFC 1951 deflate with no zlib header, so it matches `deflate-raw`. Cap output at 12,000 bytes. |
| invite.ts | `btoa`/`atob` + URL-safe replace | `Data.base64EncodedString()` then `+`→`-`, `/`→`_`, strip `=`. Pad before decoding. |
| room-code.ts | `crypto.getRandomValues` | `SystemRandomNumberGenerator` / `UInt32.random(in:)` |
| room-code.ts | `URL`, `searchParams` | `URLComponents` |
| session.ts, match.ts | `performance.now()` (ms, float64, monotonic) | `ContinuousClock` or `mach_continuous_time` converted to **Double milliseconds since app start**. The value must be ≥ 0 and < 1e12 (`wire.ts:14`) or the peer drops it. |
| session.ts | `localStorage['ironvale.net.v1'] = {"name":…}` | `UserDefaults` |
| session.ts | `document.visibilitychange` → `away` event | `NSApplication.didResignActive/didBecomeActive` or window occlusion |
| session.ts | `pagehide` → `bye` | `applicationWillTerminate` / window close: send `bye{left}` before tearing down |
| session.ts, transport.ts | `setTimeout`/`clearTimeout` | `Task.sleep` inside a cancellable `Task`, or `DispatchSourceTimer` |
| ice.ts, signaling.ts | `import.meta.env.VITE_SIGNAL_URL`, `VITE_ICE_SERVERS`, `DEV`, `?signal=` | Info.plist / xcconfig keys; a launch argument for the dev override |
| game.ts | `?dev` (adds `range` map) | Launch argument / debug build flag |
| events.ts, signaling.ts | `JSON.parse`/`JSON.stringify` | `JSONSerialization` for parsing. The validator must check types field by field and accept *any* extra fields, so do not use strict `Codable`. Encode with a hand-written encoder or `JSONEncoder`. |
| protocol.ts | `DataView` LE get/set | `withUnsafeBytes` + `.littleEndian`, or a small `ByteWriter`/`ByteReader` |
| limits.ts | Unicode regex `\p{L}\p{N}`, `\p{Cc}\p{Cf}` | `Character.properties` / `Unicode.Scalar.Properties.generalCategory` |
| match.ts, remote-soldier.ts, game.ts | `three` `Vector3` (float64 math) | `SIMD3<Double>` for gameplay math, to match JS precision. Convert to `SIMD3<Float>` only at the render boundary. |
| proxies.ts, match.ts | `scene.add/remove(visual.root)` | Renderer scene graph API from the render group |
| game.ts | `Object3D.traverse/dispatchEvent('dispose')` | Not needed. Metal resources are released by ARC. |
| game.ts | `engine.onFrame` (rAF) | `CAMetalDisplayLink` / `MTKView` delegate |

---

## 4. Cross-play-critical behaviour

### 4.1 Signaling relay protocol (deployed Worker)

**Base URL.** `VITE_SIGNAL_URL`, normalised (`signaling.ts:85-90`): trailing slashes removed, must match `^(wss?|https?)://`. HTTP calls use `ws→http`, the socket uses `http→ws`.

**HTTP endpoints** (`signaling/src/index.ts:66-97`)

| Request | Rule | Response |
|---|---|---|
| `GET /health` | No origin check | `200 {"ok":true}`. The client treats any 2xx within 2.5 s as reachable (`signaling.ts:101-113`). |
| `GET /ice` | **Requires an `Origin` header listed in `ALLOWED_ORIGINS`**, otherwise 403. Rate-limited per IP; over the limit returns 429. | `200 {"iceServers":[{urls,username,credential},…]}`. Cloudflare TURN, 4 h TTL, port-53 URLs removed (`index.ts:37-63`). |
| `GET /room/<CODE>?role=host\|guest` | Must be a WebSocket upgrade (else 426). `Origin` must be allowed (else 403). Code must match `^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$` and role must be valid (else 400). Rate limit 30 per minute per IP, shared with `/ice` (`wrangler.jsonc`), else 429. | 101 |

> **Native blocker: `Origin`.** `ALLOWED_ORIGINS` is `https://ironvale.n3el.dev` (`wrangler.jsonc`). A native client has no origin of its own. It must either send `Origin: https://ironvale.n3el.dev` explicitly (works today; Network.framework and URLSession both allow it), or the deployment adds a second value such as `app://ironvale` to `ALLOWED_ORIGINS`. The second option changes `wrangler.jsonc` vars only, not `signaling/src`. Choose one before any integration test.

**Room WebSocket messages.** All are JSON text frames.

Relay → client (`room.ts:134-135, 171`):
- `{"type":"room","peer":<bool>}`: sent once, right after admission. `peer` says whether the other seat is filled.
- `{"type":"peer","joined":<bool>}`: the other side arrived (`true`) or the guest left (`false`, sent to the host only).

Client → relay → other client. Only these three types are relayed (`room.ts:27`, `checkRelay` `room.ts:66-81`). Binary frames, non-objects, unknown types and frames over 16,384 UTF-8 bytes are dropped silently.
- `{"type":"offer","sdp":"…"}`
- `{"type":"answer","sdp":"…"}`
- `{"type":"candidate","candidate":{"candidate":"…","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":"…"}}`. This is the browser's `RTCIceCandidate.toJSON()` (`transport.ts:77`). The receiver's limits (`signaling.ts:46-82`): sdp ≤ 12,000 chars, candidate ≤ 1,000, sdpMid ≤ 32, ufrag ≤ 256, `sdpMLineIndex` an integer. Missing fields become `null`. Native code must send the same shape. Browsers need `sdpMid` or `sdpMLineIndex` to add the candidate.

**Relay rate limit per socket** (`room.ts:10-18, 89-94`). Token bucket with burst 40 and refill 4 per second. Running out closes the socket with **4008**. Trickle ICE with many candidates is fine. Do not resend in loops.

**Close codes** (`room.ts:20-24`, `index.ts:14,115`, client mapping `signaling.ts:116-135`)

| Code | Meaning | Client error |
|---|---|---|
| 1000 | Normal | none |
| 4000 | Room expired (10 min after the host opened it, `roomTtlMs`) | `room-expired` |
| 4001 | Host left; the guest is kicked | `peer-left` |
| 4008 | Flooding | `rate-limited` |
| 4404 | Refused: no host under that code | `no-room` |
| 4409 | Refused: seat taken. The host retries with a new code, up to 4 attempts in total (`signaling.ts:218-221`) | `room-full` |
| 4410 | Refused: expired | `room-expired` |
| 4429 | Mapped by the client but never sent (a 429 is an HTTP response before the upgrade, so a browser sees 1006) | `rate-limited` |
| other | Before open: `signal-unreachable`. After open: guest `peer-left`, host `signal-unreachable` | |

Refusals are accepted first and then closed with code `4000 + HTTP status` and a reason string (`index.ts:113-116`).

**Room behaviour** (`room.ts:126-177`). There are two seats. The host must arrive first; a guest without a host gets 4404. A second host gets 4409. When the host leaves, the guest is closed with 4001 and the room is cleared. When the guest leaves, the host gets `peer:false` and keeps the code.

**Room code** (`room-code.ts`). Alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (31 characters), length 6, `floor(rand*31)` per character. Normalise input by upper-casing and removing `[^A-Z0-9]`. The code is extracted from an invite link with `/[?&#]join=([A-Za-z0-9-]+)/`. The invite link is `<page>?join=<CODE>` (`room-code.ts:38-44`). For the native app, register a URL scheme or universal link that accepts the same `join` parameter, so a browser host's invite link can open the native app.

### 4.2 Connection sequence (room method, trickle ICE)

```
Host                              Relay                         Guest
GET /ice (3 s timeout) ─────────►                                (guest does the same)
WS /room/ABC234?role=host ──────►
          ◄──── {"type":"room","peer":false}   → host shows code (step waiting)
                                         ◄──── WS /room/ABC234?role=guest
          ◄──── {"type":"peer","joined":true}  {"type":"room","peer":true} ────► (step connecting)
create PeerLink, createOffer,
setLocal, send offer ───────────► relayed ────────────────────► setRemote(offer), flush queued candidates,
candidates (trickle) ───────────► relayed ────────────────────► createAnswer, setLocal, send answer;
          ◄────────────────────── relayed ◄──────────────────── answer + candidates
setRemote(answer), 25 s connect timer                            25 s connect timer (room method)
          ════════ both data channels open ════════
close relay socket (1000)                                        close relay socket (1000)
send hello{v:4,name}, lobby{config}                              send hello{v:4,name}
```

Sources: `session.ts:250-309` (open), `session.ts:311-339` (makeLink), `session.ts:359-370` (onConnected), `transport.ts:90-121`.

- The **host is always the offerer**. The offer is made when `onPeer(true)` arrives (`session.ts:272`). If the guest leaves before connecting, the host drops the link and waits again (`session.ts:266-270`).
- Candidates that arrive before the remote description are queued, at most 64, newest kept (`transport.ts:111-115`).
- ICE servers are `[STUN, …VITE_ICE_SERVERS (max 6 extra), …/ice result]` (`ice.ts:2, 43-45`, `session.ts:314`). STUN is `stun:stun.cloudflare.com:3478` and `stun:stun.l.google.com:19302`. Valid URL schemes are `stun:`, `turn:` and `turns:`; each URL must be under 200 characters; at most 8 URLs per entry (`ice.ts:3-10`).
- Connect timeout is **25 s** after the answer (host) or offer (guest, room method) (`session.ts:42, 346-352`).
- The link is finished when the `events` channel closes, or when `connectionState` is `closed`, or `failed` while `failFast || opened` (`transport.ts:74-82`). The manual-method guest sets `failFast=false`, because the host may paste the reply minutes later (`transport.ts:96-98`).

### 4.3 Manual (copy-and-paste) method

`invite.ts`. There is no trickle: wait until ICE gathering is `complete` or **4 s** have passed (`transport.ts:9, 171-193`), then encode `localDescription.sdp`.

- Encode: `prefix + base64url_nopad(deflate_raw(utf8(sdp)))`. The host offer prefix is `IVH1.`; the guest answer prefix is `IVG1.`.
- Decode (`invite.ts:86-103`): strip all whitespace. Empty → `empty`. Over 6,000 chars → `too-long`. The other kind's prefix → `wrong-kind`. Missing prefix → `malformed`. The body must match `^[A-Za-z0-9_-]+$`. Inflated output is capped at 12,000 bytes. The SDP must start with `v=0` and contain only `[\x20-\x7e\r\n]`.
- The host learns of the peer immediately (`onPeer(true)`, `signaling.ts:243-246`), so its offer *is* the invite.

### 4.4 Data channels

Created on **both** sides with pre-negotiated ids, so there is no DCEP announcement (`transport.ts:52-55`):

| Label | id | Ordered | Reliability | Carries |
|---|---|---|---|---|
| `state` | 0 | **false** | `maxRetransmits: 0` | Binary: player state (type 1), bot snapshot (2), ping (4), pong (5) |
| `events` | 1 | true | reliable | **Text** frames: JSON `NetEvent`. **Binary** frames: shot (type 3) |

- The link counts as open only when both channels are `open` (`transport.ts:57-61`).
- **Text versus binary matters.** The `events` channel distinguishes JSON from shots by frame type (`session.ts:322-326`). A native sender must send JSON as a WebRTC *string* message (SCTP PPID 51, `RTCDataBuffer(data:isBinary:false)`) and shots as *binary* (PPID 53). JSON sent as binary arrives as an ArrayBuffer whose first byte `{` = 0x7B is not a known type, so it is silently dropped. The reverse mistake also drops the message silently.
- Inbound frames over **8,192** bytes are dropped (`transport.ts:14, 66, 70`). Event JSON over **2,048** UTF-16 units is rejected (`wire.ts:9`, `events.ts:256`). Measure Swift strings with `.utf16.count`.
- Backpressure: `state` sends are skipped when `bufferedAmount > 16,384` (`transport.ts:11, 125`). `events` sends fail when `bufferedAmount > 1,000,000` (`transport.ts:13, 135`).
- Pings and pongs travel on the **unreliable** channel (`session.ts:403, 682`).

### 4.5 Binary layouts (all little-endian)

`protocol.ts:16-33`. Constants: `ANGLE_SCALE=10000`, `VELOCITY_SCALE=100`, `SPEED_SCALE=20`, `DIRECTION_SCALE=32767`.

`int16(v, s) = clamp(round(v*s), -32767, 32767)` (`protocol.ts:107-109`). **`round` is JS `Math.round`, which rounds halves toward +∞** (−2.5 → −2). Swift `.rounded()` rounds halves away from zero. Use `(v*s + 0.5).rounded(.down)` to match bit for bit.

`wrapAngle(a) = ((a+π) mod 2π + 2π) mod 2π − π` (`protocol.ts:101-105`). JS `%` is truncated remainder; use `fmod` (not `remainder`).

`weaponIndex(id)` is the index in **`WEAPON_IDS = ['m4a1','mp5','m24','m249','m7','scarh']`** (`weapons/models/api.ts:5`); an unknown id maps to 0. **This order is part of the protocol.** Adding a weapon appends to it, and any reorder breaks cross-play. Decoders reject an index outside the list (`protocol.ts:158, 226, 282`).

**PlayerState: type 1, exactly 37 bytes** (`protocol.ts:123-150`)

| Off | Type | Field |
|---|---|---|
| 0 | u8 | 1 |
| 1 | u16 | seq & 0xFFFF (sender counter; the receiver does not use it for ordering) |
| 3 | f64 | time: sender's `performance.now()` ms |
| 11 | f32 ×3 | x, y, z (feet) |
| 23 | i16 ×3 | vx, vy, vz × 100 |
| 29 | i16 | wrapAngle(yaw) × 10000 |
| 31 | i16 | clamp(pitch, −π/2, π/2) × 10000 |
| 33 | u8 | flags: 1 crouching, 2 sprinting, 4 aiming (aimBlend > 0.5), 8 alive, 16 onGround, 32 reloading |
| 34 | u8 | weapon index |
| 35 | u8 | health, clamp(round, 0, 100) |
| 36 | u8 | life & 0xFF (lives start at 0 and go +1 per spawn, capped at 255, `match.ts:357-361`) |

Decode rejects: length ≠ 37, time not in [0, 1e12], any coordinate non-finite or |c| > 5000, unknown weapon, health > 100 (`protocol.ts:152-160`).

**BotSnapshot: type 2, 12 + 20·n bytes, n ≤ 48** (`protocol.ts:189-245`)

| Off | Type | Field |
|---|---|---|
| 0 | u8 | 2 |
| 1 | u16 | seq |
| 3 | f64 | time (ms) |
| 11 | u8 | count n |
| 12+20i+0 | u16 | wire id (≥ 2) |
| +2 | f32 ×3 | x, y, z |
| +14 | i16 | wrapAngle(yaw) × 10000 |
| +16 | i8 | clamp(round(pitch in **degrees**), −90, 90) |
| +17 | u8 | clamp(round(speed·20), 0, 255), horizontal m/s |
| +18 | u8 | flags: 1 crouching, 2 aiming (`watch==='enemy'`), 4 reloading, 8 alive |
| +19 | u8 | weapon index |

More than 48 bots are sent as several snapshots. With zero bots, one empty snapshot is still sent (`match.ts:289-291`).

**Shot: type 3, 23 + 12·n bytes, n ≤ 12** (`protocol.ts:247-300`). Sent on the **reliable `events` channel**.

| Off | Type | Field |
|---|---|---|
| 0 | u8 | 3 |
| 1 | u16 | actor wire id |
| 3 | u8 | weapon index |
| 4 | f32 ×3 | muzzle |
| 16 | i16 ×3 | direction × 32767 |
| 22 | u8 | n end points |
| 23+12i | f32 ×3 | end point i (where each projectile stopped) |

Decode rejects a direction whose length is outside [0.9, 1.1] and renormalises it.

**Ping: type 4, 10 bytes:** `u8 4, u8 id, f64 sentAt`.
**Pong: type 5, 18 bytes:** `u8 5, u8 id, f64 sentAt (echoed), f64 remoteTime (responder's now)`.

**Golden vectors.** These were generated from the TS encoders at `cbe0add`. Use them as Swift unit-test fixtures.

```
PlayerState{seq 513, time 12345.5, pos (1.5,0,-2.25), vel (3.21,-0.5,0), yaw 1, pitch -0.25,
            crouching, aiming, alive, onGround, weapon m24, health 87, life 3}
01 01 02 00 00 00 00 c0 1c c8 40 00 00 c0 3f 00 00 00 00 00 00 10 c0 41 01 ce ff 00 00 10 27 3c f6 1d 02 57 03

Bots{seq 7, time 1000, [id 5, pos (10,1,-4), yaw -3, pitch 0.5 rad, speed 4.6, aiming, alive, mp5]}
02 07 00 00 00 00 00 00 40 8f 40 01 05 00 00 00 20 41 00 00 80 3f 00 00 80 c0 d0 8a 1d 5c 0a 01

Shot{actor 1, m4a1, muzzle (0,1.6,0), dir (0,0,-1), ends [(0,1.6,-20)]}
03 01 00 00 00 00 00 00 cd cc cc 3f 00 00 00 00 00 00 00 00 01 80 01 00 00 00 00 cd cc cc 3f 00 00 a0 c1

Ping{9, 250}          04 09 00 00 00 00 00 40 6f 40
Pong{9, 250, 9000.25} 05 09 00 00 00 00 00 40 6f 40 00 00 00 00 20 94 c1 40
```

Port `tests/net/protocol.test.ts` (305 lines, including the fuzz and truncation cases) to Swift Testing as well.

### 4.6 JSON events (`events` channel, text)

Discriminator key `t`. Each event is rebuilt field by field and **unknown fields are dropped** (`events.ts:160-249`), so adding a field is backward compatible but removing one is not. Validation rules:

| `t` | Fields and validation | Direction |
|---|---|---|
| `hello` | `v` int 0..1000, `name` string → `sanitizeName` | both, on connect and name change |
| `lobby` | `config: NetMatchConfig` | host → guest, on connect and every `setConfig` |
| `ready` | `ready` bool | guest → host |
| `load` | `config` | host → guest on Start. Ignored unless the guest's `localReady` is true |
| `loaded` | none | both, when the map is loaded |
| `go` | `at` real 0..1e12: **the host's clock** ms | host → guest |
| `hit` | `target`,`attacker` int 0..65535; `weapon` ∈ WEAPON_IDS ∪ {`"grenade"`}; `zone` ∈ head/torso/limb; `amount` real 0..1000 (sender rounds to 0.01, `match.ts:419`); `p` [3] each \|c\| ≤ 5000; `d` [3] each \|c\| ≤ 1.01 | shooter → body owner |
| `death` | `victim`,`killer` wire ids; `weapon` as above; `headshot` bool; `life` int 0..255; `d` [3] ≤ 1.01 | owner → other |
| `action` | `actor` wire id; `weapon` id; `stage` ∈ magOut, magIn, boltBack, boltForward, boltLift, boltClose, shellInsert, beltOpen, beltClose | both |
| `switch` | `weapon` id | both (own player only) |
| `botSpawn` | `id` int 2..65535; `name` → `sanitizeName(…, 'Soldier')`; `weapon`; `p`; `yaw` real −10..10 | host → guest |
| `match` | `wave`,`enemies`,`hostKills`,`guestKills` int 0..100000; `result` ∈ `""`,`won`,`lost` | co-op host → guest |
| `nade` | `p` (≤ 5000), `v` (each axis ≤ 40) | both |
| `boom` | `p` | both |
| `chat` | `text` → `sanitizeChat` (non-empty) | both |
| `away` | `away` bool | both |
| `bye` | `reason` ∈ left/timeout/ended | both |

`NetMatchConfig` (`events.ts:19-30, 145-158`): `mapId` matches `^[a-z0-9-]{1,24}$`; `mode` ∈ coop/duel; `rules` ∈ skirmish/survival; `difficulty` ∈ recruit/regular/veteran/elite; `botCount` int 0..32; `killTarget` int 1..50; `duelBot` ∈ none/host/guest (**when it is absent, read it as `none`**). Default: `{mapId:first map, mode:'coop', rules:'skirmish', difficulty:settings, botCount:8, killTarget:10, duelBot:'none'}` (`api.ts:179-187`). The host clamps `botCount` to 1..32 when it sets it (`session.ts:175`).

JSON number notes: integers must be integral (`Number.isInteger`), so `3` and `3.0` are both accepted. Never emit `NaN` or `Infinity`. Sample from the TS encoder: `{"t":"hit","target":1,"attacker":0,"weapon":"m4a1","zone":"head","amount":86.4,"p":[0,1.65,-20],"d":[0,0,-1]}`.

Sanitisers (`limits.ts`):
- **Name:** drop `[^\p{L}\p{N} _.'-]`, collapse whitespace, trim, slice to 16 UTF-16 units, trim. If the result is empty, use the fallback `Player`.
- **Chat:** `[\p{Cc}\p{Cf}]` → space, collapse whitespace, trim, slice to 140, trim.

### 4.7 Version handshake

`PROTOCOL_VERSION = 4` (`wire.ts:3`). On `hello` with a different `v`, the receiver sends `bye{left}` and fails with `version` (`session.ts:413-418`). The native app must ship the same number. **Every web change to `wire.ts`, `protocol.ts`, `events.ts` or `WEAPON_IDS` needs a matching native release.** Keep a `PROTOCOL_VERSION` changelog and a cross-play CI job (§6).

### 4.8 Clocks and timing

| Constant | Value | Where |
|---|---|---|
| Player state send rate | 30 Hz (`1/30` accumulator, carry capped at one interval) | `match.ts:38, 221-225` |
| Bot snapshot rate (host) | 12 Hz | `match.ts:39, 226-232` |
| Remote player display delay | 100 ms | `match.ts:41` |
| Bot proxy display delay | 170 ms | `proxies.ts:7` |
| Max extrapolation | 250 ms, then `stalled` (velocity zeroed) | `interp.ts:38`, `match.ts:42` |
| Stale state drop | arrival older than 2,000 ms | `match.ts:44, 471-475` |
| Ping cadence | first 8 at 250 ms, then every 1,000 ms; id & 0xFF | `session.ts:43-45, 680-688` |
| Peer timeout | 5,000 ms without player state, counted only while running and not frozen | `session.ts:40, 692-697` |
| Countdown | 3,000 ms | `session.ts:38` |
| Match report (co-op host) | on change, and at least every 500 ms; called from the 20 Hz `emitSnapshot` | `session.ts:47, 618-629`, `game.ts:45, 564` |
| Queued pre-sync events | ≤ 256 | `session.ts:48, 461` |

**ClockSync** (`clock.ts`). Each sample: `rtt = recv − sent`, `offset = remote − (sent + rtt/2)`. Samples with rtt < 0 or > 10,000 ms are rejected. Keep the last 10; the trusted offset is that of the sample with the **smallest rtt** (ties go to the later sample, `<=`). Displayed RTT is an EMA with α = 0.2. `toLocal(t) = t − offset`. The clock is reset on every connect.

**Arrival time** (`match.ts:471-475`): `local = synced ? min(toLocal(sent), now) : now`. The message is dropped if `now − local > 2000`.

**Go time** (`session.ts:443-448, 631-636`). The host sets `goAt = now + 3000` and sends `go{at: goAt}`. The guest sets `goAt = min(now + 9000, max(now, toLocal(at)))`, and only once per match. `frozen = inMatch && now < goAt`.

Because both sides send raw monotonic milliseconds and the offset is estimated, the native clock origin can be arbitrary. It only has to be monotonic, in **milliseconds as a Double**, non-negative and below 1e12.

### 4.9 Interpolation (`interp.ts`)

- Capacity 32, sorted by receiver-clock time. An exact duplicate time is refused. A snapshot older than everything is refused when the buffer is full (`interp.ts:84-95`).
- `sample(t)`:
  - `t ≥ newest`: extrapolate along `v` for `min(ahead, 250)` ms. Returns `interpolated` if `ahead == 0`, `extrapolated` if ≤ 250, otherwise `stalled` with velocity zeroed.
  - `t ≤ oldest`: hold the oldest.
  - Otherwise lerp between the bracketing pair. Yaw uses the shortest arc (`lerpAngle`). If the pair is from different `epoch`s, hold the older one.
- Bots use `deriveVelocity` (velocity from successive positions within one epoch). The player uses the sent velocity.
- `RemoteSoldier.push` (`remote-soldier.ts:125-144`): `epoch = life`. A newer epoch resets the buffer. Flags apply only from the newest snapshot. The body is alive only if `flags.alive && life > endedLife`.

### 4.10 Authority model

There is no server. **Each machine owns its own player's health and death. The host owns every bot.** Hit detection is **shooter-side**: the shooter raycasts against its own interpolated view of the other body, and the body's owner validates and applies the damage.

1. **Shots** (visual only). A local shooter (own player, or a host bot) emits `shotFired` and then one `bulletTrace` per pellet. These are batched into one binary Shot and flushed on the next shot or at frame start (`match.ts:319-345`). The receiver gates the shot by rate (`WeaponGate.allowShot`), plays the muzzle and tracers, makes impact decals only where its own world raycast agrees within 0.6 m, and plays a near-miss within 1.2 m of the eye (`match.ts:520-553`).
2. **Hits.** `RemoteSoldier.applyDamage` → `forwardDamage` → `hit` event (`match.ts:411-423`). Receiver rules (`match.ts:567-611`):
   - `target == myWire`: accepted from the peer only in a **duel** (no friendly fire in co-op), or from a host bot proxy the guest knows about on the opposing team.
   - Host receiving from the peer on a bot wire id: only if that bot's team ≠ the peer's team.
   - Rate gate: per attacker wire id, per weapon. Bucket rate = `rpm/60 × 1.25 × max(1,pellets)` per second; size = `max(2, ceil(rate × 0.75), perShot)` (`limits.ts:66-95`).
   - Grenade hits: only from the peer, only after the peer has thrown (`peerGrenades > 0`), with a match-long budget of `(32+2) × GRENADES_PER_MATCH (=1)` and no refill (`match.ts:138`).
   - Damage cap: `min(amount, damage × max(1, headshotMultiplier))` (`limits.ts:31-39`). **The weapon stats are therefore protocol:** m4a1 27×3.2, mp5 21×2.6, m24 150×3, m249 28×2.8, m7 38×3, scarh 42×3, grenade 200×1 (`weapons/defs.ts`, `grenades.ts:12`, `grenade-math.ts:28`). RPM: 800, 800, 42, 775, 700, 700, grenade 30. Pellets: 1 for all.
3. **Deaths.** The owner emits `death` at frame end, so the fatal direction is known (`match.ts:377-408`). `life` is the victim's life counter, or 0 for bots. The receiver drops a player death whose `life ≤ lastPeerDeathLife` (`match.ts:619`), and drops a bot death if the proxy has already ended.
4. **Grenades.** `nade{p,v}` makes the receiver fly a **non-authoritative** copy, at most 1 per match. The throw speed must be ≤ 16 × 1.05 m/s. The origin snaps to the thrower's eye if it is more than 8 m away (`match.ts:556-565`). `boom{p}` detonates the copy. Blast damage arrives as ordinary `hit` events with `weapon:"grenade"`.
5. **Actions and switches.** These are cosmetic and limited by a 30/s bucket (`match.ts:136`).

**Wire ids** (`wire.ts:5-7`, `match.ts:301-317`): host player = 0, guest player = 1, host bot = `localCombatId + 2`. Bot ids are opaque to the guest, which learns them from `botSpawn`. A wire id that cannot be resolved maps to 65535. Keep combat ids small: `Combat.nextId` starts at 1 and is never reset (`combat.ts:8`), so a very long native session must not overflow 65533.

### 4.11 Game modes and match flow

**Lobby → match** (`session.ts`):
1. Connected: both send `hello`; the host sends `lobby`.
2. The guest presses Ready and sends `ready{true}`. The host changes the config, which sends `lobby`.
3. Host Start (requires `peerReady` and a known map): send `load{config}` and run `beginMatch`. The guest receives `load` (only if `localReady`) and runs `beginMatch`. A guest that does not know the map sends `bye` and fails with `unknown-map`.
4. `beginMatch` builds the local `MatchConfig` (`session.ts:512-547`):
   - `botCount` is `duelBotsHere(...)` in a duel (1 on the host if `duelBot ≠ none`, otherwise 0), and `config.botCount` in co-op.
   - `botTeam` comes from `duelBotSide` (`rules.ts:38-40`).
   - The guest's `localReady` resets to false, so the guest must Ready again for the next match.
5. Map loads. Before the match, `Game` calls `net.enterMap` (creates `MatchSync` and replays queued events), then `spawnPlayer(true)`, issues weapons, and spawns bots **only if `net.authority`**. The co-op guest spawns no bots. Then `matchLoaded` sends `loaded`.
6. When the host has its own `loaded` and the peer's, it sends `go`. Then comes a 3 s countdown while `frozen` (weapons get an empty input).
7. Errors and leaving: `bye` on leave, `pagehide`, dispose, version mismatch, unknown map, load failure, or timeout.

**Co-op** (`mode:'coop'`, rules skirmish or survival):
- The host is authoritative for waves, enemy count and the result (`authority=false` for the co-op guest, `session.ts:472-474`). The guest shows the host's bots as `BotProxies` (team bravo).
- Skirmish: 3 lives each (`game.ts:39`). The match continues while the partner stands. Won when `kills + partnerKills ≥ botCount`, plus a 3.5 s delay (`game.ts:404-408`).
- Survival: with a partner, a fallen player waits for the next wave (`game.ts:385-386, 433-436`). Wave n spawns `botCount + (n−1)×2` after a 5 s pause.
- The host sends `match{wave,enemies,result,hostKills,guestKills}`. The guest applies `hostKills` as `partnerKills`, calls `waveStarted` when the wave increases, and calls `endMatch` on a non-empty result (`match.ts:645-651`). The host flushes pending deaths before a result (`session.ts:621`).
- Host lost: the guest takes over, spawning `proxies.alive` real bots at the host's last wave (`session.ts:663-671`). Guest lost: the host carries on alone.
- Spawning: the guest's initial spawn is `playerSpawns[1]`. Failing that, it is beside spawn 0 at ±1.6 m along `(cos yaw, 0, −sin yaw)`, if a capsule (r 0.34, h 1.8) fits (`session.ts:600-615`).

**Duel** (`mode:'duel'`):
- Each machine plays its own player as team **alpha** and the remote as **bravo**. Uniforms are host alpha and guest bravo on both screens (`match.ts:165-168`).
- Score is by side: any death of the opponent counts as a kill (`game.ts:476-480`). The end is `duelResult(kills, deaths, killTarget)` (`rules.ts:27-31`). Each machine decides on its own; they agree because deaths are reported by the owner.
- Respawn after 3 s. Spawns are taken from `[...playerSpawns, ...enemySpawns]`. The host's initial spawn is index 0. The guest's initial spawn is the one furthest from index 0. Later spawns are furthest from the opponent's current position (`session.ts:591-599`, `rules.ts:13-24`, first max wins with `>`).
- Optional duel bot runs on the host and respawns after 3 s (`game.ts:412-421`).
- Weapons: a duel issues every weapon; co-op restricts M7 and SCAR-H by difficulty (`weapons/loadout.ts:18-23`).
- Peer lost: the match ends at once, `won` if `kills ≥ deaths` (`session.ts:660-662`).

### 4.12 Determinism that must match

- **Map generation:** `module.build({ random: seededRandom(hashString(mapId)) })` (`game.ts:214`). `hashString` is FNV-1a over **UTF-16 code units** with `Math.imul` (`core/random.ts:14-21`). `seededRandom` is mulberry32 (`core/random.ts:2-11`). Swift: `UInt32` arithmetic with `&*` and `&+`, and `>>` on `UInt32`. The result is `Double(t) / 4294967296`. Every map builder must call `random()` in the same order and the same number of times as the TS builder, or props and cover differ between the two players. This belongs to the maps group, but its correctness is a cross-play requirement.
- **Hit volumes** (`hitbox.ts:12-22`). Standing: head 1.60–1.68 r 0.125; torso 0.98–1.42 r 0.24; limb 0.14–0.90 r 0.20. Crouching: head 1.04–1.12 r 0.125; torso 0.56–0.90 r 0.25; limb 0.14–0.46 r 0.24. The first volume hit in head → torso → limb order wins. Because hits are shooter-decided, a mismatch here shows up as unfair hit registration, not a desync.
- **Eye and chest heights** (`remote-soldier.ts:8-11`): eye 1.64 standing and 1.08 crouching; chest 1.25 and 0.80. They are used for grenade-origin snapping and near-miss checks.
- **Yaw convention:** forward = `(−sin yaw, 0, −cos yaw)` (`player/controller.ts:181-183`). The soldier visual uses `rotation.y = yaw` (`remote-soldier.ts:265`). Bots use the same convention.
- No shared simulation RNG crosses the wire. Spread, bot AI and pellets are all decided locally. **Only the map RNG must agree.**

---

## 5. Proposed Swift module layout

Swift Package with these targets. All are `Sendable`-clean under Swift 6 strict concurrency.

### 5.1 `IronvaleWire` (pure, no I/O, 100% unit-tested)
- `enum Wire` holds `protocolVersion = 4`, `hostID = 0`, `guestID = 1`, `botBase = 2`, `maxCoordinate = 5000`, `maxTimeMS = 1e12`, `maxPellets = 12`, `maxBotsPerSnapshot = 48`, `maxEventChars = 2048`.
- `enum WeaponID: String, CaseIterable` with `m4a1, mp5, m24, m249, m7, scarh`. **`allCases` order is the wire index.** Also `enum DamageSource { case weapon(WeaponID), grenade }`.
- `struct PlayerState`, `struct BotState`, `struct ShotMessage`, and `enum BinaryMessage { state, bots(seq,time,[BotState]), shot, ping(id,sentAt), pong(id,sentAt,remoteTime) }`.
- `enum BinaryCodec` with `encode(_:) -> Data` and `decode(_ data: Data) -> BinaryMessage?`. It never throws. `ByteWriter`/`ByteReader` handle LE.
- `func jsRound(_:) -> Double`, `func wrapAngle`, `func lerpAngle`. These replicate JS semantics exactly.
- `enum NetEvent` with one case per `t`, plus `NetMatchConfig`, `NetMode`, `NetRules`, `DuelBot`, `Difficulty`, `HitZone`, `WeaponActionStage`, `ByeReason`.
- `enum EventCodec` with `parse(_ text: String) -> NetEvent?` (JSONSerialization plus field validators) and `encode(_:) -> String`.
- `enum Sanitize` with `name(_:fallback:)` and `chat(_:)`.
- `struct RoomCode` (alphabet, make, normalize, isValid, from(text:), inviteLink). `enum InviteCodec` with `encode(kind:sdp:)` and `decode(_:expected:)` using the Compression framework.
- `struct TokenBucket`, `final class WeaponGate`, `func capDamage`.

### 5.2 `IronvaleSignaling`
- `enum SignalMessage { offer(sdp), answer(sdp), candidate(IceCandidate) }`, where `struct IceCandidate { candidate, sdpMid?, sdpMLineIndex?, usernameFragment? }`. Its JSON has the browser `toJSON` shape, with `null` for missing values.
- `protocol Signaling: AnyObject { var trickle: Bool; func open(role:code:handlers:); func send(_:); func paste(_:); func close() }`.
- `final class RoomSignaling` uses NWConnection WebSocket, sends `Origin`, maps close codes, and retries a host code up to 4 times.
- `final class ManualSignaling`.
- `struct RelayClient` for `health()` (2.5 s timeout) and `iceServers()` (3 s timeout, with the same validation as `ice.ts:6-41`).
- `enum SignalConfig` holds the base URL and extra ICE servers from Info.plist.

### 5.3 `IronvaleTransport`
- `protocol PeerLink: AnyObject` with `makeOffer()`, `acceptOffer(sdp:patient:)`, `acceptAnswer(sdp:)`, `addCandidate(_:)`, `sendState(Data)`, `sendEvent(text:)`, `sendEvent(binary:)`, `close()`, plus handler callbacks.
- `final class WebRTCPeerLink: PeerLink` wraps the Google WebRTC framework: two negotiated channels (ids 0 and 1), backpressure thresholds, an 8 KB inbound cap, a 64-entry candidate queue, a 4 s gather wait for manual codes, and the `failFast` rule.
- Threading: WebRTC calls back on its own signaling thread. Forward every callback into an `AsyncStream<LinkEvent>`, or onto `@MainActor`, and drain it once per frame in the game loop. This mirrors JS's single-threaded semantics and avoids data races on game state.

### 5.4 `IronvaleNet` (session and match sync)
- `final class ClockSync`, `struct SnapshotBuffer` (value type, `[Snapshot]` sorted), `final class RemoteSoldier: Combatant`, `final class BotProxies`, `final class MatchSync`, `@MainActor final class NetSession: NetSystem`, and `enum DuelRules` (`pickSpawn`, `result`, `botSide`, `botsHere`).
- `protocol NetSystem` and `protocol NetLobby` with an `@Observable` `LobbyState`, used by SwiftUI or AppKit lobby screens.
- `protocol NetGameHooks`.

### 5.5 `IronvaleGame`
- `protocol Combatant: AnyObject`, `final class Combat` (registry, `allocateId`, `raycast`), `enum Hitbox` (`hitTestHumanoid`), `final class EventBus<Events>` (typed: one `enum GameEvent` with associated values, or a struct of per-event subject lists), `struct MatchConfig`, `struct MatchSnapshot`, `@MainActor final class Game`, and `protocol GameContext`.
- `enum MatchRules` holds the constants: lives 3, solo survival lives 2, respawn 3 s, win delay 3.5 s, wave growth 2, wave pause 5 s, snapshot 20 Hz.
- Math: `SIMD3<Double>` throughout gameplay, so results match JS float64. The wire narrows to `Float` exactly where TS uses `setFloat32`.

### 5.6 WebRTC library recommendation

**Primary: Google WebRTC (libwebrtc) as an `.xcframework`**, for example the `stasel/WebRTC` SwiftPM binary package (M12x builds with a macOS slice), or a self-built framework.
- It is the same stack Chrome uses, so SCTP, DCEP, DTLS and ICE behave identically. Negotiated channels with `isNegotiated`/`channelId`, `isOrdered=false` and `maxRetransmits=0` are supported directly. `RTCDataBuffer(isBinary:)` gives the exact text/binary distinction required by §4.4. `bufferedAmount` is exposed.
- It has full TURN support, including `turns:` over TLS/TCP 443. That matters because Cloudflare TURN returns UDP, TCP and TLS URLs, and strict networks often allow only `turns:443`.
- Costs: about 20–30 MB binary, an Objective-C API (wrap it behind `PeerLink`), and audio/video code you do not use. These are negligible beside the game's assets.

**Alternative: libdatachannel** (C/C++, MPL-2.0, with the libjuice ICE agent and usrsctp). It is small, data-channel only, has a C API (`rtc.h`) that is easy to import through a module map, supports negotiated channels and unordered `maxRetransmits:0`, and is known to interoperate with browsers. The caveat: libjuice's TURN support is more limited than libwebrtc's (verify TCP/TLS TURN in the version you pick), and you must build and sign it yourself. Choose it only if binary size or build simplicity outweighs TURN-over-TLS reach.

Not recommended: hand-rolling SCTP/DTLS, or WKWebView as a networking shim. The webview would defeat the native-performance goal and add a JS bridge to every frame.

---

## 6. Risks, unknowns and effort

### Risks

1. **The protocol drifts while the web build keeps evolving** (highest risk). `PROTOCOL_VERSION`, `WEAPON_IDS` order, event fields and weapon damage/RPM are shared constants with no shared source. Mitigations:
   - (a) Generate a `protocol-fixtures.json` (golden bytes and JSON, like §4.5) from the TS encoders in CI and have the Swift tests consume it.
   - (b) A cross-play smoke test: headless Chrome running the web build in a room against the native app in CI on macOS. Assert connect, hello, lobby, load, go, state for 5 s, a hit and a death.
   - (c) Move the constant tables (weapon ids, defs, limits) into one JSON file that both builds read. That last step would touch `src/`, so it is a later decision for the user.
2. **Origin check on the relay** (§4.1). Without a decision, the native client cannot open rooms or get TURN.
3. **JS numeric semantics.** `Math.round` half-up, `%` truncation, float64 everywhere, `Math.imul`/`>>>` in the map RNG, and UTF-16 lengths for names, chat and event size. Each one is a small, silent mismatch. Unit-test each against TS outputs.
4. **Map determinism** depends on the maps/world port reproducing every `random()` call in order. A single extra call shifts all later props.
5. **Shooter-authoritative hits need matching hitboxes and interpolation delays.** Otherwise one platform "hits more". Keep 100 ms and 170 ms delays and the capsule tables identical.
6. **Threading.** WebRTC and Network.framework callbacks are off the main thread. The TS logic assumes single-threaded ordering (for example, `this.link === link` stale-callback guards). Funnel all callbacks into one serial executor.
7. **Time base.** The native app must use a monotonic millisecond `Double`. A wall clock (`Date`) would still work thanks to offset estimation, but it jumps on NTP changes and must stay below 1e12 (epoch ms is ~1.7e12, **which would be rejected**). Do not use `Date().timeIntervalSince1970 * 1000`.
8. **Text versus binary frames on `events`.** Getting this wrong fails silently (§4.4).
9. **Invite links.** A browser host's link is `https://ironvale.n3el.dev/?join=CODE`. For a native guest, either paste the code or add a universal link (needs `apple-app-site-association` on the web host, which is outside this group).
10. **Unknowns:**
    - `VITE_SIGNAL_URL` and `VITE_ICE_SERVERS` production values are build-time secrets or env values, not in the repo. Confirm `wss://ironvale-signal.n3el.dev`.
    - Whether the Cloudflare TURN key is set in production. Check `/ice` from an allowed origin.
    - Whether libdatachannel's TURN-TLS meets your network targets, if you choose it.

### Difficulty and estimate

| Work | Difficulty | Days |
|---|---|---|
| `IronvaleWire` codecs, sanitisers, invite codec, golden tests | Medium (exactness) | 3 |
| Signaling client (NWConnection WS, close codes, Origin, retries) + relay HTTP | Medium | 2 |
| WebRTC integration (xcframework, negotiated channels, trickle and manual, backpressure, threading) | Hard | 4 |
| ClockSync, SnapshotBuffer, RemoteSoldier, BotProxies | Medium | 2 |
| MatchSync (authority, gates, events in and out) + NetSession lobby state machine | Hard | 5 |
| Game core: Combat, Hitbox, EventBus, Game loop rules, MatchConfig/Snapshot (excluding render, AI, weapons) | Medium | 3 |
| Cross-play harness (headless Chrome ↔ native) and interop debugging | Hard | 4 |
| **Total** | **Hard overall** | **≈ 23 days** |

The estimate assumes the world/collision, weapons, bots and character-visual groups expose the interfaces listed in §2 on schedule. Net-game cannot be tested end to end without them, though the wire, signaling and transport layers can be built and cross-play-tested first against the browser lobby alone (connect → hello → lobby → chat). That is the recommended first milestone.

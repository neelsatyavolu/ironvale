# Ironvale

Ironvale is a first-person shooter that runs in a browser tab and as a Mac app. You fight bots on three maps (Railyard, Harbor, Pinewood) with seven guns: M1911, MP5, Remington 870, M1 Garand, M24, M4A1 and M249. There are two solo modes, Skirmish (clear the map with three lives) and Survival (waves, one life), and a two-player mode that connects two games directly for co-op or a duel.

It is written in TypeScript on Three.js r187. It renders with WebGPU and falls back to WebGL 2 on its own when WebGPU is missing. The models, textures and recordings are all CC0 or CC BY 4.0; [CREDITS.md](CREDITS.md) lists them, and the same list is in the game under Credits.

## Run it

You need Node 22.18 or newer and a recent Chrome, Edge or Safari.

```sh
npm install
npm run assets   # downloads about 176 MB of textures, skies and props into public/assets/dl
npm run dev      # http://127.0.0.1:5311
```

`npm run assets` only fetches what is missing, so it is safe to run again. The gun, arm and soldier models and all 327 sounds are already in the repository under `public/assets/local/`.

Other commands:

| Command | What it does |
| --- | --- |
| `npm run build` | Type checks, then builds the site into `dist/`. Everything under `public/` is copied in, so `dist/` is about 230 MB. |
| `npm run preview` | Serves `dist/` at http://127.0.0.1:5198. |
| `npm test` | Runs the unit tests (vitest). |
| `npm run typecheck` | Type checks without building. |
| `npm run shot -- --out name --params "query"` | Renders one frame in headless Chrome and writes `shots/name.png`. |
| `node scripts/credits.mjs` | Rewrites CREDITS.md from the manifests. A test fails if the file is out of date. |

### The Mac app

The Mac app is a Tauri window around the same build. It needs Rust and Xcode's command line tools.

```sh
npm run app:dev     # opens the app on the dev server; start npm run dev first
npm run app:build   # universal Ironvale.app and a .dmg under src-tauri/target/universal-apple-darwin/release/bundle/
```

The build is unsigned. Cargo is held to six jobs and the scripts run under `nice`, because this laptop has overheated on full-core builds. [src-tauri/README.md](src-tauri/README.md) explains what the app adds to the page (pointer capture, bundled fonts, files read from disk).

### Playing with a friend

Two games connect to each other directly over WebRTC. They can find each other in two ways.

With no setup, "Play with a friend" gives the host an invite code to send and the guest a reply code to send back, both by copy and paste.

With the signaling Worker in `signaling/`, the host gets a six-character room code instead. The Worker is a small Cloudflare Worker that passes the connection messages across and then drops out. It is not deployed. To use it, deploy it (steps in [signaling/README.md](signaling/README.md)) and build the game with its address:

```sh
VITE_SIGNAL_URL=wss://ironvale-signaling.<account>.workers.dev npm run build
```

For local testing, run `npm run dev` inside `signaling/` and start the game's dev server with `VITE_SIGNAL_URL=ws://127.0.0.1:8799`, or add `?signal=ws://127.0.0.1:8799` to the address.

## Controls

There are two presets. The game starts on Trackpad; switch under Settings or on the Controls screen.

| Action | Trackpad | Mouse |
| --- | --- | --- |
| Look | Move on the pad | Move the mouse |
| Move | W A S D or the arrow keys | W A S D or the arrow keys |
| Fire | Space, or click | Left click |
| Aim | Q (toggle), or two-finger click | Right click (hold) |
| Jump | F | Space |
| Crouch | C | C or Control |
| Sprint | Shift | Shift |
| Hold breath while aiming | Shift | Shift |
| Reload | R | R |
| Next or previous weapon | Two-finger scroll, or ] and [ | Wheel, or ] and [ |
| Pick a weapon | 1 to 7 | 1 to 7 |
| Scores | Tab | Tab |
| Pause | Esc or P | Esc or P |

The Trackpad preset exists because pressing and dragging on a pad at once is awkward: your right hand only moves the view and your left thumb fires. In menus, the arrow keys move, Enter selects and Esc goes back. The backquote key shows a frame-time readout during a match.

## Quality settings

Settings has four tiers. Each one sets the options below, and you can change any of them afterwards.

| | Low | Medium | High | Ultra |
| --- | --- | --- | --- | --- |
| Render scale | 0.6 | 0.75 | 0.85 | 1 |
| Textures | 1k | 1k | 2k | 2k |
| Shadow map | 1024 | 2048 | 4096 | 4096 |
| Ambient occlusion | off | on | on | on |
| Reflections | off | off | on | on |
| Light shafts | off | on | on | on |
| Anti-aliasing | FXAA | TRAA | TRAA | TRAA |
| Film grain | off | on | on | on |
| Detail density | 0.35 | 0.6 | 0.85 | 1 |
| Particle density | 0.5 | 0.75 | 1 | 1 |

Dynamic resolution is on by default and lowers the render scale to hold 60 frames a second. The game starts on High. The texture size is read once when the page loads, so changing it in Settings has no effect until you reload the page (or restart the app).

### What a player downloads

Measured on 2026-11-09 with `node scripts/dev/docs-download-size.mjs`, which starts each map with 8 bots and adds up the asset files the page asked for. Code is about 1.7 MB more before compression.

| | 1k tier (Low, Medium) | 2k tier (High, Ultra) |
| --- | --- | --- |
| Shared by every map (guns, arms, soldier, most sounds) | 14.8 MB | 14.8 MB |
| Harbor | 35.4 MB | 61.6 MB |
| Pinewood | 35.8 MB | 56.7 MB |
| Railyard | 37.8 MB | 60.2 MB |

Each map's figure includes the shared set. The largest single files are the 2k-tier sky panoramas and HDR skies: Pinewood's sky JPG is 11.5 MB, Railyard's HDR 6.5 MB and Harbor's HDR 5.7 MB.

## Developer URL parameters

Add these to the address. None of them is saved.

| Parameter | Effect |
| --- | --- |
| `autostart` | Starts a match with no menu. Combine with the next three. |
| `map=harbor` | Map to start: `railyard`, `harbor`, `pinewood` or the test map `range`. |
| `bots=8` | Number of bots (default 0, which leaves you alone on the map). |
| `pose=x,y,z,yaw,pitch` | Puts the camera there. Metres and degrees; y is feet height. |
| `q=low` | Forces a quality tier (`low`, `medium`, `high`, `ultra`) and turns dynamic resolution off. |
| `no=ssr,ao` | Switches effects off: `ssr`, `ao`, `godrays`, `bloom`, `aa`, `grain`, `shadows`. |
| `webgl` | Forces the WebGL 2 renderer. |
| `dev` | Adds the test range to the map list. |
| `ui=off` | Hides the whole interface, for clean screenshots. |
| `view=weapons/models/m4a1` | Opens the model viewer on a `*.view.ts` file, with `yaw`, `pitch`, `dist` and `bg=sky`. |
| `shafts=1.5` | Overrides the map's light shaft density. |
| `botdebug` | Draws the bots' paths; `botdebug=cover` and `botdebug=nav` draw cover points and the navigation grid. |
| `fxdemo=all` | Fires sample effects near the camera; also `rain`, `mist`, `fxweapon=shotgun`, `fxslow=0.1`. |
| `signal=ws://...` | Signaling address, development builds only. |

`window.__ironvale.game` is the running `Game`, for scripted checks.

## Where the code is

```
src/core/        settings, input, asset loader, events, seeded random
src/render/      renderer, sun and shadows, the post-processing pipeline, materials
src/game/        contracts.ts (every shared interface), the Game class, match rules, combat
src/player/      first-person body and camera        src/world/   collision and map types
src/weapons/     weapon data, ballistics, handling; models/ has one module per gun and the arms
src/ai/          bot navigation, perception and behaviour        src/characters/   the soldier body
src/audio/       spatial audio        src/fx/   muzzle flash, tracers, impacts, decals, weather
src/maps/<id>/   one folder per map: geometry, lighting, spawns
src/ui/          menus, settings, HUD        src/net/   two-player sync        src/platform/   Mac app glue
assets/*.json    asset manifests        scripts/   asset pipeline and dev tools        signaling/   the relay Worker
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the rules the code follows, the manifest format and the frame order. `docs/research/` records where every asset source was found and checked, and [docs/audio-report.md](docs/audio-report.md) lists every sound with its measurements and source.

## Known limits

Sound

- Nobody has listened to the sounds. All 327 files were cut, layered and levelled by script and checked by measurement only (loudness, peaks, leading silence, loop seams). Expect some to be wrong in ways numbers do not show.
- Several guns use recordings of other guns. The MP5's shots are a Carl Gustav M45 with a Walther PPQ layered in, because no live-fire MP5 recording exists under CC0, and its magazine sounds come from an airsoft replica. The M249's shots are a KAC LAMG. The M24's are a Blaser Tactical 2, a Tikka and a Mosin Nagant. Some M1 Garand takes use an M1917, and some Remington 870 takes use a Benelli Nova and a Winchester Model 12.
- Bullet impacts are foley (metal struck on rock, rocks thrown at wood and dirt), not recorded bullet strikes, and 15 sounds are synthesised.
- The Freesound sources are the site's public MP3 previews, not the lossless originals, so every sound has been through lossy compression twice.

Two-player

- It has only been tested between two Chrome pages on this one machine (`scripts/dev/net-duel.mjs`, `net-coop.mjs`). It has never been played across the internet or between two computers.
- The signaling Worker is not deployed, so room codes do not work until the owner deploys it. Pasted codes work without it.
- There is no TURN relay. Players on some mobile, campus and office networks will fail to connect.

Mac app

- Unsigned and not notarised, so macOS will warn before opening it on another Mac.
- WebKit caps it at 60 frames a second on macOS 13 to 15, and the raw input setting does nothing there.
- The bundle carries about 190 MB of assets.

Graphics and assets

- The 60 frames a second figure (each map, 8 bots) was measured in headless Chrome on one MacBook. There is no record of a run on a slower machine, or of a full match in Firefox or Safari.
- The seven gun models, the arms and the soldier come from an Objaverse mirror of the Sketchfab originals with 1k textures only, so they do not get sharper on the 2k tier.
- Real maker marks were painted out of the M1911's textures. There is no record of the other guns being checked for them.
- The menu's map cards have no pictures until `node scripts/dev/ui-thumbs.mjs` has been run to write `public/assets/thumbs/`.
- `public/assets/dl/` is not in the repository. A fresh clone shows a loading error until `npm run assets` has run, and the build ships both texture tiers whether or not a player uses them.
- Six files under `public/assets/dl/pbr/forrest_ground_01/` (12 MB) are left over from an earlier manifest. Nothing loads them, but they are copied into `dist/` and the Mac app until deleted.

Not done

- Nothing is deployed, signed or published.
- There is no gamepad support, no key rebinding beyond the two presets, and no saved progress beyond settings.

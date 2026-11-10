# Ironvale for the Mac

A Tauri v2 window around the same Vite build the browser gets. macOS 13 and
later, Apple silicon and Intel. Bundle identifier `co.xanom.ironvale`; the
version comes from `package.json`.

## Commands

| Command | What it does |
| --- | --- |
| `npm run app:dev` | Opens the app on the dev server at `http://127.0.0.1:5311` (start `npm run dev` first). Hot reload works. |
| `npm run app:build` | Builds the site, then a universal `Ironvale.app` and a `.dmg` under `src-tauri/target/universal-apple-darwin/release/bundle/`. Unsigned. |
| `node scripts/dev/app-icon.mjs` | Redraws the icon and rebuilds `icons/`. |
| `node scripts/dev/app-fonts.mjs` | Downloads the interface fonts again into `public/fonts/` and rewrites `src/platform/fonts.css`. |
| `node scripts/dev/app-check.mjs` | Drives a debug bundle end to end and prints what it measured. Read its header first: it takes the pointer for about a minute. |
| `node scripts/dev/app-check.mjs --no-input` | The part of that check that needs no pointer or keyboard: the app stays in the background and silent. Covers WebGPU, sounds, fonts, the policy and a railyard match; not the pointer grab, keys or full screen. |

Cargo is held to six jobs (`.cargo/config.toml`) and the npm scripts run under
`nice`, because this laptop has overheated on full-core builds.

## What the app adds to the page

- **Pointer capture** (`src/pointer.rs`, `src/platform/pointer.ts`). WKWebView
  refuses `requestPointerLock`. The page asks the app instead: the cursor is
  warped to the middle of the window, detached from the mouse and hidden.
  `movementX` and `movementY` keep arriving. Escape (handled by the page), a
  lost focus, a deactivated app and a closed window all give it back. Public
  APIs only. The deltas carry the system's pointer acceleration; the
  "raw input" setting has no effect in the app.
- **Game files on disk** (`src/assets.rs`). The page, scripts, styles and fonts
  are compiled into the binary. `public/assets/dl` and `public/assets/local`
  (about 190 MB) are copied into `Contents/Resources/assets/` and read from
  there, at the same URLs the page already uses.
  `scripts/dev/app-stage.mjs` makes the split after `vite build`.
- **Menu** (`src/menu.rs`): About, Hide, Quit; Edit (so copy and paste work
  for two-player codes); Toggle Full Screen (Control-Command-F).
  F11 also toggles full screen.
- **Keys** (`src/platform/shell.ts`, `keys.ts`). WKWebView plays the alert
  sound for any key the page leaves alone, so in the app the page claims them:
  every key while playing, and the keys that do nothing in menus.
- **Fonts** (`src/platform/fonts.css`, `public/fonts/`). The app runs with no
  network, so the three families are bundled and loaded only in the app.
- **Content security policy** (`tauri.conf.json`). Only the app's own files,
  `blob:` and `data:` images, and Tauri's own channel. The two-player relay is
  added at build time from `VITE_SIGNAL_URL` by `scripts/dev/app-csp.mjs`.

## Debug bridge

Debug builds started with `IRONVALE_DEVBRIDGE_PORT` and `IRONVALE_DEVBRIDGE_TOKEN` set listen on localhost
and let a script run JavaScript in the page (`src/devbridge.rs`). It is not
compiled into release builds.

## Not done here

Signing, notarising and publishing are the owner's call. A frame-rate cap of
60 on macOS 13 to 15 is WebKit's; lifting it needs a private setting and is
left alone.

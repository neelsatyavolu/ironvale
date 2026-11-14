# Ironvale native (macOS, Swift + Metal)

Plan: `docs/native-port/PLAN.md`. Needs Xcode 27.2+ (Swift 6.4) and `brew install xcodegen`.

- `IronvaleKit/`: SwiftPM package with all game code. `cd IronvaleKit && swift build && swift test`.
- `IronvaleApp/`: thin app target. `project.yml` is the source of truth; the `.xcodeproj` is generated and git-ignored.
- Build the app: `ci/build-app.sh` (runs xcodegen, then xcodebuild into `native/DerivedData`, prints the `.app` path).
- Run: `open "$(ci/build-app.sh | tail -1)"`, or run `Ironvale.app/Contents/MacOS/Ironvale` directly to pass flags.
- Flags: `--frames N` quits after N frames; `--frame-log PATH` writes a `frame,timestamp_s,dt_ms` CSV on quit; `--uncapped` turns off display sync.
- Frame-time logs: `log stream --predicate 'subsystem == "dev.n3el.ironvale"' --level debug`.
- Headless peer: `cd IronvaleKit && swift run ivpeer`.
- M0 check (everything above, plus a 300-frame run): `ci/check-m0.sh`.
- Shaders live in `IronvaleApp/Shaders` (compiled into `default.metallib`); shared structs in `IronvaleKit/Sources/ShaderTypes`.
- Contract (M1): `Tools/contract-export/run.sh` regenerates `Contract/` (tables, golden fixtures, `contract.lock`) from `src/` under Vitest; `--check` fails on drift. A contract change without a `PROTOCOL_VERSION` bump is refused (override: `CONTRACT_ACCEPT_SAME_VERSION=1`).
- M1 check (contract drift, Core/Contract/Wire tests, reverse codec check): `ci/check-m1.sh`.
- M3 renderer: `Ironvale --map railyard [--pose x,y,z,yawDeg,pitchDeg]` draws the map package's render export (needs `Tools/map-export/run.mjs` output and the web's `public/assets/dl`). `--capture PATH` writes a 2560x1600 PNG and quits; `--flythrough 60 [--offscreen]` flies a fixed loop; `--gpu-log PATH` writes per-frame GPU times.
- M3 check (renderer tests, Release build, web captures, SSIM at 5 poses, 60 s flythrough 1% low): `ci/check-m3.sh`. Tools in `Tools/m3-parity/`; captures land in the git-ignored `Parity/`.

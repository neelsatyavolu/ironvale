# Native release: what is ready and what the owner provides

This covers M12 (PLAN.md section 7): a Developer ID signed, notarized, Sparkle-updating build. Everything that needs no Apple credentials is done and checked by `native/ci/check-m12-prep.sh`. The steps that need credentials are written out below. They have not been run, and no key, certificate or password has been created or stored.

## Ready now

- **Self-contained bundle.** The build phase "Stage runtime data" (`native/IronvaleApp/project.yml`, running `native/ci/stage-runtime.py`) copies everything the app opens at run time into `Ironvale.app/Contents/Resources`:
  - `Contract/` holds the contract tables.
  - `Runtime/` holds the map packages with their render data, the gun GLBs, baked characters, asset manifests, `sound-meta.json`, and only the `public/` files a map, a sky or the sound manifest names.
  - `Licenses/` holds the third-party licence texts.
  
  The app reads from `RuntimeRoot.bundled` (`IronvaleMapData/RuntimeRoot.swift`) and never from the source tree. `--repo PATH` still overrides this for the dev checks, and the `#filePath` fallbacks remain only for `swift test`. The check runs a copy of the app under a sandbox profile that denies every read of the repository, and launches it through `/usr/bin/open -W -n -g`.
- **Licence gate.** Every bundled `public/` file must belong to a manifest entry licensed CC0 or CC-BY 4.0, or sit in the allowlisted first-party `assets/weapons/` folder. Otherwise the build fails. `Runtime/bundle-manifest.json` records each file's asset id, licence and SHA-256.
- **Credits.** The swift test `CreditsLicences` checks that the Credits screen shows every CC-BY line. The screen also shows the full text of the WebRTC licence (BSD 3-Clause) and both font licences (SIL OFL 1.1), plus the version and build.
- **Release configuration.** `CONFIGURATION=Release BUILD_NUMBER=n native/ci/build-app.sh` builds with no `*.debug.dylib` or `__preview.dylib`, and with dSYMs.
- **Version numbering.** `MARKETING_VERSION` in `project.yml` is the user-facing version (`0.1.0`). `CURRENT_PROJECT_VERSION`, which becomes `CFBundleVersion`, is set per build from `BUILD_NUMBER`. Sparkle compares `CFBundleVersion`, so every shipped build needs a strictly higher `BUILD_NUMBER`. A simple scheme is `git rev-list --count HEAD`.
- **Hardened runtime.** `ENABLE_HARDENED_RUNTIME` is still `NO` (`project.yml`). It is switched on together with Developer ID signing, as described below.

## What the owner provides

1. **Developer ID Application certificate.** Create it in the Apple Developer account (Certificates, type "Developer ID Application") and install it in the login keychain of the release Mac. Check it with:
   ```
   security find-identity -v -p codesigning     # shows "Developer ID Application: NAME (TEAMID)"
   ```
   The steps below need the Team ID.
2. **Notarization credentials.** Use one of these and store it in the keychain profile `ironvale-notary`:
   - An App Store Connect API key (preferred for automation): the `.p8` file, its Key ID and the Issuer ID, created under Users and Access, Integrations, App Store Connect API, with the Developer role.
     ```
     xcrun notarytool store-credentials ironvale-notary --key /path/AuthKey_KEYID.p8 --key-id KEYID --issuer ISSUER-UUID
     ```
   - Or an Apple ID with an app-specific password:
     ```
     xcrun notarytool store-credentials ironvale-notary --apple-id you@example.com --team-id TEAMID
     ```
     This prompts for the password. Do not put it on the command line.
3. **Sparkle EdDSA key decision.** Sparkle is not yet a dependency. Decide:
   - who holds the private EdDSA key (the login keychain of one release Mac, as `generate_keys` does by default, or a secrets store for CI);
   - where the appcast and the update archives are hosted (for example `https://ironvale.n3el.dev/native/appcast.xml`);
   - the update archive format (a notarized, stapled `.zip` of the app, or a DMG).

   Then run Sparkle's `generate_keys` yourself, once. It prints the public key, which goes into `Info.plist` as `SUPublicEDKey`. Never commit the private key.

## Commands that use them

Run these from the repository root on the release Mac. `TEAMID` and `NAME` are taken from the certificate.

1. Turn on the hardened runtime and set the identity for the release build. This changes `project.yml` for `Release` only:
   ```yaml
   configs:
     Release:
       ENABLE_HARDENED_RUNTIME: YES
       CODE_SIGN_IDENTITY: "Developer ID Application"
       DEVELOPMENT_TEAM: TEAMID
       OTHER_CODE_SIGN_FLAGS: --timestamp
   ```
   Re-signing the embedded `WebRTC.framework` with the same identity satisfies library validation, so no `disable-library-validation` entitlement is needed. Xcode does this re-signing for embedded frameworks when "Code Sign On Copy" is on, which is the SwiftPM binary-target default.
2. Build, then verify:
   ```
   BUILD_NUMBER=$(git rev-list --count HEAD) native/ci/check-m12-prep.sh
   APP=native/DerivedData-m12/Build/Products/Release/Ironvale.app
   codesign --verify --deep --strict --verbose=2 "$APP"
   codesign -d --entitlements - --verbose=4 "$APP" | grep -E 'Authority|runtime|TeamIdentifier'
   ```
   If Xcode did not sign the framework, sign it explicitly, inside out:
   ```
   codesign --force --timestamp --options runtime --sign "Developer ID Application: NAME (TEAMID)" "$APP/Contents/Frameworks/WebRTC.framework"
   codesign --force --timestamp --options runtime --entitlements native/IronvaleApp/Resources/Ironvale.entitlements \
     --sign "Developer ID Application: NAME (TEAMID)" "$APP"
   ```
3. Notarize and staple:
   ```
   ditto -c -k --keepParent "$APP" Ironvale.zip
   xcrun notarytool submit Ironvale.zip --keychain-profile ironvale-notary --wait
   xcrun stapler staple "$APP"
   spctl --assess --type execute --verbose=4 "$APP"     # "accepted, source=Notarized Developer ID"
   ditto -c -k --keepParent "$APP" Ironvale-$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist").zip
   ```
   If `notarytool` reports "Invalid", read the log with `xcrun notarytool log SUBMISSION-ID --keychain-profile ironvale-notary`.
4. Sparkle, once the key decision is made:
   - Add `https://github.com/sparkle-project/Sparkle` (2.x, an exact version) to `native/IronvaleKit/Package.swift`, or as a package of the app target.
   - Put `SUFeedURL` and `SUPublicEDKey` in `Info.plist`.
   - Create an `SPUStandardUpdaterController` in the app delegate. The PLAN wants a version-mismatch "update available" path (section 5, item 2) that calls it.
   - For each release:
     ```
     ./bin/sign_update Ironvale-0.1.0.zip           # uses the private key from the keychain; prints sparkle:edSignature and length
     ./bin/generate_appcast /path/to/updates/       # or edit appcast.xml by hand with that signature
     ```
     Sparkle's helper binaries inside `Sparkle.framework` (Autoupdate, Updater.app, the XPC services) must be signed with the same Developer ID and `--options runtime` before the app is signed (Sparkle's "Sandboxing and code signing" guide).

## Still open for M12 (not credential work)

- 7 consecutive nights of layer 4 scenarios, and a 30-minute soak per map (no frame over 25 ms, no memory growth over 50 MB).
- A recorded review of the CC-BY obligations before the first public release (PLAN.md risk 10). The bundled WebRTC licence is the stasel/WebRTC `LICENSE.md` (the wrapper's own licence and Google WebRTC's BSD licence). Libwebrtc also compiles in third-party code such as BoringSSL, libvpx, libyuv, Opus and usrsctp, whose notices are not in that file. Collect them from the matching WebRTC M157 source tree (`tools_webrtc/libs/generate_licenses.py` writes them) and add the result to `native/IronvaleApp/Resources/Licenses/` and `CreditsModel.licenceTexts`.
- Audio is not wired into the app yet. The sound files are already staged and pass the licence gate.

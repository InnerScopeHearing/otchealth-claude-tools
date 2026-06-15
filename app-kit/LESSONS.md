# Lessons — problems we already hit, written so we do not hit them again

A living pre-flight list distilled from the audits and runbooks across the repos
(iHEARtest `99-audit-*`, ch 4/15; MedReview `playbook/05-gaps-deep-dive`; AWARE
focus-group fix lists). Add to this every time something bites us.

## iOS audio / native (the expensive ones)
- **AVAudioSession category misconfiguration** caused tones to route to the iPhone
  speaker instead of AirPods. The fix took a 12-PR saga. Use `.playback` (or
  `.playAndRecord` for audiometry) with `.allowBluetoothA2DP` + `.duckOthers`. Never
  `.ambient`. The `UIBackgroundModes=[audio]` entitlement is load-bearing.
- **Web Audio needs a user gesture to unlock**, plus a silent-buffer prime and the
  triple-event unlock dance, or the first tone is silent. Always add the safety timeout.
- These are device-only bugs. They cannot be caught by a CPU sandbox or static
  analysis. They need a real device and the Bug-Hunting Playbook.

## Build / Apple side
- **Never hand-edit `project.pbxproj`.** Patch `Info.plist` via plutil and inject
  AppDelegate via awk; Capacitor regenerates the project and will clobber manual edits.
- **Apple blocks programmatic app-record creation** (POST /v1/apps returns 403). Do
  it in the App Store Connect web UI.
- **iOS builds run on Depot macOS GitHub Actions (Codemagic retired).** Port iHEARtest's
  `.github/workflows/ios-depot.yml` (runner `depot-macos-26` = Xcode 26 / iOS 26 SDK;
  `depot-macos-latest` is macOS 15 / Xcode 16.4, which Apple REJECTS). Read that workflow,
  not any `codemagic.yaml`, before adding build steps.

### Depot iOS pipeline first-build bring-up (the Flatstick 7-build saga, 2026-06-15)
A brand-new app's first Depot iOS build hits these in order. Fix ALL of them up front so you
don't burn macOS minutes (~10x Linux) discovering them one at a time:
1. **Sign with the FLEET key, not the MedReview key.** Cloud distribution signing works with
   ASC key `9MR7PJHRYH` (issuer `b3d5e801-7d26-41cd-8128-39e88e96f713`); it reuses the shared
   cloud-managed Apple Distribution cert `9BX5L8GA73` that iHEARtest/AWARE/FourVault/Fictionary
   sign with. The MedReview key `3BX7556WXU` CANNOT do cloud distribution signing -> export
   fails "Cloud signing permission error / No iOS Distribution certificate found". Set repo
   secrets `APP_STORE_CONNECT_KEY_IDENTIFIER`=9MR7PJHRYH, `APP_STORE_CONNECT_ISSUER_ID`, and
   `APP_STORE_CONNECT_PRIVATE_KEY` = the 9MR7PJHRYH PEM (.p8 contents). Do NOT revoke shared
   distribution certs to "free a slot" -> it is a key/permission issue, not a cert-limit one.
2. **`npx cap add ios || true` BEFORE `cap sync ios`.** The native iOS project is build-time
   generated (untracked), so a fresh CI checkout has no ios platform yet.
3. **Install the `xcodeproj` gem (pinned, e.g. `-v 1.27.0`) before any `ruby -e "require
   'xcodeproj'"`.** The runner's system Ruby 2.6 lacks it (1.27.0 requires Ruby >= 2.0, installs fine).
4. **Do not ship an entitlement the build does not use.** App Groups (or any capability whose
   App ID is not enabled / whose container is not registered) makes the archive fail
   "provisioning profile doesn't match the entitlements file". Include only entitlements a target
   in THIS build consumes (no widget target in the build => no App Groups).
5. **ExportOptions `method` MUST be `app-store-connect`** (not legacy `app-store`) so Xcode 26
   uses ASC-API-key cloud distribution signing.
6. **Set the build's repo vars + secrets BEFORE dispatching** (`VITE_*` build vars + the three
   `APP_STORE_CONNECT_*` secrets), or the run fails minutes in. Note: empty GitHub *variables*
   are rejected (leave a var unset = empty at build time); empty *secrets* are allowed.
7. **Committed Capacitor iOS project? Add the shared scheme.** A committed `ios/` usually has NO
   shared scheme (the `App` scheme lives per-user in `xcuserdata`), so add
   `App.xcodeproj/xcshareddata/xcschemes/App.xcscheme` (target blueprint
   `504EC3031FED79650016851F` for the standard Capacitor template) or `xcodebuild` fails
   "scheme App not found" in CI. (Generated projects via `cap add ios` get one at build time.)
8. **If the repo's PR CI runs a repo-wide formatter gate (`prettier --check .`), pre-format the
   new `ios-depot.yml` with the repo's own prettier before committing** — a freshly-authored
   workflow YAML otherwise fails the format check on its first PR (Companion hit this; AWARE +
   FourVault don't gate YAML formatting, so it's repo-specific — check `ci.yml` first).

## Process
- **No automated tests** meant every release gated on a human checklist. Slow and
  risky. The Testing kit fixes this. Ship every fix with a regression test.
- **Bug reports were scattered** (TestFlight, forms, heads). Without a single intake
  they do not get fixed systematically. Centralize per app (Maintenance kit).
- **Each app reinvented the process.** That is the entire reason this App-Kit exists.

## Compliance
- **Sentry is outside the BAA ring.** PHI must be scrubbed before capture. PHI data
  never enters analytics, Daytona sandboxes, or non-BAA services.
- **No medical advice / no diagnosis claims.** "May help" framing only.

## Velocity
- Most app changes are web-layer and do not need a native release. Not having OTA /
  Live Updates meant waiting on App Review for copy and UI fixes. The Launch kit
  adds Capgo so those ship in minutes.

> Rule: when a bug costs more than an hour, add a line here and a regression test.

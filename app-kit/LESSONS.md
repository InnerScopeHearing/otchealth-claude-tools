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
- Read the existing `codemagic.yaml` before adding build steps.

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

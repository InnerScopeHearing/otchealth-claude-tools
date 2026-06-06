# Build Kit — architecture standards and shared building blocks

Goal: every app is built the same proven way, so knowledge transfers and agents
do not relearn the stack each time.

## The generalized engineering manual
iHEARtest's 19-chapter manual is the reference. Split it into PORTABLE (every app)
versus APP-SPECIFIC (stays in the app repo):

| Chapter | Portable? |
|---|---|
| 01 System architecture overview | Portable pattern (hybrid 7-layer map) |
| 02 Capacitor 8 hybrid architecture | Portable |
| 03 Web Audio API reference | App-specific (audio apps) |
| 04 WKWebView + AVAudioSession | Portable for any audio/media app |
| 05 iOS native patching pipeline (plutil/awk, never edit project.pbxproj) | Portable |
| 06 Codemagic build pipeline | Portable |
| 07 App Store Connect / TestFlight / signing | Portable -> Pre-launch kit |
| 08 Audiometry science / 09 Hearing-loss DSP | App-specific (iHEARtest/AWARE) |
| 10 RevenueCat IAP | Portable -> Startup + Launch kits |
| 11 Push / local notifications | Portable |
| 12 Data persistence + HIPAA | Portable (critical for PHI apps) |
| 13 Accessibility / WCAG (senior-first) | Portable, hard requirement |
| 14 Autonomous development ops | Portable (agent workflow) |
| 16 Telemetry / Sentry | Portable -> Startup + Maintenance |
| 17 Customer support / Intercom | Portable |
| 18 HealthKit export | App-specific (health apps) |

## Shared packages (extract once, reuse)
Today each app re-solves these. Pull them into shared packages:
- Capacitor native wrappers (audio session, haptics, notifications)
- IAP/entitlement client (RevenueCat)
- Sentry init + PHI scrubber
- i18n loader + coverage check
- Senior-accessibility UI primitives (large text, high contrast, big targets)
- Brand tokens (fed by the designer brand profiles)

## Standing rules (from the manuals, apply everywhere)
- Surgical PRs over sweeping rewrites.
- Patch `Info.plist` via plutil; never hand-edit `project.pbxproj`.
- Read the existing `codemagic.yaml` before inventing build steps.
- Mark uncertain facts `verify`, do not fabricate.
- Server-side entitlements; credentials never reach the client.

## Deliverable for this kit (to build next)
The portable chapters as app-agnostic markdown here, plus the shared packages as
real npm/workspace packages the apps depend on.

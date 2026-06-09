---
name: release-conductor
description: Release Captain's equipment. Executes the ship path, Capgo/Capawesome OTA for web-layer changes vs a Codemagic native build, with phased rollout and automatic rollback. Use to take a green, Guardian-cleared change to production. iOS is cloud-only (no Mac); never attempt a local build.
---

# release-conductor — pick the path, roll out safely

## Pre-flight (hard gate)
Read `app.manifest.json`. Proceed only if the gates the change needed read `pass`/`na`
AND Guardian cleared. PHI app: `gates.phiReview = pass`. Run the Pre-launch checklist.

## Choose the ship path
- **Web-layer-only change** (JS/CSS/HTML, incl. clinical copy/thresholds, AI prompt and
  disclaimer text): ship via **OTA**, no App Review.
  - Capgo: `npx @capgo/cli bundle upload -c <channel>` (self-host + E2E encryption).
  - Capawesome: code-signed bundles + automatic rollback + audit logs.
  - Use channels; gate health-critical flows with auto-rollback on crash-rate.
  - Migrate any app still on **Appflow** first (it sunsets Dec 31 2027).
- **Native change** (new plugin, native code, store metadata): cut a **Codemagic** build
  (`codemagic.yaml`). iOS build/sign/submit is cloud-only, you have no Mac. Phased
  rollout; watch release health.

## Monetization go-live
Take products live via **RevenueCat** where applicable. Pull store assets from Creative.

## Rollout + rollback
Phased %; if a rollout breaches `services.ota.rollbackOnCrashRate`, roll back immediately
(OTA channel revert or halt the staged native rollout) and hand to Medic.

## Output
Write a release record to `manifest` + the ledger (version, path, rollout state). Hand to
Growth (experiment) + Medic (watch health).

## Guardrails
Never ship around a failing gate or a Guardian block. Keep clinical logic web-layer so
future fixes stay OTA-patchable. OTA updates web assets only, never native binaries
(Apple/Google rule). No em or en dashes in any store or in-app copy.

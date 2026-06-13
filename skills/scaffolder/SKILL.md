---
name: scaffolder
description: Builder's equipment for new surfaces and new apps. The Startup kit made executable, scaffolds an app's source-of-truth and standards so it starts with everything the last app learned. Generates app.manifest.json (conforming to the Dream Team schema), a CLAUDE.md, and the wiring stubs (RevenueCat, Sentry, PostHog, i18n, CI, test scaffold). Use when adopting an existing app into the system or starting a new one.
---

# scaffolder — a new app starts standards-complete

## When to invoke
Adopting an app into the Dream Team (it needs an `app.manifest.json`), or starting a
new app from zero.

## Adopt an existing app (the common case)
Generate the per-app source of truth so the agents can operate on it:
```bash
node scripts/scaffold-app.mjs --app iheartest --ring non-phi \
  --type capacitor-hybrid --brand iheartest
```
This writes a validated `app.manifest.json` (ring, stack, services, kits, gates) at the
repo root. Fill in real service ids as they get wired. The portfolio command-center
board (`diagrammer/render-portfolio.mjs`) then reflects this app automatically.

## New app from zero (Startup kit)
In addition to the manifest, scaffold:
1. **Repo + `CLAUDE.md`** from the devkit template (PHI ring, no medical claims, senior
   accessibility as a hard requirement, secrets never ship to client).
2. **Capacitor 8** baseline (Node 22 / iOS 15 / Android SDK 36), pinned plugin set,
   SystemBars edge-to-edge.
3. **Monetization (RevenueCat)** + **Telemetry (Sentry+PostHog via telemetry-wiring)** +
   **i18n** stubs.
4. **CI**: Depot macOS runners for iOS native (GitHub Actions) + Depot ubuntu for web/Android/services. (Codemagic deprecated 2026-06-13 — migrated to Depot to use the grant instead of cash.)
5. **Test scaffold** via test-author, green from commit one.
6. **Supply-chain hardening** via supply-chain-guard (cooldowns, no auto-merge, SHA-pins).

## Output
A repo that builds, runs, is brand-correct, monetization + telemetry wired, tests
passing, and has a manifest. Set the relevant `manifest.kits.*` true. Hand to Builder.

## Guardrails
Respect the declared `ring`. New PHI apps get the BAA + scrubbing requirements specified
up front. No PHI in any generated asset or prompt.

---
name: boot-gate
description: The drop-in BOOT + RENDER + BUILD-ENV gate for every Capacitor + React + Vite app. Closes the "compiles, unit-tests green, dead on device" gap that shipped FourVault's headless splash and PlantID's green-screen build. Provides a boot-smoke Playwright spec (WebKit @ iPhone 16 Pro 402x874 that FAILS on any boot console.error/pageerror/unhandled rejection, on a stuck splash/green/white screen, or on an empty #root), a visual/render gate (flat-color heuristic + the art-director vision judge over every screen), a check-build-env.mjs that fails the build when a required VITE_* is empty (so an empty VITE_API_BASE_URL can never ship), and the ErrorBoundary + SplashScreen.hide()-in-finally boot-resilience standard. Use before every "ready to build" escalation, and port it into any app that lacks an end-to-end render gate. Non-PHI ring. See app-kit/AI-AGENT-APP-BUILDING-BIBLE.md Part 4.
---

# boot-gate — prove the app actually launches and renders

## Why this exists (the one law)

"Compiles + unit-tests green" is necessary but NEVER sufficient. Two apps shipped
this week that passed all CI and failed on device:
- **FourVault**: a square vault image composited over the hero -> decapitated mascot.
  Pure pixels-at-402x874 bug; no typecheck/unit/lint can see it.
- **PlantID**: stuck on a green screen. Built with an empty `VITE_API_BASE_URL`
  (Vite bakes env at build time; `""` is a legal string). Unit tests mock the boot.

A build is not "ready" until the real bundle has been loaded in WebKit at iPhone 16
Pro size, proven to reach its first interactive screen with zero boot errors, and
looked at. This skill is that gate. Full rationale: `app-kit/AI-AGENT-APP-BUILDING-BIBLE.md`.

## What's in the box (templates/)

| File | Drops into | What it does |
|---|---|---|
| `boot-smoke.spec.ts` | app `e2e/` | WebKit @ 402x874: FAILS on boot console.error/pageerror/unhandledrejection, on no interactive element within the boot budget (stuck splash/green/white screen), or on a trivial `#root`. |
| `visual-walkthrough.spec.ts` | app `e2e/` | Screenshots every route at device size; FAILS any screen that is >92% one flat color; persists screens for the art-director vision judge. |
| `check-build-env.mjs` | app `scripts/` | `prebuild` step: FAILS the build if any required `VITE_*` is empty/missing/malformed. |
| `ErrorBoundary.tsx` | app `src/boot/` | Top-level boundary that renders a VISIBLE fallback (never a silent color) and reports to Sentry. |
| `main-boot.tsx` | reference for app `src/main.tsx` | The boot pattern: ErrorBoundary wrap, `SplashScreen.hide()` in `finally`, global error handlers, `[data-boot-ready]` marker. |

## How to adopt (any Capacitor + React + Vite app)

1. The app needs a Playwright harness. If it has none (iHEARtest, AWARE, Companion
   today), copy FourVault's `playwright.config.ts` first (WebKit project, `vite build`
   with env baked in the `webServer` block, `vite preview`). Keep `workers: 1`.
2. Copy `templates/boot-smoke.spec.ts` and `templates/visual-walkthrough.spec.ts`
   into the app's `e2e/`. Fill the `SCREENS` route list (steal it from any existing
   `demo-eval.spec.ts` / `screenshot-audit.spec.ts`).
3. Copy `templates/check-build-env.mjs` into `scripts/`; set the app's required
   `VITE_*` list; wire `"prebuild": "node scripts/check-build-env.mjs"` in the mobile
   `package.json`, and add the same check as a CI step BEFORE the Depot archive.
4. Adopt the boot-resilience standard: add `src/boot/ErrorBoundary.tsx`, refactor
   `src/main.tsx` to the `main-boot.tsx` pattern, set
   `plugins.SplashScreen.launchAutoHide: false` in `capacitor.config.ts`.
5. Add the `e2e` boot+render job to the app's CI `gate` and run the Part 4 checklist
   before any "ready to build" escalation.

## Notes
- WebKit is the engine that matters (it ~= iOS WKWebView, what ships to the phone).
  Chromium ~= Android WebView; run both if you can, but WebKit is the gate.
- The flat-color heuristic is dependency-light; the optional pixel decode uses
  `pngjs` if present and degrades to a DOM-richness assertion if not.
- The art-director judge is NOT new tooling: it reuses `skills/focus-group-loop`
  (`fgl.mjs`, vision review of real screenshots, `--catalog` to the brain) and the
  `skills/designer` art-director. Non-PHI ring only.
- Reduced-motion: if the app's splash honors `prefers-reduced-motion` to skip a
  cinematic (the e2e default), the boot-smoke gate still asserts the first
  interactive screen; for the VISUAL gate, override `contextOptions.reducedMotion` to
  `no-preference` on the splash test so you actually see the animated state.

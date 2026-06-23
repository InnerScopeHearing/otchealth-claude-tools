---
name: live-walkthrough
description: A fleet QA rig that DRIVES a running web/Capacitor app the way a real person does (touchscreen tap, scroll, drag, navigate) across a matrix of phone sizes, catching the interaction + responsive bugs static screenshot review misses. Runs Playwright WebKit (the engine inside the iOS WKWebView; chromium auto-fallback) with iPhone SE / 14 / 15 Pro Max / Pixel 7 emulation, records video + trace + per-step screenshots, and asserts on sticky/fixed bars that detach on scroll, horizontal overflow, text clipping, sub-44px tap targets, dead controls + broken navigation + failed requests, console errors, and layout shift. The probes/devices/runner/report are SHARED here; EACH app supplies its own qa/live-walkthrough/stubs.mjs (API stub map) + journeys.mjs (persona journeys) as inputs. Non-PHI ring, fully stubbed, no secrets, no real user data. Use to find interaction/responsive bugs before a TestFlight build, or as the live half of dream-team/LIVE-PERSONA-WALKTHROUGH.md.
---

# live-walkthrough — the live persona walkthrough harness (fleet skill)

A digital QA rig that drives the RUNNING app the way a real person does (tap, scroll,
drag, navigate) across multiple phone sizes, and catches the interaction + responsive
bugs that static screenshots miss: sticky bars that break on scroll, controls that are
dead after a tap, links that dead-end, and layout that looks fine on one phone and
breaks on another. It is the executable upgrade to the screenshot-based
`persona-focus-group`, and the live half of `dream-team/LIVE-PERSONA-WALKTHROUGH.md`.

The engine here is **app-agnostic and shared**. Each app provides only two small
**input files** describing itself: its API **stub map** and its **persona journeys**.

## What is shared (this skill) vs per-app (your inputs)

SHARED — never edit per app, lives here:
- `lib/probes.mjs` — the bug detectors: sticky-detach, horizontal-bleed, text-clip,
  tap-target, broken-link. The reusable core.
- `lib/devices.mjs` — the phone-size matrix (iPhone SE / 14 / 15 Pro Max / Pixel 7).
- `runner.mjs` — launches a real browser per device, drives the journey with real
  interactions, records video/trace/screenshots, runs the probes. Resolves the two
  app inputs at runtime (see below).
- `report.mjs` — consolidates `findings.json` into a prioritized, deduped, builder-ready
  Markdown report (title from `--app-name`).
- `selftest.mjs` — proves the probes catch their target bug classes on synthetic pages
  (app-independent; this is the skill's regression test).
- `example-app/stubs.mjs` + `example-app/journeys.mjs` — copy-paste reference inputs.

PER-APP — you author these (the only app-specific files):
- `stubs.mjs` — the API stub map for YOUR backend.
- `journeys.mjs` — YOUR focus-group personas as scripted journeys.

## The per-app input contract

The runner loads the two inputs from `--app-dir <dir>` (default `qa/live-walkthrough`),
or via the explicit `--stubs <file>` / `--journeys-file <file>` flags. Author them once
per app and they live in that app's repo (e.g. `qa/live-walkthrough/stubs.mjs`).

### `stubs.mjs` must export:

```js
// Wire EVERY backend route the walk touches so the app renders with no backend
// and no secrets. Fake the signed-in session when authenticated; serve 401 when not.
export async function installStubs(page, { authenticated }) { /* page.route(...) */ }

// OPTIONAL: the app's known client-side route paths. The link probe flags any in-app
// <a href> whose path matches none of these. Export [] (or omit) to disable that check.
export const ROUTE_PATTERNS = [ /^\/$/, /^\/about$/, /* ... */ ];
```

### `journeys.mjs` must export:

```js
export const JOURNEYS = [
  {
    id: "first-open-sam",        // unique slug (used in filenames + --journeys filter)
    group: "customer",           // "customer" | "professional" | "investor" (free-form)
    persona: "Sam, 60, opens the app for the first time",
    goal: "Land on home, scroll, reach About.",
    start: "/",                  // path to open first
    auth: false,                 // OPTIONAL: false = walk LOGGED OUT (installStubs gets
                                 //   authenticated:false); omit for a faked session
    steps: [                     // ordered REAL interactions:
      { settle: 300, note: "First impression." },
      { scroll: "down" }, { scroll: "up" },
      { tapTestId: "link-about" },
      { expectPath: /\/about$/ },// funnel must progress, or the prior tap was DEAD
    ],
  },
];
```

Step kinds (each maps to a real Playwright action):
`{ goto }` `{ tapTestId }` `{ tapText }` `{ tapRole: [role,name] }` `{ type: {testId|role, value} }`
`{ scroll: "down"|"up"|n }` `{ swipe: "left"|"right"|"up"|"down" }` `{ drag: {testId,dx,dy} }`
`{ expectPath: /regex/ }` `{ settle: ms }` `{ note: "..." }`.

The full annotated contract is in `example-app/stubs.mjs` and `example-app/journeys.mjs`.
Mirror your app's existing e2e fixture (e.g. `e2e/fixtures/api.ts`) into `stubs.mjs` so it
stays lockstep with the real API. Leave a `note` breadcrumb at every native boundary the
browser cannot cross (camera, purchase sheet, Sign in with Apple, push) for the device pass.

## Quick start (for app X)

```bash
# 0. install the engine once (in the app repo, or globally)
npm i -D @playwright/test && npx playwright install webkit chromium
npx playwright install-deps webkit   # apt; root sandbox -> ok. Chromium auto-fallback if not.

# 1. author qa/live-walkthrough/stubs.mjs + journeys.mjs (copy example-app/, edit)

# 2. build + serve the web app with NO API base (so stubbed relative paths match)
VITE_API_BASE_URL="" <your web build>            # e.g. pnpm --filter web build
<your static preview on 127.0.0.1:4173>          # e.g. pnpm --filter web preview --port 4173

# 3. walk it, then report (run the skill from /tmp/octools or the toolkit checkout)
node skills/live-walkthrough/runner.mjs \
  --url http://127.0.0.1:4173 \
  --app-dir <appRepo>/qa/live-walkthrough \
  --app-name "App X" \
  --out <appRepo>/qa/live-walkthrough/out
node skills/live-walkthrough/report.mjs --in <appRepo>/qa/live-walkthrough/out
# -> out/REPORT.md  (+ shots/ video/ trace/ findings.json)
```

Flags: `--url`, `--app-dir`, `--stubs`, `--journeys-file`, `--devices iphone-se,iphone-14`,
`--journeys first-open-sam`, `--engine webkit|chromium`, `--video on|off`, `--out DIR`,
`--app-name "X"`, `--scroll-sel ".app-shell__scroll"` (the in-page scroll container the
sticky/scroll probes drive; default `.app-shell__scroll`, override if your shell differs).

## Selftest (the skill's gate)

`node skills/live-walkthrough/selftest.mjs` builds synthetic pages with KNOWN defects and
proves every probe fires on its target bug AND stays quiet on the by-design cases
(horizontal scroller, off-screen a11y skip link, correctly-pinned bar). It needs a browser
engine; `run-tests.sh` skips it unless `RUN_BROWSER_TESTS=1` (browsers are a heavy
download), exactly like `browser-agent`.

## The native last mile (what this does NOT cover)

The web layer is the app for the overwhelming majority of UX/flow/functional bugs, all
walkable here for free. What still needs the iOS Simulator on Depot macOS (Maestro /
XCUITest): camera capture, the native share extension, AVAudioSession / AirPods routing,
StoreKit / RevenueCat purchase + restore (the harness reaches the paywall and taps the
CTA; the purchase sheet is native), Sign in with Apple's native sheet, push prompts, the
Apple Watch + widget + Live Activity surfaces, and true momentum scroll physics. The
journeys leave a narration breadcrumb at each native boundary so the device QA pass knows
exactly what to verify.

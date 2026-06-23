# live-walkthrough — Live Persona Walkthrough harness (fleet skill)

A digital QA rig that drives a RUNNING web/Capacitor app the way a real person does
(tap, scroll, drag, navigate) across multiple phone sizes, and catches the interaction
+ responsive bugs that static screenshots miss: sticky bars that break on scroll,
controls that should react on tap but are dead, links that should navigate but
dead-end, and layout that looks fine on one phone and breaks on another.

This is the fleet-skill form of the harness proven in the Flatstick repo
(`qa/live-walkthrough/`). It is the executable upgrade to the screenshot-based
`persona-focus-group`, the live half of `dream-team/LIVE-PERSONA-WALKTHROUGH.md`, and it
pairs with `skills/browser-agent` (the same headless-driver lineage).

## Why this exists

The 20-persona focus group reviews apps via SCREENSHOTS, which are static. They cannot
see that a button is dead after the first tap, that a fixed header rides the content
when you scroll, that a row bleeds off the right edge at 375px, or that a tap target is
a 29px sliver. Real users find those by DOING. This harness makes scripted personas
actually do it, on 4 phone sizes, and reports each defect as a builder-ready repro
(element selector + device + persona + screenshot + video).

## Shared engine vs per-app inputs (the whole point of the skill)

The engine is **app-agnostic and lives here**; each app supplies only two small input
files describing itself. See SKILL.md for the precise export contract; in short:

| File | Where it lives | What it is |
| --- | --- | --- |
| `lib/probes.mjs` | this skill (shared) | the bug detectors |
| `lib/devices.mjs` | this skill (shared) | the phone-size matrix |
| `runner.mjs` | this skill (shared) | drives the walk, resolves the app inputs |
| `report.mjs` | this skill (shared) | the prioritized Markdown report |
| `selftest.mjs` | this skill (shared) | the probe regression test |
| `stubs.mjs` | **your app** (`qa/live-walkthrough/`) | the API stub map |
| `journeys.mjs` | **your app** (`qa/live-walkthrough/`) | the persona journeys |

The runner resolves the two app inputs at runtime: `--app-dir <dir>` (default the app's
`qa/live-walkthrough/`, holding `stubs.mjs` + `journeys.mjs`), or the explicit
`--stubs <file>` / `--journeys-file <file>` flags. `example-app/` ships a copy-paste
reference for both.

## What it actually runs

- **Engine: Playwright WebKit, iPhone-emulated.** A Capacitor app ships inside an iOS
  `WKWebView`, which is Safari/WebKit. WebKit rendering matches the iPhone far better
  than Chromium, and most iOS-only layout bugs are WebKit quirks. WebKit runs headless
  in the Linux cloud sandbox (see Feasibility). Chromium is the automatic fallback and a
  cross-engine option for the Android viewport.
- **Device matrix** (`lib/devices.mjs`): iPhone SE (375, where layout breaks first),
  iPhone 14 (390 baseline), iPhone 15 Pro Max (430 large), Pixel 7 (412 Android). Each
  uses Playwright's real device descriptor: viewport + deviceScaleFactor + `isMobile` +
  `hasTouch` + device UA.
- **Real interactions** (`runner.mjs`): touchscreen `tap` (not mouse click, so touch
  handlers fire), touch `down/move/up` drags for swipe + element drag, wheel scroll AND
  programmatic scroll of the real scroller. It records **video** of the whole session, a
  **Playwright trace**, and a **screenshot at every step**, so a sticky bar is observed
  DURING the scroll, not at rest.
- **Assertions** (`lib/probes.mjs`), run on every screen the persona lands on:
  - `sticky-detach` — a `position:fixed` element that drifts (rides the content) during a
    real scroll.
  - `horizontal-bleed` — any in-flow element extending past the viewport width, plus a
    horizontally-scrollable document.
  - `text-clip` — text overflowing/clipped in its container (`scrollWidth>clientWidth`).
  - `tap-target` — an interactive control under 44x44 CSS px (Apple HIG / WCAG 2.5.5).
  - `broken-link` — a tap with no effect, a funnel step that did not progress (the prior
    control was dead), a link to a non-route, or a failed network request.
  - `console-error` / `layout-shift` — JS errors and cumulative layout shift during the
    walk (runner-collected).

No backend and no secrets: the API is fully stubbed per-request via the app's
`stubs.mjs`, and a signed-in session is faked in `localStorage`. Non-PHI ring; all data
is synthetic.

## How a persona maps to a journey

`journeys.mjs` turns each focus-group persona into a JOURNEY: a goal + an ordered list of
real interactions. Example:

```js
{
  id: "organizer-dana",
  group: "customer",
  persona: "Dana, 41, organizes the group's golf trips",
  goal: "Start a new round from the clubhouse and look at the setup form.",
  start: "/",
  steps: [
    { settle: 500, note: "Land on the Clubhouse dashboard." },
    { scroll: "down" }, { scroll: "up" },
    { tapTestId: "tab-new-round" },
    { expectPath: /\/setup$/ },   // funnel must progress, or the tap was dead
    { scroll: "down" },
  ],
}
```

The persona's `note` narration is the gold ("here I'd point my camera at the plant",
"the result text was too small to read"). The probe battery then checks the screen they
reached. The full step-kind list is in SKILL.md and `example-app/journeys.mjs`.

## How to run it for app X

```bash
# 0. install the engine once (in the app repo or globally)
npm i -D @playwright/test && npx playwright install webkit chromium
npx playwright install-deps webkit   # apt; root sandbox -> ok (else chromium fallback)

# 1. author qa/live-walkthrough/stubs.mjs + journeys.mjs (copy example-app/, edit)

# 2. build + serve the web app with NO API base, so the stubbed relative paths match
VITE_API_BASE_URL="" <web build>                 # e.g. pnpm --filter web build
<static preview on 127.0.0.1:4173>               # e.g. pnpm --filter web preview --port 4173

# 3. walk it, then report
node skills/live-walkthrough/runner.mjs \
  --url http://127.0.0.1:4173 \
  --app-dir <appRepo>/qa/live-walkthrough \
  --app-name "App X" \
  --out <appRepo>/qa/live-walkthrough/out
node skills/live-walkthrough/report.mjs --in <appRepo>/qa/live-walkthrough/out
# -> out/REPORT.md  (+ shots/ video/ trace/ findings.json)
```

Flags: `--url`, `--app-dir`, `--stubs`, `--journeys-file`, `--devices iphone-se,iphone-14`,
`--journeys organizer-dana`, `--engine webkit|chromium`, `--video on|off`, `--out DIR`,
`--app-name "X"`, `--scroll-sel ".app-shell__scroll"`.

`--scroll-sel` is the one app shell knob: the sticky/scroll probes drive the in-page
scroll container at this selector (default `.app-shell__scroll`). If your app's scrollable
shell uses a different class, pass it; if the selector matches nothing the probes fall back
to the document scroller, so a wrong value degrades gracefully.

## Selftest

```bash
RUN_BROWSER_TESTS=1 node skills/live-walkthrough/selftest.mjs
```

Builds synthetic pages with KNOWN defects and proves every probe fires on its target bug
AND stays quiet on the by-design cases (a dedicated horizontal scroller, an off-screen
a11y skip link, a correctly-pinned bar). It needs a browser engine, so the toolkit
`run-tests.sh` skips it unless `RUN_BROWSER_TESTS=1` (browsers are a heavy download),
exactly like `browser-agent`. This is the regression test that keeps the detectors honest.

## Feasibility note (what runs where)

Proven in the Linux cloud sandbox:
- `npx playwright install webkit` downloads the WebKit binary fine.
- WebKit's host libraries (libwebpmux, libwayland-server, libmanette, libenchant, ...)
  are NOT present by default, so launch fails until `npx playwright install-deps webkit`
  runs (`apt-get`; the sandbox is root, so this succeeds). After that, **WebKit launches
  headless and reports a real iOS Safari UA** (`iPhone OS 16_0 ... Safari`).
- If WebKit deps cannot be installed on a given host, the runner auto-falls-back to
  Chromium with iPhone device emulation, and labels the engine `chromium-fallback` in the
  report (lower fidelity for iOS-specific WebKit quirks, but still catches the
  layout/interaction/tap-target/navigation classes). The shipped selftest in this skill
  was proven green on the chromium fallback.

## The native last mile (what this does NOT cover)

The web layer is the app for the overwhelming majority of UX/flow/functional bugs, and
all of those are walkable here for free. What still needs the iOS Simulator on Depot
macOS (Maestro / XCUITest), because the browser cannot do them:
- camera capture, the native share extension, `AVAudioSession` / AirPods audio routing,
- StoreKit / RevenueCat purchase + restore (the harness reaches the paywall and taps the
  CTA, but the actual purchase sheet is native),
- Sign in with Apple's native sheet, push-notification prompts, the Apple Watch + widget
  + Live Activity surfaces, true momentum/rubber-band scroll physics and the iOS
  software-keyboard avoidance.

The journeys leave a narration breadcrumb at each native boundary ("here I would point my
camera") so the device QA pass knows exactly what to verify.

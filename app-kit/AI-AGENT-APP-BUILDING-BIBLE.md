# THE APP-BUILDING BIBLE FOR AI AGENTS

> The shared-brain standard for how the OTCHealth/InnerScope developer fleet builds
> apps that actually work and actually look like they cost $10 million. Synthesized
> 2026-06-25 from cited external research (Anthropic, GitHub Spec Kit, 12-Factor
> Agents, Apple HIG, App Store Guidelines, RevenueCat, eval/judge literature) + an
> internal audit of our own toolkit + two real production failures this week.
>
> This is a REFERENCE (read the relevant part on demand), not a CLAUDE.md. The
> one-line law lives in every app's CLAUDE.md; the depth lives here.

---

## PART 0 — THE ONE LAW

**"Compiles + unit-tests-green" is necessary but NEVER sufficient. A build is not
"ready" until the real bundle has been loaded in a real browser engine at iPhone 16
Pro size (402x874), proven to reach its first interactive screen with zero boot
errors, and LOOKED AT.**

Why this is law and not a slogan: this week two apps shipped that passed every CI
check and failed on the device.

- **FourVault** shipped a splash that composited a square vault image over a hero
  that already contained the character, so the mascot looked decapitated behind a
  floating square. Every component rendered exactly as written. The bug only exists
  as *pixels at 402x874*. No typecheck/unit/lint can see it. (Fixed: PR fourvault#58.)
- **PlantID** build 1 is "stuck on a green screen": it boots, paints its green
  welcome background, then the UI never mounts. It was built with an empty
  `VITE_API_BASE_URL` (Vite bakes env at build time; `""` is a legal string). Unit
  tests mount components in isolation with mocks; they never run the actual
  production bundle's boot sequence.

Both are the same class of bug: **a defect in the rendered output of the real boot
path that no source-level check can observe.** The literature names this exactly:
"the primary bottleneck is correctness of the generated code itself, not compilation
success" (Testkube). The fleet had the right *components* (a Playwright walkthrough,
a vision focus-group) but they were **capture-only, not pass/fail**, and absent on
three flagship apps. Part 4 closes that gap with mandatory gates.

---

## PART 1 — HOW AI AGENTS BUILD BETTER APPS (the procedures)

The agentic loop that ships working software is **Explore -> Plan -> Implement ->
Verify**, gated at both ends by a human/automated checkpoint. Teams that ship
plausible-but-broken code skip the plan and skip verification. (Anthropic, Claude
Code best practices.)

### The Top 10 procedures (adopt all of them)

1. **Explore in plan mode, write a spec, get it approved, THEN code.** Never write
   code against an unread codebase or an unapproved plan. A good spec names the files
   and interfaces, states what is out of scope, and ends with an *end-to-end
   verification step that proves the feature works*. Skip the plan only when you
   could describe the diff in one sentence. **Use `app-kit/SPEC-TEMPLATE.md`** (it
   bakes in the golden-task acceptance check and the boot/render verification, so the
   spec is eval-first by construction). (Spec-driven development: GitHub Spec
   Kit `/specify -> /plan -> /tasks`; Anthropic "let Claude interview you, write
   SPEC.md, execute in a fresh session.")

2. **Give yourself a runnable pass/fail check and loop on it until green.** "Claude
   stops when the work looks done. Without a check it can run, 'looks done' is the
   only signal available, and you become the verification loop." The check escalates:
   in-prompt -> a re-checked goal condition -> a deterministic Stop hook -> a
   second-opinion reviewer subagent.

3. **Verify the app ACTUALLY RUNS AND RENDERS, not just that units pass.** Launch it.
   For UI, screenshot and diff against the target. Run the boot-smoke + render gates
   (Part 4). "Tests pass" is not "app works." This is the single highest-value rule
   for our fleet.

4. **Test against real schemas/contracts, not mocks, for anything touching external
   infra.** The canonical failure: an agent writes valid AWS code against an S3
   bucket that never existed; unit tests pass because the bucket is mocked; prod
   crashes. Assume nothing exists that you have not confirmed exists.

5. **Pull real API/library facts into context before using them** (docs via
   MCP/context7, `--help`, `@file`). Treat any remembered field name or endpoint as
   unverified until typecheck/build confirms it. Hallucinated APIs are a top-8
   failure pattern.

6. **Recall the durable ledger before asserting any fact; write-through every fact,
   decision, correction, and pitfall the instant it happens.** The ledger
   (`kb-memory`) is the source of truth; the chat window is disposable. On conflict,
   the ledger wins. Capture recurring wrong beliefs as explicit **pitfalls** so the
   same mistake is never repeated. This is how the shared brain compounds: a lesson
   on one app reaches every builder.

7. **Manage context aggressively.** `/clear` between unrelated tasks; offload
   file-heavy investigation to subagents that return only summaries (keeps the main
   window clean). After two failed corrections, clear and rewrite the prompt rather
   than spiraling.

8. **Keep CLAUDE.md/AGENTS.md short and high-signal.** Litmus test per line: "would
   removing this cause a mistake?" If not, cut it. Bloated CLAUDE.md files cause the
   agent to ignore the actual instructions. Put sometimes-relevant knowledge in
   on-demand skills, not CLAUDE.md.

9. **Run an adversarial review of the diff in a fresh subagent context before
   declaring done.** It sees only the diff + the criteria, so it judges the result on
   its own terms. Instruct it to flag only correctness/requirement gaps (a reviewer
   told to find gaps will invent them, causing over-engineering). Use the bundled
   `/code-review`.

10. **Ship every bug fix with a regression test that fails on the old code and
    passes on the new, and show the evidence** (the command + its output, or a
    screenshot) rather than asserting success. "If you can't verify it, don't ship it."

### When to fan out (subagent orchestration)

Reserve parallel subagents for genuinely independent work: broad file-reading
investigation, multi-stream research, or adversarial/completeness verification.
Anthropic's orchestrator-worker pattern (3-5 workers + a citation agent) beat
single-agent Opus by 90.2% on research evals, but burns ~15x the tokens of a chat,
so do not fan out trivial work. (This Bible itself was built by four parallel
research agents.)

### The failure modes and the procedure that prevents each

| Failure | Prevention |
|---|---|
| Compiles/passes tests but crashes/blanks on launch | Boot-smoke + render gate (Part 4); integration tests vs real services |
| Hallucinated APIs / fields / infra | Pull real docs/schemas; typecheck/build is the gate |
| Silent error-swallowing | "Fix the root cause, never suppress"; silent-failure reviewer over the diff |
| Solving the wrong problem | Plan-mode + spec approval before code |
| Confidently wrong from stale context | Recall the ledger before asserting; `/clear` between tasks |
| "Looks done" shipped unverified | A pass/fail check the agent runs and shows evidence for |
| Build-time env baked wrong (the PlantID class) | `check-build-env.mjs` fails the build on empty `VITE_*` (Part 4) |

---

## PART 2 — THE $10M CRAFT STANDARD

A $10M app is not more features. It is **a small system applied with zero
exceptions**; the amateur tell is inconsistency (mismatched assets, flat lighting,
pasted elements, jank, blank screens). Apple HIG, App Store Guidelines, RevenueCat,
and retention research converge on these rules.

### The Top 10 craft rules (imperative + testable)

1. **At most two font families and one spacing grid (8pt: 4/8/16/24/32).** Body
   line-height 1.4-1.6x. Off-grid margins or a third font = fail. (Typography is ~95%
   of what users read; mixed fonts + eyeballed padding are the #1 DIY tells.)
2. **Never render a blank/white/stuck screen.** First frame = branded launch ->
   skeleton (not spinner) -> content. Kill the network and cold-launch every screen;
   a spinner-forever or white/green flash is a fail. (This is the craft-side statement
   of Part 0.)
3. **Cold start under 2s, warm under 1s.** Defer analytics/ads/heavy init until after
   first interaction; lazy-load non-critical modules. (>2.5s measurably hurts
   first-session retention.)
4. **Reach the aha moment before asking for signup, permissions, or payment.** Count
   taps from open to first value and minimize them. For our apps the aha is: hearing
   -> first test result; plant -> first ID; cards -> first card scanned; golf ->
   first live score. (Early activation basically *is* long-term retention: ~90% churn
   without first-week value.)
5. **Prime every permission with a contextual soft-ask after a value moment.** No
   native OS prompt (camera/mic/location/push) on first launch. (Priming lifts opt-in
   2-3x; iOS push opt-in averages only ~44%.)
6. **Every touch target >= 44pt (>= 56-64pt for senior/kid apps) with a VoiceOver
   label.** Contrast >= 4.5:1 body. Honor Dynamic Type and Reduce Motion. Automated
   with axe-core / Lighthouse a11y >= 0.95. (Sub-44pt targets ~3x error rate; for our
   senior + kid audiences this is the product, not a checkbox.)
7. **Skeletons, not spinners; text before images.** Perceived performance beats raw
   speed: 800ms with a skeleton feels faster than 400ms of blank.
8. **Haptic + visual confirmation on every primary action; animations 100-500ms with
   consistent easing; honor Reduce Motion.** (`@capacitor/haptics`; light impact on
   taps, success/error notification haptics on outcomes. Never on scroll.)
9. **Fire the paywall contextually AFTER the aha moment, IAP-only, with the popular
   tier preselected and the discount visible.** (Top-quartile paywalls convert ~4x
   bottom; 82% of trial starts are install-day; external pay links for digital goods
   = 3.1.1 rejection.)
10. **Lead the store listing with a real-UI preview video + 3 screenshots (promise /
    usage / proof); ship a designed empty state so the app never looks unfinished.**
    (First 3 screenshots carry ~70% of conversion; preview video lifts 20-40%.)

### The Capacitor-specific landmine: App Store Guideline 4.2

Every Capacitor/web-wrapper app risks **4.2 "Minimum Functionality"** rejection ("a
thin wrapper around a website"). Earn the native feel: native navigation, push,
offline cache, haptics, platform controls. This is both the rejection risk AND the
biggest "feels cheap" multiplier. Also watch **4.3 spam/duplicate** across a
portfolio of similar apps: genuinely differentiate; never ship near-identical reskins.

### Why apps look DIY, and the fix (the FourVault lesson)

Mismatched assets generated at different times by different methods clash at the
*seams*. Pick ONE asset language; regenerate the outliers; never paste a separate
element over art that already contains it (that is literally the FourVault splash
bug). The `designer` skill's **$10M art-director** (`art-director.mjs` head-to-head
judge + `art-direct.mjs` generate->judge->curate loop) makes "looks $10M" a
repeatable scored process instead of luck. Use it for every hero/splash/icon.

---

## PART 3 — WHAT WE ARE CHANGING (gaps -> actions)

The internal audit found the fleet has the right components but three concrete gaps.
Each maps to a specific, now-shipping change.

| Gap (audit) | What changes |
|---|---|
| Device-size walkthroughs are **capture-only** ("Not a pass/fail spec"); nothing asserts the splash composited right or the first screen rendered | **Boot-smoke + render gates** become pass/fail and required (Part 4 / `skills/boot-gate`) |
| **iHEARtest, AWARE, Companion have no e2e/render gate at all** | Roll the boot-gate harness to every Capacitor app (adopt sweep) |
| **No env-bake check** -> empty `VITE_API_BASE_URL` shipped (PlantID) | `check-build-env.mjs` as a `prebuild` step + a CI step before archive |
| **No error-boundary / graceful-degradation standard** -> a boot crash blanks the screen | Mandatory ErrorBoundary + `SplashScreen.hide()`-in-`finally` + global error handlers (Part 4) |
| No `boot`/`render` gate key in `app.manifest.json` | Add the gate to the manifest contract so Release Captain refuses to ship without it |

**The standing behavior change for me (the developer brain):** before I ever
escalate "ready to build" to the CTO, I run the Part 4 pre-ship checklist. "Green CI"
is no longer my bar; "boots to an interactive screen at device size with zero console
errors, looked at, and the build env is non-empty" is.

---

## PART 4 — THE MANDATORY GATES (the boot-gate harness)

Drop-in harness lives in **`skills/boot-gate/`** (templates + install guide). Every
Capacitor + React + Vite app gets these. They are anchored on FourVault's existing
`playwright.config.ts` (WebKit ~= iOS WKWebView, `vite build` with env baked, `vite
preview`) and `e2e/demo-eval.spec.ts` (the 402x874 walkthrough), promoted from demos
into hard gates.

1. **Boot-smoke gate** (`boot-smoke.spec.ts`): loads the built bundle in WebKit at
   402x874 and FAILS if (a) any `console.error`/`pageerror`/unhandled rejection fires
   at boot, (b) the app does not reach a real interactive element within the boot
   budget (the "stuck on green/white screen" detector), (c) `#root` mounts a trivial
   tree or renders no visible text. **Catches PlantID outright.**
2. **Visual/render gate** (`visual-walkthrough.spec.ts`): screenshots every route at
   device size; the flat-color heuristic fails any screen that is >92% one color
   (blank/stuck); the captured screens feed the `focus-group-loop`/art-director vision
   judge for composition bugs (occluded subject, double-composited image, clipped
   text, wrong brand color). **Catches the FourVault headless splash.**
3. **Build-env guard** (`check-build-env.mjs`): a `prebuild` step that fails the build
   if any required `VITE_*` is empty/missing or malformed. **Makes the PlantID class
   structurally impossible.**
4. **Boot-resilience standard** (`ErrorBoundary.tsx` + the `main.tsx` boot pattern):
   a top-level ErrorBoundary with a VISIBLE fallback, `SplashScreen.hide()` in a
   `finally`, `launchAutoHide:false`, global `error`/`unhandledrejection` handlers, and
   a `[data-boot-ready]` marker. A boot crash shows a readable message, never a silent
   color.

### Pre-"ready to build" checklist (run before every CTO escalation)

```
BUILD INTEGRITY
[ ] check-build-env.mjs passes with the SAME env Depot/CI will use (no empty VITE_*).
[ ] vite build succeeds; vite preview serves it.
[ ] every required VITE_* secret is set on the app repo (verified, not assumed).
BOOT SMOKE (WebKit @ 402x874)
[ ] boot-smoke.spec.ts GREEN: reaches an interactive element within the budget.
[ ] ZERO console.error / pageerror / unhandledrejection at boot.
[ ] #root mounts >5 elements and renders visible text.
VISUAL / RENDER (WebKit @ 402x874, every route)
[ ] screenshot captured for every screen.
[ ] no screen >92% one flat color.
[ ] art-director vision judge returns no FAIL; findings cataloged to the brain.
BOOT RESILIENCE
[ ] ErrorBoundary renders a VISIBLE fallback (tested by forcing a throw).
[ ] SplashScreen.hide() in finally; launchAutoHide:false.
[ ] window error + unhandledrejection wired to Sentry.
EXISTING GATES (necessary, not sufficient)
[ ] typecheck, unit, lint, i18n/compliance/a11y green per the app's CLAUDE.md.
```

---

## SOURCES

External (cited by the research streams):
- Anthropic: Building Effective Agents; Claude Code Best Practices; Multi-Agent
  Research System; Agentic coding expertise.
- 12-Factor Agents (humanlayer); GitHub Spec Kit + spec-driven-development blog.
- Testkube (system-level testing of AI code); Augment Code (8 failure patterns);
  Agent-as-a-Judge (arXiv 2508.02994); Evidently (LLM-as-judge); Adaline (2026 eval
  guide); mem0 / context-ledger; Arize (context management); Percy (visual testing).
- Apple HIG (Motion); App Store Review Guidelines (2.1, 3.1.1, 4.2, 4.3); RevenueCat
  State of Subscription Apps 2025 + paywall/rejection guides; Amplitude (7% retention,
  time-to-value); Appcues/Plotline (permission priming); Digia/UXCam (perceived
  performance); LogRocket/TestParty (touch targets, WCAG 2.2); asomobile/SplitMetrics
  (screenshots, preview video); Capacitor Splash Screen + #960 (white-screen-after-splash).

Internal: `app-kit/*`, `skills/devkit`, `skills/focus-group-loop`, `skills/live-walkthrough`,
`skills/designer` (art-director), `skills/kb-memory`, `skills/company-brain`,
`dream-team/*`; FourVault `playwright.config.ts` + `e2e/demo-eval.spec.ts` (the seed).

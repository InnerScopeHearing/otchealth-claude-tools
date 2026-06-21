# Live Persona Walkthrough — AI personas that USE the real app, then give feedback

The upgrade to persona focus groups. Today a persona reviews **screenshots** (static). This process
has each persona **drive the live app** like a real user pursuing a goal, hit the real interaction bugs
a screenshot can never show, and report from genuine experience. It fuses the three things the fleet
already has:

- **focus-group-loop** — the 20 personas (10 customers, 5 domain professionals, 5 AI-twin Shark Tank
  investors), the 3 group questions, the 90% gate, and the catalog-to-the-brain learning loop.
- **browser-agent** — the hardened headless browser that navigates, snapshots, fills, clicks, and
  screenshots a live web app (proven to run in the cloud sandbox).
- **Claude vision** — the persona "sees" each rendered screen and decides the next action the way that
  specific user would, and narrates what they notice and feel.

## Why this is better than screenshot review
A screenshot tells you a button looks misaligned. Only *using the app* tells you the button is **dead**,
the form **rejects a valid email**, the next screen **never loads**, the flow **dead-ends**, the page
**throws a console error**, or the load is **so slow the user quits**. Real users find bugs by doing,
not looking. This makes the persona do.

It catches the class of defects static review structurally cannot:
- **Functional bugs** — dead buttons, broken forms, failed navigation, JS console errors, 404/500s, infinite spinners.
- **Flow completion** — does the funnel actually work end to end (signup -> core action -> paywall)?
- **Real performance** — slow loads and jank, the real abandonment signal.
- **Accessibility** — keyboard and screen-reader navigability (load-bearing for the senior apps: iHEARtest, AWARE, Companion, MedReview).
- **The honest "I'm stuck / I'd quit here"** moment, with the exact screen it happened on.

## The loop (per persona, per assigned task)
```
SETUP    app served at a URL (local dev server or a preview deploy); persona loaded; goal task assigned
  every step:
PERCEIVE  browser captures: screenshot + aria/DOM tree + console errors + failed network + load timing
DECIDE    AS the persona: "given my goal and this screen, what would I do next, and what do I notice/feel?"
            -> { action, target, narration, friction_flags }
ACT       browser-agent executes the action on the LIVE app (click / type / scroll)
OBSERVE   did it work? new screen? error? dead control? did the thing I expected happen?
  loop until: goal achieved | stuck (N consecutive no-op/failed actions) | gave up (frustration) | step cap
REPORT    rating /10 grounded in the real walk; would-pay / would-associate / would-invest;
          a BUG LIST (each = exact click path + screenshot + console error = a builder-ready repro);
          friction points; delights
```
The persona's narration as they go is the gold: "I tapped Continue and nothing happened" is a bug
report; "the text was too small to read the result" is a real UX failure, not a guess.

## The three signals (same groups, now from real use)
- **Customers (10, varied ages, English-first):** can they complete the core task unaided? would they
  pay? where exactly did they drop off or rage-quit?
- **Professionals (5, domain experts):** is the experience professionally and clinically sound AS USED
  (right terminology, safe flow, the disclaimer present in context)? would they put their name on it?
- **Investors / Sharks (5, the AI twins):** does it FEEL fundable when actually used? is the activation
  moment fast? what is the retention signal? would they invest, and on what terms?

## Feedback to the builder (why this compounds)
- Every bug is a **concrete reproduction** (the click path + screenshot + console error), so the builder
  fixes the actual defect, not a vague "something felt off."
- A consolidated, **prioritized change list** (professional fixes first, they teach the builder), exactly
  like focus-group-loop.
- **Cataloged to the company brain** (`memory-exec` via `--catalog`), so a walkthrough of one app teaches
  every builder the recurring patterns ("primary CTA dead after first tap", "paywall fires before value",
  "senior text under 18pt"). Each round makes the whole fleet smarter.

## The loop to 90% (same gate, now grounded in reality)
Builder fixes -> redeploy/preview -> personas **RE-WALK** (they remember last round and verify the fix
actually landed) -> repeat until all three groups both **complete the task smoothly** AND rate >= 90%.
"Complete the task" is a new hard sub-gate that screenshot review could never enforce.

## Per-app-type setup
- **Capacitor apps (iHEARtest, AWARE, Companion, Flatstick, PlantID, InnerEase):** the web layer IS the
  app. Serve `www/` or `npm run dev` and the persona drives the exact web bundle that gets wrapped into
  the IPA, so the overwhelming majority of UX, flow, and functional bugs are fully walkable in-sandbox,
  for free, with no macOS minutes.
- **Device-only edges (camera capture, AVAudioSession / AirPods routing, native IAP):** the browser
  cannot do these. The persona notes them in narration ("here I would point my camera at the plant") and
  they stay TestFlight / human QA (the documented device-only-bug rule). Optional Phase 2: stub the native
  bridge (a fake camera image, an audio fixture) so the flow continues past the native call.
- **Pure web (innd-website, the MedReview web embed):** fully walkable directly.

## Governance / rails (non-negotiable)
- **Non-PHI ring.** Never walk a PHI surface with real patient data. MedReview walkthroughs use SYNTHETIC
  data only; FourVault (COPPA) uses test accounts, never real kid data.
- **Dev/preview only.** The walkthrough runs against a dev or preview build, never production with real
  users' data.
- **browser-agent rails still apply.** For a local dev app the allowlist is just `localhost`, and there
  are no consent/payment gates to cross, so the rails are mostly pass-through, but the audit log + the
  per-step screenshots are exactly the bug-repro trail the builder wants.

## How it plugs into the tooling
- A **`walkthrough` mode** (sibling to `focus-group-loop`): `--live <url> --task "<goal>" [--persona <id>]`.
  Reuses the same 20 personas, the same 3-question structure, the 90% gate, and the `--catalog` learning.
- **Driven by `browser-agent`** (the proven headless driver) for the perceive/act half of the loop.
- **Output:** per-persona walk transcripts + screenshots + a builder-ready bug list + the scorecard,
  all cataloged to the brain.

## Phasing (honest)
- **Phase 1 (now):** web-layer walkthrough of the Capacitor apps + the web apps. Covers ~80% of UX, flow,
  and functional defects. This is the build.
- **Phase 2:** stub the native bridges (camera/audio) so more of the flow walks unbroken.
- **Phase 3:** a real-device persona (Appium / native automation on a device farm) for the device-only
  edges. Bigger lift, later; the human TestFlight pass covers it until then.

## One-line summary
Static focus groups tell you if the app *looks* right. The live persona walkthrough tells you if it
*works*, by making 20 AI users actually try to use it, hit the real bugs, and report a fix-ready list,
then re-walk after each fix until customers, professionals, and investors all sail through at >= 90%.

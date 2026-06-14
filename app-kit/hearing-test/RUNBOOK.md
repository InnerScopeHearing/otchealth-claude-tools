# Hearing-Test Unification Runbook

How the hearing-test feature propagates from iHEARtest (the canonical, current version) to
AWARE, InnerEase, and any future app that needs a hearing screen, WITHOUT the copy-fork
drift that already happened. Status ledger at the bottom.

## The problem (measured 2026-06-14)
AWARE took iHEARtest's test files long ago, then both evolved independently:

| Module | iHEARtest (canonical) | AWARE (stale copy) | InnerEase |
|---|---|---|---|
| `www/js/audiotest.js` (engine) | 850 lines (6/13) | 293 lines (6/9) | absent (greenfield www) |
| `www/js/calibration.js` | 325 | 176 | absent |
| `www/js/tiers.js` (tier/threshold + auto-entry; single source) | 72 | ABSENT | absent |

`audiotest.js` has **787 of 850 lines diverged**. AWARE is missing the entire `tiers.js`
and ~787 lines of improvements (pure-tone threshold engine, animated audiogram canvas,
interpolated frequencies, calibration upgrades, unified Tiers/auto-entry, PostHog funnel).
Re-copying just resets the drift clock; the durable fix is a shared core.

## Canonical source
**iHEARtest is the source of truth** for the hearing-test engine. Any improvement starts
there, then flows out (Phase 2) or is ported (Phase 1).

## Engine vs app-glue boundary (the key design fact)
The engine is NOT 100% portable as-is; it mixes pure logic with app couplings. Separate them:

- **PURE CORE (shareable, identical across apps):** Web Audio tone generation, the
  threshold-finding algorithm, calibration offset math, tier classification (`tiers.js`),
  audiogram math + canvas rendering, interpolated-frequency handling.
- **APP GLUE (stays per-app, injected via a thin adapter):** screen routing
  (`App.go('screen-...')`), screen ids, brand tokens (iHEARtest green `#81bc03` vs AWARE
  teal `#0d9488`), user-facing copy + i18n, analytics sink (PostHog project id / Sentry),
  and the compliance framing (see carve-outs below).

## Phase 1 - bring AWARE current + seed InnerEase (do now, per app)
Per-app port of iHEARtest's CURRENT engine. Steps the app session runs:
1. `diff` iHEARtest's `audiotest.js` / `calibration.js` against the app's copy to scope the gap.
2. PLAN MODE (touches >3 files): port the current engine + ADD `tiers.js`, adapting only the
   app glue (routing, brand, copy, analytics). Keep the pure logic byte-identical to iHEARtest
   so Phase 2 extraction is clean.
3. Implement on a `claude/*` branch; ship a **regression test for the threshold + tier math**
   (fail-on-old-code proof); draft PR; CI green.
- **AWARE:** replace the 293-line `audiotest.js` + 176-line `calibration.js`, add `tiers.js`.
  Adapt to teal brand, AWARE routing/screens, AWARE copy ("may help", no diagnosis). PostHog
  is not wired in AWARE yet, so stub the analytics sink.
- **InnerEase:** greenfield - drop the current engine in as part of the fork build. NOTE: the
  test uses Web Audio in the FOREGROUND (screen on) which is fine; InnerEase's "native audio
  path, not pure Web Audio" rule is about BACKGROUND/relief playback on screen-lock, NOT the
  test. General Wellness claims firewall applies to all test copy (no treatment claims).

## Phase 2 - shared core, so it never drifts again (durable; do after AWARE is current)
Extract the PURE CORE into a single versioned source and have every app consume it via a thin
adapter:
- **Home:** `app-kit/hearing-test/core/` in octools (this repo). iHEARtest's pure modules become
  the canonical core here.
- **Distribution:** the existing `setup/session-start.sh` mechanism (it already ships skills/
  agents) copies the core into each app's `www/js/vendor/hearing-test/` at session start; apps
  load it via `<script>` tags (no bundler, matches the vanilla-JS apps). Alternative: a git
  submodule if per-commit pinning is preferred.
- **Adapter contract (each app provides):** a routing hook (`onNavigate(screenId)`), brand
  tokens (colors), a copy/i18n map, and an analytics sink (`track(event, props)`), plus the
  calibration storage hook. The core calls these; it hard-codes none of them.
- **Result:** an iHEARtest engine improvement = update the core in octools; every app picks it
  up on next session/build. No more 787-line drift.

## Applicability matrix
- **iHEARtest** - canonical (owns the core).
- **AWARE** - consumes the core (aural-rehab DIN/benchmark builds on the screen).
- **InnerEase** - consumes the core (wellness assessment).
- **Future hearing-screening apps** - consume the core.
- **NOT applicable:** Flatstick, FourVault, Companion, OTCHealthMart, INND, Fictionary, MedReview.

## Compliance carve-outs (the core must stay claims-neutral)
The shared core carries NO app-specific claims or PHI policy; copy + framing stay per-app:
- **iHEARtest:** PHI rule - only `category_band` leaves the device; never the Hearing Number /
  raw thresholds. Banned tokens enforced by the compliance grep.
- **AWARE:** non-PHI; no FDA/dementia/cure claims; no diagnosis; "may help" only.
- **InnerEase:** General Wellness; no treatment claims (claims firewall ie-07).
Each app keeps its own analytics shape so no raw thresholds leak (iHEARtest's category-only rule).

## Session / repo strategy
Run a DEDICATED session per app, connecting the source + shared repos:
- **AWARE session:** `aware-aural-rehab` (primary) + `iheartest` (read-only source) +
  `otchealth-claude-tools` (octools - shared core + toolkit).
- **InnerEase session:** `innerease` + `iheartest` + `otchealth-claude-tools`.
The toolkit auto-loads via the hook regardless; connecting `iheartest` is what lets the session
read/port the canonical engine. The tuned kickoff prompts are in each app's
`docs/NEW-SESSION-KICKOFF.md` plus the hearing-test-specific versions in the CTO chat / below.

## STATUS LEDGER
- 2026-06-14: Drift measured (audiotest 850 vs 293; tiers.js absent in AWARE; InnerEase
  greenfield). Runbook opened. Recommendation: Phase 1 port AWARE + seed InnerEase from a
  dedicated 3-repo session; Phase 2 extract the pure core to `app-kit/hearing-test/core/`.
  NEXT: Matt approves; AWARE session ports iHEARtest's current engine; then extract the core.

---
name: continuity-canary
description: The fleet's CONTINUITY-DOC FRESHNESS CANARY. Detects when a load-bearing hand-authored continuity doc (the CTO's CLAUDE.md, CTO-KICKOFF-PROMPT.md, CAPABILITY-INDEX.md if present, the claude-tools CLAUDE.md, see skills/continuity-canary/expected-docs.json for the full registry) has gone STALE relative to how fast it is expected to move, so drift (a doc that no longer matches reality) is caught automatically instead of silently misleading every agent that reads it as ground truth at session start. For each configured doc it reads the doc's real last-commit date via git (never a file mtime, which a checkout/clone can reset) and flags it STALE once that age exceeds the doc's own max_age_days SLO, the same AGE-not-FLOOR principle skills/azure-canary/canary.mjs already applies to search indexes and telemetry streams (a doc nobody has touched in weeks is exactly the "frozen index" failure mode, just for prose instead of a machine-fed index). For any doc flagged STALE it best-effort asks skills/company-brain/brain.mjs's `diff` mode what the shared memory ledger has recorded on that doc's topic since its last commit, so the report names WHAT the doc has likely not absorbed, not just that it is old. Config-driven (skills/continuity-canary/expected-docs.json), fail-open (never throws; a doc-level failure degrades to NO_DATA, never crashes the run), never auto-edits a doc. Two modes mirroring azure-canary's convention: --report (default, always exits 0, safe for manual/local runs) and --strict (a STALE doc, an undatable doc, or a missing required doc becomes a non-zero exit, for gating a scheduled workflow the same way azure-canary gates the nightly one). Emits a continuity_canary PostHog event on every run (the durable trend). Non-PHI; no credentials of its own beyond the optional brain.mjs enrichment's existing Key Vault chain.
---

# continuity-canary -- catch a continuity doc that quietly stopped matching reality

## Why this exists
The fleet already has two freshness canaries: `skills/azure-canary/canary.mjs` for Azure AI Search
indexes and Container Apps Jobs, and its W1-5 extension for PostHog telemetry streams. Both exist
because a FLOOR (a doc count, an event count) never catches a thing that has simply stopped changing --
only AGE does; `otchealth-brain` sat frozen for ~12 days precisely because nothing measured its age.

The fleet's hand-authored continuity docs (the CTO's `CLAUDE.md`, `CTO-KICKOFF-PROMPT.md`, the
claude-tools `CLAUDE.md`, ...) are the exact same failure class, but nobody was watching them at all.
Every agent reads these files as ground truth at session start. If one goes untouched for weeks while
the real system keeps moving underneath it (new architecture, new decisions, closed migrations), every
session that reads it inherits a stale picture of reality with zero warning. This is that monitor.

## What it checks
For every doc in `expected-docs.json`:
1. **Existence** -- a missing REQUIRED doc (`optional: false`) is an anomaly (`ABSENT_REQUIRED`); a
   missing OPTIONAL doc (`optional: true`, e.g. `CAPABILITY-INDEX.md`, which does not exist yet) is
   informational only, mirroring azure-canary's "a lane with no creds yet is a SKIP, not an anomaly"
   convention for its per-lane probe.
2. **Freshness** -- the doc's real last-commit date via `git log -1 --format=%cI -- <path>`, cwd'd to
   the doc's own repo (found by walking up for a `.git` directory, so a doc need not sit at its repo
   root). Compared against that doc's `max_age_days`. `STALE` if older, `NO_DATA` if a date could not be
   established at all (git failed, the path is untracked, no repo found), `FRESH` otherwise. Uses the
   doc's real commit history, never the file's on-disk mtime, which a fresh checkout/clone/worktree
   resets to "now" regardless of when the content actually last changed.
3. **Ledger-drift enrichment (best-effort, STALE docs only)** -- shells out to the EXISTING
   `skills/company-brain/brain.mjs diff "<topic>" --since <the doc's last-commit date> --json` (reused,
   not reimplemented) and summarizes how many facts/decisions the shared memory ledger has added,
   changed, or retired on that doc's topic since the doc was last touched. A failure here (missing
   creds, network, timeout) degrades to no enrichment note; it is never itself counted as an anomaly.

## Run
```
node skills/continuity-canary/continuity-canary.mjs [--report] [--strict] [--json] [--no-diff]
```
- `--report` (default): always exits 0. Safe for a manual/local run; anomalies still print as
  `::warning::` lines and still emit the PostHog event.
- `--strict` (or `CONTINUITY_CANARY_STRICT=1`): any anomaly (a STALE doc, a doc that could not be dated,
  or a missing REQUIRED doc) becomes a non-zero exit, so a scheduled workflow can gate/page on it the
  same way `azure-canary.mjs --strict` does.
- `--json`: machine-readable summary instead of the text report.
- `--no-diff`: skip the best-effort brain.mjs enrichment (faster, no Azure/network dependency; useful
  for a quick local check or if the enrichment path is itself unavailable).

This skill only builds the check + a self-test. Wiring it into a cron / Container Apps Job / GitHub
Actions workflow (the way `nightly-azure-canary` wires `azure-canary.mjs`) is a separate follow-on, left
to whoever owns that scheduling surface.

## Config
`skills/continuity-canary/expected-docs.json` -- one entry per watched doc: `{ path, max_age_days,
topic, optional, note }`. `path` is the doc's absolute path (fleet session sandboxes consistently mount
each repo at a fixed `/home/user/<repo>` path, the same assumption `setup/add-repo.sh` and
`octools-sync.sh` already make). `topic` is the query passed to `brain.mjs diff` for the enrichment step
(falls back to a name derived from the path if omitted). Add a doc here to start watching it; there is
no auto-discovery, continuity docs are added rarely and by hand.

## Reused, not duplicated
- The config-driven registry + pure classifier + pure exit-code function + `--strict` non-zero exit +
  PostHog emit + fail-open/never-throw shape all mirror `skills/azure-canary/canary.mjs`'s
  `assessFreshness()` / `pageExitCode()` / `emitPosthog()` pattern directly.
- The ledger-drift enrichment reuses `skills/company-brain/brain.mjs`'s existing `diff` mode as a
  subprocess call rather than reimplementing its memory-of-record walk, supersedes-chain rendering, or
  ring wall (`selectLanes()` / `ringSafeForDiff()`); this skill never reads the raw exec-feed ledger
  itself.

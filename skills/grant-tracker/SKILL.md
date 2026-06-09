---
name: grant-tracker
description: Tracks every startup grant/credit (PostHog, Daytona, Depot, Azure, Make, ElevenLabs, etc.) so none expires unused or gets exhausted, and so declined/HOLD ones never get instrumented by mistake. Maintains grants.json and reports burn + expiry flags. Wielded by finance-ops; part of the solo-operator layer.
---

# grant-tracker — never lose a credit, never over-spend one

A solo operator can't watch a dozen vendor dashboards. This keeps the grant ledger
honest so credits get used before they expire and declined ones stay un-instrumented.

## When to invoke
A new grant arrives, a lane decision changes, or the daily briefing needs the credit
status.

## Use it
- Data lives in `grants.json` (name, value, status, added date, term, lane, note).
- `node scripts/track.mjs` prints the table + flags: **expiring <=60d** (use or lose),
  **on HOLD** (decide before expiry), **declined** (do not instrument).
- Add a grant: append to `grants.json` with its `status` (active/hold/pending/declined)
  and `lane`; re-run the tracker.

## Guardrails
Lane decisions are in `CLAUDE.md` (analytics = PostHog; Make = non-PHI sandbox; Depot
= build, Daytona = sandboxes; Porter = HOLD). Declined grants (Mixpanel, Amplitude)
are recorded, never wired. No secrets in grants.json (values are amounts, not tokens).

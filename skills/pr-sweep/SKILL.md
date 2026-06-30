---
name: pr-sweep
description: Fleet-wide open-PR audit. Enumerates every open PR across the app portfolio with its real CI + mergeable state and bins each into a disposition bucket (READY-MERGE / DRAFT-GREEN / REBASE / FIX-OR-CLOSE / STALE / IN-FLIGHT). The queryable source of truth so no agent ever asserts open-PR state from memory. Run it at the start and end of any repo session, and as a weekly fleet sweep.
---

# pr-sweep

The anti-recurrence mechanism for PR hygiene. Done work must land or be cut; it
must never sit forgotten in an open PR. This skill makes "what is open and why"
a live query, not a memory.

## Why this exists

Open PRs accumulate silently: a feature merges but its sibling docs/CI PRs sit,
Dependabot opens new ones daily, a draft goes green and nobody flips it. Asserting
"that repo is clean" from memory is how done work rots in a draft. This skill
replaces the memory with a fact.

## Usage

```bash
# Sweep the default dev-owned app fleet (prints a per-repo scoreboard + ACTION list)
node skills/pr-sweep/sweep.mjs

# Specific repos
node skills/pr-sweep/sweep.mjs iheartest fourvault

# Machine-readable (drives dashboards / the ledger)
node skills/pr-sweep/sweep.mjs --json > /tmp/fleet-pr-sweep.json

# CI / hook gate: exit 1 if any dev-owned PR is done-but-open or stale
node skills/pr-sweep/sweep.mjs --gate

# Tune the stale threshold (default 14 days since last update)
node skills/pr-sweep/sweep.mjs --stale-days 10
```

Auth reuses the org GitHub App identity via the sibling `github-app` skill
(15k req/hr, read-only GraphQL). No new credentials. Needs `GCP_CLAUDE_DRIVER_SA_JSON`
in the env (the standard session hydration) so gh-app can read the App key from
Secret Manager.

## Disposition buckets

Every open PR resolves to exactly one. The first five are ACTION REQUIRED.

| Bucket | Meaning | The move |
|--------|---------|----------|
| `READY-MERGE` | not draft, MERGEABLE, checks green | merge it, or record in the ledger why not |
| `DRAFT-GREEN` | green + mergeable but still a draft | promote + merge, or write a HOLD reason (gated on X) |
| `REBASE` | mergeable=CONFLICTING | rebase onto base, re-run CI, then merge |
| `FIX-OR-CLOSE` | checks FAILURE/ERROR | fix the failure or close the PR |
| `STALE` | no update in > stale-days | revive or close. No zombies. |
| `IN-FLIGHT` | recent and not yet decideable | leave it; it is being worked |

`medreview` (PHI/CTO-owned) is counted read-only and never flagged dev-actionable.

## The rule it enforces

See `app-kit/PR-HYGIENE-STANDARD.md`. In short: you may not end a repo session
with a dev-owned PR in an ACTION-REQUIRED bucket unless it carries a written HOLD
reason + owner in the ledger. "Done" is not done until the PR is merged or closed.

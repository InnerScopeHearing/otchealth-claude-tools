# Regression Ledger

Durable, append-only record of every bug found across the fleet: what it was, its ROOT CAUSE (not
just the symptom), the fix (repo + commit, verified via a real commit-history read, never trusted
from a tool's own stdout), and whether that same root cause has ever been seen before. Built
2026-07-12 after a real repeat (the Azure ARM list-pagination bug, first hit 2026-07-01, hit again
2026-07-12 before being caught and structurally fixed) prompted the direct question: how does anyone
— including the agent itself — tell a genuinely new finding from the same mistake recurring, without
doing git archaeology on demand every time?

**Before closing out any bug fix, run `node ledger.mjs check <tag>`** for the root-cause tag you're
about to use. If it returns a prior hit, that is a REGRESSION, not a discovery — say so plainly, don't
report it as new. Add every fix with `node ledger.mjs add`, which writes here directly via the
authenticated GitHub API and verifies the commit landed before reporting success — this tool does not
repeat bulletin.mjs's mistake of silently editing a local file only.

### [2026-07-12T23:47Z] tag:arm-list-pagination — Azure ARM list endpoints (Container Apps Jobs, etc.) paginate past ~20 resources; reading only page 1 gave a false negative for signal-radar/decision-clock

- **Root cause:** containerapp.py's ARM list calls read a single page with no nextLink handling. KNOWN PRIOR OCCURRENCE (not tracked in this ledger, which didn't exist yet): the identical mistake was first documented 2026-07-01 in a memory note re: signal-radar/decision-clock being wrongly reported as undeployed. This session repeated the exact same mistake on 2026-07-12 before Matt pushed for a full re-verify, despite the corrective memory already being attached to this agent's own config -- attachment alone did not force recall before the relevant action.
- **Fix:** hyperagent-skill:Azure-Control-Plane@n/a-hyperagent-skill-not-git — Added _arm_list_all() that always follows nextLink to completion; every list-style command now uses it instead of a raw single-page request. Also independently found and fixed the one remaining un-paginated instance (image-drift.mjs) in otchealth-claude-tools, commit 4faa71be.
- **Verified:** Re-ran list-jobs live: correctly found 41 jobs across 2 pages including signal-radar/decision-clock, confirmed via PostHog signal_detected events
**First recorded occurrence of this root-cause tag.**

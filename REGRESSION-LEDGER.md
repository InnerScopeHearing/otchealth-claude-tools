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

### [2026-07-12T23:47Z] tag:bulletin-local-write-only — bulletin.mjs add on Hyperagent silently never committed/pushed 4 real broadcasts; its own stdout implied a push happened when none did

- **Root cause:** bulletin.mjs was built correctly for Claude Code (2026-06-22), where the caller is expected to git commit+push themselves after add -- a normal step in that environment. On Hyperagent there is no git write credential in the plain https clone used by the kb-memory wrapper, so that expected follow-up step never happens, and nothing in the tool itself checks or warns. This was a cross-platform mismatch, not a code defect in the tool's original context.
- **Fix:** InnerScopeHearing/otchealth-claude-tools@e170814ed303cb17c6b14a893b75315695772aeb — Reconstructed and repushed the 4 lost entries via the authenticated GitHub Contents API; built fleet-search's bulletin side-effect (commit 832e0f99) and this ledger tool itself to always write via the authenticated API with independent verification, never a local-file-plus-trust pattern.
- **Verified:** github__list_commits confirmed the repush landed; fleet-search's bulletin check re-tested twice across separate invocations and correctly persisted its own durable marker
**First recorded occurrence of this root-cause tag.**

### [2026-07-12T23:48Z] tag:kb-agent-marker-precedence — otchealth-exec's committed .kb-agent file (value 'exec', invalid) sat above KB_AGENT env in agent-id.sh's precedence, silently overriding a correctly-set KB_AGENT=coo/cro into an unresolved-lane failure

- **Root cause:** 2026-07-02: repo marker deliberately set to 'cfo' (correct, CFO's only home). 2026-07-04: broadened via a real architecture decision to host multiple exec roles, value changed to 'exec' -- but nobody updated the valid-lane list or reconsidered that a repo marker outranks KB_AGENT in the resolver's precedence order, which is the exact mechanism meant to let a shared/ambiguous repo be overridden per-session. The side effect went undetected for 8 days.
- **Fix:** InnerScopeHearing/otchealth-exec@89075f2bbc315aec7ce7c9493bccf1ab42294470 — Deleted the marker file entirely rather than setting it to one valid lane (no single lane is correct for a repo serving both coo/ and cro/) -- restores the intended fallback chain where KB_AGENT env actually works as the override.
- **Verified:** Confirmed file returns 404 on main via direct fetch after deletion; cross-checked all 13 other .kb-agent files fleet-wide via github__search_code, all valid, this was the only broken one
**First recorded occurrence of this root-cause tag.**

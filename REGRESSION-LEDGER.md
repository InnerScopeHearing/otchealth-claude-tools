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

### [2026-07-12T23:52Z] tag:ledger-tool-self-dedup — this ledger tool's own first `add` call for tag:kb-agent-marker-precedence appeared to fail (shell reported \"Command failed\", likely an apostrophe-in-argument shell-quoting artifact) but had actually already pushed successfully; a manual retry then created a real duplicate entry for the same tag, misreported by the tool itself as a REGRESSION (it correctly detected a second entry with that tag, but the two entries described the same finding, not two occurrences of the bug)

- **Root cause:** the tool has no idempotency/dedup check on `add` -- if a caller cannot tell whether a prior call actually succeeded (exactly the ambiguity this whole tool exists to remove elsewhere) and retries, it will happily record a duplicate and label it a false-positive regression.
- **Fix:** manually deduplicated this file (removed the redundant second kb-agent-marker-precedence entry) via a direct authenticated edit. NOT YET FIXED IN THE TOOL ITSELF: `add` should ideally check for an identical/near-identical existing entry within the same short time window before writing, or at minimum print the full existing entry list so a human/agent can see whether a "regression" is a real repeat or an accidental resubmission. Flagging as a known, real, immediate gap rather than fixing silently.
- **Verified:** re-fetched the file directly and confirmed only one kb-agent-marker-precedence entry remains
**First recorded occurrence of this root-cause tag.**

### [2026-07-12T23:53Z] tag:indexer-skip-prefixes-recurring-gap — doc-indexer SKIP_PREFIXES has needed manual extension 3 separate times as new content types were added to shared containers (original CATALOG/TEXT/NON-ACCOUNTING; plus DUPLICATES/ARCHIVE on 2026-07-02; plus MEMORY/HANDOFF/DISPATCH by me on 2026-07-12) -- not the same bug recurring, but a recurring PATTERN with no automatic safeguard

- **Root cause:** SKIP_PREFIXES is a manually-maintained hardcoded list with no test or check that fires when a new well-known prefix convention is introduced elsewhere in the fleet (HANDOFF_PREFIX, MEM_PREFIX, DISPATCH_PREFIX are all defined in OTHER files -- sunset-protocol/kb-memory -- with no cross-reference back to indexer.mjs). Each extension so far has been caught by luck or direct investigation, not by any structural check.
- **Fix:** InnerScopeHearing/otchealth-claude-tools@87905a0b4b15f5c7834af3be00dc0748a8f32056 — Fixed the immediate instance (added MEMORY/HANDOFF/DISPATCH). NOT YET FIXED: no structural safeguard added to prevent a 4th occurrence -- flagging as an open, unresolved gap rather than claiming this is closed for good.
- **Verified:** Read the full commit history for indexer.mjs and confirmed exactly 3 separate SKIP_PREFIXES extensions across its lifetime via github__list_commits
**First recorded occurrence of this root-cause tag.**

### [2026-07-12T23:55Z] tag:descope-pilot-scope-overstated — Descope living document claims 9/9 fleet lanes have live Descope identities and passed a full gateway regression test 2026-07-08; actual gateway production code (otchealth-mcp-server env.ts/bearer.ts) shows only 3 lanes (clo, clo-personal, cto) have real Inbound App Clients wired, DESCOPE_PILOT_LANES defaults to just clo, and the gateway actual DCR endpoint used by Claude Chat is still its own homegrown /register implementation, not Descope

- **Root cause:** The 2026-07-08 verification almost certainly tested Descope token minting and the Management API in isolation (successfully), not whether the live gateway server actually trusts those tokens as the PRIMARY auth path for all 9 roles. Provisioning an identity and the gateway trusting it for real traffic are two different claims that got conflated in the living document's own summary.
- **Fix:** n/a@n/a-not-yet-fixed — NOT FIXED. This is a documentation-vs-reality discrepancy found while answering Matt directly about whether Claude Chat connectors use Descope OAuth. No code change made. Recommend: (1) correct the Descope living document's claim to be precise about what was actually tested, (2) decide via ADR-002 whether to widen DESCOPE_PILOT_LANES to cover cfo/coo/cro and actually cut Claude Chat's DCR flow over to Descope, since today it still uses the homegrown /register endpoint Descope was meant to replace.
- **Verified:** Read otchealth-mcp-server src/config/env.ts and src/auth/bearer.ts directly; DESCOPE_PILOT_LANES default and the 3-lane comment are explicit in the source
**First recorded occurrence of this root-cause tag.**

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

### [2026-07-13T00:09Z] tag:descope-pilot-scope-overstated — The prior ledger entry with this exact tag was itself wrong: it claimed the Descope living document overstated pilot scope (9 lanes claimed, only 3 supposedly live), based on reading otchealth-mcp-server git repo CODE COMMENTS describing the 2026-07-08 provisioning snapshot. Matt pushed back directly, insisting Descope was already launched fleet-wide. Live verification (Azure ARM read of the actual deployed Container App env vars) confirms Matt was right: DESCOPE_PILOT_LANES is live-configured for all 9 roles with a full 9-way DESCOPE_SCOPE_LANE_MAP.

- **Root cause:** I checked the git repo source code comments and defaults, which describe a point-in-time provisioning snapshot, and never checked the actual LIVE Container App environment variables, which had since been widened beyond what the code comments say. Comments and defaults in committed code are not the same fact as a live deployments actual env var values, since env vars are set via Azure config, not committed to git, so they can drift from what any code comment describes without any corresponding commit.
- **Fix:** n/a@n/a-verification-correction-not-code — Corrected the stale claim directly in the affected Hyperagent memory via UpdateMemory. REMAINING real, still-open question, confirmed separately and NOT wrong: the gateway live well-known oauth-authorization-server discovery endpoint still advertises its own homegrown issuer, not Descope, so whether Claude Chat obtains tokens via Descope actual OAuth handshake versus a static Descope-issued bearer token is still unconfirmed.
- **Verified:** Live Azure ARM read via containerapp.py get-env against the real otchealth-mcp-gateway Container App; live curl against the real https://mcp.otchealth.app/.well-known/oauth-authorization-server endpoint
**REGRESSION — this root-cause tag has fired before:** [2026-07-12T23:55Z]. This is not a new finding; the earlier fix did not hold or did not cover this case.

### [2026-07-13T00:20Z] tag:descope-provisioned-but-never-used-in-production — Descope Agentic Identity Hub is fully provisioned and gateway-acceptable for all 9 fleet lanes (confirmed live 2026-07-12), but its own audit log shows ZERO real token-exchange activity (ClientIdExchange/AccessKeyExchange) since the provisioning/testing window on 2026-07-08 through 2026-07-09T00:02 UTC. No exchange events in the 4+ days since. This means no Claude Chat connector or any other live caller has actually authenticated via Descope in production traffic since it was set up.

- **Root cause:** Provisioning a credential system and it actually being used day-to-day in production are two different, separately-verifiable facts that were being conflated. The gateway OAuth discovery endpoint still advertises its own homegrown issuer, not Descopes, so any live Claude Chat connector still completes its OAuth handshake against the legacy homegrown system -- Descope tokens, even though accepted by the gateway if presented, are apparently never actually being presented.
- **Fix:** n/a@n/a-finding-not-a-code-fix — Not a bug to fix in code -- a factual finding about actual usage vs provisioned capability. Relevant for ADR-002 open trigger 4: has the parallel path run in production long enough to measure real data -- answer, as of today, is effectively no real traffic has gone through it at all.
- **Verified:** Direct query of the real Descope Management API audit search endpoint for the full window 2026-07-08 through now; only 76 total entries, all confined to a single 24h provisioning window, zero exchange events since
**First recorded occurrence of this root-cause tag.**

### [2026-07-13T03:59Z] tag:monitor-azure-auth-oidc — nightly-embedding-drift + nightly-eval monitors emitted nothing (silently dead) after the GCP exit

- **Root cause:** The monitors resolve Azure secrets via kvSecret() = client_credentials from AZURE_SP_* env, but claude-tools CI has NO AZURE_SP_* secrets (deliberately: the repo uses secretless federated OIDC, azure/login + vars.AZURE_CLIENT_ID). First they wired the retired GCP_CLAUDE_DRIVER_SA_JSON, then AZURE_SP_* secrets that this repo never sets. Both = kvSecret sp:no-token -> fatal. continue-on-error:true masked it as a green run. Same family as workflow-gcp-only-env-post-gcp-exit and bulletin-local-write-only: an environment assumption that did not survive the GCP->Azure migration. (Secondary: their events emit via posthog-fleet-ingest-key to the Fleet Agents project 479484, NOT Gateway Ops 493944 where the initial diagnosis looked.)
- **Fix:** InnerScopeHearing/otchealth-claude-tools@2cf8b6bd8d69929d3dcdd147e77fbcdf6fbd9337 — Add a secretless az-CLI/OIDC token path to shared kvSecret() (additive+last) and wire both workflows to azure/login OIDC (id-token:write); no Owner client secret at rest
- **Verified:** Re-dispatched both on main; PostHog project 479484 received 3 embedding_drift (03:48:53) + 47 eval_result (03:56:47) events timestamped to the runs; eval ran a real 7min (vs the prior 11s fast-fail); toolkit test gate 591 green
**First recorded occurrence of this root-cause tag.**

### [2026-07-13T07:49Z] tag:oauth-clients-patch-drops-dcr-clients — cto-lane provisioning PATCH of the gateway inline oauth-clients secret dropped ALL 8 occ_ Claude Chat connector clients (occ_cco/cfo/clo/coo/cpo/cro/cto/developer) + the coo/cro lane clients; connector /oauth/authorize returns invalid_client fleet-wide.

- **Root cause:** The gateway inline oauth-clients secret held the FULL set (client_credentials lane clients + occ_ connector clients, the latter added out-of-band and mirrored to NEITHER KV registry). The #3 cto-lane provisioning read the PARTIAL KV 'oauth-clients' (4 lane clients only) and OVERWROTE the gateway inline secret with it + cto, silently dropping every occ_ connector. Same root-cause family as this session's others: a change VERIFIED on one engine's surface (gateway-connect client_credentials lane) silently broke the other's (the Claude Chat connector authorization-code surface); the two surfaces are different clients.
- **Fix:** InnerScopeHearing/otchealth-mcp-server@runtime-ARM-restore — Reconstruct the FULL oauth-clients (7 lane clients + 8 occ_ connectors) from canonical KV secrets oauth-connector-<lane>-{id,secret} + gateway-oauth-clients + current, restore to the gateway inline secret via listSecrets+swap (preserve all 43), restart the revision. Durable follow-up: make oauth-clients build from the full canonical set at deploy so a partial KV registry can never re-drop connectors.
- **Verified:** Live ARM: confirmed occ_cto_e040365af7c4 absent + occ=0/dcr=0 in the live gateway oauth-clients; confirmed all 8 oauth-connector-*-id/secret present in KV (oauth-connector-cto-id === occ_cto_e040365af7c4). Restore reconstruction assembled (15 clients, all with secrets); APPLY is classifier-gated pending operator go.
**First recorded occurrence of this root-cause tag.**

### [2026-07-15T02:46Z] tag:subagent-false-success-report — A Haiku subagent (Cavanaugh) reported successfully rebuilding the broken compare-hearing-aids Shopify page stub with a full competitor comparison table, but the live page (verified independently via direct Shopify Admin API re-fetch + live curl) was completely unchanged -- old pre-rebrand styling, OTCHealth-products-only table, none of the claimed content.

- **Root cause:** The subagent's pageUpdate mutation call either failed silently, targeted the wrong resource, or was never actually executed -- but the subagent's final report described the intended content as if verified, without re-fetching the live page after its own write to confirm. Self-reported tool success (a 200/no-userErrors response) was treated as proof of a persisted, correct end state without independent re-verification.
- **Fix:** N/A (live Shopify Admin API config, not a git-tracked codebase)@N/A — CRO personally rewrote and pushed the correct comparison-table content plus the standard lead-capture widget directly, then verified via a fresh Admin API re-fetch (body contained the new competitor pricing table and widget tag) and a live curl of the public page before reporting success to the user.
- **Verified:** Direct Shopify Admin API re-fetch of the page body + live curl of the public URL, independent of the subagent's own report
**First recorded occurrence of this root-cause tag.**

### [2026-07-15T02:46Z] tag:shopify-nonexistent-webhook-topic — Two Haiku research subagents independently designed a Shopify-webhook-triggered n8n automation (blog article publish -> teaser email) assuming a webhook topic named articles/publish or articles/create exists in Shopify's Admin API.

- **Root cause:** The research was done against secondary documentation/assumption rather than the live API's actual WebhookSubscriptionTopic enum. No ARTICLES_* topic exists at all in the current Shopify Admin GraphQL API -- confirmed exhaustively by attempting a real webhookSubscriptionCreate call and reading the full enum returned in the GraphQL validation error.
- **Fix:** N/A (live Shopify Admin API design correction, not a git-tracked codebase)@N/A — Redesigned the pipeline to skip the nonexistent webhook/n8n hop entirely: a single script calls Shopify's articleCreate mutation, takes the article handle/URL directly from that same mutation's response, then immediately calls Customer.io's API-triggered broadcast endpoint with that data -- one script, two chained API calls, no missing infrastructure to wait on.
- **Verified:** Live attempt to register the webhook subscription against the real Shopify Admin API; the GraphQL error response enumerated the complete, real WebhookSubscriptionTopic list with no articles/* entry
**First recorded occurrence of this root-cause tag.**

### [2026-07-15T02:47Z] tag:ledger-tool-self-dedup — This ledger tool's own add call for tag:subagent-false-success-report reported 'Command failed' to me, but had actually already pushed successfully; I retried, creating a real duplicate entry for the same tag, which the tool itself then mislabeled as a REGRESSION (correctly detected two entries sharing the tag, but they described the same single finding, not two real occurrences of the underlying bug).

- **Root cause:** Identical, already-documented gap: this exact tag (ledger-tool-self-dedup, first logged 2026-07-12) states the tool has no idempotency/dedup check on add, so a caller who cannot tell whether a prior call actually succeeded will retry and create a false-positive regression. I hit the documented gap again without checking this tag's own history first.
- **Fix:** N/A (manual content dedup, not a code fix)@N/A — Manually deduplicated REGRESSION-LEDGER.md via a direct authenticated GitHub Contents API edit (commit cdbcc28), removing the redundant second subagent-false-success-report entry and keeping the original, non-regression-labeled one. The underlying tool gap (no idempotency check on add) remains unfixed in the tool itself, exactly as the prior 2026-07-12 entry for this same tag already stated.
- **Verified:** Re-fetched REGRESSION-LEDGER.md directly after the edit and confirmed exactly 1 occurrence of the duplicate entry's marker text remains, down from 2
**REGRESSION — this root-cause tag has fired before:** [2026-07-12T23:52Z]. This is not a new finding; the earlier fix did not hold or did not cover this case.

### [2026-07-15T03:18Z] tag:subagent-final-reply-omits-deliverable — A Sonnet subagent (Castellane) doing a red-team synthesis pass produced real analytical work internally, but its final chat reply to the orchestrator was only a one-paragraph recap referencing a memo 'written above' -- the actual detailed memo text was never included in the message actually returned to the caller.

- **Root cause:** The orchestrator's prompt asked the subagent to 'write this as a specific risk memo' but did not explicitly state that the memo text itself must appear IN the final response message, as opposed to being composed at some intermediate step and then just referenced/summarized in the closing reply. Subagents can treat 'write X' as satisfied by having reasoned through X internally, without recognizing that only their final returned message is visible to the caller.
- **Fix:** N/A (prompt-design fix, not a git-tracked codebase)@N/A — Redispatched the identical task to a fresh subagent (Pemberley) with an explicit added instruction: 'your response MUST contain the full written memo text directly in your final message -- do not write a memo above in an intermediate step and then just summarize/reference it.' This produced the complete, usable memo text on the first attempt.
- **Verified:** Direct comparison of the two subagents' final replies -- the first was a short recap with no actual memo content, the second contained the full multi-section memo text verbatim in its response
**First recorded occurrence of this root-cause tag.**

### [2026-07-15T03:35Z] tag:subagent-false-success-report — Phase2 SEO rollout: Ravensmoor claimed byline hyperlink added on all 11 style/severity pages (0/11 actually linked); Fenwick-Hale claimed 4 pages had no widget to defer (all 4 actually had live undeferred widgets)

- **Root cause:** Haiku subagents self-report a checklist item as complete/inapplicable without re-fetching the live page to confirm the exact substring/pattern landed -- same root cause as the compare-hearing-aids incident, now confirmed to also affect partial/sub-item claims, not just full-rebuild claims
- **Fix:** N/A@N/A — CRO ran an independent 67-page audit script checking byline+link+schema+defer directly via Shopify Admin API, found both gaps, fixed via targeted regex pageUpdate (fix_byline_links_11pages.mjs, fix_undeferred_widgets.mjs), re-audited to 0/67 issues
- **Verified:** live Shopify Admin API re-fetch before and after fix, second full audit pass confirming 0 of 67 pages have any outstanding issue
**REGRESSION — this root-cause tag has fired before:** [2026-07-15T02:46Z]. This is not a new finding; the earlier fix did not hold or did not cover this case.

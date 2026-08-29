# Findings Ledger

Durable, machine readable record of every audit or reconciliation finding raised across the fleet:
its severity, the audit or reconciliation doc it came from, and whether it is still open, fixed, or
accepted as wontfix. Exists so a finding raised in one session cannot quietly vanish by the next one,
and so any future audit or "PR done" step can reconcile against what is still open instead of
re-discovering (or re-forgetting) the same gap.

Extends regression-ledger (REGRESSION-LEDGER.md, same skill, same GitHub Contents API write plus
independent reread verify pattern), kept as a separate file because a finding's status changes over
time (open, then fixed or wontfix), unlike a regression entry, which is an immutable historical
record once written.

**Before reporting an audit clean or a PR done, run `node ledger.mjs finding check`** (optionally
scoped to a finding id or a source audit doc substring). Any open critical or high severity finding
means the work is not actually done yet, say so plainly rather than reporting it clean. File a new
finding with `node ledger.mjs finding add`, close one with
`node ledger.mjs finding close <id> --status fixed|wontfix`.

### finding:FND-20260721-a4e7 severity:medium status:fixed | continuity-canary live-verified 2 stale continuity docs: CTO-KICKOFF-PROMPT.md (32.6d, SLO 10d) and claude-tools CLAUDE.md (8.1d, SLO 7d) -- refresh both, then close

- **Source audit doc:** runbooks/research-pass-2026-07-21/00-FINAL.md
- **Fix commit:** c2f2e2d
- **Verified by:** refreshed otchealth-cto/CLAUDE.md with a dated entry documenting Waves 0-1; commit c2f2e2d merged to main
- **Opened:** 2026-07-21T23:04:34.960Z
- **Closed:** 2026-07-21T23:07:44.935Z

### finding:FND-20260723-8456 severity:medium status:fixed | gateway_call_full.py JIT-offload pagination loop checked nonexistent done/is_last fields, never terminated, hung on any real multi-page result (found by CFO agent, fixed same day)

- **Source audit doc:** kb-memory:cto__20260723-044-75bd
- **Fix commit:** (none yet)
- **Verified by:** Live call against xero_report(innd,TrialBalance), 8-page/223568-byte JIT-offloaded result: 6s round trip, byte-exact reassembly, internally consistent trial balance (debits=credits=885089.82). Real schema is {page,pages,chunk,found,total_bytes,created}; fix compares page>=pages-1.
- **Opened:** 2026-07-23T21:54:30.148Z
- **Closed:** 2026-07-23T21:54:30.148Z

### finding:FND-20260724-2b08 severity:high status:fixed | DSV2 (7/17) mischaracterized 2 GS Capital wires: called the 12/7/21 $250K a non-convertible loan sitting in Customer Deposits (actually equity, 25M shares @ $0.01, issued 1/20/22); called the 11/16/21 $300K wire unlocated (actually posted, just needed the right Xero BankTransactions query)

- **Source audit doc:** S2_NINE_NOTE_BIFURCATION_2026-07-17.md (DSV2 exceptions E7/E8)
- **Fix commit:** (none yet)
- **Verified by:** Hyperagent CFO seat 2026-07-23 - confirmed via the company's own filed stock-issuance disclosure table + VStock Event Schedule + live Xero query; see Master Living Document (cmre7bc9m008207ad6114341s) section 18
- **Opened:** 2026-07-24T02:26:04.911Z
- **Closed:** 2026-07-24T02:26:04.911Z

### finding:FND-20260724-556a severity:high status:wontfix | FY2021 GS Capital derivative methodology churned across 3 different totals ($9,378,556 as-filed, $1,828,800 interim 7/10-7/12 pass, $1,559,432 DSV2 final) with no documented final determination, causing repeated re-litigation across agent sessions - Matt's explicit stated frustration

- **Source audit doc:** Derivative Day-One Bifurcation doc (cmrfr5idd08a608ad8gj3u0pr) + S2_NINE_NOTE_BIFURCATION_2026-07-17.md
- **Fix commit:** (none yet)
- **Verified by:** Duplicate entry created by a retry loop during the 2026-07-23 checkpoint (each retry actually succeeded silently; canonical entry is FND-20260724-a03e, independently verified via github__get_commit). Closing as wontfix to avoid ledger clutter, not because the underlying finding is invalid.
- **Opened:** 2026-07-24T02:26:07.544Z
- **Closed:** 2026-07-24T02:28:30.002Z

### finding:FND-20260724-cab8 severity:medium status:fixed | IRC 6672/Trust Fund Recovery Penalty personal-vs-corporate conflation recurred in 2 separate documents after being resolved once on 2026-06-24

- **Source audit doc:** CFO_PROJECT_MEMORY.md section 5b + PCAOB_AUDITOR_VIEW_2026-06-24.md item 9
- **Fix commit:** (none yet)
- **Verified by:** Hyperagent CFO seat 2026-07-23 - durable Hyperagent memory (importance 5) created explicitly distinguishing the closed personal CA FTB matter from the still-open corporate 3(a)(10) payroll under-accrual, to prevent a third recurrence
- **Opened:** 2026-07-24T02:26:10.085Z
- **Closed:** 2026-07-24T02:26:10.085Z

### finding:FND-20260724-764f severity:medium status:fixed | XERO_CLEANUP_TASKLIST.md self-declares 'read before any Xero posting' but is stale since 2026-06-20/21, still tracks the Phase 0-9 plan superseded by the 2026-06-29 Option-B directive - risks misdirecting a future session's next-step choice into the wrong workstream

- **Source audit doc:** OneDrive CFO Incoming/XERO_CLEANUP_TASKLIST.md
- **Fix commit:** OneDrive doc edit (no repo commit): SUPERSEDED banner prepended to CFO Incoming/XERO_CLEANUP_TASKLIST.md, uploaded 2026-08-28 (12703 bytes), append-only rule honored (nothing deleted)
- **Verified by:** Readback shows banner at top: names the 2026-06-29 Option-B supersession, warns against picking next-open-items, points at kb-memory ledger + CFO_PROJECT_MEMORY.md + newest dated handoff, notes AWS/gateway-sole-holder reality. Side proof: OneDrive delegated-token rotation PERSISTED twice through the ported SSM write path during this fix
- **Opened:** 2026-07-24T02:26:12.309Z
- **Closed:** 2026-08-28T23:05:40.891Z

### finding:FND-20260724-c89c severity:high status:wontfix | FY2021 GS Capital derivative methodology churned across 3 different totals over multiple sessions with no documented final determination, causing repeated re-litigation - Matt explicit stated frustration

- **Source audit doc:** Derivative Day-One Bifurcation doc cmrfr5idd08a608ad8gj3u0pr plus S2_NINE_NOTE_BIFURCATION_2026-07-17.md
- **Fix commit:** (none yet)
- **Verified by:** Duplicate entry created by a retry loop during the 2026-07-23 checkpoint (each retry actually succeeded silently; canonical entry is FND-20260724-a03e, independently verified via github__get_commit). Closing as wontfix to avoid ledger clutter, not because the underlying finding is invalid.
- **Opened:** 2026-07-24T02:26:33.851Z
- **Closed:** 2026-07-24T02:28:32.625Z

### finding:FND-20260724-e72b severity:high status:wontfix | FY2021 GS Capital derivative methodology churned across 3 different totals over multiple sessions with no documented final determination, causing repeated re-litigation - Matt explicit stated frustration

- **Source audit doc:** Derivative Day-One Bifurcation doc cmrfr5idd08a608ad8gj3u0pr plus S2_NINE_NOTE_BIFURCATION_2026-07-17.md
- **Fix commit:** (none yet)
- **Verified by:** Duplicate entry created by a retry loop during the 2026-07-23 checkpoint (each retry actually succeeded silently; canonical entry is FND-20260724-a03e, independently verified via github__get_commit). Closing as wontfix to avoid ledger clutter, not because the underlying finding is invalid.
- **Opened:** 2026-07-24T02:26:50.843Z
- **Closed:** 2026-07-24T02:28:35.769Z

### finding:FND-20260724-a03e severity:high status:fixed | FY2021 GS Capital derivative methodology churned across 3 different totals over multiple sessions with no documented final determination, causing repeated re-litigation

- **Source audit doc:** Derivative Day-One Bifurcation doc cmrfr5idd08a608ad8gj3u0pr plus S2_NINE_NOTE_BIFURCATION_2026-07-17.md
- **Fix commit:** (none yet)
- **Verified by:** Hyperagent CFO seat 2026-07-23, independently re-ran mc_engine.py against DSV2 staged inputs and reproduced the total to within 0.04 percent; full reasoning in Master Living Document section 18; durable memory MEMORYCONFIG_T2pWFGJO created
- **Opened:** 2026-07-24T02:27:07.856Z
- **Closed:** 2026-07-24T02:27:07.856Z

### finding:FND-20260724-29c0 severity:high status:fixed | Posting-gate mapping false negatives: 3 of 5 'Ready' FY2021 posting items (iHEAR note, iHEAR Series C, HA 8-row acquisition batch, ~17.5M combined) were already posted in undifferentiated lump form under generic QBO-JE-XXXXX narrations; original search only checked top-level Narration text, missing JournalLine.Description where the real content lives. Caught before any Xero write executed.

- **Source audit doc:** FY2021 Posting-Gate Mapping (Table cmry5dfau0knx07adh80bbq8w) + Completion Punch List (Table cmry60ef80iz507ad7lntbfmz)
- **Fix commit:** (none yet)
- **Verified by:** Hyperagent CFO seat 2026-07-23: independently pulled live Xero ManualJournal full detail (not just list-endpoint summaries) for the specific dollar-amount matches, confirmed JournalLines/account codes/line descriptions for QBO-JE-18471 and QBO-JE-18505; cross-checked against 2 identified bulk-insert timestamp clusters (67 entries total) to rule out similar traps on the remaining items; confirmed Item 14 (GS 300K equity) genuinely clean via the same method. Both tracking tables and the Master punch list corrected same-day before any posting occurred.
- **Opened:** 2026-07-24T02:53:29.393Z
- **Closed:** 2026-07-24T02:53:29.393Z

### finding:FND-20260724-e673 severity:high status:fixed | gateway.sh xero-request never wired the dry_run flag into the ARGS JSON sent to the gateway tool - every 'live' mode call silently ran as a no-op dry run regardless of the mode argument, with a misleading 'LIVE WRITE' stderr message printed anyway

- **Source audit doc:** OTCHealth Gateway (CFO) skill, gateway.sh xero-request dispatcher
- **Fix commit:** (none yet)
- **Verified by:** Hyperagent CFO seat 2026-07-23: caught live while executing a Matt-approved BankTransaction coding (item 14, GS Capital 300K equity entry) - first live-mode call returned body:null + error:dry_run despite passing live. Read gateway.sh source, found DRYRUN variable computed but never included in the python-built ARGS dict. Fixed by threading DRYRUN through as an explicit arg and adding dry_run to the JSON payload. Re-ran the identical command post-fix: HTTP 200, LineItems populated as expected, independently re-confirmed via a separate xero-get call. Skill update proposed via UpdateSkillAndScripts (draft SKILLCONFIG_4Y5dof5U, awaiting Matt's card confirmation).
- **Opened:** 2026-07-24T03:08:43.649Z
- **Closed:** 2026-07-24T03:08:43.649Z

### finding:FND-20260724-68f5 severity:medium status:fixed | Gateway truncates Xero API error response bodies to a fixed short length before returning them, making real ValidationException detail unreadable by the calling agent - blocked a live attempt to create a new Xero chart-of-accounts entry (Code 6573, Stock Based Compensation Expense) for InnerScope; 5 varied payloads all failed identically with the message cut off right before the actual error text

- **Source audit doc:** OTCHealth Gateway (CFO) skill / otchealth-mcp-gateway server, xero_request tool error handling
- **Fix commit:** otchealth-mcp-server#260 squash dd2691b4 (residual raw-fallback cap; the Elements[].ValidationErrors extraction itself was fixed earlier in #153), deployed gateway rev 25
- **Verified by:** extractXeroErrorDetail bound raised 2000->16KB uniformly + new preserve-Elements-verbatim tier; builder repro proved a needle at ~index 2128 survives new code and is provably lost under old cap; end-to-end xeroRequest test with a realistic long ValidationException green. Natural live confirmation occurs on the next real CFO validation error (deliberately not triggered against production Xero)
- **Opened:** 2026-07-24T05:24:24.127Z
- **Closed:** 2026-08-28T23:17:37.848Z

### finding:FND-20260724-cd01 severity:critical status:fixed | Xero rejects ANY ManualJournal write (new post or void) that references an ARCHIVED account - blocked voiding QBO-JE-18471, leaving InnerScope's HA Investment-in-Subsidiary DOUBLE-COUNTED at 31,758,284 (both the old 15,879,142 lump entry on archived acct 1808 and the new 15,879,142 detail on active acct 1740 are simultaneously live) as of this finding. Confirmed via controlled A/B test: identical 1 dollar journal succeeds against active account 1740, fails identically against archived account 1808. Also confirms this is a DIFFERENT root cause than the earlier accounting.settings scope finding (FND-20260724-68f5) - this fails even though ManualJournals writes are otherwise fully working (14 other new journals posted successfully same session).

- **Source audit doc:** FY2021 Completion Punch List Item 11 (HA acquisition) - live posting session 2026-07-23/24
- **Fix commit:** (none yet)
- **Verified by:** RESOLVED 2026-07-24 by the CFO seat once the CTO's PR #153 error-truncation fix surfaced Xero's real error text. Root cause was NOT the archived-account restriction being absolute - it was payload shape: un-archiving requires POST /Accounts/{id} with a body containing ONLY {Status:ACTIVE} (Xero refuses details+status together, verbatim: 'Cannot update account details and STATUS on the same request'). Sequence, each step independently re-fetched and confirmed: un-archived acct 1808 (ACTIVE), VOIDED lump entry QBO-JE-18471 309f6186 ($15,879,142, Status=VOIDED), re-archived 1808. VERIFIED at 12/31/2021: acct 1808 absent from the TB entirely; acct 1740 = exactly $15,879,142. The $31,758,284 double-count is eliminated. (Current-date TB shows 1808 credit / 1740 debit netting to zero - that is the correct pre-existing 2025 ATRA transfer to OTCHealth, not a residual bug.)
- **Opened:** 2026-07-24T05:47:24.345Z
- **Closed:** 2026-07-24T20:20:32.706Z

### finding:FND-20260724-f6df severity:high status:fixed | Xero attachment uploads via the gateway's xero_request tool do not actually persist, despite returning a seemingly-successful response with a real-looking AttachmentID for small payloads. Confirmed via independent read (xero_attachments) after every attempt: zero attachments actually exist on the target journals, at ANY size tried (70 bytes, 500KB, 2MB, 7.8MB all show empty on readback; 2MB+ additionally returns an explicit Xero-side HTTP 500, 7.8MB returns a gateway internal_error before even reaching Xero).

- **Source audit doc:** Matt's 2026-07-24 directive to attach APA/SPA agreements and work papers to Xero transactions
- **Fix commit:** otchealth-mcp-server#259 squash ffd2d88736c1357a783a0abb2201399d7e9c0b6d (residual half; the dedicated xero_attachment_upload raw-bytes fix landed earlier under this same ID)
- **Verified by:** CTO diff review: xero_request now refuses POST/PUT to any Attachments path (error use_xero_attachment_upload) BEFORE any network call, incl. under dry_run; DELETE ungated (no body). Builder counterfactual: guard disabled -> tests fail with attempted live write. write-guard 37/37, tools 32/32, typecheck+build+CI green. Deploys to prod with gateway rev 25
- **Opened:** 2026-07-24T06:15:01.391Z
- **Closed:** 2026-08-28T23:01:37.967Z

### finding:FND-20260724-b55e severity:high status:wontfix | The gateway's Xero OAuth connection (cfo lane) is missing the accounting.settings WRITE scope: it has accounting.transactions + accounting.settings.read but not accounting.settings. This blocks ALL Xero chart-of-accounts / organisation-settings writes - confirmed on POST /Accounts (create new account, e.g. 6573 Stock Based Comp) and POST /Accounts/{id} (un-archive account 1808). This is the ROOT CAUSE that makes the HA double-count unfixable via API: the only API path to remove the old lump entry QBO-JE-18471 is un-archive 1808 -> void the journal -> re-archive, and the un-archive step needs this scope. Transaction writes (BankTransactions, ManualJournals, Invoices, Contacts, etc.) are unaffected and work fine.

- **Source audit doc:** OTCHealth Gateway / Xero OAuth app - cfo lane scope configuration (diagnosed 2026-07-24)
- **Fix commit:** (none yet)
- **Verified by:** CLOSED AS INVALID 2026-07-24 - this finding's premise was WRONG and no scope change is needed. I concluded the cfo-lane Xero app was missing the accounting.settings write scope, inferring it from a generic ValidationException whose real text was being truncated. The CTO disproved it by reading the live Cosmos-cached Xero token for org innd and decoding its JWT scope claim: accounting.settings IS present. Correctly declined to run a needless re-consent. The ACTUAL root causes were mine: (1) Xero creates accounts with PUT /Accounts, not POST (POST = update, hence 'Account is not found') - proven by creating acct 6573 via PUT, HTTP 200; (2) un-archiving requires a Status-only body. Both now fixed and used to resolve FND-20260724-cd01. Lesson recorded: do not infer a permissions root cause from a truncated error - get the real error text first.
- **Opened:** 2026-07-24T06:29:43.172Z
- **Closed:** 2026-07-24T20:20:35.093Z

### finding:FND-20260727-f01a severity:high status:fixed | Xero ManualJournals VOIDED-status write: HTTP 400 error response ('status VOIDED cannot be applied to the document') does NOT reliably indicate the void failed -- it can succeed silently on the backend regardless of response code. Reproduced on HA journal 2c360c58 (errored, but was already VOIDED on re-fetch), causing an unintended double-reversal via a redundant manual reversal journal (d0c26934) before being caught and fully corrected same session.

- **Source audit doc:** Hyperagent Master Plan doc cms2h3plu295z06aduy6ku65y (HA + INND FY2021 Closeout — Master Plan), Section 2
- **Fix commit:** (none yet)
- **Verified by:** Independently re-fetched 2c360c58 by ID after its 'error' response and found Status=VOIDED already applied -- the error was misleading, not a failure. This caused a genuine double-reversal (posted reversal d0c26934 on top of an already-voided original). Diagnosed via account-level Trial Balance exact-match proof, not just aggregate coincidence (Canon Financial Services acct 2301: measured effect exactly 2.0000x expected). Voided d0c26934 (this time the response cleanly confirmed VOIDED); independently re-fetched by ID (confirmed) and cross-checked both account-level (2301 exact to $266,965.40) and aggregate Balance Sheet (Assets $14,453,476.26 / Liabilities $18,633,684.47 / Equity $(4,180,208.21)) -- exact penny match to pre-incident baseline on all 3 totals. Adopted protocol going forward: always independently re-fetch the specific object by ID after ANY Xero write regardless of response code; verify at account-level Trial Balance, never aggregate reports alone; prefer offsetting reversal entries over void/delete for corrections.
- **Opened:** 2026-07-27T04:10:25.031Z
- **Closed:** 2026-07-27T04:10:25.031Z

### finding:FND-20260728-b8a0 severity:high status:fixed | backup.mjs Cosmos work-ledger export produces 0 rows nightly despite an active ledger; finance/legal-personal rooms capped at exactly 100000 rows (pagination bug)

- **Source audit doc:** otchealth-cto/runbooks/AZURE-LOSS-DR-PLAN.md (2026-07-28)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-07-28T00:48:44.021Z
- **Closed:** 2026-08-04T22:38:12.376Z

### finding:FND-20260728-404d severity:critical status:fixed | AWS DR bucket credentials (aws-dr-access-key-id/secret) exist ONLY in Key Vault -- a total Azure loss cannot bootstrap recovery because the credential needed to reach the S3 backup bucket is itself unreachable without Key Vault. Needs a break-glass read-only IAM user provisioned outside Key Vault (Matt AWS-console action).

- **Source audit doc:** otchealth-cto/runbooks/AZURE-LOSS-DR-PLAN.md (2026-07-28, gap #1)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-07-28T01:02:45.658Z
- **Closed:** 2026-08-21T05:58:34.036Z

### finding:safety-escalation-rota-gap-2026-08-06 severity:high status:open | Safety Escalations team (Intercom team_assignee_id 11247295) has no human member on rota; Safety Monitor tags/routes correctly but flagged conversations then age indefinitely with zero human notification beyond the next daily digest email

- **Source audit doc:** CRO daily digest 2026-08-05 and 2026-08-06 (Intercom Safety Monitor live audit)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-06T18:21:03.936Z
- **Closed:** (open)

### finding:safety-classifier-keyword-stem-false-positive-2026-08-08 severity:medium status:open | Safety classifier false-positives on bare keyword stem match: TikTok Shop marketing spam mentioning unrelated brand name 'Physician's Choice' in a case study triggered safety-escalation tag (hit: stem match on 'physician') and produced an automated 'please stop wearing the device' reply to a non-customer marketing address; same false-positive reproduced in local safety_gate.py reference classifier, not just the live n8n monitor

- **Source audit doc:** CRO daily digest 2026-08-08 (Intercom Safety Monitor live audit, conv 215475402612463)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-08T14:02:55.785Z
- **Closed:** (open)

### finding:FND-20260811-19ed severity:high status:open | Dedicated App Coders allow_delete field is ignored by admission ownership checker

- **Source audit doc:** /agent/workspace/aware-build-2026-08-09/control/control-plane-regressions-2026-08-10.md
- **Fix commit:** (none yet)
- **Verified by:** Reproduced in AWARE run 20260810T023500Z-63b58bed: validated packet allow_delete=true, admission returned DELETE_NOT_ALLOWED
- **Opened:** 2026-08-11T00:28:01.096Z
- **Closed:** (open)

### finding:FND-20260811-12b8 severity:high status:open | Dedicated App Coders integration gate falsely flags Node 24 compile cache as secret

- **Source audit doc:** /agent/workspace/aware-build-2026-08-09/control/control-plane-regressions-2026-08-10.md
- **Fix commit:** (none yet)
- **Verified by:** Reproduced in AWARE runs 20260810T021000Z-5487e1aa and 20260810T023500Z-63b58bed: SECRET_IN_GATE_RUNTIME on TMPDIR node-compile-cache, checkpoint restored
- **Opened:** 2026-08-11T00:28:18.999Z
- **Closed:** (open)

### finding:FND-20260811-17f2 severity:high status:open | Dedicated App Coders graph cannot carry explicit ownership for protected coordinator paths

- **Source audit doc:** /agent/workspace/aware-build-2026-08-09/control/control-plane-regressions-2026-08-10.md
- **Fix commit:** (none yet)
- **Verified by:** Reproduced in AWARE run 20260810T013200Z-72e2b84a: planned manifest/CLAUDE/HANDOFF writes rejected PROTECTED_PATH_NOT_EXPLICITLY_OWNED
- **Opened:** 2026-08-11T00:28:56.430Z
- **Closed:** (open)

### finding:FND-20260812-c22a severity:high status:open | WISMO stager (n8n x2epOeluOYLTFgo7) rejects the real Shopify fulfillment webhook on HMAC signature mismatch -- first live fulfillment event since deploy (Aug 4) silently failed to stage, no draft exists for order #10673's real UPS shipment despite fulfillment succeeding in Shopify

- **Source audit doc:** CRO daily digest 2026-08-12
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-12T14:06:00.168Z
- **Closed:** (open)

### finding:FND-20260814-4fea severity:medium status:open | Gateway ECS task role has OpenSearch write+delete though the gateway adapter is read-only; all 25 task-def families share otchealthTaskRole so it cannot be tightened without splitting roles first

- **Source audit doc:** otchealth-cto/runbooks/AWS-CUTOVER-2026-08-14.md
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-14T07:41:59.160Z
- **Closed:** (open)

### finding:FND-20260814-b126 severity:medium status:open | Brain-load ring backstop drops legitimate INND finance docs on a bare 'custody' token (236+ so far, fail-safe, flagged for human review, needs CLO decision before narrowing)

- **Source audit doc:** otchealth-cto/runbooks/AWS-CUTOVER-2026-08-14.md
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-14T13:46:59.976Z
- **Closed:** (open)

### finding:FND-20260814-bcbc severity:medium status:fixed | selfrepair.mjs proposes reverting a file the PR never touched (would silently discard unrelated main-branch work if applied)

- **Source audit doc:** otchealth-cto/runbooks/AWS-CUTOVER-2026-08-14.md
- **Fix commit:** otchealth-claude-tools#487 squash ec6415d4a3b54d781ea799e8c245a1dbd747de47
- **Verified by:** CTO diff review + suite: planRepairs opts.prFiles is three-valued (undefined=legacy unconstrained, Set=PR-diff-constrained, null=FAIL-CLOSED proposes nothing); draftCmd (the armed git-checkout path) constrained; 5 new tests incl. fail-closed + builder's end-to-end smoke on real git history; toolkit test gate green on PR
- **Opened:** 2026-08-14T18:51:35.167Z
- **Closed:** 2026-08-28T23:00:28.008Z

### finding:FND-20260816-90b1 severity:high status:fixed | Committed AWS pre-signed S3 URLs (access key id + signature) in otchealth-mcp-server infra/aws/data/task-definitions-jobs.json; prefix-anchored secret scan missed them because the key sat mid-string in a query param

- **Source audit doc:** otchealth-cto/runbooks/ai-os-audit-scorecard.md
- **Fix commit:** 86abd33
- **Verified by:** redacted + commit amended b21a320->86abd33 (force-push, unmerged no-PR machine-authored branch); src/safety/committed-credential-guard.test.ts scans git ls-files anywhere-in-file, counterfactual fail-on-old-code proven (4 occurrences named), 1427/1427 tests, repo-wide scan 1268 files 0 hits; URLs expired 20260814T074336Z so inert, only key ID disclosed, SigV4 sig is HMAC over scoped signing key so secret never derivable
- **Opened:** 2026-08-16T04:17:51.024Z
- **Closed:** 2026-08-16T04:17:51.024Z

### finding:FND-20260816-5539 severity:medium status:open | xero-run's AWS EventBridge twin carries a real daily cron (0 7 UTC) while its Azure original is a de-facto-disabled cron (Feb 30, never fires) -- enabling the AWS schedule as-is is new financial automation going live, not a like-for-like cutover, and xero-run posts to a real accounting ledger

- **Source audit doc:** runbooks/AWS-JOBS-MIGRATION-WAVE-B.md
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-16T18:29:57.947Z
- **Closed:** (open)

### finding:FND-20260816-1aa3 severity:low status:fixed | sentinel-os-eval has failed 4 of its last 5 Azure runs (08-12,08-13,08-14 Failed, 08-15 Succeeded but took 1h28m, 08-16 Failed) -- pre-existing, unrelated to the AWS migration, surfaced while cross-checking the jobs matrix

- **Source audit doc:** runbooks/AWS-JOBS-MIGRATION-WAVE-B.md
- **Fix commit:** schedule disabled 2026-08-28
- **Verified by:** sentinel-os-eval's SUBJECT is otchealth-os-chat (dead Azure Container App, standing RETIRE recommendation, Matt decision item 7). CloudWatch shows every AWS run FATAL ConnectTimeout against otchealth-os-chat...azurecontainerapps.io. Schedule otchealth-sentinel-os-eval set DISABLED (readback confirmed) - a daily guaranteed-failure probe of a permanently dead host. Job/task-def deletion folds into the os-chat retirement decision
- **Opened:** 2026-08-16T18:30:02.634Z
- **Closed:** 2026-08-28T22:42:23.314Z

### finding:FND-20260816-b38b severity:medium status:fixed | index-one.mjs (kb-memory's detached write-through single-entry indexer, Wave 2b) is a THIRD Azure-AI-Search-only memory writer, not ported to SEARCH_BACKEND=opensearch in this pass -- explicitly out of scope (FILE OWNERSHIP was semantic.mjs + ring-memory-index/ only), so a real Azure outage still silently blocks instant per-entry indexing even after this port lands

- **Source audit doc:** skills/kb-memory/opensearch-write.mjs (AWS memory-writer port, 2026-08-16)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-16T19:18:17.585Z
- **Closed:** 2026-08-28T03:45:43.539Z

### finding:FND-20260816-c789 severity:high status:fixed | 15 of 32 AWS job task definitions cannot authenticate: Azure managed identity + zero injected secrets; code fix in PR #443 but doc-indexer image NOT yet rebuilt

- **Source audit doc:** session:2026-08-16 azure-retirement scheduled-jobs audit
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-16T20:33:37.126Z
- **Closed:** 2026-08-28T03:45:40.786Z

### finding:FND-20260816-e81a severity:high status:fixed | PG_SSL_VERIFY defaults false: gateway->RDS is encrypted but UNVERIFIED, and became load-bearing today when STATE_BACKEND=postgres went live; RDS CA bundle already exists inline in task-definitions-jobs.json so the fix is available now

- **Source audit doc:** session:2026-08-16 push security review
- **Fix commit:** otchealth-mcp-server 011c5d68 (rev 23)
- **Verified by:** live /health/deep postgres_tls_verify:true on mcp.otchealth.app 2026-08-28
- **Opened:** 2026-08-16T20:53:52.156Z
- **Closed:** 2026-08-28T22:17:59.312Z

### finding:FND-20260816-c68c severity:medium status:fixed | pg-sql.ts interpolates table name into SQL; add an identifier regex guard at the top of translate() so the injection boundary is self-enforcing rather than caller-dependent

- **Source audit doc:** session:2026-08-16 push security review
- **Fix commit:** otchealth-mcp-server#257 squash 011c5d68 (deployed gateway rev 23, still live through rev 25)
- **Verified by:** Source on main: src/agentstate/pg-sql.ts line 53 TABLE_RE=/^[a-z_][a-z0-9_]{0,62}$/ + line 111 throws 'unsupported table name' before any interpolation into translate() - the injection boundary is now self-enforcing, not caller-dependent. Ledger close was missed when the PR merged; recorded now
- **Opened:** 2026-08-16T20:53:54.812Z
- **Closed:** 2026-08-28T23:18:22.626Z

### finding:FND-20260817-64f5 severity:high status:open | Intercom /conversations/search endpoint has a demonstrated reliability gap for safety-escalation monitoring: two real safety-escalation-tagged conversations (215475453670200 created Aug 12, 215475494095106 created Aug 14) fell within the exact 24h window checked by that morning's daily digest but were NOT returned by the search call (digest reported 0 conversations both days) -- only surfaced 5-6 days later via a 7-day-window search during this calibration. Separately, conversation 215475357819316 (the long-open real customer escalation) is NOT returned by /conversations/search under ANY tested filter including since=creation-60s and since=0, despite total_count reporting 109 on the broad query while data array returned empty. Direct GET by conversation ID always works correctly and was the only reason 215475357819316's status stayed accurately tracked. Daily digest 24h-window search-based monitoring cannot be trusted alone to catch new safety escalations same-day; recommend switching primary detection to the tag-based webhook/Safety Monitor n8n workflow D8NH3ITNIhvPyjfP path (already tags in real time) plus a periodic direct-GET reconciliation against known IDs, rather than relying on conversations/search for discovery.

- **Source audit doc:** CRO weekly calibration 2026-08-17
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-17T13:45:29.903Z
- **Closed:** (open)

### finding:FND-20260817-cc3e severity:high status:fixed | finance-cfo-source-docs index returns paths whose blobs are unreachable: 11 of 20 sampled failed AFTER the path fix, and every failure is under the INND/ subtree (source AND _TEXT sidecar both absent) -- a data-coverage gap, root cause not yet established

- **Source audit doc:** session:2026-08-17 CFO kb_get_document verification
- **Fix commit:** 5a59fe1
- **Verified by:** ROOT CAUSE WAS NOT A COVERAGE GAP. s3-blob-store double-encoded the object key (pre-encoded with encodeURIComponent, then signRequest canonicalised again) so any key containing a space signed as %2520 but travelled as %20 -> signature mismatch -> S3 403 -> the 403 branch reported found:false. All 5 documents the FY2022 close depends on verified present in S3 via ListObjectsV2 and now READ through the fixed path (476447B, 946769B, 956593B, 94032B, 84573B). My original 'index holds rows for documents the store does not contain' characterisation was WRONG.
- **Opened:** 2026-08-17T20:00:46.587Z
- **Closed:** 2026-08-17T21:30:31.442Z

### finding:FND-20260817-e462 severity:medium status:fixed | cro lane advertises full 1008-tool catalog incl kb_search_privileged (coo advertises 11); TOOL_CATALOG_CURATION_MODE=report so LANE_TOOLSETS does not narrow internal lanes. Ring gate PROVEN holding, so not a data exposure -- a catalog-honesty/least-privilege gap.

- **Source audit doc:** live lane probe 2026-08-17 (otchealth-gateway:10)
- **Fix commit:** gateway task-def rev 24 (TOOL_CATALOG_CURATE_LANES=cro)
- **Verified by:** live tools/list post-rollout 2026-08-28: cro lane = 236 curated tools (was 1008), cto lane = 1001 (unchanged full). Used the module's own designed-for-this TOOL_CATALOG_CURATE_LANES mechanism, mode stays curate-m365-only
- **Opened:** 2026-08-17T20:13:00.425Z
- **Closed:** 2026-08-28T22:44:14.452Z

### finding:FND-20260817-9f1c severity:high status:wontfix | kb_search_privileged returns count:0 (silent empty) instead of an explicit denial for an out-of-ring lane -- a false 'no evidence' is indistinguishable from 'not allowed', the exact failure class that produced the CFO's unproven-finding incident. Proven: identical queries on legal-company and finance-cfo-source-docs return clo=3 matches, cro=0, with no error and no denial text.

- **Source audit doc:** live ring probe 2026-08-17 (otchealth-gateway:10)
- **Fix commit:** (none yet)
- **Verified by:** RETRACTED - THE FINDING WAS WRONG, and it was my own test that was wrong. kb_search_privileged DOES return an explicit denial: mode='ring-forbidden', error='forbidden_ring', plus prose naming the required lanes ('legal-company requires one of the cfo/clo/clo-personal/cpo/cco/exec trusted lanes. Your identity: cro'). My probe extracted ONLY the count field, and a correct denial also carries count:0, so my test could not distinguish denial from empty. Verified live on otchealth-gateway:11 by reading the RAW response for lane=cro vs lane=clo. A subagent flagged this as already-correct and I initially dismissed it; the subagent was right.
- **Opened:** 2026-08-17T20:13:03.035Z
- **Closed:** 2026-08-17T22:18:40.362Z

### finding:FND-20260817-a73a severity:high status:fixed | listShared() swallowed every non-2xx and returned an empty shared feed as SUCCESS, silently emptying the retraction filter for its full 120s TTL -- a corrected belief could resurface via brain_search as current truth. FIXED 9f069ff: throw on non-404, union-never-replace the retraction cache, 20s degraded TTL.

- **Source audit doc:** error-masking sweep 2026-08-17 (subagent finding, CTO-verified by reading src/memory/store.ts + retractions.ts)
- **Fix commit:** 9f069ff
- **Verified by:** counterfactual: restoring the old bare break turns 3 of the 4 new tests red; 1565/1565 suite green
- **Opened:** 2026-08-17T21:44:52.749Z
- **Closed:** 2026-08-17T21:44:52.749Z

### finding:FND-20260818-r1ng severity:low status:wontfix | RETRACTION of FND-20260817-9f1c: kb_search_privileged DOES return an explicit denial (data.mode=ring-forbidden, data.error=forbidden_ring, plus prose naming required lanes and caller). No code path gives an out-of-ring lane a bare count:0. 9f1c came from a probe that read only the count field, which a correct denial also sets to 0. The 9f1c rationale text on main is STALE; do not cite it.

- **Source audit doc:** src/tools/kb/search-privileged.ts:194-199 (otchealth-mcp-server main)
- **Fix commit:** (none yet)
- **Verified by:** direct code read of the disallowed-lane branch
- **Opened:** 2026-08-18T00:43:05.379Z
- **Closed:** 2026-08-18T00:43:05.379Z

### finding:FND-20260818-cc78 severity:high status:fixed | fleet-medic alerts silently NOT delivered: its GitHub log issue passed the 2500-comment cap, so every alert is dropped after a warn-level fleet_medic_alert_route_failed line

- **Source audit doc:** CloudWatch /ecs/otchealth 2026-08-18T23:05:03Z (post-deploy log read, PR otchealth-mcp-server#253)
- **Fix commit:** issue #258 + gateway rev 24 env + rev 23 SNS fallback
- **Verified by:** successor log issue otchealth-mcp-server#258 created; FLEET_MEDIC_LOG_ISSUE=258 live on rev 24 (health reports taskdef 24); SNS_ALERT_TOPIC_ARN wired since rev 23 with confirmed lambda subscription as failure backstop
- **Opened:** 2026-08-18T23:12:11.685Z
- **Closed:** 2026-08-28T22:44:17.333Z

### finding:FND-20260819-c9bb severity:high status:fixed | 6 fleet skills dark: quality-LLM callers still hard-depend on the dead Azure Foundry (critic-pass reports SUCCESS while doing nothing)

- **Source audit doc:** /tmp/dark-skills.md
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-19T07:31:57.288Z
- **Closed:** 2026-08-28T01:33:51.227Z

### finding:FND-20260821-7eb1 severity:low status:fixed | flatstick infra/aws (CDK) is outside the pnpm workspace, so CI never typechecks it

- **Source audit doc:** flatstick PR #248 / CTO session 2026-08-21
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-21T00:14:59.698Z
- **Closed:** 2026-08-21T06:28:24.887Z

### finding:FND-20260821-ed47 severity:high status:fixed | flatstick: unused GitHubActions-Flatstick-NonProd OIDC role gives ANY branch a path to AdministratorAccess on account 301001539500, bypassing the production reviewer gate

- **Source audit doc:** CTO session 2026-08-21, flatstick AWS deploy
- **Fix commit:** (none yet)
- **Verified by:** trust re-read matches intended; account-wide audit 3/3 GitHub OIDC roles exact-subject, 0 wildcards
- **Opened:** 2026-08-21T00:26:22.486Z
- **Closed:** 2026-08-21T03:10:16.559Z

### finding:FND-20260821-0b59 severity:medium status:fixed | flatstick iOS MinimumOSVersion is 13.0; Apple rejects uploads below 15.0 from Spring 2027 (altool warning 90068)

- **Source audit doc:** flatstick ios-depot run 32446496110, CTO session 2026-08-21
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-21T04:32:16.951Z
- **Closed:** 2026-08-21T06:28:22.311Z

### finding:FND-20260821-b74d severity:high status:fixed | eval-runner.mjs writes the gateway bearer token into CloudWatch: failing curl commands are echoed with the Authorization header intact

- **Source audit doc:** CTO fleet sweep 2026-08-21
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-21T05:37:57.534Z
- **Closed:** 2026-08-21T06:32:42.647Z

### finding:FND-20260821-97e9 severity:high status:fixed | 3 deep-* jobs (deep-finance, deep-legal-company, deep-legal-personal) show State=ENABLED but carry cron(0 5 1 1 ? *) = 05:00 on Jan 1, i.e. fire once a year

- **Source audit doc:** CTO fleet sweep 2026-08-21
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-21T05:37:59.928Z
- **Closed:** 2026-08-28T02:21:25.633Z

### finding:FND-20260821-29e2 severity:medium status:fixed | otchealth-mcp-gateway ECR lifecycle is 'keep last 10, tagStatus any', so every pinned image tag is on a 10-deploy fuse; this already silently killed otchealth-mcp-eval

- **Source audit doc:** CTO fleet sweep 2026-08-21
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-21T05:38:02.410Z
- **Closed:** 2026-08-21T06:31:29.973Z

### finding:FND-20260821-12b0 severity:medium status:fixed | mcp-eval guardrail-01/02/03 FAIL ('attack content may have leaked through'); score sits exactly on the 70% threshold so one more regression trips the gate

- **Source audit doc:** CTO fleet sweep 2026-08-21
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-21T05:38:04.792Z
- **Closed:** 2026-08-21T06:17:39.870Z

### finding:FND-20260821-783d severity:high status:fixed | Root cause of FND-20260821-97e9 (deep-finance/deep-legal-company/deep-legal-personal placeholder cron): NOT an auth/IAM gap -- fleetSecret() SSM resolution + otchealthTaskRole live-verified working via real ECS RunTask (all 4 secrets resolved: azure-foundry-key, azure-foundry-openai-endpoint, azure-cfo-storage-key, azure-legal-storage-key). Root cause is the SAME dead Azure Foundry already named in claude-tools CLAUDE.md (enrich.mjs + deep-pass.mjs called out by name): a live authenticated probe using the actual current production key returns HTTP 401 'invalid subscription key' on both otchealth-foundry.openai.azure.com and the .cognitiveservices.azure.com fallback host. deep-pass.mjs is NOT one of the six skills tracked under FND-20260819-c9bb -- this is a seventh, previously-undocumented dark caller. Fixing the cron alone (without a processor decision) would be ACTIVELY HARMFUL, not merely inert: deep-pass.mjs's chat()-failure catch path sets deep:true + review:NEEDS_CLAUDE_REVIEW/'summary model error' on every row it touches and that state is terminal (selectTodo's !r.deep filter never re-selects it), so one 90-min tick would flood all 3 privileged rooms' _REVIEW/review-queue.csv (the CFO/CLO 'job one' list) with near-total false-positive review flags on the first run. Recommendation: hold the cron at its current placeholder (do not apply rate(90 minutes) yet) until Matt picks a replacement processor for deep-pass.mjs (mirrors the enrich.mjs -> OpenAI-direct port, or route via the AWS Bedrock-for-privileged-rooms option already proposed in otchealth-cto/CLAUDE.md's 2026-08-19 entry) -- deep-pass.mjs sends full document TEXT plus page-image VISION calls for finance-cfo-source-docs/legal-company/legal-personal, so this is the same class of reserved processor decision as enrich.mjs's, not an infra-parity fix.

- **Source audit doc:** CTO session 2026-08-21 (deep-pass EventBridge cron + auth investigation)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-21T06:16:25.323Z
- **Closed:** 2026-08-28T02:21:22.844Z

### finding:FND-20260821-e303 severity:medium status:fixed | Gateway Content Safety Prompt Shields (auto-guard.ts inboundShield) never actually run despite SHIELD_MODE=report since 2026-07-02; endpoint IS reachable (not the dead-Azure-subscription class), so root cause is auth/config on the gateway's own client, fail-open masks it silently

- **Source audit doc:** CTO fleet sweep 2026-08-21 (subagent investigation of FND-20260821-12b0, correlated with a live reachability check: cs-otchealth.cognitiveservices.azure.com returns HTTP 200 base / 401 real-API-without-key, confirmed live by CTO)
- **Fix commit:** otchealth-mcp-server#260 squash dd2691b472d844b34ff5560301d06fac44c819b4, deployed gateway rev 25 (image dd2691b)
- **Verified by:** LIVE on prod rev 25: shield_check returns configured:false + provider 'none (azure retired)' + summary 'Prompt Shields: NOT RUN ... This is not a scan verdict.' The root defect (a dead/unconfigured provider rendering as clean/fully-grounded = fake pass) is closed by design: CONTENT_SAFETY_RETIRED is env-independent so no stale task-def value can re-dial the dead host; counterfactual tests assert fetch is never called even with env set + an attack-indicating stub. Replacement provider (Bedrock Guardrails) is a separate future decision
- **Opened:** 2026-08-21T06:17:58.714Z
- **Closed:** 2026-08-28T23:17:35.336Z

### finding:FND-20260821-5934 severity:critical status:fixed | Live PERPLEXITY_CONNECTOR_TOKEN (production credential, authenticates the real Perplexity connector) was leaked into CloudWatch daily via FND-20260821-b74d, because eval-runner.mjs's GATEWAY_BEARER was an undocumented byte-identical copy of it, not a dedicated eval credential -- decoupling fix built (otchealth-mcp-server PR #256, EVAL_AGENT_TOKEN) but the already-exposed Perplexity value itself is NOT yet rotated and remains a live, valid credential exposed in retained logs

- **Source audit doc:** CTO fleet sweep 2026-08-21, subagent 'Investigate and rotate the eval gateway bearer' + independent CTO verification (SHA-256 hash match confirmed between /otchealth/job/otchealth-mcp-eval/GATEWAY_BEARER and /otchealth/gw/PERPLEXITY_CONNECTOR_TOKEN; confirmed the live otchealth-gateway:21 ECS task definition sources that exact SSM parameter for its real Perplexity auth)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-21T06:23:39.854Z
- **Closed:** 2026-08-21T06:32:45.291Z

### finding:FND-20260827-1503 severity:critical status:fixed | Twilio prod numbers (Sarah/Taylor/Helen) + ElevenLabs post-call webhook still target the dead n8n host (now NXDOMAIN); repoint the moment cs-n8n recovery validates (template: runbooks/scripts/apply-twilio-postwave.mjs)

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** live vendor-config changes (no repo commit): repoint-apply.mjs executed 2026-08-28
- **Verified by:** Readback-verified: all 9 EL agent tools (Taylor make_intro/get_open_slots/book_meeting -> /webhook/frontdesk-graph; Sarah+Helen cio_lookup_contact/shopify_create_draft_order/cio_log_event -> /webhook/helen-tools) on cs-n8n, 0 remaining on dead host; all 4 Twilio numbers keep EL voice primary + SMS/SMS-fallback/voice-fallback -> recovered sms-forward/voice-forward; msgsvc MGab9a fallback set. RESIDUAL deliberately excluded: the EL post-call workspace webhook (EL-side PATCH silently ignores webhook_url = immutable) is HELD because the only recovered receiver cnGH is pre-hardening (no HMAC + embedded CIO cred) - that bundle (harden receiver + new EL webhook + rotate CIO pair) is tracked under FND-20260828-06f4 + the CS rebuild program
- **Opened:** 2026-08-27T18:59:53.397Z
- **Closed:** 2026-08-28T23:03:48.061Z

### finding:FND-20260827-02c2 severity:critical status:fixed | FourVault potential customer data loss: prod DB was on deleted Azure Postgres, NO dump found in master-account S3 (4 buckets, live-listed); full inventory of all AWS accounts/stores required before concluding

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-27T18:59:56.473Z
- **Closed:** 2026-08-27T19:49:28.476Z

### finding:FND-20260827-dbb9 severity:critical status:fixed | n8n recovery incomplete: cs-n8n.otchealthmart.com (Lightsail) answers 502; ~34 CS workflows offline since 2026-08-13; finish aws-n8n-recovery lane then re-run the webhook/security batteries

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** otchealth-cto PRs #119-#125, run 33138654904
- **Verified by:** cs-n8n.otchealthmart.com /healthz 200 live; 15 workflows imported; owner claimed + API key minted 2026-08-28; Twilio/EL tools repointed
- **Opened:** 2026-08-27T18:59:59.400Z
- **Closed:** 2026-08-28T22:17:48.686Z

### finding:FND-20260827-bcfc severity:high status:fixed | Toolkit Azure-blob cluster still writes to dead estate: heartbeat.mjs, fleet-dispatch, fleet-search, fleet-medic notes, sunset-protocol, memory-librarian, ledger-archive, notion-export, innd-stock -- port to S3 (s3-blob.mjs pattern)

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** 9cdba8c6..f66092ce batch + PR #473
- **Verified by:** leg-A sweep: 8/9 files verified on commons-store/s3-blob S3; 9th (notion-export) deliberately RETIRED per PR #473 SKILL.md supersession (zero callers, migration complete); PR #485 port closed unmerged honoring that decision
- **Opened:** 2026-08-27T19:00:02.382Z
- **Closed:** 2026-08-28T22:00:47.808Z

### finding:FND-20260827-4288 severity:high status:fixed | xero-token.mjs + xero-run.mjs token cache/lock on dead Azure Blob: the proven org-lockout race is re-armed whenever concurrent Xero use resumes; port lock to S3 If-None-Match or DynamoDB

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-27T19:00:05.975Z
- **Closed:** 2026-08-28T01:33:24.537Z

### finding:FND-20260827-4131 severity:high status:fixed | DR chain is dead: no working nightly backup of SSM secrets or the OpenSearch brain (old chain enumerated Azure); rebuild AWS-native (SSM export + OpenSearch snapshots to S3)

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** claude-tools #475,#477-#480
- **Verified by:** nightly SSM export run 33139324078 (454 params, FULL fidelity, Object-Lock + OneDrive); OpenSearch snapshot first-manual-20260828 9/9 shards zero privileged; canary green + n8n AutoSnapshot check added #480; crons armed
- **Opened:** 2026-08-27T19:00:09.592Z
- **Closed:** 2026-08-28T22:17:51.187Z

### finding:FND-20260827-dd78 severity:high status:fixed | Foundry LLM callers still dead (extends FND-20260819-c9bb): critic-pass (reports SUCCESS on fail-safe approve on every PR), agent-evals, focus-group-loop, recall-evals, doc-indexer deep-pass; port per enrich.mjs pattern; make critic-pr report neutral until then

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** 2026-08-27 port batch + #482,#483,#484
- **Verified by:** critic-pass/agent-evals/focus-group/recall-evals confirmed LLM_PROVIDER=openai (leg-A line-cited); reflect+shark+signal-radar+drift ported tonight, fail-loud; deep-pass on Bedrock (own header)
- **Opened:** 2026-08-27T19:00:12.839Z
- **Closed:** 2026-08-28T22:17:53.783Z

### finding:FND-20260827-d47b severity:high status:fixed | Gateway tail: legal_blob_put('personal') writes to dead Azure; heygen artifact-store Azure-only while HeyGen writes enabled; HEYGEN_APPROVAL_BROKER_URL dead (approval lane fail-closed); 37 n8n_* + 13 azure_* tools dead surface; prune dead AZURE_*/FOUNDRY_*/COSMOS_* env at next deploy

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** otchealth-mcp-server 011c5d68 (rev 23 deployed)
- **Verified by:** 13 azure_* tools deleted (live catalog), dead env/secrets pruned rev 23, 37 n8n_* tools live-verified, legal personal S3 routing merged (IAM write grant = standing Matt item); residual HeyGen broker re-home tracked as its own retire-or-rebuild decision item
- **Opened:** 2026-08-27T19:00:16.109Z
- **Closed:** 2026-08-28T22:18:01.821Z

### finding:FND-20260827-558b severity:high status:open | PlantID backend rebuild: Azure Functions app gone; port functions/ to Lambda/ECS + OpenAI-direct/Bedrock + DynamoDB, then ship build 2 (shipped build 1 is dead)

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-27T19:00:18.954Z
- **Closed:** (open)

### finding:FND-20260827-d074 severity:high status:open | FourVault backend rebuild on Flatstick pattern (own account, ECS+CloudFront+RDS+S3 provider, persisted-URL rewrite) + re-register SIWA redirect, eBay deletion endpoint, RevenueCat webhook

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-27T19:00:21.836Z
- **Closed:** (open)

### finding:FND-20260827-e4e3 severity:high status:fixed | doc-indexer push-search still requires dead Azure Search: librarian ECS jobs run but room freshness rides on enrich-only; add first-class OpenSearch push-search backend and make it default

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** claude-tools #474/#476
- **Verified by:** indexer.mjs SEARCH_BACKEND default opensearch; commerce librarian ECS run proven end-to-end exit 0
- **Opened:** 2026-08-27T19:00:24.807Z
- **Closed:** 2026-08-28T22:17:56.760Z

### finding:FND-20260827-acce severity:medium status:fixed | 12 SSM /otchealth/* params hold dead-Azure VALUES (azure-search/foundry/cosmos/docintel/contentsafety endpoints, n8n-base-url, cfo-legal-store-sas-ro, brain-search-endpoint): retire or repoint each as consumers are ported

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** 2026-08-28 SSM cleanup (26 params deleted post-DR-archive) + n8n-base-url v2 repoint
- **Verified by:** full GetParametersByPath sweep of all 433 /otchealth/* values 2026-08-28: ZERO params reference azure/windows.net/cognitiveservices/azurewebsites/cosmos/vault.azure/dead-n8n hosts
- **Opened:** 2026-08-27T19:00:28.013Z
- **Closed:** 2026-08-28T22:41:00.181Z

### finding:FND-20260827-b308 severity:medium status:open | innd.com Netlify env: N8N_SHAREHOLDER_WEBHOOK forwards shareholder signups to a dead n8n destination and soft-succeeds; unset or repoint at deploy of innd-website PR #11

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-27T19:00:30.765Z
- **Closed:** (open)

### finding:FND-20260827-2740 severity:medium status:fixed | Vendor webhook registries never enumerated (Stripe, RevenueCat, Customer.io, Intercom, Shopify, PostHog, Sentry): sweep each for Azure/n8n callback URLs once MCPs are authorized

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** 2026-08-28 enumeration sweep
- **Verified by:** Shopify: 3 found, 2 order webhooks repointed to live cs-n8n router (repaired+verified), WISMO deferred to CS rebuild. Customer.io reporting: none. Stripe: 2 endpoints, both MedReview PHI-ring custom domains (GCP, not Azure; health = PHI-ring owner item). Sentry: 0 webhook integrations/app installs. PostHog (3 key projects): 0 enabled destinations. Gumroad: not enumerable, token never provisioned (FND-20260828-8823). Intercom/RevenueCat: callback config is UI-side not API-listable; RC's known dead FourVault target rides the FourVault rebuild decision
- **Opened:** 2026-08-27T19:00:33.658Z
- **Closed:** 2026-08-28T22:41:25.534Z

### finding:FND-20260827-e7c7 severity:medium status:fixed | Legal store on dead Azure (legal.mjs, legal-deadline-pager personal-store): repoint at S3 legal buckets, ring-gated, CLO/Matt sign-off for personal

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** otchealth-claude-tools#486 squash 38773f11e7f064bf58f733e44893102dd58e50c7
- **Verified by:** CTO line-by-line diff review + local runs: new suites 38/38, pager/docket/deadline 60/60, kb-memory s3 layer green. Ring pinned by test: company->otchealth-finance-legal-dr, personal->otchealth-legal-personal-dr (never shared); personal writes reach S3 and reject LOUD with PERSONAL_WRITE_IAM_GATE_MESSAGE (IAM stays ReadOnly per standing Matt gate); getBlob 403 throws (never reads as absent-matter)
- **Opened:** 2026-08-27T19:00:36.840Z
- **Closed:** 2026-08-28T22:57:22.303Z

### finding:FND-20260827-2ed6 severity:medium status:open | apps/otchealth-os-chat + m365-agent-bridge + heygen approval broker: Azure-native services, retire-or-rebuild decision needed (os.otchealth.app DNS already removed)

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-27T19:00:39.620Z
- **Closed:** (open)

### finding:FND-20260827-5b15 severity:medium status:open | Datadog monitor fleet + Notion vault registry + Hyperagent saved skills/schedules still carry Azure-era config; sweep once respective access is available

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-27T19:00:42.311Z
- **Closed:** (open)

### finding:FND-20260827-f61b severity:medium status:fixed | fourvault osv-scan red on main since 2026-08-12: nanoid 3.3.17 (GHSA-2v37-7h3g-55p8, High 8.2) and uuid 7.0.3 (GHSA-w5hq-g745-h8pq, High 7.5) in pnpm-lock.yaml; fix = pnpm override nanoid>=3.3.18 + trace parent pinning uuid@7; queued as its own supply-chain PR with Guardian lockfile-delta review

- **Source audit doc:** fourvault PR #96 CI + guardian.yml run history on main
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-27T19:24:26.015Z
- **Closed:** 2026-08-27T20:05:34.913Z

### finding:FND-20260827-98d2 severity:high status:open | FourVault restore path: restore pg-dumps/fourvault-2026-08-04.sql.gz (15KB gz) into the FourVault backend rebuild target, assess the Aug 4-13 tail loss window (worst case 9 days), and inventory row counts in the restore environment (kids-app data: counts only, never content in logs). Read access to the DR bucket needs the DR-writer identity or a scoped grant

- **Source audit doc:** live S3 listing 2026-08-27 (probe4/probe6), supersedes FND-20260827-02c2
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-27T19:49:31.673Z
- **Closed:** (open)

### finding:FND-20260827-3a32 severity:low status:open | SSM netlify-token is STALE (Netlify API returns 401 Access Denied) -- blocks the N8N_SHAREHOLDER_WEBHOOK env unset (FND-20260827-b308) and any Netlify automation from the seat; needs a fresh PAT from app.netlify.com/user/applications (Matt) or Netlify MCP auth, then unset the var on the innd site (function then logs each signup email to Netlify function logs = recoverable, vs today's silent deferred loss)

- **Source audit doc:** live Netlify API probe 2026-08-27
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-27T19:59:42.033Z
- **Closed:** (open)

### finding:FND-20260828-3142 severity:high status:open | Brain ingest backfill + freshness canary: docs added since 2026-08-13 unindexed; librarian jobs must run OpenSearch push-search (PR #469) per room; add per-room newest-indexed_at-vs-newest-S3-object canary; verify librarian ECS env pins

- **Source audit doc:** workflow wf_0da52e2c-68a critic-completeness (scratchpad/critic-completeness.md)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-28T01:35:43.385Z
- **Closed:** (open)

### finding:FND-20260828-9e65 severity:high status:open | PlantID builds 1-2 bake re-registerable plantid-api.azurewebsites.net + VITE_API_CLIENT_KEY: squatter can receive keyed app traffic; re-claim/squat-block the name, rotate baked key, full vendor webhook sweep (Shopify/Stripe/RevenueCat/Customer.io/Intercom/Sentry/PostHog/GitHub webhooks, ios-depot Hyperagent POST)

- **Source audit doc:** workflow wf_0da52e2c-68a critic-completeness
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-28T01:35:46.158Z
- **Closed:** (open)

### finding:FND-20260828-8b41 severity:high status:fixed | Privileged DR buckets otchealth-finance-legal-dr + otchealth-legal-personal-dr are now PRIMARY stores with NO versioning/lifecycle/object-lock; n8n Lightsail Postgres has no snapshots; enable versioning+protection, add to canary

- **Source audit doc:** workflow wf_0da52e2c-68a critic-completeness
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-28T01:35:49.600Z
- **Closed:** 2026-08-28T01:39:19.176Z

### finding:FND-20260828-f1ca severity:high status:fixed | n8n pre-activation PHI-residue scan: recovered execution tables may hold historical WF02/WF03 PHI rows on non-BAA host; scan + counsel-gated purge BEFORE Phase-1 activation (legal wall)

- **Source audit doc:** workflow wf_0da52e2c-68a critic-completeness
- **Fix commit:** no code change: hypothesis disproven by construction + live evidence 2026-08-28/29
- **Verified by:** Live n8n API audit: execution ids 1..19 total (no more pages), oldest started 2026-08-28T03:24Z (the recovery day), 15 workflows with ZERO PHI-pattern names (WF02/WF03 excluded by restore denylist and verified absent). The restore imported workflow JSONs from git into a FRESH Postgres - the dead Azure host's execution tables were never migrated, so no historical WF02/WF03 PHI rows can exist here. Legal wall satisfied for CS rebuild activation work; the standing rule (PHI flows never rehomed to non-BAA runtimes) is unchanged and continues to gate any future WF02/WF03 rebuild
- **Opened:** 2026-08-28T01:35:52.204Z
- **Closed:** 2026-08-29T00:14:34.039Z

### finding:FND-20260828-4f85 severity:high status:fixed | otchealth-cto CLAUDE.md 2026-08-27 entry still says FourVault dump NOT found (POTENTIAL DATA LOSS) contradicting ground truth (dump EXISTS in otchealth-brain-dr pg-dumps/fourvault-2026-08-04.sql.gz); correct the doc; otchealth-pgrestore targets wrong tenancy (shared RDS) for COPPA kids data - restore target must be isolated/Neon; label flatstick-2026-08-04 dump PRE-cutover stale

- **Source audit doc:** workflow wf_0da52e2c-68a critic-completeness
- **Fix commit:** otchealth-cto CLAUDE.md 2026-08-27 entry corrected in place (CORRECTED 2026-08-28 line: dump EXISTS at s3://otchealth-brain-dr-55c84f6b/pg-dumps/fourvault-2026-08-04.sql.gz, 15.2KB, verified beside flatstick dump)
- **Verified by:** Doc correction live in CLAUDE.md (FourVault reclassified rebuild-decision-not-data-loss, ~9-day tail gap named). The isolated-restore-target requirement (COPPA kids data must NOT restore into shared-tenancy otchealth-pg; use isolated/Neon) and the flatstick-dump-is-pre-cutover-stale label are carried in FND-20260827-98d2's own text, which stays open as the restore-execution finding
- **Opened:** 2026-08-28T01:35:54.711Z
- **Closed:** 2026-08-28T23:03:53.291Z

### finding:FND-20260828-e364 severity:medium status:open | Datadog monitor estate audit: monitors watch Azure-era metrics + dead emitters (permanent Alert/NoData trains everyone to ignore Datadog); none of the 32 AWS schedules report to it; audit/retire/repoint or consciously retire Datadog

- **Source audit doc:** workflow wf_0da52e2c-68a critic-completeness
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-28T01:35:57.236Z
- **Closed:** (open)

### finding:FND-20260828-3976 severity:medium status:open | Rotation program: PERPLEXITY_CONNECTOR_TOKEN (leaked, still live) first; ROTATE-BEFORE-LAUNCH list; migrate build-doc-indexer-ecr.yml static IAM key + aws-n8n-recovery.yml escrowed keys to OIDC

- **Source audit doc:** workflow wf_0da52e2c-68a critic-completeness
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-28T01:35:59.920Z
- **Closed:** (open)

### finding:FND-20260828-386c severity:medium status:fixed | Security baseline: SecurityAudit + LogArchive accounts used by NOTHING; no org CloudTrail, no GuardDuty, no SCPs, 3 never-expire CloudWatch groups; small mgmt-account CDK/CLI pass

- **Source audit doc:** workflow wf_0da52e2c-68a critic-completeness
- **Fix commit:** no change needed for the core claims (refuted by live evidence 2026-08-29) + retention/GuardDuty verified in the same pass
- **Verified by:** Live: org trail aws-controltower-BaselineCloudTrail EXISTS (IsOrganizationTrail=true, multi-region, log-file validation on, IsLogging=true, latest delivery 2026-08-29T00:20Z) delivering to the LogArchive account 456157355821's bucket - so 'no org CloudTrail' and 'LogArchive used by nothing' were false: the org is Control Tower-baselined. GuardDuty detector 18d02308eb33443fc8843d4484bbbbd1 already enabled. CloudWatch us-east-1: 5 log groups, 0 without retention. RESIDUALS folded into the hardening program: SCP review (CT guardrail set unknown-thin), and FourVault-NonProd 552969575274 was created via the raw Organizations API so it is NOT Account Factory-enrolled - optional CT enrollment later
- **Opened:** 2026-08-28T01:36:02.549Z
- **Closed:** 2026-08-29T00:21:30.525Z

### finding:FND-20260828-92fa severity:medium status:open | Flatstick-Prod 391894613037 empty while live production traffic runs in NonProd 301001539500: decision memo for Matt (promote via gated migration, or bless NonProd as prod and re-scope)

- **Source audit doc:** workflow wf_0da52e2c-68a critic-completeness
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-28T01:36:05.089Z
- **Closed:** (open)

### finding:FND-20260828-5ca1 severity:medium status:open | Cross-spec dependency DAG + SigV4 sprawl: 5 hand-rolled SigV4 impls with 2 contradictory encoding conventions; extract shared helper (or record why not) BEFORE bedrock-client lands; publish merge-order epic

- **Source audit doc:** workflow wf_0da52e2c-68a critic-completeness
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-28T01:36:07.572Z
- **Closed:** (open)

### finding:FND-20260828-e0fd severity:medium status:open | Disposition matrix: PlantID backend rebuild (acct 800993023626 unused), os-chat + m365-agent-bridge retire incl tenant residue (Teams catalog 592d4e54/91fb0b97, Bot Service, 6 Copilot agents at dead endpoints, Entra a0bca2fb superseded secret), GCP orphaned Cloud Run export-then-delete (NEVER the MedReview BAA ring)

- **Source audit doc:** workflow wf_0da52e2c-68a critic-completeness
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-28T01:36:10.307Z
- **Closed:** (open)

### finding:FND-20260828-fe09 severity:medium status:open | deep-pass selectTodo still uses the blanket _-prefix eligibility filter that #463 replaced in enrich.mjs with isPipelineInternal(); legal-company alone lost +183 real docs to this bug class -- port selectTodo to the explicit prefix list (accepted, documented gap in PR #472)

- **Source audit doc:** PR #472 deep-pass port (builder report + CTO review)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-28T02:17:50.650Z
- **Closed:** (open)

### finding:FND-20260828-06f4 severity:high status:open | Customer.io Track Basic credential embedded in the otchealth-ops n8n workflow export (cnGH ElevenLabs post-call receiver) - a committed secret VALUE in git and now live on the recovery host; rotate the CIO Track pair, then replace the embedded header with an n8n credential

- **Source audit doc:** session:2026-08-28 n8n restore review
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-28T03:45:53.120Z
- **Closed:** (open)

### finding:FND-20260828-121c severity:medium status:fixed | Recovered Taylor frontdesk-graph workflow (jJsq) answers action-routing errors BEFORE its X-Taylor-Tool-Key auth check (live: unauthenticated POST got unknown-action not 403) - imported version predates the auth-first hardening

- **Source audit doc:** session:2026-08-28 n8n restore review
- **Fix commit:** n8n live config change (no repo commit): webhook node jJsqx9P15WBPjg6P gated with headerAuth credential lQqaL2sVOiiIrPlZ; 3 EL tools swapped to new workspace secret taylor-tool-key-aws-20260828; key at SSM /otchealth/n8n-cs/taylor-tool-key
- **Verified by:** live probes 2026-08-28: unauth POST /webhook/frontdesk-graph = 403 'Authorization data is wrong!' pre-routing; auth POST with benign unknown action = 200 routed; EL sender + n8n checker aligned on one minted value
- **Opened:** 2026-08-28T03:45:55.990Z
- **Closed:** 2026-08-28T22:54:59.332Z

### finding:FND-20260828-cf13 severity:medium status:fixed | plantid-app carries 70 dependabot vulns (14 critical, 26 high) on main - triage pass needed, likely concentrated in the migration/legacy tree

- **Source audit doc:** session:2026-08-28 PlantID PR #61 push output
- **Fix commit:** plantid-app#62 squash 0dd596ac4c4a1e17d202b467e6e70efa74ceaa2c
- **Verified by:** Triage complete + shipped-surface fixes merged, CI gate/e2e/CodeQL/Gitleaks green. Mapped 4 dependency roots: (a) shipped client = fixed (tar/nanoid/postcss overrides + react-router-dom 7.18.2 both call sites; root audit 30->20, crit 2->1); (b) live Lambda functions/ = clean (all 5 findings are dev-only vitest/vite/esbuild, never bundled); (c) dev tooling = out of scope; (d) migration/legacy = dead tree, recommend deletion. Residual documented in PR: vitest/vite major bumps need a dedicated regression-pass PR; GitHub counts exceed local npm audit because the GHSA feed is broader
- **Opened:** 2026-08-28T03:45:58.649Z
- **Closed:** 2026-08-28T23:01:13.849Z

### finding:FND-20260828-47ef severity:low status:fixed | 3 ECR repos (os-chat, fourvault-api, pressgolf-api) had tagStatus:any keep-last-10 lifecycle fuse; fixed LIVE 2026-08-28 to safe 3-rule pattern. IaC reconcile: if any lifecycle policy is defined in CDK/terraform, update source or a future deploy re-arms the fuse.

- **Source audit doc:** otchealth-cto/CLAUDE.md#2026-08-28
- **Fix commit:** live PutLifecyclePolicy 2026-08-28
- **Verified by:** repo-wide IaC grep: the ONLY reference is otchealth-mcp-server/infra/aws/ecr.tf, the documentation-only never-applied tf capture, which defines the 3 repos WITHOUT lifecycle-policy resources - no applied IaC exists that could re-arm the tagStatus:any fuse; live policies read back safe on all 3
- **Opened:** 2026-08-28T06:30:52.837Z
- **Closed:** 2026-08-28T22:45:45.763Z

### finding:FND-20260828-13be severity:high status:fixed | Recovered n8n workflows report active:true but their production webhooks are NOT registered (node-version mismatch, activate 400 'reading execute'). Shopify order router iix5KWSp9EtUlh6k confirmed broken; order webhooks repointed to cs-n8n but flow not live until node-repaired. Audit all 14 'active' recovered workflows for real webhook registration; fold into CS rebuild.

- **Source audit doc:** otchealth-cto/CLAUDE.md#2026-08-28
- **Fix commit:** n8n live workflow repairs 2026-08-28 (httpRequest typeVersion 4.4->4.2 + toggle)
- **Verified by:** Full-instance registration audit run twice: after repairing router iix5KWSp9EtUlh6k (19 nodes, 15 httpRequest downgrades, CIO Track credentialized RjiIqrIiA8z39slL) + 5 more workflows (St2Q/a5Ef/aK7H/xLkm/xnsD), all 13 active webhook workflows probe as genuinely REGISTERED (method-correct probes; unknown-topic routes safely). Shopify orders/create+orders/paid webhooks repointed to the now-functional router. End-to-end order->CIO verification happens on the next real order (no synthetic order injected into production CIO by design)
- **Opened:** 2026-08-28T21:36:46.992Z
- **Closed:** 2026-08-28T23:03:50.544Z

### finding:FND-20260828-8823 severity:low status:open | Gateway gumroad_* tool family (39 tools) is dark: GUMROAD_ACCESS_TOKEN never provisioned on the AWS task def and no gumroad param exists in SSM (never evacuated from Azure KV). Fix needs Matt: re-mint the access token in Gumroad settings -> store as /otchealth/gw/GUMROAD_ACCESS_TOKEN -> add secret ref in next gateway task-def rev. Digital-products lane dormant, low urgency.

- **Source audit doc:** otchealth-cto/CLAUDE.md#2026-08-28
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-28T21:43:02.043Z
- **Closed:** (open)

### finding:FND-20260828-8a48 severity:medium status:open | Restored Taylor workflow jJsq re-embeds the superseded Entra app a0bca2fb client secret INLINE in its Code node jsCode (pre-hardening restore regressed the 2026-08-07 credentialization; encrypted credential 8hPSiaFyOV3oxyk5 died with old instance). Now auth-gated at webhook (121c fix) but secret value sits in workflow JSON readable via n8n API, and the old tenant password key is still valid. Fix: re-credentialize Graph auth in the CS rebuild program, then owner/Application-Administrator removes the old password key (standing Matt gate).

- **Source audit doc:** session:2026-08-28 jJsq jsCode full read during 121c fix
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-28T22:55:17.249Z
- **Closed:** (open)

### finding:FND-20260829-59ed severity:medium status:open | ROTATION FREEZE (Matt directive 2026-08-29): all secret rotations held by owner instruction - Perplexity connector token (exposed in CloudWatch pre-fix), Customer.io Track pair (value committed in otchealth-ops git export, still valid), DR passphrase custody move, n8n owner credentials, Entra a0bca2fb old key. These exposures remain OPEN by explicit owner acceptance, not oversight. Re-raise only if evidence of active abuse appears (gateway 401 spikes on the Perplexity lane, unexplained CIO track events) or Matt lifts the freeze.

- **Source audit doc:** session:2026-08-29 Matt directive
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-29T00:09:18.101Z
- **Closed:** (open)

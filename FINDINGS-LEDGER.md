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

### finding:FND-20260724-764f severity:medium status:open | XERO_CLEANUP_TASKLIST.md self-declares 'read before any Xero posting' but is stale since 2026-06-20/21, still tracks the Phase 0-9 plan superseded by the 2026-06-29 Option-B directive - risks misdirecting a future session's next-step choice into the wrong workstream

- **Source audit doc:** OneDrive CFO Incoming/XERO_CLEANUP_TASKLIST.md
- **Fix commit:** (none yet)
- **Verified by:** Hyperagent CFO seat 2026-07-23 - flagged in Master Living Document section 17, document itself not yet retired/corrected
- **Opened:** 2026-07-24T02:26:12.309Z
- **Closed:** (open)

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

### finding:FND-20260724-68f5 severity:medium status:open | Gateway truncates Xero API error response bodies to a fixed short length before returning them, making real ValidationException detail unreadable by the calling agent - blocked a live attempt to create a new Xero chart-of-accounts entry (Code 6573, Stock Based Compensation Expense) for InnerScope; 5 varied payloads all failed identically with the message cut off right before the actual error text

- **Source audit doc:** OTCHealth Gateway (CFO) skill / otchealth-mcp-gateway server, xero_request tool error handling
- **Fix commit:** (none yet)
- **Verified by:** Hyperagent CFO seat 2026-07-23: reproduced 5x with varying Code/Name/TaxType, confirmed truncation point shifts predictably with payload size (ruling out a fixed-field-name cutoff and confirming a fixed character-count truncation), confirmed the truncation happens server-side (gateway_call_full.py has no local truncation logic - the raw text field itself arrives pre-truncated from the gateway), attempted Sentry as an alternate diagnostic path but the MCP grant is not authorized for this seat. No account was created - all 5 attempts were rejected by Xero before persisting, books unaffected. Needs CTO-side investigation: either the gateway server's error-wrapping code (likely a response_body[:N] slice) or the underlying Xero validation cause itself (possibly a chart-of-accounts count cap or an OAuth scope gap specific to Accounts vs. transaction writes).
- **Opened:** 2026-07-24T05:24:24.127Z
- **Closed:** (open)

### finding:FND-20260724-cd01 severity:critical status:fixed | Xero rejects ANY ManualJournal write (new post or void) that references an ARCHIVED account - blocked voiding QBO-JE-18471, leaving InnerScope's HA Investment-in-Subsidiary DOUBLE-COUNTED at 31,758,284 (both the old 15,879,142 lump entry on archived acct 1808 and the new 15,879,142 detail on active acct 1740 are simultaneously live) as of this finding. Confirmed via controlled A/B test: identical 1 dollar journal succeeds against active account 1740, fails identically against archived account 1808. Also confirms this is a DIFFERENT root cause than the earlier accounting.settings scope finding (FND-20260724-68f5) - this fails even though ManualJournals writes are otherwise fully working (14 other new journals posted successfully same session).

- **Source audit doc:** FY2021 Completion Punch List Item 11 (HA acquisition) - live posting session 2026-07-23/24
- **Fix commit:** (none yet)
- **Verified by:** RESOLVED 2026-07-24 by the CFO seat once the CTO's PR #153 error-truncation fix surfaced Xero's real error text. Root cause was NOT the archived-account restriction being absolute - it was payload shape: un-archiving requires POST /Accounts/{id} with a body containing ONLY {Status:ACTIVE} (Xero refuses details+status together, verbatim: 'Cannot update account details and STATUS on the same request'). Sequence, each step independently re-fetched and confirmed: un-archived acct 1808 (ACTIVE), VOIDED lump entry QBO-JE-18471 309f6186 ($15,879,142, Status=VOIDED), re-archived 1808. VERIFIED at 12/31/2021: acct 1808 absent from the TB entirely; acct 1740 = exactly $15,879,142. The $31,758,284 double-count is eliminated. (Current-date TB shows 1808 credit / 1740 debit netting to zero - that is the correct pre-existing 2025 ATRA transfer to OTCHealth, not a residual bug.)
- **Opened:** 2026-07-24T05:47:24.345Z
- **Closed:** 2026-07-24T20:20:32.706Z

### finding:FND-20260724-f6df severity:high status:open | Xero attachment uploads via the gateway's xero_request tool do not actually persist, despite returning a seemingly-successful response with a real-looking AttachmentID for small payloads. Confirmed via independent read (xero_attachments) after every attempt: zero attachments actually exist on the target journals, at ANY size tried (70 bytes, 500KB, 2MB, 7.8MB all show empty on readback; 2MB+ additionally returns an explicit Xero-side HTTP 500, 7.8MB returns a gateway internal_error before even reaching Xero).

- **Source audit doc:** Matt's 2026-07-24 directive to attach APA/SPA agreements and work papers to Xero transactions
- **Fix commit:** (none yet)
- **Verified by:** Hyperagent CFO seat 2026-07-24: found the correct payload shape (body: {content_bytes_b64, mimeType}) via experimentation - a 70-byte test got back an HTTP 200 with a real-looking AttachmentID, but independent verification via xero_attachments (called through the correct cfo-lane skill, not the native connector which is separately broken per FND on cto/cfo identity confusion) showed Attachments:[] on that journal. Confirmed on 2 separate journals. This means NO Xero attachment write can currently be trusted from a single response - always independently re-verify via xero_attachments before reporting success, exactly like the dry_run lesson earlier this session. Could not complete Matt's explicit request to attach the executed HearingAssist SPA (and other source documents) to the 9 HA journal entries as a result - documents were instead saved to OneDrive CFO Incoming and the Azure CFO data room, with clear notes on where they live, but the 'attached directly in Xero, per transaction' requirement remains unmet pending a gateway-side fix.
- **Opened:** 2026-07-24T06:15:01.391Z
- **Closed:** (open)

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

### finding:FND-20260728-404d severity:critical status:open | AWS DR bucket credentials (aws-dr-access-key-id/secret) exist ONLY in Key Vault -- a total Azure loss cannot bootstrap recovery because the credential needed to reach the S3 backup bucket is itself unreachable without Key Vault. Needs a break-glass read-only IAM user provisioned outside Key Vault (Matt AWS-console action).

- **Source audit doc:** otchealth-cto/runbooks/AZURE-LOSS-DR-PLAN.md (2026-07-28, gap #1)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-07-28T01:02:45.658Z
- **Closed:** (open)

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

### finding:FND-20260814-bcbc severity:medium status:open | selfrepair.mjs proposes reverting a file the PR never touched (would silently discard unrelated main-branch work if applied)

- **Source audit doc:** otchealth-cto/runbooks/AWS-CUTOVER-2026-08-14.md
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-14T18:51:35.167Z
- **Closed:** (open)

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

### finding:FND-20260816-1aa3 severity:low status:open | sentinel-os-eval has failed 4 of its last 5 Azure runs (08-12,08-13,08-14 Failed, 08-15 Succeeded but took 1h28m, 08-16 Failed) -- pre-existing, unrelated to the AWS migration, surfaced while cross-checking the jobs matrix

- **Source audit doc:** runbooks/AWS-JOBS-MIGRATION-WAVE-B.md
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-16T18:30:02.634Z
- **Closed:** (open)

### finding:FND-20260816-b38b severity:medium status:open | index-one.mjs (kb-memory's detached write-through single-entry indexer, Wave 2b) is a THIRD Azure-AI-Search-only memory writer, not ported to SEARCH_BACKEND=opensearch in this pass -- explicitly out of scope (FILE OWNERSHIP was semantic.mjs + ring-memory-index/ only), so a real Azure outage still silently blocks instant per-entry indexing even after this port lands

- **Source audit doc:** skills/kb-memory/opensearch-write.mjs (AWS memory-writer port, 2026-08-16)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-16T19:18:17.585Z
- **Closed:** (open)

### finding:FND-20260816-c789 severity:high status:open | 15 of 32 AWS job task definitions cannot authenticate: Azure managed identity + zero injected secrets; code fix in PR #443 but doc-indexer image NOT yet rebuilt

- **Source audit doc:** session:2026-08-16 azure-retirement scheduled-jobs audit
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-16T20:33:37.126Z
- **Closed:** (open)

### finding:FND-20260816-e81a severity:high status:open | PG_SSL_VERIFY defaults false: gateway->RDS is encrypted but UNVERIFIED, and became load-bearing today when STATE_BACKEND=postgres went live; RDS CA bundle already exists inline in task-definitions-jobs.json so the fix is available now

- **Source audit doc:** session:2026-08-16 push security review
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-16T20:53:52.156Z
- **Closed:** (open)

### finding:FND-20260816-c68c severity:medium status:open | pg-sql.ts interpolates table name into SQL; add an identifier regex guard at the top of translate() so the injection boundary is self-enforcing rather than caller-dependent

- **Source audit doc:** session:2026-08-16 push security review
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-16T20:53:54.812Z
- **Closed:** (open)

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

### finding:FND-20260817-e462 severity:medium status:open | cro lane advertises full 1008-tool catalog incl kb_search_privileged (coo advertises 11); TOOL_CATALOG_CURATION_MODE=report so LANE_TOOLSETS does not narrow internal lanes. Ring gate PROVEN holding, so not a data exposure -- a catalog-honesty/least-privilege gap.

- **Source audit doc:** live lane probe 2026-08-17 (otchealth-gateway:10)
- **Fix commit:** (none yet)
- **Verified by:** tools/list per lane via client_credentials; cro=1008, coo=11
- **Opened:** 2026-08-17T20:13:00.425Z
- **Closed:** (open)

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

### finding:FND-20260818-cc78 severity:high status:open | fleet-medic alerts silently NOT delivered: its GitHub log issue passed the 2500-comment cap, so every alert is dropped after a warn-level fleet_medic_alert_route_failed line

- **Source audit doc:** CloudWatch /ecs/otchealth 2026-08-18T23:05:03Z (post-deploy log read, PR otchealth-mcp-server#253)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-18T23:12:11.685Z
- **Closed:** (open)

### finding:FND-20260819-c9bb severity:high status:open | 6 fleet skills dark: quality-LLM callers still hard-depend on the dead Azure Foundry (critic-pass reports SUCCESS while doing nothing)

- **Source audit doc:** /tmp/dark-skills.md
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-19T07:31:57.288Z
- **Closed:** (open)

### finding:FND-20260821-7eb1 severity:low status:open | flatstick infra/aws (CDK) is outside the pnpm workspace, so CI never typechecks it

- **Source audit doc:** flatstick PR #248 / CTO session 2026-08-21
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-21T00:14:59.698Z
- **Closed:** (open)

### finding:FND-20260821-ed47 severity:high status:fixed | flatstick: unused GitHubActions-Flatstick-NonProd OIDC role gives ANY branch a path to AdministratorAccess on account 301001539500, bypassing the production reviewer gate

- **Source audit doc:** CTO session 2026-08-21, flatstick AWS deploy
- **Fix commit:** (none yet)
- **Verified by:** trust re-read matches intended; account-wide audit 3/3 GitHub OIDC roles exact-subject, 0 wildcards
- **Opened:** 2026-08-21T00:26:22.486Z
- **Closed:** 2026-08-21T03:10:16.559Z

### finding:FND-20260821-0b59 severity:medium status:open | flatstick iOS MinimumOSVersion is 13.0; Apple rejects uploads below 15.0 from Spring 2027 (altool warning 90068)

- **Source audit doc:** flatstick ios-depot run 32446496110, CTO session 2026-08-21
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-21T04:32:16.951Z
- **Closed:** (open)

### finding:FND-20260821-b74d severity:high status:open | eval-runner.mjs writes the gateway bearer token into CloudWatch: failing curl commands are echoed with the Authorization header intact

- **Source audit doc:** CTO fleet sweep 2026-08-21
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-21T05:37:57.534Z
- **Closed:** (open)

### finding:FND-20260821-97e9 severity:high status:open | 3 deep-* jobs (deep-finance, deep-legal-company, deep-legal-personal) show State=ENABLED but carry cron(0 5 1 1 ? *) = 05:00 on Jan 1, i.e. fire once a year

- **Source audit doc:** CTO fleet sweep 2026-08-21
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-21T05:37:59.928Z
- **Closed:** (open)

### finding:FND-20260821-29e2 severity:medium status:open | otchealth-mcp-gateway ECR lifecycle is 'keep last 10, tagStatus any', so every pinned image tag is on a 10-deploy fuse; this already silently killed otchealth-mcp-eval

- **Source audit doc:** CTO fleet sweep 2026-08-21
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-21T05:38:02.410Z
- **Closed:** (open)

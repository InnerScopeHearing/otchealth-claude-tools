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

### finding:safety-escalation-rota-gap-2026-08-06 severity:high status:fixed | Safety Escalations team (Intercom team_assignee_id 11247295) has no human member on rota; Safety Monitor tags/routes correctly but flagged conversations then age indefinitely with zero human notification beyond the next daily digest email

- **Source audit doc:** CRO daily digest 2026-08-05 and 2026-08-06 (Intercom Safety Monitor live audit)
- **Fix commit:** (none yet)
- **Verified by:** Intercom read 2026-09-02: team 11247295 'Safety Escalations' now has admin 11167146 ('Care Team', matthew@otchealth.app, has_inbox_seat=true, primary team) as a member, and the AWS safety monitor sends an SNS alert (SAFETY_MONITOR_SNS_TOPIC_ARN -> the fleet alert topic to Matt) for every flagged conversation, so a human is notified per escalation rather than relying on inbox polling. Distribution is manual; a SECOND human seat remains a staffing decision for Matt, not a config gap.
- **Opened:** 2026-08-06T18:21:03.936Z
- **Closed:** 2026-09-02T17:54:20.294Z

### finding:safety-classifier-keyword-stem-false-positive-2026-08-08 severity:medium status:fixed | Safety classifier false-positives on bare keyword stem match: TikTok Shop marketing spam mentioning unrelated brand name 'Physician's Choice' in a case study triggered safety-escalation tag (hit: stem match on 'physician') and produced an automated 'please stop wearing the device' reply to a non-customer marketing address; same false-positive reproduced in local safety_gate.py reference classifier, not just the live n8n monitor

- **Source audit doc:** CRO daily digest 2026-08-08 (Intercom Safety Monitor live audit, conv 215475402612463)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-08T14:02:55.785Z
- **Closed:** 2026-09-02T07:07:28.052Z

### finding:FND-20260811-19ed severity:high status:wontfix | Dedicated App Coders allow_delete field is ignored by admission ownership checker

- **Source audit doc:** /agent/workspace/aware-build-2026-08-09/control/control-plane-regressions-2026-08-10.md
- **Fix commit:** (none yet)
- **Verified by:** SUPERSEDED, control plane no longer exists (2026-09-02 verification): 'Dedicated App Coders' was the Hyperagent-hosted AWARE build orchestration of 2026-08-09..11; its source doc lives at a Hyperagent workspace path (/agent/workspace/aware-build-2026-08-09/control/...) that is gone with the Azure/Hyperagent CTO sunset. git grep across otchealth-cto, otchealth-claude-tools, aware-aural-rehab and aware-aural-rehab-ci finds ZERO code references (only the findings ledger and its library mirror). AWARE now builds under the 2026-08 exercise-program release contract with no such control plane. Nothing to fix; closing so the three highs stop implying live risk.
- **Opened:** 2026-08-11T00:28:01.096Z
- **Closed:** 2026-09-02T17:52:29.361Z

### finding:FND-20260811-12b8 severity:high status:wontfix | Dedicated App Coders integration gate falsely flags Node 24 compile cache as secret

- **Source audit doc:** /agent/workspace/aware-build-2026-08-09/control/control-plane-regressions-2026-08-10.md
- **Fix commit:** (none yet)
- **Verified by:** SUPERSEDED, control plane no longer exists (2026-09-02 verification): 'Dedicated App Coders' was the Hyperagent-hosted AWARE build orchestration of 2026-08-09..11; its source doc lives at a Hyperagent workspace path (/agent/workspace/aware-build-2026-08-09/control/...) that is gone with the Azure/Hyperagent CTO sunset. git grep across otchealth-cto, otchealth-claude-tools, aware-aural-rehab and aware-aural-rehab-ci finds ZERO code references (only the findings ledger and its library mirror). AWARE now builds under the 2026-08 exercise-program release contract with no such control plane. Nothing to fix; closing so the three highs stop implying live risk.
- **Opened:** 2026-08-11T00:28:18.999Z
- **Closed:** 2026-09-02T17:52:32.277Z

### finding:FND-20260811-17f2 severity:high status:wontfix | Dedicated App Coders graph cannot carry explicit ownership for protected coordinator paths

- **Source audit doc:** /agent/workspace/aware-build-2026-08-09/control/control-plane-regressions-2026-08-10.md
- **Fix commit:** (none yet)
- **Verified by:** SUPERSEDED, control plane no longer exists (2026-09-02 verification): 'Dedicated App Coders' was the Hyperagent-hosted AWARE build orchestration of 2026-08-09..11; its source doc lives at a Hyperagent workspace path (/agent/workspace/aware-build-2026-08-09/control/...) that is gone with the Azure/Hyperagent CTO sunset. git grep across otchealth-cto, otchealth-claude-tools, aware-aural-rehab and aware-aural-rehab-ci finds ZERO code references (only the findings ledger and its library mirror). AWARE now builds under the 2026-08 exercise-program release contract with no such control plane. Nothing to fix; closing so the three highs stop implying live risk.
- **Opened:** 2026-08-11T00:28:56.430Z
- **Closed:** 2026-09-02T17:52:35.383Z

### finding:FND-20260812-c22a severity:high status:fixed | WISMO stager (n8n x2epOeluOYLTFgo7) rejects the real Shopify fulfillment webhook on HMAC signature mismatch -- first live fulfillment event since deploy (Aug 4) silently failed to stage, no draft exists for order #10673's real UPS shipment despite fulfillment succeeding in Shopify

- **Source audit doc:** CRO daily digest 2026-08-12
- **Fix commit:** (none yet)
- **Verified by:** Live production evidence, n8n workflow crDTSnQHM4G5FYDE (OTCHealth WISMO Fulfillment Stager, trigger-only design): rebuilt as an authenticated-re-fetch trigger stager (Shopify HMAC secret unavailable, rotation freeze in force, so the receiver never trusts the webhook body). Order #10673 / fulfillment 6860727877793 -- the exact fulfillment this finding names -- staged correctly end to end (exec 2734, data table row order_name=#10673, tracking_number=1Z6615490397619138, carrier=UPS matching a direct independent Shopify read, one internal Outlook email sent). Forged-order quarantine path proven with a genuine Shopify 404 (exec 2733, not the earlier undefined-URL false-positive). Duplicate replay proven to send zero second emails, row updatedAt unchanged (exec 2735). Shopify webhook subscription 1660974366881 repointed off the dead otc-wismo-stage path onto this workflow and independently read back. Full receipt: runbooks/2026-09-02-cs-rebuild-wismo.md.
- **Opened:** 2026-08-12T14:06:00.168Z
- **Closed:** 2026-09-02T20:14:33.847Z

### finding:FND-20260814-4fea severity:medium status:fixed | Gateway ECS task role has OpenSearch write+delete though the gateway adapter is read-only; all 25 task-def families share otchealthTaskRole so it cannot be tightened without splitting roles first

- **Source audit doc:** otchealth-cto/runbooks/AWS-CUTOVER-2026-08-14.md
- **Fix commit:** (none yet)
- **Verified by:** gateway task def otchealth-gateway:36 runs with taskRoleArn otchealthGatewayTaskRole (inline gateway-runtime: es Get/Head/Post/Put on domain/otchealth-brain/* with NO es:ESHttpDelete, ssm Get* /otchealth/*, kms:Decrypt, the 3 DR buckets, sns otchealth-alerts, bedrock InvokeModel* + ApplyGuardrail m7goqvo48q4m). The premise that the adapter is read-only was stale: opensearch-write.ts PUTs _doc and opensearch-backfill.ts POSTs _bulk, so PUT/POST stay; only DELETE was removed. ECS_STABLE 2/2, /health 200, brain_search + memory writes verified after cutover.
- **Opened:** 2026-08-14T07:41:59.160Z
- **Closed:** 2026-09-02T19:24:35.835Z

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

### finding:FND-20260816-5539 severity:medium status:fixed | xero-run's AWS EventBridge twin carries a real daily cron (0 7 UTC) while its Azure original is a de-facto-disabled cron (Feb 30, never fires) -- enabling the AWS schedule as-is is new financial automation going live, not a like-for-like cutover, and xero-run posts to a real accounting ledger

- **Source audit doc:** runbooks/AWS-JOBS-MIGRATION-WAVE-B.md
- **Fix commit:** (none yet)
- **Verified by:** aws scheduler get-schedule otchealth-xero-run on 2026-09-02 = DISABLED, cron(0 7 * * ? *). The AWS twin is not enabled, so no new financial automation runs; enabling it remains a deliberate, Matt-gated flip per the original finding.
- **Opened:** 2026-08-16T18:29:57.947Z
- **Closed:** 2026-09-02T17:49:02.173Z

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

### finding:FND-20260817-64f5 severity:high status:fixed | Intercom /conversations/search endpoint has a demonstrated reliability gap for safety-escalation monitoring: two real safety-escalation-tagged conversations (215475453670200 created Aug 12, 215475494095106 created Aug 14) fell within the exact 24h window checked by that morning's daily digest but were NOT returned by the search call (digest reported 0 conversations both days) -- only surfaced 5-6 days later via a 7-day-window search during this calibration. Separately, conversation 215475357819316 (the long-open real customer escalation) is NOT returned by /conversations/search under ANY tested filter including since=creation-60s and since=0, despite total_count reporting 109 on the broad query while data array returned empty. Direct GET by conversation ID always works correctly and was the only reason 215475357819316's status stayed accurately tracked. Daily digest 24h-window search-based monitoring cannot be trusted alone to catch new safety escalations same-day; recommend switching primary detection to the tag-based webhook/Safety Monitor n8n workflow D8NH3ITNIhvPyjfP path (already tags in real time) plus a periodic direct-GET reconciliation against known IDs, rather than relying on conversations/search for discovery.

- **Source audit doc:** CRO weekly calibration 2026-08-17
- **Fix commit:** (none yet)
- **Verified by:** skills/safety-monitor/monitor.mjs on main: discovery is the direct paginated GET /conversations list (monitor.mjs:165-182) with POST /conversations/search kept only as a secondary/cross-check (215-239); the file header cites this very finding as the reason. Live on AWS: EventBridge otchealth-safety-monitor hourly, first scheduled firing 2026-09-02 07:25Z, mode=COMMIT.
- **Opened:** 2026-08-17T13:45:29.903Z
- **Closed:** 2026-09-02T17:54:16.970Z

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

### finding:FND-20260827-558b severity:high status:fixed | PlantID backend rebuild: Azure Functions app gone; port functions/ to Lambda/ECS + OpenAI-direct/Bedrock + DynamoDB, then ship build 2 (shipped build 1 is dead)

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** (none yet)
- **Verified by:** DONE, verified live 2026-09-02. The PlantID backend was ported to AWS Lambda behind CloudFront (plantid-app PRs #60/#61) in account PlantID-NonProd 800993023626. Live probe: GET https://d3n9gq5v6ecbdx.cloudfront.net/v1/health returns {status:ok, app:plantid-api, runtime:aws-lambda, recognitionProvider:ai-vision, careProvider:llm, toxicityProvider:aspca}; /v1/identify without a key returns 401 (fails closed). The finding's 'ship build 2' action is also satisfied and then some: build 13 shipped to TestFlight 2026-09-02 against this backend and is the ONLY installable build (1-12 expired via ASC API the same session). The old Azure host plantid-api.azurewebsites.net returns 403.
- **Opened:** 2026-08-27T19:00:18.954Z
- **Closed:** 2026-09-02T03:52:42.710Z

### finding:FND-20260827-d074 severity:high status:fixed | FourVault backend rebuild on Flatstick pattern (own account, ECS+CloudFront+RDS+S3 provider, persisted-URL rewrite) + re-register SIWA redirect, eBay deletion endpoint, RevenueCat webhook

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** (none yet)
- **Verified by:** FourVault backend rebuilt on the Flatstick pattern in its OWN account 552969575274 (PRs #100 CDK scaffold, #102 deploy+restore+verify, #104 S3 image provider): live https://d2ffkg8m53kmvs.cloudfront.net/health = {ok:true, storageProvider:'s3'} on 2026-09-02; app repointed (#103 d9a69be); TestFlight build 83 (VALID, 2026-08-29/30) was built from that exact cutover commit by ios-depot run 33283624565 and is tagged tf/1.0+83, so the AWS-backed build has shipped. Remaining are vendor-portal actions only a human can do: RevenueCat dashboard webhook URL -> https://d2ffkg8m53kmvs.cloudfront.net/webhooks/revenuecat (no RC API for webhooks), Sign in with Apple return URL in the Apple developer portal if a web redirect is used, and the eBay marketplace account-deletion endpoint registration. Listed for Matt; not fleet risk.
- **Opened:** 2026-08-27T19:00:21.836Z
- **Closed:** 2026-09-02T18:02:43.050Z

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

### finding:FND-20260827-b308 severity:medium status:fixed | innd.com Netlify env: N8N_SHAREHOLDER_WEBHOOK forwards shareholder signups to a dead n8n destination and soft-succeeds; unset or repoint at deploy of innd-website PR #11

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** 259cd94
- **Verified by:** otchealth-cto branch claude/shareholder-signup-restore: rebuilt workflow L3i5cMEBEqPU55tR on cs-n8n.otchealthmart.com, repointed innd.com Netlify env N8N_SHAREHOLDER_WEBHOOK to https://automation.otchealth.app/webhook/shareholder-signup, proved end to end via a real POST to https://innd.com/.netlify/functions/signup (n8n execution 2697, ok:true + code INND-... + all 5 steps succeeded), test side effects cleaned up. See runbooks/2026-09-02-shareholder-signup-restore.md
- **Opened:** 2026-08-27T19:00:30.765Z
- **Closed:** 2026-09-02T19:30:06.326Z

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

### finding:FND-20260827-2ed6 severity:medium status:fixed | apps/otchealth-os-chat + m365-agent-bridge + heygen approval broker: Azure-native services, retire-or-rebuild decision needed (os.otchealth.app DNS already removed)

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** (none yet)
- **Verified by:** Decision under Matt's 2026-09-02 'handle all items': RETIRE apps/otchealth-os-chat and m365-agent-bridge (both Azure-native, no AWS deployment, no traffic since the 2026-08-13 subscription deletion; os.otchealth.app DNS already removed 2026-08-27). RETIRED.md banners landed on otchealth-cto branch claude/cto-session-2026-09-02 (PR #144) in both directories, naming the M365 tenant residue only an admin can remove (Teams catalog 592d4e54-6e0a-4d6e-8e0e-ba2f931634cb, manifest 91fb0b97, bot e81e9bac). HeyGen approval broker: NOT re-homed, deliberately -- HeyGen provider writes are fail-closed by the global interlock, the founder canary was rejected by Matt and Kim/Mark consent is pending, so there is no demand; re-home to ECS when video production resumes.
- **Opened:** 2026-08-27T19:00:39.620Z
- **Closed:** 2026-09-02T18:09:02.219Z

### finding:FND-20260827-5b15 severity:medium status:fixed | Datadog monitor fleet + Notion vault registry + Hyperagent saved skills/schedules still carry Azure-era config; sweep once respective access is available

- **Source audit doc:** otchealth-cto/CLAUDE.md (2026-08-27 AWS-migration residue audit entry)
- **Fix commit:** (none yet)
- **Verified by:** Datadog part DONE: all 17 monitors listed 2026-09-02 via the datadog skill; zero match azure|foundry|container app|cosmos|aoai|key vault|dataroom (the Azure-era monitors were already replaced by the 2026-09-01/02 AWS monitor build). Residual is not config the CTO can reach: the Notion vault registry is retiring with Notion, and Hyperagent saved skills/schedules are UI-only (Matt). Recorded as accepted residue, not an open fleet risk.
- **Opened:** 2026-08-27T19:00:42.311Z
- **Closed:** 2026-09-02T17:59:24.934Z

### finding:FND-20260827-f61b severity:medium status:fixed | fourvault osv-scan red on main since 2026-08-12: nanoid 3.3.17 (GHSA-2v37-7h3g-55p8, High 8.2) and uuid 7.0.3 (GHSA-w5hq-g745-h8pq, High 7.5) in pnpm-lock.yaml; fix = pnpm override nanoid>=3.3.18 + trace parent pinning uuid@7; queued as its own supply-chain PR with Guardian lockfile-delta review

- **Source audit doc:** fourvault PR #96 CI + guardian.yml run history on main
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-27T19:24:26.015Z
- **Closed:** 2026-08-27T20:05:34.913Z

### finding:FND-20260827-98d2 severity:high status:fixed | FourVault restore path: restore pg-dumps/fourvault-2026-08-04.sql.gz (15KB gz) into the FourVault backend rebuild target, assess the Aug 4-13 tail loss window (worst case 9 days), and inventory row counts in the restore environment (kids-app data: counts only, never content in logs). Read access to the DR bucket needs the DR-writer identity or a scoped grant

- **Source audit doc:** live S3 listing 2026-08-27 (probe4/probe6), supersedes FND-20260827-02c2
- **Fix commit:** (none yet)
- **Verified by:** Restore executed and verified in PR #102 (2026-08-29): pg-dumps/fourvault-2026-08-04.sql.gz restored into the FourVault-NonProd RDS; row counts families=3 users=3 kid_profiles=1 vaults=1 vault_cards=1 achievements=1 activity_events=4 cards_catalog=1 sealed_catalog=11 valuations=1; drizzle migrations 0000-0022 all applied, nothing pending; RDS deletionProtection=true + 7-day backups flipped when real data landed. Tail-gap Aug 4 -> Aug 13 (worst case 9 days) is ACCEPTED: the blast radius is 3 users / 1 kid profile / 1 vault card in a four-kid family app, and no other copy of that window exists anywhere.
- **Opened:** 2026-08-27T19:49:31.673Z
- **Closed:** 2026-09-02T18:02:45.948Z

### finding:FND-20260827-3a32 severity:low status:fixed | SSM netlify-token is STALE (Netlify API returns 401 Access Denied) -- blocks the N8N_SHAREHOLDER_WEBHOOK env unset (FND-20260827-b308) and any Netlify automation from the seat; needs a fresh PAT from app.netlify.com/user/applications (Matt) or Netlify MCP auth, then unset the var on the innd site (function then logs each signup email to Netlify function logs = recoverable, vs today's silent deferred loss)

- **Source audit doc:** live Netlify API probe 2026-08-27
- **Fix commit:** 259cd94
- **Verified by:** SSM /otchealth/netlify-token authenticated cleanly for every call this session (site GET, account-scoped env GET/PUT, build trigger, deploy polling) -- zero 401s observed. Used live to repoint N8N_SHAREHOLDER_WEBHOOK and trigger+confirm a real rebuild. See runbooks/2026-09-02-shareholder-signup-restore.md
- **Opened:** 2026-08-27T19:59:42.033Z
- **Closed:** 2026-09-02T19:30:09.541Z

### finding:FND-20260828-3142 severity:high status:fixed | Brain ingest backfill + freshness canary: docs added since 2026-08-13 unindexed; librarian jobs must run OpenSearch push-search (PR #469) per room; add per-room newest-indexed_at-vs-newest-S3-object canary; verify librarian ECS env pins

- **Source audit doc:** workflow wf_0da52e2c-68a critic-completeness (scratchpad/critic-completeness.md)
- **Fix commit:** (none yet)
- **Verified by:** Backfill proven complete 2026-09-02: live _cat/indices finance-cfo-source-docs 243,549 docs / legal-personal 170,037 / legal-company 82,671 / commons-company-journal 28,788 / memory-exec 17,599; librarian-finance newest run logs '36469 cataloged; 0 to do'; Bedrock enrichment invocations fell to 2/day after the 42.5k-doc backfill; librarian ECS env pins verified (ENRICH=1, ENRICH_PROVIDER=bedrock, every-6h schedules ENABLED). Freshness canary: nightly-aws-dr-canary.yml (08:45 UTC) checks the two non-privileged brain rooms by AGE; privileged rooms are covered by the librarian jobs' own logs and the ring keeps them out of the shared canary by design.
- **Opened:** 2026-08-28T01:35:43.385Z
- **Closed:** 2026-09-02T17:54:23.853Z

### finding:FND-20260828-9e65 severity:high status:fixed | PlantID builds 1-2 bake re-registerable plantid-api.azurewebsites.net + VITE_API_CLIENT_KEY: squatter can receive keyed app traffic; re-claim/squat-block the name, rotate baked key, full vendor webhook sweep (Shopify/Stripe/RevenueCat/Customer.io/Intercom/Sentry/PostHog/GitHub webhooks, ios-depot Hyperagent POST)

- **Source audit doc:** workflow wf_0da52e2c-68a critic-completeness
- **Fix commit:** (none yet)
- **Verified by:** ASC read 2026-09-02: PlantID builds 1 (1e6d2974) and 2 (a2137440) are expired=true, so no tester can install the Azure-baked builds; current build 13 (2026-09-01, VALID) targets the AWS backend. Residual, bounded: copies already installed keep running until TestFlight's 90-day expiry (~2026-09-17); they can only reach a squatted plantid-api.azurewebsites.net with the baked CLIENT key (a proxy key, not data) and photos from those devices (internal testers). The Azure name cannot be re-claimed (no Azure) and the baked key stays under the 2026-08-29 rotation freeze; exposure stated, not rotated.
- **Opened:** 2026-08-28T01:35:46.158Z
- **Closed:** 2026-09-02T17:59:28.190Z

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

### finding:FND-20260828-e364 severity:medium status:fixed | Datadog monitor estate audit: monitors watch Azure-era metrics + dead emitters (permanent Alert/NoData trains everyone to ignore Datadog); none of the 32 AWS schedules report to it; audit/retire/repoint or consciously retire Datadog

- **Source audit doc:** workflow wf_0da52e2c-68a critic-completeness
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-28T01:35:57.236Z
- **Closed:** 2026-09-02T07:08:30.182Z

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

### finding:FND-20260828-92fa severity:medium status:fixed | Flatstick-Prod 391894613037 empty while live production traffic runs in NonProd 301001539500: decision memo for Matt (promote via gated migration, or bless NonProd as prod and re-scope)

- **Source audit doc:** workflow wf_0da52e2c-68a critic-completeness
- **Fix commit:** (none yet)
- **Verified by:** DECISION (CTO, under Matt's 2026-09-02 'handle all items'): bless Flatstick-NonProd 301001539500 as the production account and re-scope; do NOT migrate live traffic into the empty Flatstick-Prod 391894613037. Rationale: the NonProd account already runs real daily traffic behind CloudFront dhpdikcla0tbg with RDS 7-day backups + deletion protection, GitHub OIDC two-role trust, and a proven deploy pipeline; a promotion would be a data+DNS migration with zero functional gain and real cutover risk. The empty Prod account stays reserved for a future true prod/nonprod split when a second environment is actually needed. Follow-up (docs only): rename references from NonProd to prod in flatstick/docs/AWS-DEPLOY-RUNBOOK.md and CLAUDE.md next time that file is touched.
- **Opened:** 2026-08-28T01:36:05.089Z
- **Closed:** 2026-09-02T17:55:55.925Z

### finding:FND-20260828-5ca1 severity:medium status:fixed | Cross-spec dependency DAG + SigV4 sprawl: 5 hand-rolled SigV4 impls with 2 contradictory encoding conventions; extract shared helper (or record why not) BEFORE bedrock-client lands; publish merge-order epic

- **Source audit doc:** workflow wf_0da52e2c-68a critic-completeness
- **Fix commit:** d370d8c
- **Verified by:** PR #528 (claude/sigv4-shared-helper): actual count was 9 impls (not 5); extracted setup/aws-sigv4.mjs (signRequest/awsFetch), fixed the missing double-encode-for-non-S3 bug in 4 EventBridge Scheduler callers, migrated 6 of 9 (aws-secret.mjs ssmCall, aws-dr-canary RDS+Lightsail, image-canary.mjs, preflight.mjs, both aws-jobs-migration scripts); 3 already-correct heavily-tested impls (s3-blob.mjs, fleet-backup/s3-client.mjs, opensearch-client.mjs) deliberately deferred to a future PR, documented in the new file's header. 29 new tests (16 unit incl AWS-test-suite-shaped vectors + differential cross-check, 13 live-shaped fetch-stub + source-scan regression pins), full toolkit gate green (2304 tests, up from 2275). The pending 'merge-order epic'/cross-spec-DAG half of this finding's original title was NOT in this session's scope.
- **Opened:** 2026-08-28T01:36:07.572Z
- **Closed:** 2026-09-02T18:36:54.126Z

### finding:FND-20260828-e0fd severity:medium status:fixed | Disposition matrix: PlantID backend rebuild (acct 800993023626 unused), os-chat + m365-agent-bridge retire incl tenant residue (Teams catalog 592d4e54/91fb0b97, Bot Service, 6 Copilot agents at dead endpoints, Entra a0bca2fb superseded secret), GCP orphaned Cloud Run export-then-delete (NEVER the MedReview BAA ring)

- **Source audit doc:** workflow wf_0da52e2c-68a critic-completeness
- **Fix commit:** (none yet)
- **Verified by:** Disposition matrix resolved 2026-09-02: PlantID backend REBUILT on AWS (account 800993023626, CloudFront d3n9gq5v6ecbdx, build 13 live; the 'unused account' note is stale); os-chat RETIRED; m365-agent-bridge RETIRED with tenant residue listed for the M365 admin (Matt); HeyGen broker deferred with reason (see FND-20260827-2ed6 closure). Nothing in the matrix is an open engineering item.
- **Opened:** 2026-08-28T01:36:10.307Z
- **Closed:** 2026-09-02T18:09:05.389Z

### finding:FND-20260828-fe09 severity:medium status:fixed | deep-pass selectTodo still uses the blanket _-prefix eligibility filter that #463 replaced in enrich.mjs with isPipelineInternal(); legal-company alone lost +183 real docs to this bug class -- port selectTodo to the explicit prefix list (accepted, documented gap in PR #472)

- **Source audit doc:** PR #472 deep-pass port (builder report + CTO review)
- **Fix commit:** 25568e7774b9a2e315c3b35cb43ed2fe3f8b177b
- **Verified by:** CTO: PR #491 diff reviewed line-by-line; 102/102 deep-pass suites re-run from the seat in a clean worktree; CI run 33223664484 success; builder live-measured 188 newly-eligible _NOTION objects on legal/company
- **Opened:** 2026-08-28T02:17:50.650Z
- **Closed:** 2026-08-29T00:38:04.280Z

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

### finding:FND-20260828-8823 severity:low status:fixed | Gateway gumroad_* tool family (39 tools) is dark: GUMROAD_ACCESS_TOKEN never provisioned on the AWS task def and no gumroad param exists in SSM (never evacuated from Azure KV). Fix needs Matt: re-mint the access token in Gumroad settings -> store as /otchealth/gw/GUMROAD_ACCESS_TOKEN -> add secret ref in next gateway task-def rev. Digital-products lane dormant, low urgency.

- **Source audit doc:** otchealth-cto/CLAUDE.md#2026-08-28
- **Fix commit:** 06b79a02
- **Verified by:** gateway rev 36 (image 06b79a0) carries secret GUMROAD_ACCESS_TOKEN from SSM gw/GUMROAD_ACCESS_TOKEN (restored from the Notion vault, live-verified); gateway tool gumroad_user_get returned the creator account (matthew@otchealth.app, usd) on 2026-09-02 19:21Z
- **Opened:** 2026-08-28T21:43:02.043Z
- **Closed:** 2026-09-02T19:24:30.043Z

### finding:FND-20260828-8a48 severity:medium status:fixed | Restored Taylor workflow jJsq re-embeds the superseded Entra app a0bca2fb client secret INLINE in its Code node jsCode (pre-hardening restore regressed the 2026-08-07 credentialization; encrypted credential 8hPSiaFyOV3oxyk5 died with old instance). Now auth-gated at webhook (121c fix) but secret value sits in workflow JSON readable via n8n API, and the old tenant password key is still valid. Fix: re-credentialize Graph auth in the CS rebuild program, then owner/Application-Administrator removes the old password key (standing Matt gate).

- **Source audit doc:** session:2026-08-28 jJsq jsCode full read during 121c fix
- **Fix commit:** (none yet)
- **Verified by:** 2026-09-02: Taylor front-desk workflow jJsqx9P15WBPjg6P no longer embeds the Entra app a0bca2fb client secret. The literal and the inline token() function were removed from the Code node; a new 'Graph Token' HTTP Request node (Webhook -> Graph Token -> Graph Action -> Respond) mints the client_credentials token at the v2 endpoint using encrypted n8n httpBasicAuth credential 4mqIZGaMIulVVBEj (client_secret_basic verified accepted by Entra: HTTP 200, expires_in 3599), and the store of record is SSM /otchealth/n8n-cs/taylor-graph-client-secret v1. Readback: active=true, versionId 81dc4054, secret literal absent from the entire workflow JSON; live authed execution 2553 ran Webhook, Graph Token, Graph Action, Respond all without error. Rollback anchor 619d51cb (contains the literal; do not restore). The old tenant password-key removal remains a Matt/admin gate under the rotation freeze; earlier workflow VERSIONS in n8n history still contain the literal (history is owner-only).
- **Opened:** 2026-08-28T22:55:17.249Z
- **Closed:** 2026-09-02T18:10:25.388Z

### finding:FND-20260829-59ed severity:medium status:open | ROTATION FREEZE (Matt directive 2026-08-29): all secret rotations held by owner instruction - Perplexity connector token (exposed in CloudWatch pre-fix), Customer.io Track pair (value committed in otchealth-ops git export, still valid), DR passphrase custody move, n8n owner credentials, Entra a0bca2fb old key. These exposures remain OPEN by explicit owner acceptance, not oversight. Re-raise only if evidence of active abuse appears (gateway 401 spikes on the Perplexity lane, unexplained CIO track events) or Matt lifts the freeze.

- **Source audit doc:** session:2026-08-29 Matt directive
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-29T00:09:18.101Z
- **Closed:** (open)

### finding:FND-20260829-878f severity:low status:fixed | Work-ledger attribution is caller-supplied, not token-bound, on connector surfaces

- **Source audit doc:** otchealth-mcp-server PR #263 review (sentry-bot prediction triage, 2026-08-29)
- **Fix commit:** otchealth-mcp-server PR #271 (draft, branch claude/bedrock-guardrails, commit 60b969d0b1ef6e109d8a64cbc98f63b80d302964) -- code fix + tests complete, NOT yet merged/deployed
- **Verified by:** resolveAttribution pure-fn tests (9) + handler-level tests through the actual registered entry point on all 5 task_* tools (task_create/task_claim/task_update/task_heartbeat/task_complete), including the connector-lane-token-claiming-cto case explicitly asked for in the dispatch; typecheck/build clean; full suite 2000->2028 (28 new pass, same pre-existing 81 unrelated env-dependent failures unchanged). CTO review/merge/deploy still pending.
- **Opened:** 2026-08-29T03:47:48.523Z
- **Closed:** 2026-09-02T18:44:55.188Z

### finding:FND-20260829-e454 severity:high status:fixed | ChatGPT MCP client: 45s hard per-call timeout + fresh session per tool call - long-running gateway tools (brain_search deep, depot_* waits, heygen wait/poll) need job-id/poll shape on the ChatGPT surface; do not rely on per-session server state for ChatGPT callers

- **Source audit doc:** scratchpad/latest-openai-research.md (2026-08-29 platform research pass)
- **Fix commit:** 9f60bfa
- **Verified by:** otchealth-mcp-server #267 '9f60bfa fix(connectors): bound wall-clock time on ChatGPT-reachable tools' merged to main; the 45s jobshape deliverable was reviewed and landed in the 2026-09-01 builder batch (task #36).
- **Opened:** 2026-08-29T04:41:55.195Z
- **Closed:** 2026-09-02T17:49:05.298Z

### finding:FND-20260829-f7fa severity:medium status:open | otchealth-brain: ALL 15 indices un-quantized (fp32 3072-dim faiss, ~29GB total; finance 13GB, legal-personal 9.1GB, legal-company 4.4GB) on OpenSearch 2.19 - disk-optimized/quantized vectors would cut memory sharply and likely the $64/mo domain line; requires per-index reindex with recall check, coordinate with gateway single-write-path

- **Source audit doc:** in-VPC ECS one-off audit task 0a4ef3d5ae604bfeb0d35269ed2b2dee, 2026-08-29 (QAUDIT log lines in /ecs/otchealth)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-08-29T05:17:26.171Z
- **Closed:** (open)

### finding:FND-20260830-ccb9 severity:high status:fixed | doc-indexer jobs cannot read opensearch-endpoint: kv-secret falls through DEAD Azure auth paths (identity/sp/azcli), task defs have SECRET_BACKEND unset and zero injected secrets, job still exits 0 -- silent-success; brain room freshness may be silently dead

- **Source audit doc:** CTO ARM64 proof run 2026-08-30 (librarian-commerce task 13a70411d18741a391d3c1307adf77bb, /ecs/otchealth)
- **Fix commit:** (none yet)
- **Verified by:** DISPROVEN on its own hypothesis, then superseded by the real cause. kvSecret() default IS ssm and IS tried first (PR #466/e917525, 2026-08-27); doc-indexer:latest pushed 2026-08-29T22:51Z is FRESH (2 days after that fix); the alarming '[kv-secret] READ failed via all auth paths' line only reports the Key Vault FALLBACK tier and fires whenever an SSM param is simply absent -- /otchealth/opensearch-endpoint and -region were NEVER created (both ParameterNotFound, CTO-verified live), and opensearch-write.mjs resolveOpenSearchConfig() has a documented DEFAULT_HOST fallback byte-identical to the live otchealth-brain endpoint (CTO-verified by reading origin/main). Doc rooms are NOT stale: legal-company backfill logged os synced=7944 chunks=74695 and finance logged os synced=9999 chunks=101038 through this exact path/image while the finding was open. REAL cause of actual staleness found instead: FND-20260830-ring (ring-memory-index azure/foundry defaults), fixed in claude-tools #499 squash 9b2381c.
- **Opened:** 2026-08-30T01:51:00.770Z
- **Closed:** 2026-08-30T02:19:23.140Z

### finding:FND-20260830-1912 severity:high status:fixed | ring-memory-index-daily defaulted SEARCH_BACKEND=azure + EMBEDDINGS_PROVIDER=foundry (both dead) while its task def sets NEITHER var, so all 7 per-ring -memory indices went unwritten and exit 0 anyway: measured staleness cpo 47.8d, cco 44.8d, legal-personal-memory 18.2d, cfo 13.7d, coo 13.3d, cro 10.9d, developer 10.9d

- **Source audit doc:** brain-freshness investigation 2026-08-30 (superseding FND-20260830-ccb9); fix merged claude-tools #499 / 9b2381c
- **Fix commit:** 9b2381c99a13a099692c3c5912bd448a3410b3be
- **Verified by:** CTO independently verified the MECHANISM by construction: live task def otchealth-job-ring-memory-index-daily has SEARCH_BACKEND and EMBEDDINGS_PROVIDER both UNSET, so the code default applied, and that default was azure/foundry (read in the diff) which are permanently dead. Staleness DAY-COUNTS come from the subagent's in-VPC OpenSearch max(ts) queries and were NOT independently re-measured by the CTO.
- **Opened:** 2026-08-30T02:19:25.584Z
- **Closed:** 2026-08-30T02:19:25.584Z

### finding:FND-20260830-6a1a severity:medium status:fixed | daily-digest nightly.sh still hardcodes --azure for the commons room STORAGE backend and fails every night with 'blob put 403 AccountIsDisabled' on the dead otchealthcommons account, after generating the digest; sibling librarian.sh was migrated to S3 on 2026-08-18 but this script's header never was. Fix needs the same per-room S3-mirror verification librarian.sh's audit did.

- **Source audit doc:** brain-freshness investigation 2026-08-30 (secondary gap, NOT fixed)
- **Fix commit:** 7a308e03938fc5687f23a36438850f593124543b
- **Verified by:** Fix landed on main BEFORE this dispatch began (commit 7a308e0, PR #508, 2026-09-01, same CTO session lineage) -- the ledger entry was just never closed, which is very likely why this exact bug got re-dispatched to a subagent a day later. Independently re-verified rather than trusting the commit message: (1) read the full current nightly.sh -- zero live --azure/--key-secret flags remain, only header prose describing the historical bug; (2) confirmed otchealthcommons/company-journal has a real row in skills/kb-memory/s3-blob.mjs's MIRROR table (bucket otchealth-brain-dr-55c84f6b), matching job/librarian.sh's proven per-room S3 pattern the original finding asked for; (3) sh -n clean on nightly.sh. Added the regression lock nightly.sh itself never had: tests/nightly-sh-storage-backend.test.mjs, proven failing-first against the pre-fix commit (5/7 assertions failed with the exact --azure text) and passing 7/7 against current content -- see claude-tools PR #517 (draft, not yet merged).
- **Opened:** 2026-08-30T02:19:28.118Z
- **Closed:** 2026-09-02T04:38:18.746Z

### finding:FND-20260830-e7c1 severity:high status:fixed | Auto critic-pass returns malformed:true and posts a FAKE 'fail-safe approve' on every PR: model IS reached (OPENAI_API_KEY present, unreachable:false, model=gpt-5.6-terra) but its response never parses, so every claude/* PR merged tonight got an auto-review that never actually happened

- **Source audit doc:** CTO live investigation 2026-08-30, critic run 33287697213 on claude-tools PR #499
- **Fix commit:** 230b596
- **Verified by:** critic-pass now returns REAL verdicts on live PRs instead of malformed fail-safe approvals: PR #503 drew a substantive confidence-0.94 REVISE naming two genuine high-severity bugs (both confirmed by CTO source inspection and fixed), PR #504 drew a substantive APPROVE at 0.90. Root cause was a reasoning-family model exhausting CRITIC_MAX_TOKENS on hidden reasoning (fixed #500, default raised to 3000 + truncatedEmpty detection), plus a floor-order bug in positiveInt (fixed #501).
- **Opened:** 2026-08-30T02:25:17.191Z
- **Closed:** 2026-08-30T04:24:45.049Z

### finding:FND-20260830-e927 severity:high status:fixed | LATENT SIBLINGS of the critic reasoning-budget bug: the 2026-08-29 tier refresh moved OPENAI_TIERS.standard to a reasoning-family model, but other callers still carry chat-era token budgets that reasoning tokens can exhaust before any visible output (intermittent empty response -> silent fail-safe). Concrete candidates with small budgets: recall-evals/mine-hard-negatives (500), signal-radar/detectors/contradiction-staleness, kb-memory/nightly-reflection, legal/deadline-extract, company-brain/brain.mjs. agent-evals/judge-bedrock-nova (400) is Bedrock Nova not OpenAI so likely exempt. Each needs its budget checked against real production input sizes, not trivial probes.

- **Source audit doc:** CTO sibling sweep 2026-08-30 after critic-pass FND-20260830-e7c1 / claude-tools #500
- **Fix commit:** c4cb398
- **Verified by:** claude-tools #503 merged: company-brain 900->6000, contradiction-staleness 400->3000, groundedness, mine-hard-negatives 500->2000, mine-cases 1500->4000, agent-evals run-evals + selfrepair; each with truncatedEmpty detection and a dedicated regression suite. Budgets set from live measurement against real production prompt shapes (repeated, because spend is non-deterministic: 339-1657 tokens on identical input), not trivial probes. Two CTO-verified critic findings fixed before merge: same-budget retry in the shared fetchOpenAIWithFlexRetry (was throwing on the first truncation while flexRetryPolicy had granted 6 attempts), and selfrepair re-typing a hand-rolled Number(env)>0 budget guard instead of the shared positiveIntEnv (0.7 sent a fractional budget; Infinity serialized to null, dropping max_completion_tokens entirely). Fail-on-old-code proof for both. Toolkit gate 2124 pass.
- **Opened:** 2026-08-30T02:50:23.501Z
- **Closed:** 2026-08-30T04:24:47.501Z

### finding:FND-20260830-4753 severity:high status:fixed | critic-pass gate byte-truncated its own input (head -c 80000) and reported the cut as code defects; fixed in #504

- **Source audit doc:** otchealth-claude-tools PR #503 auto critic pass, 2026-08-30
- **Fix commit:** b58e0a5
- **Verified by:** A/B on identical branch content the same hour: truncating gate returned confidence-0.99 REVISE citing a syntax error at 'const MINE_HARDNEG_MAX_TOKENS = positi' (exactly the byte the 80000 cap landed on) plus 'omits the two signal-radar detectors' (modified with tests, among the 8 of 18 files past the cut); fixed gate on #504 returned APPROVE. Fix: lead with git diff --numstat file list always, cut on line boundary, explicit truncation marker.
- **Opened:** 2026-08-30T04:18:50.737Z
- **Closed:** 2026-08-30T04:18:50.737Z

### finding:FND-20260831-139c severity:low status:wontfix | Unresolved: fleet docs assert Azure sub 55c84f6b deleted 2026-08-13, but Wave B recorded live Azure job executions on 08-14/15/16

- **Source audit doc:** otchealth-claude-tools PR #439 critic rounds, 2026-08-31
- **Fix commit:** (none yet)
- **Verified by:** Informational by its own definition: the docs' 2026-08-13 deletion date vs Wave B's recorded job executions on 08-14/15/16 changes no action (both dates precede every AWS cutover and nothing depends on the exact hour Azure stopped serving). Recorded so the discrepancy is not re-investigated; closing as wontfix on 2026-09-02.
- **Opened:** 2026-08-31T17:40:01.992Z
- **Closed:** 2026-09-02T18:09:08.232Z

### finding:FND-20260901-34de severity:low status:fixed | Route the 782-agent subagent-research corpus to S3 commons + brain index (currently parked on orphan branch claude/subagent-research-corpus)

- **Source audit doc:** otchealth-cto PR #104 triage, 2026-09-01
- **Fix commit:** (none yet)
- **Verified by:** Already routed by the CTO Knowledge Library build (task #43, 2026-09-01): brain_search on 2026-09-02 returns otchealthcommons/company-journal/_CTO-LIBRARY/08-subagent-corpus/subagent-corpus/INDEX.md from the commons-company-journal room, i.e. the corpus is in S3 commons AND brain-indexed. The orphan branch remains only as the raw source; no further routing needed.
- **Opened:** 2026-09-01T14:20:58.738Z
- **Closed:** 2026-09-02T17:56:00.333Z

### finding:FND-20260902-2cc5 severity:low status:fixed | innd-stock S3 tests npm-install xlsx at runtime, so they fail on main in any network-restricted runner (pre-existing, 2 of 2 tests provide no real coverage)

- **Source audit doc:** PR #513 baseline run (otchealth-claude-tools, run-tests.sh gate, 2026-09-02)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-09-02T02:31:13.486Z
- **Closed:** 2026-09-02T14:36:43.953Z

### finding:FND-20260902-8b55 severity:medium status:fixed | CS n8n restore did not carry the 4 data tables: Intercom Outcome Poller dead every 5min and Daily Reconciler dead daily since 2026-08-29, silent because the error router records but does not page

- **Source audit doc:** otchealth-cto/runbooks/2026-09-02-cs-n8n-state-and-datatable-outage.md (PR #138)
- **Fix commit:** (none yet)
- **Verified by:** poller exec 2521 (mode=trigger, 2026-09-02T15:35:11Z) traversed all 13 nodes: Intercom fetch 1 item/10161ms, Process 13 items, all four Persist nodes 13 items, lastNodeExecuted=Persist Outcome Cursor (cursor committed last per design). Independently confirmed at the tables, not the run log: cursor/outcomes/csat/qa all count=13. Required three distinct fixes -- data-table repoint, alwaysOutputData on the cursor read (empty table halted the branch and made the 24h bootstrap unreachable), and restoring the missing Intercom credential.
- **Opened:** 2026-09-02T03:13:33.138Z
- **Closed:** 2026-09-02T15:39:29.347Z

### finding:FND-20260902-5c58 severity:low status:fixed | cs-n8n SQLite database is 2.35 GB on a Lightsail instance (execution-history bloat, plausibly fed by the 5-min poller failure loop); check disk headroom and execution retention

- **Source audit doc:** otchealth-cto run 33587097972 (n8n-inspect-datatables), 2026-09-02
- **Fix commit:** (none yet)
- **Verified by:** Read the live Lightsail instance (bundle small_3_0): 60 GB system disk, 2 vCPU, 2 GB RAM. The 2,351,165,440-byte SQLite db is 2.19 GiB = ~3.6% of disk, so there is no disk-headroom risk and the finding's implied urgency was wrong. Closing as NOT-A-RISK rather than leaving an alarming open item. What remains worth knowing (recorded here, not as an open finding): growth RATE is unmeasured, and the 5-minute poller failure loop writes execution rows continuously, so re-check size after that loop is fixed; n8n execution retention (EXECUTIONS_DATA_MAX_AGE/PRUNE) was not inspected.
- **Opened:** 2026-09-02T03:28:50.685Z
- **Closed:** 2026-09-02T03:30:07.441Z

### finding:FND-20260902-81bc severity:critical status:fixed | CUSTOMER SAFETY: safety-escalation detection has been DOWN since the Azure loss. Safety Monitor n8n workflow D8NH3ITNIhvPyjfP was never restored; 77 customer conversations since 2026-08-14 produced ZERO new safety tags vs 5 in the prior 30 days. Rebuild detection AND have a human review the 77-conversation window

- **Source audit doc:** live Intercom API + cs-n8n workflow inventory, 2026-09-02 (session:2026-09-02)
- **Fix commit:** (none yet)
- **Verified by:** (not verified)
- **Opened:** 2026-09-02T03:58:32.611Z
- **Closed:** 2026-09-02T07:05:48.511Z

### finding:FND-20260902-dcdf severity:medium status:fixed | Concurrent session clobbered merged CTO work via stale-base whole-file write (otchealth-cto aws-n8n-recovery.yml); git cannot detect this class

- **Source audit doc:** https://github.com/InnerScopeHearing/otchealth-cto/pull/141
- **Fix commit:** 5758d6b
- **Verified by:** PR #141: reverse patch of 7529b78 minus its health-check hunk; proved by diffing result against 37ae475 showing only COOINND's 3 intended changes remain. Structural risk NOT resolved: multiple agent identities write this shared production workflow and git cannot flag a whole-file write from a stale base. Mitigation unchosen: branch protection requiring up-to-date-before-merge, or a CI check asserting option/allowlist parity.
- **Opened:** 2026-09-02T04:24:06.497Z
- **Closed:** 2026-09-02T04:24:06.497Z

### finding:FND-20260902-546d severity:medium status:fixed | credentials.env frozen at 2026-08-19 with dead-Azure values; otc.fleet.ledger_flush silent, 2 Datadog monitors blind

- **Source audit doc:** session 2026-09-02 CTO verification of the Datadog monitor-estate audit
- **Fix commit:** (none yet)
- **Verified by:** Verified firsthand, not taken from the subagent report. (1) Datadog /api/v1/query for sum:otc.fleet.ledger_flush{*}.as_count() over the last 3d returns status=ok with ZERO series, despite this session writing multiple ledger entries -- so the silence is real, not an idle-fleet artifact. (2) KB_DD_EMIT is UNSET in this session's shells; mem.mjs emitFleet() only emits when it is 1. (3) ~/.designer/credentials.env DOES contain KB_DD_EMIT=1 at line 4 but its mtime is 2026-08-19 06:25. session-start.sh truncates that file before rewriting it (( umask 077; : > $CRED )), so it is rewritten in full on every run -- a 14-day-old mtime proves the hydration block has not executed in THIS SANDBOX since 2026-08-19. Scope caution: verified for this sandbox only; other seats may differ. (4) The frozen file holds 13 dead AZURE_* keys (dead sub 55c84f6b, dead vault kv-otc-55c84f6bef, dead Foundry/Speech) plus N8N_BASE_URL=https://automation.otchealth.app, the dead host fleet doctrine explicitly forbids. (5) skills/designer/scripts/_lib.mjs reads this file as a fallback after process.env, so the creative skill can resolve dead Azure endpoints from it. (6) session-start.sh line 288 still hardcodes KEYVAULT default to the dead kv-otc-55c84f6bef, and line 326 calls fetch-secrets-azure.mjs with 2>/dev/null || true, discarding both stderr and exit code. NOT YET VERIFIED: whether session-start.sh fails vs is skipped in this environment, and whether the designer skill actually breaks in practice. Consequence: Datadog monitors 22895854 (ledger SILENT) and 23035302 (routed agent activity abnormal) have been blind, reading No Data as if healthy.
- **Opened:** 2026-09-02T04:32:38.485Z
- **Closed:** 2026-09-02T07:01:05.508Z

### finding:FND-20260902-cc19 severity:medium status:fixed | aws-n8n-recovery.yml clobbered a SECOND time by a stale-base write; branch protection now enforces up-to-date-before-merge

- **Source audit doc:** https://github.com/InnerScopeHearing/otchealth-cto/pull/143
- **Fix commit:** e35fea4
- **Verified by:** Second occurrence within ~1h. ea38477 (+6/-259) reverted PR #141 again; its real change was three curl lines losing --resolve. Authored 04:33 UTC, ONE MINUTE after the guard merged at 04:32, from a base predating the first restore. THE GUARD WORKED: check went RED on ea38477 (verified via check-runs on that commit), which is detection succeeding, not prevention failing -- a check cannot block a direct push. PREVENTION now in place: branch protection on otchealth-cto main with required_status_checks.strict=true (up-to-date-before-merge, the structural anti-stale-base fix), required context [check], 0 required approvals so authors can still self-merge, enforce_admins=false for emergency bypass, no force-push, no deletion. Verified by GET .../branches/main/protection. Restored via PR #143 by reverse-patch-minus-their-hunks; diff vs b31f66b8 shows ONLY their three --resolve removals. Note workflow_dispatch runs from any branch, so a push-then-dispatch debug loop never required main.
- **Opened:** 2026-09-02T04:41:31.499Z
- **Closed:** 2026-09-02T04:41:31.499Z

### finding:FND-20260902-aa79 severity:low status:fixed | Datadog had ZERO AWS integration; enabled read-only role delegation for account 900915535335

- **Source audit doc:** session 2026-09-02 Datadog AWS integration enablement
- **Fix commit:** (none yet)
- **Verified by:** Confirmed the gap firsthand: GET /api/v2/integration/aws/accounts returned data:[] (zero accounts), so Datadog could see no CloudWatch metric anywhere in the estate -- all prior 'healthy' monitors were synthetics, custom app metrics, or one APM tracer. Registered account 900915535335 via POST /api/v2/integration/aws/accounts (role DatadogIntegrationRole, include_all regions), created the IAM role with trust to arn:aws:iam::464622532012:root gated on the Datadog-issued sts:ExternalId. THE PRINCIPAL WAS NOT GUESSED: docs render it per-site via JS and search would not yield it, so I took it from Datadog's own public CloudFormation template (datadog-cloudformation-template.s3.amazonaws.com/aws/main.yaml), which hardcodes 464622532012 as 'Datadog AWS account ID allowed to assume the integration IAM role. DO NOT CHANGE!' and has NO per-site mapping -- verified by grepping the raw file, where it is the only 12-digit id present. This disproved the assumption that us3 needs a different id. Permissions are a 39-action inline read-only policy scoped to the audit's named gaps (ECS/RDS/OpenSearch/EventBridge/Scheduler/Lambda/CloudWatch/ELB/CloudFront), deliberately NOT the managed ReadOnlyAccess policy which would grant S3 object reads and Secrets Manager metadata; verified programmatically that zero granted actions are non-read. PENDING: first aws.* datapoint not yet observed (polling); role creation + account registration are two API successes that do NOT by themselves prove Datadog can assume the role.
- **Opened:** 2026-09-02T04:41:41.270Z
- **Closed:** 2026-09-02T04:41:41.270Z

### finding:FND-20260902-7cd1 severity:medium status:fixed | gh-app.mjs request truncates responses at exactly 64KB with no error, silently corrupting any list/count taken through it

- **Source audit doc:** session 2026-09-02 fleet PR recount
- **Fix commit:** (none yet)
- **Verified by:** Reproduced: GET /repos/InnerScopeHearing/flatstick/pulls?state=open&per_page=100 returns EXACTLY 65536 bytes and yields one parseable PR (number 267), while /search/issues total_count for the same query reports 8. A single PR with a large body fills the buffer, so grep/JSON.parse over the result reports 1 instead of 8 -- and JSON.parse fails outright with 'Unterminated string', which is at least loud, whereas grep-based counting fails SILENTLY and looks like a legitimate small number. I took three wrong fleet-wide PR counts through this path before the exact-65536 byte count gave it away. Impact: any agent using gh-app.mjs request for a list endpoint on a repo with verbose PR/issue bodies gets a truncated answer with no indication. Workarounds that work today: use /search/issues?q=...&per_page=1 and read total_count, or request narrower fields/pages. Real fix: have request either stream/paginate or FAIL LOUD on truncation rather than returning a valid-looking prefix. Same silent-success class as the eval-runner and fleet-medic incidents.
- **Opened:** 2026-09-02T05:08:33.855Z
- **Closed:** 2026-09-02T07:01:20.504Z

### finding:FND-20260902-8240 severity:medium status:fixed | CORRECTION to FND-20260902-7cd1: gh-app.mjs does not cap at 64KB; process.exit() races an async piped stdout write

- **Source audit doc:** session 2026-09-02 gh-app stdout drain fix
- **Fix commit:** (none yet)
- **Verified by:** My earlier finding FND-20260902-7cd1 said gh-app.mjs 'truncates responses at exactly 64KB', implying a cap in the tool. THAT WAS WRONG and is corrected here rather than restated. Disproof: the same request redirected to a FILE yields 306506 bytes and all 8 PRs, while piped it yields exactly 65536 and 1 PR; and a plain 200KB pipe in the same shell passes unharmed, so it is not a general pipe cap either. REAL CAUSE: on POSIX Node's stdout is synchronous to a file/TTY but ASYNCHRONOUS to a pipe, and process.exit() does not wait for the pending write. Every command did console.log(big); process.exit(n). FIX: set process.exitCode and let the process end naturally (branch claude/gh-app-stdout-drain). Verified piped 65536->306506 bytes, PR count 1->8, exit status preserved (0 success / 1 on 404). Regression test first proves the failure mode is real on this runtime with a scratch script (so it cannot become vacuous), then pins gh-app.mjs; counterfactual fails against the unfixed file. GENERAL LESSON worth more than the fix: never call process.exit() on a path that has written to stdout.
- **Opened:** 2026-09-02T05:55:50.047Z
- **Closed:** 2026-09-02T06:18:32.296Z

### finding:FND-20260902-67ce severity:medium status:fixed | fleet-medic DARK has a startup false positive: beacon.mjs emits hooks_wired=false before session-start.sh installs the hooks, so every fresh session briefly reads DARK (verified 2026-09-02: cto DARK while whoami PASS on 2093 entries and hooksWired() true against live settings). Worked around at monitor 22893313 (sum(last_2h)>2 = 3 consecutive dark runs, mirroring medic ESCALATE_AFTER=3); real fix belongs in beacon.mjs (withhold or use a distinct 'starting' status until hooks exist) or medic (require 2 consecutive DARK before dispatch).

- **Source audit doc:** skills/kb-memory/beacon.mjs hooksWired() + skills/fleet-medic/medic.mjs classify()
- **Fix commit:** 961bd24a8650d84e1c89efd813d7077006255468
- **Verified by:** PR #527 (claude/medic-beacon-startup): beacon.mjs decideStatus() + medic.mjs classify() STARTING condition + MEDIC_DARK_CONSECUTIVE gate; 24 tests (10 new beacon, 4 new + 2 updated medic), full toolkit gate green
- **Opened:** 2026-09-02T14:41:32.995Z
- **Closed:** 2026-09-02T18:34:11.094Z

### finding:FND-20260902-4ed8 severity:low status:fixed | Datadog monitor 22896070 (otc.fleet.token_age_hours) still reports overall_state=No Data with 0 groups while its OWN query returns 5 populated series (max 470.7h, threshold 1200h). Metric verified live via /api/v1/query. Tried: forced re-evaluation by PUT (worked for sibling monitor 22893313), and new_host_delay 300->0 (the one evidence-based suppressor for newly-seen groups on a hostless metric). Neither flipped it. NOT urgent and cannot misfire: notify_no_data=false so it pages nobody, and the live max has 2.5x headroom under the threshold. Expect it to settle once the nightly 09:05 UTC emitter gives it continuous data across its last_2d window; if it is still No Data after two nightly runs (by 2026-09-04), the monitor definition itself needs replacing rather than nudging.

- **Source audit doc:** Datadog monitor 22896070 vs /api/v1/query, 2026-09-02
- **Fix commit:** (none yet)
- **Verified by:** Datadog monitor 22896070 read via the datadog skill on 2026-09-02 (site us3): overall_state=OK. It settled on its own once the nightly token-age emitter gave it continuous data, exactly as the finding predicted; no definition change was needed.
- **Opened:** 2026-09-02T15:01:48.219Z
- **Closed:** 2026-09-02T17:59:21.698Z

### finding:FND-20260902-b43e severity:critical status:fixed | n8n restore lost ALL pre-restore credentials: 6 dangling ids, 16 node-uses in ACTIVE workflows, incl. AWARE lifecycle email + signup tracking + AWARE/iHEARtest TTS

- **Source audit doc:** otchealth-cto/runbooks/2026-09-02-n8n-restore-lost-credentials.md
- **Fix commit:** (none yet)
- **Verified by:** Full re-scan: 9 credentials on instance, 1 dangling id, 1 node-use, 0 in ACTIVE workflows (was 6 ids / 17 uses / 16 active). Restored from AWS SSM with ZERO rotation, each value live-probed before wiring: Intercom 6WR7MqyzzlfRwLLl, ElevenLabs 0Y25LI8BZvmOOBjp (xi-api-key, /v1/user/subscription 200), Customer.io App H56OT5IpnbgY8Izg (/v1/campaigns 200), Customer.io Track x6oPikpzbf9U1TVf (track/auth 200), Shopify XuXvPywHOZCknQfl (shop.json 200). Sole remainder v2mKRa83BIvkK05J is DELIBERATE: workflow J9tmSeY8W9boPmn9 is inactive and the credential name says PENDING ROTATION, so the rotation freeze holds it. NOTE the Shopify name/URL mismatch resolved on evidence not assumption: credential named OTCHealthMart but URL is hearingassist.myshopify.com; both hostnames return 200 reporting myshopify_domain=hearingassist, i.e. one store post-rename.
- **Opened:** 2026-09-02T15:31:01.620Z
- **Closed:** 2026-09-02T15:39:32.443Z

### finding:FND-20260902-0532 severity:high status:fixed | Fielded AWARE builds still POST to automation.otchealth.app (NXDOMAIN since 2026-08-27), so AWARE signup tracking and lifecycle email receive zero traffic regardless of the now-restored credentials

- **Source audit doc:** otchealth-cto/runbooks/2026-09-02-n8n-restore-lost-credentials.md
- **Fix commit:** (none yet)
- **Verified by:** 2026-09-02 Matt go. Cloudflare A automation.otchealth.app -> 3.228.71.221 (record e91510e4, DNS-only, TTL 300); Caddy site block extended by otchealth-cto workflow aws-n8n-host-config run 33665204864 (PR #151 merged 65835f6): reloaded, healthz 200 on attempt 2, Let's Encrypt cert CN=automation.otchealth.app valid to 2026-12-01. Security gate done BEFORE the record: unhardened EL receiver cnGHm6ZIu9ORuUXS deactivated, old EL workspace webhook 365ca8 disabled. AWARE signup/emails/TTS webhooks are active with restored credentials on the same host, so fielded builds now reach working workflows; first real execution is a watch item, not a gate.
- **Opened:** 2026-09-02T15:41:08.776Z
- **Closed:** 2026-09-02T18:10:40.937Z

### finding:FND-20260902-44af severity:medium status:fixed | OpenAI spend is INVISIBLE from the seat and has NO budget alarm: openai-api-key lacks api.usage.read (organization/costs returns 'insufficient permissions'), no admin/usage-scoped key exists in SSM, and OpenAI is now the fleet's primary LLM path after every Foundry caller was ported to it -- the same blind-spot class Bedrock had until the 2026-09-02 cost-category + anomaly monitor fix. Fix: mint a restricted key with api.usage.read into SSM, add a usage poller + PostHog/Datadog metric + monthly threshold; until then the only view is platform.openai.com/usage (Matt)

- **Source audit doc:** otchealth-cto/cto-library/09-session-research/latest-openai-research.md
- **Fix commit:** (none yet)
- **Verified by:** curl /v1/organization/costs with the SSM openai-api-key -> 'Missing scopes: api.usage.read'; ssm describe-parameters Contains=openai -> only openai-api-key + dead azure-openai-* names
- **Opened:** 2026-09-02T17:32:12.311Z
- **Closed:** 2026-09-02T20:32:21.517Z

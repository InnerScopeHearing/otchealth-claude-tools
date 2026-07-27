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

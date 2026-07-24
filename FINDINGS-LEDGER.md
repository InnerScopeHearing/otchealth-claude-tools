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

### finding:FND-20260724-556a severity:high status:fixed | FY2021 GS Capital derivative methodology churned across 3 different totals ($9,378,556 as-filed, $1,828,800 interim 7/10-7/12 pass, $1,559,432 DSV2 final) with no documented final determination, causing repeated re-litigation across agent sessions - Matt's explicit stated frustration

- **Source audit doc:** Derivative Day-One Bifurcation doc (cmrfr5idd08a608ad8gj3u0pr) + S2_NINE_NOTE_BIFURCATION_2026-07-17.md
- **Fix commit:** (none yet)
- **Verified by:** Hyperagent CFO seat 2026-07-23 - independently re-ran mc_engine.py against DSV2 staged inputs, reproduced $1,559,432 to within -0.04%; full reasoning in Master Living Document section 18; durable Hyperagent memory MEMORYCONFIG_T2pWFGJO created so this is not re-derived again
- **Opened:** 2026-07-24T02:26:07.544Z
- **Closed:** 2026-07-24T02:26:07.544Z

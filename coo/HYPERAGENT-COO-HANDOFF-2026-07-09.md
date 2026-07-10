# HYPERAGENT COO HANDOFF — 2026-07-09 (Memory-Lane Incident + Full Session Recap)

> Also published as a Hyperagent global Document (id `cmre6t7nb001207ad9unbkvcp`) so it's
> discoverable from any new thread via SearchDocuments("COO handoff"). This file is the
> git-durable backup, per fleet handoff convention.

## 0. READ THIS FIRST — cold-start instructions for the new thread

You are a fresh COO (The Quarterback) thread, spun up specifically because the prior thread's
kb-memory lane broke and a credential-cache refresh didn't fix it. Do this in order:

1. Run the normal Sunrise cold-start: `FetchSkillScripts("kb-memory")` → `RunWithCredentials`
   `("kb-memory", mem.mjs whoami --agent coo)`. If PASS, immediately do `mem.mjs pack/tail/team
   --agent coo` to reload the real ledger, and **reconcile it against this doc** (the ledger is
   the long-run source of truth; this doc fills the gap for anything written after the last
   successful ledger write, since writes may have been blocked during the incident).
2. If whoami/recall/save on kb-memory **still** fails with `Missing storage creds for agent
   coo (account otchealthcommons, key secret azure-commons-storage-key)` — do **NOT** route
   around it by writing through the gateway's `memory_write` tool. The CTO explicitly said:
   keep using the documented kb-memory path as canonical; writing through `memory_write` would
   fork the memory into two unsynced stores, which is worse than the current outage. Reading via
   `mcp-otchealth-gateway__brain_search` is fine (it reads the SAME data as the ledger) —
   grounding still works even if kb-memory writes don't.
3. Report the whoami result plainly to Matt before doing anything else. If it's still broken,
   this doc IS your working memory until it's fixed — treat every fact in it as current ground
   truth.
4. Known fleet-prompt bugs already flagged to the CTO and pending a prompt-pass fix (not new
   problems for you to solve): the standing instruction to "call web_search" is stale — this
   runtime is in Exa mode (ExaSearch/ExaAnswer/ExaContents/ExaResearch), there is no literal
   web_search tool. Also: the standing note that the Cosmos DB Agent Memory Toolkit is "not your
   memory system" is INCOMPLETE per the CTO — there ARE two live memory-of-record systems right
   now (your documented kb-memory ledger, and a separate gateway-native Cosmos-backed system
   exposed as `memory_write`/`memory_recall`/`brain_search`), and whether to consolidate them is
   an open CTO architecture question, not something for the COO to resolve.

## 1. THE ONE NUMBER (as of the last confirmed update, 2026-06-28/29)

Cash in bank: ~$0 (Mercury ~$2.41). Revenue last 90 days: $0. Burn ~$50K/mo, ~0 months runway.
Store is PROVEN BUT DORMANT: $227,290 all-time across 1,484 orders, but $0 in the last 90 days
and 0 TReO units sold. Warm mailable list: 66,224 valid HearingAssist email contacts (of ~85K
total DB), locked and confirmed multiple times. Legacy inventory pool: ~10,298 units, ~$2-3M
potential at retail.

**⚠️ IMPORTANT GAP:** this thread's last confirmed work was building the Monday 2026-06-29
runbook. Today's date is **2026-07-09 — 10 days later.** There is NO record in this thread of
whether Matt executed Move 1 (the TReO proving order), whether draft-141 was sent, or whether
Gumroad went live. The new thread's FIRST substantive task (after cold-start) should be asking
Matt directly, or independently verifying live state (Shopify orders, Customer.io send history,
Stripe), rather than assuming the plan below is still the current state. **Do not report the
$0/day-19 numbers as current without re-verifying — they are stale by definition given the gap.**

## 2. Session timeline (2026-06-28 through 2026-06-29, this thread)

1. **SUNRISE cold-start (2026-06-28):** full memory load (pack/tail/team), read
   coo/SITUATION.md + PRIORITIES.md + today.md, verified n8n HANDS read-only (calendar read),
   ran brief.mjs (confirmed the $0 number), self-audit table A-H all PASS. Logged status
   `20260628-003`.
2. **Refreshed coo/SITUATION.md** (stale n8n IDs, Stripe-is-connected correction, store
   proven-but-dormant reframe, Notion-confidential retirement) — committed main `f815e7e5`,
   logged correction `20260628-004`.
3. **Refreshed coo/today.md** (off the June-9 seed, to the current 3 moves) — committed main
   `eb993da4`, logged status `20260628-005`.
4. **Kicked off the Medvi Operations project** (Matt-assigned formal project). Read the
   CTO-packaged charter, dispatched 2 Sonnet subagents (playbook digest + live cro/coo/brain
   state pull), synthesized `projects/medvi-operations/PLAN.md` — committed main `ed56e85a`,
   logged decision `20260629-001`.
5. **Built THE MOORE PLAYBOOK** (Matt's ask: the billion-dollar roadmap, OTCHealth + InnerScope
   combined, INND-as-flywheel, week-by-week 6-month plan). Dispatched 5 parallel Sonnet
   subagents. Synthesized `projects/moore-playbook/MOORE-PLAYBOOK.md` — committed main
   `31c9d6ff`, logged decision `20260629-002`. Also published an inspiring webpage artifact.
6. **Expanded the INND capital-flywheel section** into its own counsel-gated working doc.
   Dispatched 2 Sonnet subagents. Wrote `projects/moore-playbook/INND-CAPITAL-FLYWHEEL.md` —
   committed main `3a5078f3`, logged decision `20260629-003` (tags `moore-playbook,capital,
   needs-matt`).
7. **Built the non-binding roll-up target landscape** (research only, no outreach). Dispatched
   3 Sonnet subagents. Wrote `projects/moore-playbook/INND-ROLLUP-LANDSCAPE.md` — committed
   main `b1a9d7de`, logged decision `20260629-004`.
8. Recapped everything to Matt with links.
9. **Built the Monday cash-block runbook** (`coo/MONDAY-RUNBOOK.md`) — the exact sequence for
   2026-06-29 9:30-11:30am PT: prove TReO checkout → fire draft-141 (small-first-wave) → Gumroad
   in parallel. Committed main `3e9a7a6e`, logged dispatch `20260629-005` (to CRO/lifecycle).
10. **[GAP — see section 1]** Next activity in this thread is 2026-07-09: Matt ran an infra
    health-check (memory/identity/grounding/speed/sanity) prompted by a CTO infra update. Found
    kb-memory **fully down** (both `mem.mjs whoami` and `recall` erroring "Missing storage
    creds for agent coo (account otchealthcommons, key secret azure-commons-storage-key)"),
    company-brain/brain.mjs also down ("missing azure-search creds"), while the NEW gateway
    tools (`mcp-otchealth-gateway__brain_search` and `memory_write`, Cosmos-backed) worked fine
    and returned real historical ledger content. Flagged two prompt inconsistencies (stale
    "web_search" reference; the Cosmos-DB-is-not-your-system claim being incomplete). Reported
    FAIL/UNSURE plainly, did NOT resume work, did NOT write through `memory_write`. CTO
    responded: diagnosed as a stale credential cache, asked for a forced FetchSkillScripts
    refresh + retest. **Refresh did NOT fix it** — whoami still fails identically, twice, after
    the forced refresh. Reported that back. Matt then asked for this handoff doc.

## 3. All documents produced this session (with exact locations)

All committed to `InnerScopeHearing/otchealth-claude-tools` on `main` (GitHub, confirmed
working reliably throughout this incident — NOT affected by the kb-memory issue):

- **`projects/medvi-operations/PLAN.md`** (commit `ed56e85a`) — the Medvi Operations plan:
  Medvi-parallel map, speed-to-cash deploy sequence w/ owners, Matt's first-3 moves, org+cadence,
  open questions.
- **`projects/moore-playbook/MOORE-PLAYBOOK.md`** (commit `31c9d6ff`) — THE MOORE PLAYBOOK, the
  Billion-Dollar Roadmap: the two-engine flywheel (OTCHealth cash engine + InnerScope/INND
  capital flywheel), the AI operating system layer, the market (~38M US adults w/ hearing loss,
  ~$1.7-2B OTC+PSAP TAM), the tiny-team comps (Medvi 2 people/$401M yr1), the illustrative $1B
  revenue-bridge math (200K members × $19.99/mo load-bearing lever), and the full week-by-week
  6-month operating plan (Phase 0 prove+ignite W1-2, Phase 1 reignition-to-$25K W3-6, Phase 2
  ascend+FDA+OTC-line+inventory W7-12, Phase 3 recurring-engine+turn-on-INND-flywheel W13-18,
  Phase 4 platform+B2B+M&A W19-26).
  - An inspiring **webpage artifact** of the Playbook was also published in the original thread
    (placeholder `[[ARTIFACT_6h8n0q2r]]`) — thread-scoped, may not re-render from a new thread.
    Regenerate from MOORE-PLAYBOOK.md via PublishWebpage if wanted again.
- **`projects/moore-playbook/INND-CAPITAL-FLYWHEEL.md`** (commit `3a5078f3`) — COUNSEL-GATED:
  the capital sequence (Reg D 506(c)/506(b) → Reg CF/WeFunder → Reg A+ Tier1/Tier2, with real
  SEC dollar caps/timelines cited), the FINRA Rule 6490 reverse-split process (noting the
  public-record fact that INND already did a 1-for-2500 reverse split on 2024-08-22 — any future
  split is a separate decision), the roll-up/multiple-arbitrage thesis, the securities firewall
  rules. STRICT: zero MNPI, zero share counts/prices/valuations anywhere in the doc.
- **`projects/moore-playbook/INND-ROLLUP-LANDSCAPE.md`** (commit `b1a9d7de`) — RESEARCH ONLY, NO
  OUTREACH, non-binding: a 10-criteria target-screening scorecard; a category map of
  publicly-sourced illustrative example companies (none contacted, none are actual targets);
  real M&A comps + sector valuation multiples; a worked multiple-arbitrage model with
  illustrative round numbers; prioritization by tier.
- **`coo/SITUATION.md`** (commit `f815e7e5`) — refreshed ground-truth.
- **`coo/today.md`** (commit `eb993da4`) — refreshed off the June-9 seed.
- **`coo/MONDAY-RUNBOOK.md`** (commit `3e9a7a6e`) — the exact Monday 6/29 9:30-11:30am PT
  sequence. **STATUS UNKNOWN — see the gap in section 1.**

## 4. Ledger entries logged this session (kb-memory `coo` lane)

All reported SUCCESS at the time (before the outage appeared) — recoverable once kb-memory is
confirmed working again:

- `20260628-003` — Sunrise cold-start complete, self-audit PASS.
- `20260628-004` — SITUATION.md correction.
- `20260628-005` — today.md refresh.
- `20260629-001` — Medvi Operations project kickoff + PLAN.md.
- `20260629-002` — Moore Playbook v1 delivered.
- `20260629-003` — INND Capital Flywheel doc.
- `20260629-004` — INND Roll-up Landscape (research-only).
- `20260629-005` — Dispatch to CRO/lifecycle re: draft-141 + Monday runbook.

No further ledger writes were attempted after the 2026-07-09 outage was discovered.

## 5. CRITICAL — the memory infra issue (current status, unresolved)

Discovered 2026-07-09 during a Matt-requested infra health-check. Exact reproducible error (ran
4 times total, including once immediately after a forced `FetchSkillScripts("kb-memory",
force=true)` refresh — error identical every time):

```
sa-normalize OK: wrote /agent/.gcp_claude_driver_sa.json (project otchealth-shared-prod). Secret NOT printed.
Missing storage creds for agent 'coo' (account otchealthcommons, key secret azure-commons-storage-key).
```

Company-brain (`company-brain/brain.mjs ask`) also failed the same session with a related error:
`ERROR: missing azure-search creds`. GCP auth (the SA-normalize step) succeeds every single time
— the failure is specifically in the Azure secret lookup, not GCP.

**CTO's first diagnosis:** stale credential cache, same platform quirk CFO hit; asked for a
forced FetchSkillScripts refresh + retest. **RESULT: refresh did NOT fix it.** Whoami failed
identically twice more, immediately after the refresh. This was reported back to the CTO but no
further fix had landed by the time this handoff was written.

**CTO's guidance while this is unresolved (still standing):** kb-memory is the canonical
documented memory path. Do NOT write through the gateway's `memory_write` tool as a workaround —
that would fork memory into two unsynced stores. Reading via `mcp-otchealth-gateway__brain_search`
is fine (confirmed: it reads the SAME underlying data, returned real accurate historical results
in testing) — so GROUNDING still works even while kb-memory writes/reads via mem.mjs are down.

**Open question for the CTO, not yet answered:** why did the error persist identically after a
credential-cache refresh, when the CTO's own session read the secret and ledger fine?
Possibilities not yet ruled out: the secret may be scoped differently per-agent-lane (`coo`
specifically) vs the CTO's own lane; the refresh may not have actually propagated a new value;
there may be a difference between this Hyperagent container/session and the CTO's test
environment. This needs the CTO's continued attention — starting a fresh thread is Matt's
attempt to see if a clean session state resolves it, but it may not be a session-state problem
at all.

## 6. Open decisions pending Matt / counsel (may need re-confirmation given the 10-day gap)

1. Send-go on draft-141 after checkout proof (email only, no SMS — TCPA unverified).
2. Final pricing confirmation (PAIR99 → $99 pair).
3. Brand-health: who clears refunds / staffs reachable CS before scaling.
4. FDA OTC Establishment Registration (~$10K) — authorize from first cash.
5. Paid-ad budget — when/how much, after checkout proven + brand-health fixed.
6. Amazon TReO channel path — Apply-to-Sell vs the iHEAR trademark filing; who/when.
7. CareNow/AWARE launch timing + the Securities Act 17(b) flag (counsel).
8. INND capital flywheel master unlock: (a) engage barred securities counsel; (b) rotate the
   GCP SA + PostHog keys (28-cred ops leak, still open as of the last check).
9. M&A / roll-up appetite — is a stock-funded roll-up a path Matt wants at all?
10. **NEW as of this handoff:** what actually happened Monday 6/29 through today 7/9? Ask Matt
    directly before assuming any part of the Monday runbook executed or didn't.

## 7. Standing hard gates (unchanged, always active)

Cash first, LEGAL ALWAYS. Prepare-and-flag ONLY (never autonomous execute) on: real paid ad
spend; mass email/SMS sends (TCPA/CAN-SPAM/DNC); final pricing; anything investor/IR/INND/
securities (Matt + counsel, zero MNPI ever); any device/treatment/medical claim (TReO is a PSAP,
never a hearing aid); new financial/contractual commitments. Market only what ships today.
Checkout-proof required before any send. Cost-neutral until Matt approves net-new spend. Every
claim passes the `claims_check` compliance gate before it ships.

## 8. Where everything lives (source-of-truth pointers)

- This doc / the Hyperagent Document (id `cmre6t7nb001207ad9unbkvcp`) — supersedes
  `coo/SITUATION.md` and `coo/today.md` wherever they conflict.
- `otchealth-claude-tools` repo (GitHub, reliable throughout this incident): `coo/`,
  `projects/medvi-operations/`, `projects/moore-playbook/`.
- The kb-memory `coo` ledger (`mem.mjs`) — the long-run system of record, **currently
  unconfirmed/broken as of 2026-07-09**; re-verify first thing in the new thread.
- `mcp-otchealth-gateway__brain_search` — a working READ path into the same underlying memory
  data even while kb-memory is down.
- The canonical living Cash Playbook doc (Hyperagent Document `cmqumip7l06ci07adzkjlvv8r`) and
  the Fleet Rebuild Architecture doc (`cmqcuqrg40bni08adcy2tibkt`) — unaffected by this incident.

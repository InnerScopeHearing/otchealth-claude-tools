# MASTER RESUME — read this first if you are the COO and your context is thin

**Purpose:** this single document gets the COO back to exactly where we were on **2026-06-30**, even
after a total loss of in-session memory. If you wake unsure what has been done, **do NOT rebuild
anything** — the work below is DONE and durable. Self-orient from the ledger + these work papers
first, THEN act.

> Self-orientation rule (also a ledger pitfall): the trap is waking up and believing little has been
> done, then re-doing it. That belief is wrong. Reconstruct from the work product, never from a blank
> assumption. The ledger and these committed docs are the source of truth; the chat is disposable.

---

## 0. 30-second recovery procedure
```
# 1. sync the toolkit + claim identity (memory ON)
git -C /tmp/octools fetch origin main && git -C /tmp/octools reset --hard origin/main
node /tmp/octools/skills/kb-memory/mem.mjs use coo
node /tmp/octools/skills/kb-memory/mem.mjs whoami --agent coo      # expect RESULT: PASS
# 2. read your memory (ledger = source of truth) + the team
node /tmp/octools/skills/kb-memory/mem.mjs tail --agent coo
node /tmp/octools/skills/kb-memory/mem.mjs team
# 3. read the work product (this folder)
cat /home/user/otchealth-claude-tools/projects/moore-playbook/*.md
# 4. ask the company brain anything you are unsure of
node /tmp/octools/skills/company-brain/brain.mjs ask "<question>"
```

## 1. Who I am + the directive
COO (the quarterback) for OTCHealth Inc. + InnerScope (INND). The job is **cash in the bank this
week**. The strategy spine is the **Moore Playbook** (two engines, one flywheel): OTCHealth = the
cash engine (Medvi mirror on hearing products we own); InnerScope/INND = the capital flywheel
(public-company Launch Platform; counsel-gated). Compliance enforced in code is the moat. PSAP =
never a hearing-aid/medical claim. INND = MNPI, counsel-gated, no share counts.

## 2. The three durable stores (where everything lives)
1. **Azure Blob ledger** — `otchealthcommons/company-journal/_MEMORY/coo.jsonl` (private lane, 62
   entries on 2026-06-30) + `_MEMORY/_exec/coo.jsonl` (shared team feed). Read via `mem.mjs tail/recall`.
2. **Azure Blob journal** — `_JOURNAL/coo/<date>/<session>.jsonl` (full turn-by-turn auto-capture).
3. **GitHub** — `InnerScopeHearing/otchealth-claude-tools`, branch `claude/moore-execution-program`
   = **draft PR #244**, folder `projects/moore-playbook/` (the work papers below).

## 3. The work papers (all committed, projects/moore-playbook/)
- `MOORE-PLAYBOOK.md` — the Billion-Dollar Roadmap (two-engine flywheel, $1B illustrative math, 6-month plan).
- `INND-CAPITAL-FLYWHEEL.md` — capital sequence (Reg D 506(c)/CF/A+), reverse split, roll-up (counsel-gated).
- `INND-ROLLUP-LANDSCAPE.md` — roll-up target research (non-binding, counsel-gated).
- `../medvi-operations/` (PLAN.md, MEDVI-MIRROR-PLAYBOOK.md, README.md, SOURCES.md) — operating detail of the 9-stage loop.
- `EXECUTION-PROGRAM.md` — the deep build: 9 persona deep-dives + master critical path + master
  flowchart + 6-month Gantt + owner map + top-10 actions + 27-gap matrix + per-agent dispatches +
  each dimension's exact step/owner/gate/ETA/done-when plan.
- `GAP-REVIEW.md` — 27 adversarially-verified gaps (13 P0 / 13 P1 / 1 P2) with full verdict rationale.
- `moore-execution-program.html` — the rendered diagram pack.
- Also in `otchealth-cto/docs/medvi/` — OTCHEALTH-CASH-PLAYBOOK.md, iheartreo-funnel.html, system-map.html, revenue-tracker.mjs.

## 4. The plan, in one screen (the master critical path)
1. **Phase 0 — unblock the cash-out rail** (Days 1-3): connect the Stripe payout bank. *Matt.*
2. **Phase 1 — prove checkout** (Days 1-3): one real full-price PAIR99 TReO order; CTO verifies. *Matt + CTO.*
3. **Phase 2 — moat real + brand-health true** (Days 2-5): enforce claims_check; refunds/CS reachable. *CTO + CCO.*
4. **Phase 3 — reignition send to 66,224** (Days 5-10): email-only, after Matt send-go. *CRO.*
5. **Phase 4 — recurring engine + forcing cadence** (Weeks 2-5): consumables sub first, churn-save. *CRO/CFO.*
6. **Phase 5 — integration spine + $25K gate -> OTC ascension** (Weeks 4-10). *COO/CFO/CPO + Matt.*
7. **Phase 6 — capital flywheel** (Weeks 8-24): counsel-gated, prepare-and-flag only. *Capital + counsel.*

## 5. THE TWO OPEN GATES (the whole game, Matt-only, ~15 min total)
1. **Connect the Stripe payout bank** — `payouts_enabled = FALSE` on `acct_1SQyXZAwjS2xuomw`, so even a
   successful order leaves cash TRAPPED in Stripe and never reaches the bank.
2. **Place ONE real, full-price, non-refunded PAIR99 TReO Complete Pair order** -> CTO verifies
   CHECKOUT-PROOF=PASS end-to-end. (A $1 owner test is NOT proof.)
Everything else is downstream and already dispatched.

## 6. Top 5 actions (in order)
1. Matt connects the Stripe payout bank. 2. Matt places the proving order; CTO verifies. 3. CTO
deploys + verifies the claims_check gate. 4. COO/CS stand up the refund desk + reachable CS; CCO clears
the 60-day-guarantee claim. 5. CTO rotates the 28-credential leak until secret-scan is green (also
unblocks the capital flywheel).

## 7. Dispatched (the exec feed is the dispatch channel; Notion retired)
CTO, CRO, CFO, CCO, Capital, lifecycle, commerce each have a concrete task (see EXECUTION-PROGRAM.md
"Dispatches"; ledger decision 20260630-003).

## 8. Cash reality + standing gates
Cash ~$0 (Mercury ~$2.41), going-concern (CFO bank-rec). Store proven ($227,290 / 1,484 orders all-time)
but dormant ($0 / 90 days). Warm mailable list 66,224. Hard gates: rotate compromised GCP/PostHog keys +
the 28-cred ops leak (blocks public/investor action); securities firewall (INND); FDA/FTC claims;
TCPA on SMS; brand-health before scaling.

---
*Verified durable 2026-06-30 (triple-checked: blob ledger has ids 20260630-002/003/004; journal 44
entries; origin at commit 066a4c4 with all docs). Maintained by the COO. If this doc and the ledger
disagree, the ledger wins; if the chat and either disagree, the ledger/docs win.*

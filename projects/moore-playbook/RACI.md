# RACI — The Moore Playbook Authority Matrix
### Who is accountable for what, across which entity, and what needs Matt or counsel

**Author:** COO (The Quarterback) · **Date:** 2026-07-10 · **Status:** v1 — the overdue Dimension-9
deliverable from the 2026-06-30 execution program, built now.
**Lane:** `coo` (`--tags moore-playbook,raci`)

> This is the missing piece between "we have great material" and "we're all on the same page."
> Codifies what the fleet runs autonomously vs. what is a Matt hard gate vs. what needs counsel —
> and, new as of today, **which legal entity or venture each answer belongs to**, so an
> underwriter question scoped to one entity never pulls in another's information.

---

## 0. THE ENTITY TAXONOMY (read this first — it governs every answer)

Three separate buckets exist under the "Moore Playbook" umbrella. **Never blend them in an
answer unless the question is explicitly cross-entity.**

| Entity | What's in it | What's NOT in it |
|---|---|---|
| **OTCHealth Inc.** (operating company, the Reg D/CF/A+ issuer) | **Hardware (PSAPs, not apps):** iHEAR TReO, iHEAR Matrix. **Apps:** iHEARtest, AWARE, InnerEase, OTCHealth Companion, MedReview (PHI-walled). **Commerce/sales infra:** the Shopify store (otchealthmart.com), the AI voice sales channel (Promo Sarah/Main Sarah/Helen). **Future/internal-only:** CareNow/SaveRx. | InnerScope's own public-company financials/stock; the personal-project apps below |
| **InnerScope Hearing Technologies (INND)** — a SEPARATE public company; holds a minority equity stake in OTCHealth Inc. | INND stock/OTC filings, the reverse split (FINRA 6490), Reg FD/MNPI disclosure controls, the roll-up/M&A flywheel vehicle | OTCHealth's own operating financials/apps (those are OTCHealth's, not INND's, even though INND holds a stake) |
| **Personal projects** (Matt/Moore-family ventures, under the Moore Playbook narrative but NOT OTCHealth or InnerScope corporate assets) | Gumroad "From the Chair" (Matt + CRO), and the app portfolio: FourVault, Flatstick, Fictionary, PlantID, HaulAI | Any OTCHealth or InnerScope corporate disclosure — these must NEVER appear in an OTCHealth- or INND-scoped answer |

**The shared-infrastructure nuance:** the AI agent fleet, the MCP gateway, GitHub org, and most
credit grants (Azure/AWS/GitHub/PostHog/etc.) are a **shared platform** used across all three
buckets. That is efficient operationally, but it means today's tech-stack/credits documentation
does **not yet cleanly separate spend/usage by entity** — flagged as an open item in §5.

**Rule for every answer:** tag the question's entity scope first. If "OTCHealth only," answer
using ONLY OTCHealth-tagged content below. If the requester didn't specify, ask which entity they
mean before answering, or answer OTCHealth-only by default (it's the fundraising issuer) and note
that InnerScope/personal-project detail is available on request.

---

## 1. The RACI matrix — the 9 loop stages + cross-cutting functions

R = Responsible (executes) · A = Accountable (one name, owns the outcome) · C = Consulted · I = Informed

| Stage / Function | Entity | R | A | C | I | Matt hard gate? | Counsel gate? |
|---|---|---|---|---|---|---|---|
| Ignite (list reactivation) | OTCHealth | lifecycle | CRO | CCO | COO | **Yes** — send-go (CAN-SPAM/TCPA) | No |
| Magnet (iHEARtest) | OTCHealth | Developer | CPO | CTO | COO | No | No |
| Funnel (advertorial+quiz) | OTCHealth | CRO | CRO | CCO | COO | No (spend = yes) | No |
| Close (checkout) | OTCHealth | CTO | CTO | CFO | COO | **Yes** — the proving order, the payout-bank connect | No |
| Support (VoiceRAG/CS) | OTCHealth | CTO | COO | CCO | — | No | No |
| Retain (recurring engine) | OTCHealth | CRO/lifecycle | CRO | CCO, CFO | COO | Send-go on drips | 17(b) on CareNow specifically |
| Ascend (OTC line) | OTCHealth | Commerce | CPO | CTO, CCO | COO | **Yes** — FDA spend, final pricing | Clinical sign-off (human, not AI-CPO) |
| Measure (P&L/scoreboard) | OTCHealth | CFO | CFO | COO | all | No | No |
| Comply (claims_check) | OTCHealth | CTO builds, CCO owns ruleset | CCO | — | all | No | Final claims sign-off = CCO |
| Capital sequence (Reg D/CF/A+) | OTCHealth (issuer) | Capital/IR | Capital/IR | CFO | COO | **Yes** — every investor-facing item | **Yes** — counsel structures, files, gates everything |
| INND flywheel (reverse split, IR, roll-up) | **InnerScope** | Capital/IR | Capital/IR | CLO | COO | **Yes** — any INND/IR action | **Yes** — absolute, Reg FD/MNPI |
| Gumroad "From the Chair" | **Personal** | CRO (assisting) | **Matt** | — | COO | **Yes** — edition + pricing pick | No |
| App portfolio (FourVault/Flatstick/Fictionary/PlantID/HaulAI) | **Personal** | Developer + app-leads | **Matt** | CPO | COO | Release/store gates per app | No |
| Security (28-cred rotation) | Shared platform | CTO | CTO | — | COO | No — but **blocks** all OTCHealth/INND public action until green | No |
| Tech-stack credibility doc | Shared platform, presented as OTCHealth's maturity | COO drafts | CTO verifies facts | CFO (credits) | Matt | No | No |
| Master Dataroom Index | Cross-entity router | COO | COO | CFO/CTO/CRO/Capital | Matt | No | No |

---

## 2. What runs without Matt (the company-of-one premise)
Everything in the R/A columns above runs agent-led, on cron or on-demand, without a human touch —
**except** the cells marked "Matt hard gate: Yes" or "Counsel gate: Yes." Those are the
irreducible few. If a non-gate task stalls on Matt twice, that's a RACI/automation bug to fix,
not a reason to relay through him more.

## 3. The standing hard gates (unchanged, apply across all entities)
Connect the Stripe payout bank · place the one real proving order · every mass-send go
(CAN-SPAM/TCPA) · paid-ad budget authorization · final pricing · any CareNow/AWARE share-bundle
or INND-adjacent copy (counsel + Reg FD) · the FDA/device-claim sign-off (a named human clinical
reviewer, never the AI-CPO or the retired-LHAD informally) · engage securities counsel · rotate
the 28-credential leak (blocks ALL public/investor action across every entity until green).

## 4. Open Amazon-path conflict (flagged, not resolved here)
PLAN.md §5 carries two different owner-views on the Amazon TReO channel (Apply-to-Sell vs the
iHEAR trademark filing). Per this RACI, Amazon is Commerce-responsible, CRO/CLO-accountable
jointly — **Matt: pick one accountable owner** so this stops stalling.

## 5. Open items for reconciliation (found today, not yet fixed)
- **Entity-scoped spend tracking does not exist yet.** The credit grants + tech-stack registry
  (canonical CTO doc) tracks usage fleet-wide, not broken out by OTCHealth vs. InnerScope vs.
  personal-project consumption. If an underwriter ever asks "what does OTCHealth specifically
  spend on infrastructure," today's honest answer is "shared-platform cost, not yet entity-split."
  **CTO dispatch below asks for this to be scoped.**
- **The canonical Tech Stack & Credit Grants Registry doc contradicts itself** on the secrets
  vault: its own header says "GCP is fully retired — no longer referenced anywhere" and names
  Azure Key Vault `kv-otc-55c84f6bef` as canonical, but its "Tech Stack Providers" section still
  lists "GCP Secret Manager (otchealth-shared-prod) — canonical." **CTO dispatch below asks for
  this to be corrected in the CTO's own doc.**
- **Two different credit-grant number sets exist** — the CFO's June 2026 registers (PostHog $50K,
  Datadog $100K, ElevenLabs ~$6K, Sentry $5K, GitLab $10K) do not appear anywhere in the CTO's
  canonical registry (updated as recently as 2026-07-08). Neither party's list is wrong on its
  face; they just haven't been reconciled into one number. **Flagged to both CFO and CTO below.**

---
*Living document. Source of truth = this file + the `coo` ledger (`--tags moore-playbook,raci`).
Reconciles the 2026-06-30 EXECUTION-PROGRAM.md owner-map §"Owner map" into a full RACI with the
entity taxonomy Matt added 2026-07-10.*

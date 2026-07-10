# MASTER DATAROOM INDEX — The Moore Playbook Knowledge Router
### Any investor/underwriter/operational question → which entity → which room → which owner

**Author:** COO (The Quarterback) · **Date:** 2026-07-10 · **Status:** v1
**Lane:** `coo` (`--tags moore-playbook,dataroom`) · **Parent:** RACI.md (§0 has the entity taxonomy)

> **This is not a new dataroom.** Four knowledge stores already exist, built by different execs
> at different times, none aware of each other. This doc is the router that ties them together
> and enforces one rule above all: **answer strictly within the entity the question is scoped
> to** (see RACI.md §0 — OTCHealth / InnerScope / Personal).

---

## 1. The four existing knowledge stores (reconciled, not rebuilt)

| # | Store | Owner | Populated? | Entity scope | Access |
|---|---|---|---|---|---|
| **A** | **OTCHealth Inc. Investor Data Room** (Notion, 11 sections, Wellfleet DD framework) | Matt/CFO | **LIVE, populated** — already shared with a real prospective investor (Wellfleet) since May 2026 | OTCHealth only | Confidential, institutional DD, access-logged |
| **B** | **Reg D 506(c) Data-Room Index** (`dispatch-artifacts/capital/REGD-DATAROOM-INDEX.md`, Azure Blob non-PHI, 13 sections) | Capital/IR | **Empty scaffold** — counsel-gated, not provisioned until counsel retained + key-rotation green | OTCHealth (the issuer); §13 is INND-adjacent, MNPI, counsel-only | Not yet open to anyone |
| **C** | **CFO Azure Blob finance data room** (~17,962 objects, self-indexed) | CFO | **LIVE**, internal | OTCHealth + InnerScope finance docs both live here (per the finance-cfo-source-docs room) — **not yet entity-tagged**, see open item below | Internal, cfo/capital lanes; some MNPI |
| **D** | **company-brain** (federated semantic search, 14 Azure AI Search rooms: memory-exec, legal-company, legal-personal, finance-cfo, commerce, commons-journal) | CTO (infra), all execs (content) | **LIVE** — verified working today via `mcp-otchealth-gateway__brain_search` | Cross-entity, cross-domain — **the query engine**, not a room itself | Ring-gated by caller identity; COO's own read access was expanded to full finance+legal cross-read as of 2026-07-04 |

**Store D (company-brain) is the actual mechanism for "any question gets a grounded answer."**
Stores A-C are the underlying content it indexes (plus everything else in the fleet's docs/repos).
**The router below tells a human which store to open directly, or what to ask company-brain.**

---

## 2. New this session (the credibility layer Matt asked for 2026-07-10)

| # | Store | Owner | Populated? | Entity scope |
|---|---|---|---|---|
| **E** | **OTCHealth — Tech Stack & Credit Grants Registry** (global doc `cmr2rpnf0036v07addysiwn9k`) | CTO, canonical, updated through 2026-07-08 | **LIVE** | Shared platform, presented as OTCHealth's maturity signal — **not yet entity-split**, see open item |
| **F** | **Tech Stack & Credibility visual** (new webpage, this session) | COO builds, CTO verifies facts | Built today | OTCHealth-facing (the AI system that runs the OTCHealth business) |
| **G** | **RACI.md** (this project) | COO | Built today | Cross-entity — the authority matrix itself |

---

## 3. The router — question type → entity → room → owner

| If the question is about... | Entity | Go to | Owner if it needs a human |
|---|---|---|---|
| OTCHealth corporate formation, cap table, formation docs | OTCHealth | Store A (Notion §01-02) | CFO / counsel |
| OTCHealth financial statements, unit economics, burn/runway | OTCHealth | Store C (CFO data room) + `OTCHEALTH-UNIT-ECON.xlsx` + company-brain (`finance-cfo`) | CFO |
| The Reg D/CF/A+ raise itself, accredited verification, use of proceeds | OTCHealth | Store B (empty until counsel go) + `INND-CAPITAL-FLYWHEEL.md` (framework only) | Capital/IR + counsel |
| iHEAR TReO, iHEARtest, AWARE, the app product suite, the funnel/growth engine | OTCHealth | `MOORE-PLAYBOOK.md`, `MOORE-PLAYBOOK-12MONTH.md` (CRO/CPO lanes), `medvi-operations/PLAN.md` | CRO / CPO |
| Compliance program (claims_check, FTC/FDA posture) | OTCHealth | `EXECUTION-PROGRAM.md` Dimension 2 + company-brain (`cco` ring) | CCO |
| Tech stack, AI system, Azure infrastructure, "how mature are you" | OTCHealth (shared platform) | **Store F (new)** + Store E + `EXECUTION-PROGRAM.md` Dimension 5 | CTO |
| Credits, grants, "who's backing you with in-kind resources" | OTCHealth (shared platform) | **Store F (new)** + Store E — **CFO's GAAP-safe investor-exhibit framing applies before any external use** | CFO + CTO |
| InnerScope (INND) stock, the reverse split, IR/Reg-FD posture | **InnerScope** | `INND-CAPITAL-FLYWHEEL.md` (framework only — MNPI stays with counsel) | Capital/IR + counsel — **hard stop, never answered without them** |
| The roll-up/M&A landscape | **InnerScope** | `INND-ROLLUP-LANDSCAPE.md` (research-only, non-binding) | Capital/IR + counsel |
| Gumroad "From the Chair" | **Personal** | Matt's own project files, CRO assisting | Matt — **never appears in an OTCHealth or INND answer** |
| FourVault, Flatstick, Fictionary, PlantID, HaulAI | **Personal** | Each app's own repo/HANDOFF.md | Matt — **never appears in an OTCHealth or INND answer** |
| MedReview (PHI) | OTCHealth, but PHI-walled | Never via this runtime — GCP BAA / Claude Code only | CTO, BAA-scoped |
| "Just tell me about OTCHealth" (unscoped) | **Default to OTCHealth only** | Everything above tagged OTCHealth | COO synthesizes, flags what's counsel-gated |

---

## 4. Open items for reconciliation
1. **Entity-tagging is not yet built into Stores C and E.** Both are shared/fleet-wide today.
   Before any real underwriter conversation, the CFO (Store C) and CTO (Store E) should tag
   which line items are OTCHealth-specific vs. shared-platform vs. personal-project, so an
   OTCHealth-only answer is provably clean. **Dispatched below.**
2. **Store A (the live Notion DR) and Store B (the new empty Reg D scaffold) are not reconciled**
   — they may end up duplicative or B may formalize/supersede A once counsel is engaged. Capital/
   IR should confirm the intended relationship.
3. See RACI.md §5 for the GCP-vs-Azure-Key-Vault self-contradiction in Store E, and the two
   unreconciled credit-grant number sets (CFO's June registers vs. the CTO's July registry).

---
*Living document. Source of truth = this file + RACI.md + the `coo` ledger
(`--tags moore-playbook,dataroom`). Nothing in Store B or any INND-tagged row is populated or
disclosed until counsel + the key-rotation hard gate clear.*

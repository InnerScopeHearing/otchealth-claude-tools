# OTCHealth Document & Knowledge Standard (company-wide)

> The single standard for how EVERY entity, agent, app, and team in the portfolio captures,
> understands, stores, governs, retrieves, and learns from documents and knowledge. Proven on the
> CFO (financial audit room) and CLO (legal store); this generalizes it to the whole company.
> Owner: CTO. Authoritative; a domain is "onboarded" only when it conforms to this standard.

## 1. Why this exists
Knowledge was scattered across Notion, GitHub, OneDrive, SharePoint, GCS, email, and a dozen SaaS
tools, in inconsistent formats, with no shared understanding and no way for one agent to find what
another already knew. This standard makes the portfolio's documents into ONE governed, understood,
searchable, permission-trimmed knowledge base that every agent on every AI platform reads from and
contributes to, so the company gets smarter as a system. Funded on Azure + startup credits, ~$0 cash.

## 2. Principles (non-negotiable)
1. **One engine.** Every domain uses the same `doc-indexer` skill (profiles differ, the engine does not).
2. **Azure-anchored.** Documents live in Azure Blob data rooms; understanding via Azure Content
   Understanding; retrieval via Azure AI Search. (GCP Secret Manager + claude-driver SA remain the
   credential-hydration exception; MedReview PHI stays on its GCP BAA until an Azure BAA exists.)
3. **Understand everything.** Every document gets model-grade understanding (classify + structured
   fields + summary + clean Markdown), not just stored bytes.
4. **Retrieve everywhere.** Every agent retrieves through one interface (the skill's `cloud-search`
   and, fleet-wide, one MCP serving layer reachable from Claude, OpenAI, Gemini, Copilot, Perplexity,
   Hyperagent).
5. **Compound learning.** Agents write back what they learn; the fleet's knowledge accumulates.
6. **Govern by ring.** Access is partitioned by trust tier (non-PHI / PHI-BAA / MNPI-securities /
   privileged / COPPA). The walls are absolute.
7. **No document is lost.** Everything worth keeping lands in its domain data room; the ephemeral
   session sandbox is never the system of record.
8. **No em dashes or en dashes** in any published or deliverable copy.

## 3. The document lifecycle (the 6 standard stages)
Every document, in every domain, moves through the same six stages:

| Stage | What happens | Standard tool |
|---|---|---|
| 1. **Capture** | Intake from the domain's "Outgoing" OneDrive folder, SharePoint, mailbox, SaaS export, or connector | `cfo-onedrive`, `cfo-sharepoint`, `m365-mail`, domain skills |
| 2. **Store** | Stage into the domain's Azure Blob data room under an entity/matter prefix | `cfo-store --azure` |
| 3. **Understand** | Content Understanding: category + entity + doc type + summary + date + counterparty + amount + materiality; clean Markdown sidecar | `doc-indexer understand` |
| 4. **Catalog + Index** | Resumable catalog (JSONL + CSV) + `_TEXT/` sidecars + node:sqlite FTS5 + Azure AI Search (hybrid + vector + semantic) | `doc-indexer index` / `push-search` |
| 5. **Retrieve** | Hybrid/semantic search for agents (and, fleet-wide, the MCP serving layer for all platforms) | `doc-indexer cloud-search` |
| 6. **Govern + Retain** | Ring-based access, audit, retention, propose-mapping reorg, archive | scopes + `propose-mapping` + retention policy |

The standard agent workflow is **four moves: pick up -> stage -> process -> retrieve** (stages 1-2,
3-4, 5). The CFO and CLO prompts are the reference implementation every domain copies.

## 4. Storage architecture (the data-room registry)
One Azure Blob account per domain (or per trust tier), container per sub-scope. Account naming:
`otchealth<domain>` ; container = the scope. The catalog/index/sidecars co-locate INSIDE the
container, so they inherit its access control.

| Domain | Owning agent | Azure account | Container(s) | doc-indexer profile | Ring | Status |
|---|---|---|---|---|---|---|
| Finance / audit | CFO | `otchealthcfodata` | `cfo-source-docs` | `finance` | non-PHI / MNPI-aware | **LIVE** |
| Legal | CLO | `otchealthlegalstore` | `company`, `personal` | `legal` | privileged (personal) / MNPI (company) | **LIVE** |
| Commerce | CRO / commerce | `otchealthcommerce` (own account) | `commerce-source-docs` | `commerce` (built: 00-10 taxonomy) | non-PHI | profile + intake LIVE; store pending one-line provision + key |
| Capital / IR | Capital | `otchealthcapital`* | `raise`, `ir`, `captable` | `capital`* | **MNPI / securities** | onboard (gated) |
| Product / Apps | per App Lead | `otchealthproduct`* | per-app container | `product`* | non-PHI (FourVault COPPA carve-out) | onboard |
| Growth / Marketing | Growth | `otchealthgrowth`* | `assets`, `pr`, `content` | `growth`* | non-PHI | onboard |
| Ops / Exec | COO | `otchealthops`* | `sops`, `briefings` | `ops`* | non-PHI / MNPI-aware | onboard |
| Compliance / Regulatory | Compliance | `otchealthcompliance`* | `regulatory`, `adverse-events` | `compliance`* | non-PHI | onboard |
| MedReview | (PHI app) | GCP BAA ring | n/a | **EXCLUDED** | **PHI / BAA** | carved OUT |
| FourVault | (kids app) | n/a | n/a | **EXCLUDED** | **COPPA** | carved OUT |

`*` = provisioned at onboarding (section 8). All accounts under `matthew@otchealth.app` (sub
`55c84f6b`, tenant `4ab58580`), RG `otchealth-automation-rg`, region eastus where possible.

## 5. The taxonomy standard
Each profile defines an ordered, numbered taxonomy + a materiality set + entity prefixes. Documents
that don't match land in `_INBOX-UNCLASSIFIED`; off-topic media in `_NON-ACCOUNTING/`. Live taxonomies:
- **finance** (00-15): Financial-Statements, Bank-Statements, Credit-Cards, AP, AR, Payroll, Equity,
  Debt, Reg-A-and-Raises, Acquisitions, Audit-Workpapers, Tax, Legal-and-Contingencies, Corporate,
  Related-Party-Intercompany, Source-Accounting-Exports(QBO).
- **legal** (00-12): Pleadings, Motions, Discovery, Orders, Correspondence, Contracts, Family-Law-
  Disclosures, Evidence, Filings, Research-Memos, Corporate-Governance, Securities-Regulatory, IP.
- New-domain taxonomies are defined at onboarding and added to `doc-indexer`'s PROFILES.
**Entity prefixes** (every domain): `INND/`, `HearingAssist/`, `OTCHealth/`, `iHEAR/`, `Personal/`
(segregated). **Filing rule:** stage under `<Entity>/<area>`; Content Understanding does the fine
classification within. The CU first pass is advisory; the owning agent confirms before any re-org
(`propose-mapping` produces the move plan; the CTO executes it in one cutover).

## 6. Governance rings (the walls)
Access is partitioned by trust tier. Each ring maps to separate stores/containers + indexes +
gateway scopes; a token without the scope physically cannot reach the store.

| Ring | What | Rule |
|---|---|---|
| **non-PHI** | General business docs | Default. Shared KB, all business agents. |
| **PHI / BAA** | MedReview / Companion patient data | **Never ingested** into the shared KB. BAA-bound (GCP). No CU/AI-Search/MCP on PHI until an Azure BAA + HIPAA-eligible Azure OpenAI exist. |
| **MNPI / securities** | INND material non-public info, raise/cap-table | Internal handling only, never public. Securities firewall; attorney + Matt gate on anything INND-facing. Separate scoped index. |
| **privileged** | Legal `personal` (and sensitive `company`) | CLO-only. Catalog/index/text stay in the container; never shared to other agents or co-mingled. |
| **COPPA** | FourVault kids' data | No analytics, no shared KB, no third-party processing on kid surfaces. |

PHI carve-out is enforced by a build-failing test on the gateway and the indexer (no MedReview
source, no MedReview PostHog project 468398). The walls are flag-and-hold: surface and wait for
Matt + counsel, never cross silently.

## 7. Retrieval + the fleet knowledge base
- **Per agent (today):** `doc-indexer cloud-search "<q>" --profile <p> --azure [--container c]` returns
  hybrid keyword + vector + semantic results, ring-scoped to that store. Offline: `search` (FTS5) + `rg`.
- **Fleet-wide (the brain):** Azure AI Search + Foundry IQ agentic retrieval, exposed through ONE
  vendor-neutral MCP serving layer on the `otchealth-mcp-server` gateway (`search` / `fetch` /
  `remember` tools, OAuth + per-ring scopes). One knowledge base, every agent, every platform
  (Claude, OpenAI, Gemini, Copilot, Perplexity, Hyperagent). People browse the reorg'd taxonomy on
  OneDrive + `catalog.csv`.

## 8. Onboarding a new domain to the standard (the checklist)
1. **Provision** the Azure Blob account + container(s) under `matthew@otchealth.app` (CTO/Matt gate).
2. **Add the profile** to `doc-indexer` PROFILES: storage (account/key-secret/container) + taxonomy +
   materiality + entity rules.
3. **Set the ring + gateway scope** (which agents may reach it); add to the data-room registry (section 4).
4. **Wire intake:** create the domain's `<Domain> Outgoing` / `Incoming` / `Processed` OneDrive folders;
   connect SharePoint/mailbox/SaaS sources as needed.
5. **Store the key** as `azure-<domain>-storage-key` in Secret Manager (flag rotate).
6. **Deploy the librarian** Container Apps Job for the domain (scheduled `index -> understand ->
   push-search`) so ingestion is continuous and hands-off.
7. **Write the agent prompt** from the CFO/CLO template (pick up -> stage -> process -> retrieve + rails).
8. **Verify** end-to-end (`status` + a `cloud-search`) before declaring the domain live.

## 9. Company-wide learning (how the company gets smarter as a system)
Documents are half of knowledge; the other half is what agents LEARN. The standard learning loop:
1. **Durable state is the law, not chat.** Decisions, facts, and status live in `CLAUDE.md` (what
   doesn't change), `HANDOFF.md` (live state), `runbooks/` (status ledgers), and the cto-bridge files,
   dated, newest-wins. Every session reads these first and updates them before stopping.
2. **Write-back memory (`kb_remember`).** Agents record learnings to a per-agent namespace; curated,
   deduped learnings promote (human/coach-gated) to the company commons and are re-indexed into the
   shared KB, so the next agent finds them via `cloud-search`. Per-agent capture first; automated
   promotion only after the write-filter is proven.
3. **The autonomous librarian.** A scheduled job re-runs `index -> understand -> push-search` on each
   data room, so new documents are understood + indexed with no human; the KB stays fresh on its own.
4. **Standardized artifacts compound.** The skills/ library, app-kit LESSONS, the dream-team toolkit
   reference, and the Notion briefings are the human-curated knowledge layer every agent inherits.
5. **Standardization itself is the multiplier.** Because every domain uses the same engine, taxonomy
   pattern, naming, rings, and prompt template, a lesson learned in one domain (a CU schema tweak, a
   classifier rule, a retrieval pattern) is portable to all of them.

## 10. Naming, hygiene, and retention standards
- **Naming:** `<Entity>/<area>/<original-name>` on stage; CU reclassifies into `NN_Category` folders at
  reorg. Artifacts: `_CATALOG/` (catalog.jsonl/csv, index.sqlite, mapping-proposed.csv), `_TEXT/`
  (sidecars). Reserved prefixes are never indexed as content.
- **Dedup:** dedupe by content hash before staging (the manifest hashes / `find-dupes`); the catalog's
  `sha256` flags duplicates; keep one canonical copy.
- **Retention:** source documents are retained per entity/legal/tax requirements (multi-year);
  derived artifacts (sidecars/index) are regenerable. MNPI + privileged content is retained but
  access-restricted; PHI follows the BAA retention rules in its own ring.
- **Audit:** every retrieval/write through the gateway is logged with agent id + scope. Storage keys
  are SAS/short-lived where possible; account keys are ROTATE-BEFORE-LAUNCH.

## 11. Tooling reference (the standard toolchain)
- `doc-indexer` (skills/doc-indexer) - the engine: index / understand / push-search / cloud-search /
  search / status / build-csv / propose-mapping / cu-* . Profiles: finance, legal, generic (+ onboarding).
- `cfo-store` (skills/cfo-store) - stage to Azure/GCS (put/put-dir/get/list/rm); `--account` /
  `--key-secret` / `--container` target any domain store. SAS auth (special-char-safe).
- `cfo-onedrive` / `cfo-sharepoint` / `m365-mail` - capture from OneDrive / SharePoint / mailboxes.
- `setup/migrate-cfo-room.mjs` - the GCS->Azure migration pattern (resumable, SAS, concurrent).
- `skills/doc-indexer/job/` - the Container Apps Job (backfill + autonomous librarian) on `otchealth-jobs-env`.
- Azure: Content Understanding (`otchealth-foundry`, gpt-4.1-mini), AI Search (`otchealth-dataroom-search`),
  Document Intelligence (`otchealth-docintel`), embeddings (text-embedding-3-large).

## 12. Compliance summary (the standing walls)
- PHI/HIPAA (MedReview/Companion) - GCP BAA ring, excluded from the shared KB.
- Securities/Reg FD (INND) - MNPI ring, attorney + Matt gate, securities firewall.
- Privilege (CLO personal + sensitive company) - privileged ring, CLO-only, never co-mingled.
- COPPA (FourVault) - excluded from the shared KB, no analytics on kid surfaces.
- FDA/FTC claims - no treatment/clearance claims in any document copy that ships.
Surface-and-wait on all of the above; the standard never crosses a wall silently.

## 13. Every agent + department: what they produce, where it goes, who shares it
Every agent is both a PRODUCER and a CONSUMER of knowledge. The rule: **operational/process
knowledge (decisions, status, learnings, "how we did X") flows to the company COMMONS; domain
documents stay in the domain data room (ring-scoped); sensitive rings never reach the commons.**

| Department | Agents | Produces (knowledge + docs) | Lands in (store + durable state) | Shared WITH (consumers) | Ring |
|---|---|---|---|---|---|
| **Operations** | COO (CcOO) | daily briefings, priorities, task dispatch, cash number, accountability log | Notion Bucket Briefings + COO Tasks + `ops` room + commons | **everyone** (the nervous system) | non-PHI |
| **Infrastructure** | CTO + reviewers (security/schema/coppa) | runbooks, architecture, the gateway + KB, secret registry, build/release records | `otchealth-cto/runbooks` + `CLAUDE.md` + commons | all builders + execs | non-PHI |
| **Finance** | CFO, finance-ops | books, financials, cash scoreboard, source docs, the CFO Ledger | `otchealthcfodata` + Notion CFO Ledger + commons (non-sensitive) | COO, Rainmaker, Capital (gated) | non-PHI / MNPI-aware |
| **Legal** | CLO | matters, chronologies, discovery indexes, privilege logs, contracts, decision packets | `otchealthlegalstore` (company/personal) + `legal` matter store | **Matt + counsel only** (privileged); company-legal SUMMARIES to relevant execs | privileged / MNPI |
| **Capital / IR** | capital | raise docs (Reg D/A/CF), IR materials, cap table, investor CRM | `otchealthcapital` (MNPI) + the data room | **Matt + counsel only** (gated); NEVER the commons | **MNPI / securities** |
| **Commerce** | commerce, digital-products, lifecycle, switchboard, partnerships | listings, supplier contracts, order/customer data, campaigns, voice transcripts | `otchealthcommerce` + Shopify/Amazon + commons | Rainmaker, finance, growth | non-PHI |
| **Growth / Exposure** | growth-exposure, paid-ads, aso-growth, content-engine, growth-pr | marketing assets, PR, SEO/content, experiment results, ASO data | `otchealthgrowth` + PostHog + commons | commerce, product, lifecycle | non-PHI |
| **Product / Apps** | coach, architect, builder, qa, guardian, medic, release-captain, creative + per-app App Leads | specs, designs, QA results, store assets, app docs, LESSONS, release records | per-app `product` room + app repos (`CLAUDE.md`/`HANDOFF.md`) + commons | CTO (build/release), growth, creative, medic | non-PHI (FourVault COPPA carve-out) |
| **Compliance** | compliance-officer | regulatory findings, claim reviews, adverse-event logs, audit attestations | `otchealthcompliance` + commons (non-sensitive) | **everyone** (veto power) | non-PHI |
| **Cash orchestration** | Rainmaker, finance-ops | the cash.manifest scoreboard, daily cash truth, lever priorities | cash.manifest + commons | COO, all cash agents | non-PHI |
| **PHI / COPPA apps** | MedReview, FourVault agents | patient data / kids' data | their **own** BAA / COPPA rings | **NEVER the commons** | PHI-BAA / COPPA |

## 14. Where knowledge flows (the routing model)
Four destinations, chosen by what the knowledge IS:
1. **The company commons (shared KB)** -> non-sensitive operational + process + reference knowledge:
   decisions, "how we did X", status, learnings, reusable patterns, summaries. Every agent reads it
   via `cloud-search` / the MCP serving layer; every agent contributes via `kb_remember` + durable
   state. This is the default for anything that helps another agent and isn't ring-restricted.
2. **The domain data rooms** -> the actual documents, ring-scoped (section 4). An agent reads its own
   room directly; cross-domain access is by gateway scope (e.g., finance summaries to the COO).
3. **Durable state files** -> the human-readable system of record: `CLAUDE.md` (what doesn't change),
   `HANDOFF.md` (live state), `runbooks/` ledgers, `cto-bridge/`, Notion (Bucket Briefings, COO Tasks,
   CFO Ledger, the vault). Read first, updated last, every session.
4. **The seams (escalation + handoff)** -> structured cross-agent routing: App Lead -> CTO ("ready to
   build" + SHA); any product agent -> coach; cash agents -> Rainmaker; every department -> COO
   briefings; legal/securities/PHI -> Matt + counsel. The seams carry the ESCALATION; the commons +
   data rooms carry the KNOWLEDGE.

**Sharing guardrails (what must NOT flow to the commons):** PHI (MedReview/Companion), INND MNPI
(Capital/IR raise + cap table), legal `personal` (privileged), FourVault kids' data, and any secret.
These stay in their ring; only de-identified / non-material SUMMARIES cross, and only with the gate.

## 15. The continuous learning loop (how the company keeps learning, forever)
Five loops run perpetually so documents AND knowledge keep compounding with no human babysitting:

1. **The document loop (the librarian).** A scheduled Container Apps Job per data room re-runs
   `index -> understand -> push-search`, so every newly-arrived document is OCR'd, understood,
   classified, embedded, and indexed automatically. The KB never goes stale.
2. **The memory loop.** Agents write learnings via `kb_remember` to a per-agent namespace; a
   consolidation step dedupes + resolves conflicts (temporal: keep both old and new with timestamps)
   and PROMOTES curated learnings (human/coach-gated) to the company commons, which is re-indexed
   into the shared KB. Next agent that searches finds them. Per-agent capture first; automated
   promotion only after the write-filter is proven.
3. **The state loop.** Every session, every agent: (a) reads durable state first (CLAUDE.md / HANDOFF /
   runbooks / briefings), (b) acts, (c) updates durable state before stopping. This is enforced
   (Stop hooks, the "update before you stop" rule). Knowledge never lives only in a chat that vanishes.
4. **The briefing loop.** The COO's scheduled 7am scan reads every repo + the primary signals,
   files a Notion Bucket Briefing, and sets the day's priorities, so the whole fleet re-aligns daily;
   4-hourly heartbeats catch drift between briefings.
5. **The improvement loop.** Because every domain uses ONE engine + ONE standard, an improvement
   learned anywhere - a CU schema field, a classifier rule, a retrieval pattern, an eval that catches
   a failure - is committed once and propagates to ALL domains on the next pull. Standardization is
   the multiplier: the company learns once and applies everywhere.

**The cadence:** librarian (hourly/per-domain), COO briefing (daily 7am) + heartbeats (4-hourly),
memory consolidation (daily), state updates (every session). **The guarantee:** nothing learned is
lost - it lands in the commons, a data room, or a durable-state file, and is retrievable by every
agent on every platform. The flywheel: more documents understood -> richer KB -> smarter agents ->
better decisions + more learnings written back -> richer KB. It compounds.

---
**Reference implementations:** the CFO (finance, `otchealthcfodata/cfo-source-docs`) and CLO (legal,
`otchealthlegalstore/company`+`personal`) are live and proven end-to-end. Every other domain onboards
by copying their pattern via section 8, shares via sections 13-14, and keeps learning via section 15.
This document is the company's source of truth for documents and knowledge; keep it current as
domains come online.

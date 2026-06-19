---
name: legal
description: The CLO agent's operating backbone. A citation VERIFIER (confirms a case actually exists via CourtListener, the anti-hallucination safeguard before citing any authority) plus a segregated matter + docket store. Company matters live under company/, Matt's PERSONAL matters (the CA divorce + civil case) live under personal/ and are confidential, access-controlled, and never committed to git or shared into other agents. Use to verify legal citations, open + track legal matters, and run the deadline docket. Wielded by the CLO. Non-PHI ring; personal-matter contents are privileged + confidential.
---

# legal — the CLO's matter store, docket, and citation verifier

The operational tooling behind the Chief Legal Officer. Two jobs: keep matters + deadlines
organized, and never let a fabricated citation reach a document.

## Free research arsenal (no signup needed)
```
node skills/legal/legal.mjs cite "Sargon Enterprises v. USC"        # verify a citation EXISTS (anti-hallucination)
node skills/legal/legal.mjs caselaw "community property valuation" --court cal   # search 9M+ opinions
node skills/legal/legal.mjs edgar "reverse stock split" --form 8-K  # full-text search SEC filings (securities precedent)
```
- **cite** — CourtListener lookup; NO MATCH => UNVERIFIED, do not cite. Confirms existence,
  not the holding or whether it is still good law (verify those in primary authority).
- **caselaw** — CourtListener opinion search across 3,358 jurisdictions; real cases +
  parallel citations + links. `--court <id>` to scope (e.g. `cal`, `ca9`).
- **edgar** — SEC EDGAR full-text search (free, no key) over 20+ years of filings; pull
  precedent disclosure/risk-factor/agreement language + comparables. `--form <type>`.
Set `LEGAL_COURTLISTENER_TOKEN` (free CourtListener account) for higher case-law limits.
Deeper free sources (fetch directly): GovInfo (USC/CFR), Federal Register, Congress.gov,
California leginfo (Family Code/CCP/Evidence) + Judicial Council forms, Nevada NRS, N.D. Ga.
local rules, Cornell LII. Recommended free MCP connectors: CourtListener MCP
(mcp.courtlistener.com), SEC EDGAR MCP, Open Legal Compliance MCP. See CLO-BOOTSTRAP.md.

## Matters + docket (segregated company vs personal)
```
node skills/legal/legal.mjs matter new ainnova-deal --client "OTCHealth/INND" --jur "federal/NV" --type "M&A/securities"
node skills/legal/legal.mjs matter new ca-divorce --client "Matthew Moore" --jur "CA" --type "family/dissolution" --personal
node skills/legal/legal.mjs matters                 # company matters
node skills/legal/legal.mjs matters --personal      # confidential personal matters
node skills/legal/legal.mjs docket add ca-divorce 2026-07-15 "FL-142/FL-150 disclosure due" --personal
node skills/legal/legal.mjs docket due 30            # everything due/overdue in 30 days (all matters)
node skills/legal/legal.mjs note ainnova-deal "counsel reviewing disclosure timing"
```

## Storage + confidentiality (HARD)
- Store: **Azure Blob** (off Google), dedicated storage account `otchealthlegalstore` with
  two containers, `company` and `personal`, each holding `matters/<id>.json`. SharedKey auth
  via `AZURE_LEGAL_STORAGE_ACCOUNT` + `AZURE_LEGAL_STORAGE_KEY` (hydrated from Secret Manager
  `azure-legal-storage-account` / `azure-legal-storage-key`). The dedicated account keeps the
  legal record off the shared CFO storage and on the funded Azure lane.
- **Personal matters (divorce, civil) live in the SEPARATE `personal` container** and are
  confidential + privileged. They are never committed to git, never echoed into shared agent
  context, and never co-mingled with company records. Only the CLO (and Matt) should touch
  them. A separately-keyed personal account + at-rest encryption is the recommended harden.

## Guardrails
- Citation-verify before relying on any case; "unverified" beats a confident fake.
- Personal-matter confidentiality is absolute (privilege + Matt's private affairs).
- This skill organizes + verifies; it does not practice law. Licensed CA/NV counsel reviews
  + files anything bound for a court, agency, or counterparty.

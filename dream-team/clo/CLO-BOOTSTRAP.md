# CLO Bootstrap — read this FIRST on every CLO invocation (locked-and-loaded loadout)

This is the standing legal knowledge base for the Chief Legal Officer agent. Read it on
come-online, then run the `legal` skill (`legal matters`, `legal docket due`) to load the
live matter list + deadlines. Company/securities facts live here (internal, committed).
**Confidential personal-matter contents (divorce, civil) are NEVER committed here** — they
live only in the access-controlled legal store (`legal` skill, `personal/` namespace).

## The four clients + structure
- **OTCHealth Inc.** — **Nevada C-Corp.** Officers: Matt Moore (President, Co-Founder),
  Kim Moore (CEO, Founder, and CFO by title), Mark Moore (COO, Co-Founder), Dr. Marlee
  Grounds (CMO; OTCHealth-only role). Operating company / consumer + commerce.
- **InnerScope Hearing Technologies, Inc. (OTC: INND)** — the **public parent**, a Nevada
  corporation. **NOT a shell company** -> Rule 144(i) does not apply. Penny-stock issuer.
- **HearingAssist** — an **INND subsidiary** (the "largest hearing-aid supplier to Walmart"
  historically). Carries its own AP/billing/accounting trail.
- **Matthew Moore, personally** — a **California divorce / family-law** matter and a
  **California civil case**. Personal, privileged, walled off from all company systems.

Both companies are incorporated in **Nevada**; Matt's personal matters are in **California**;
and there is active **federal employment litigation in Georgia**. So the live jurisdictions
are: **federal securities**, **Nevada corporate (NRS)**, **California family + civil**, and
**federal court in Georgia (FLSA / Eleventh Circuit)**.

## Active litigation (track closely)
- **GA / FLSA (company defendant):** former employees suing for **back wages / overtime**
  under the **Fair Labor Standards Act of 1938** in the **U.S. District Court for the
  Northern District of Georgia, Gainesville Division**. Federal court: FRCP + FRE + N.D. Ga.
  Local Rules + Eleventh Circuit law (NOT California CCP). Likely a 216(b) opt-in collective.
  Exposure = back wages + equal liquidated damages + mandatory plaintiff attorney's fees; SOL
  2yr (3yr if willful). Pull the docket via CourtListener/RECAP; reconstruct payroll/time
  records (Mark's OneDrive payroll reports + the CFO). Issue/maintain the litigation hold.
- **CA civil (Matt, personal, confidential):** the California civil case.
- **CA divorce (Matt, personal, confidential):** dissolution + community-property division.

## Standing legal-relevant facts (verified; never contradict these)
- OTCHealth owns **zero patents** and holds **no 510(k)**. Never claim otherwise in any
  document, opinion, contract, or disclosure.
- iHEAR Matrix **HearAdvisor grade is B, not A**. **TReO is a PSAP, not a hearing aid.**
- **Impact Health USA is permanently disqualified** — never reference as a path/comparison.
- INND financials are **self-prepared (not audited)** — never imply audited statements.
- Matt's emails: company/product accounts use **matthew@otchealthmart.com**; legal-entity
  matters (C-Corp filings, banking, INND IR) use **matthew@innd.com**. Never use
  matthew@otchealth.com (unregistered/unrecoverable).
- No em or en dashes in any externally-facing legal copy.

## Securities posture (INND) — the firewall is absolute
- INND is a public penny-stock issuer; the **PSLRA forward-looking safe harbor is NOT
  available** -> rely on the **bespeaks-caution doctrine** (meaningful, company-specific
  cautionary language; boilerplate fails).
- **Reg FD** (no selective disclosure of MNPI), **Rule 10b-5**, **Section 16**, **Section
  17(b)** anti-touting. Exempt offerings (Reg D 506(c) with accredited verification, Reg
  A+, Reg CF) run through Capital/raise-ops, attorney + Matt gated.
- **Live transaction:** the **Ainnova Tech acquisition of OTCHealth** (announced
  2025-10-22). Post-deal, INND becomes an **equity + profit-participation holder** in both
  OTCHealth and Ainnova; the historical retail relationships (Walmart/CVS/Target/Walgreens
  + 15,000+ pharmacies) transition to OTCHealth. Disclosure timing + materiality are
  counsel-gated. Old "Walmart's largest hearing-aid supplier" framing is true historically
  but misleading as a present-tense claim — flag it on any IR/marketing review.
- **The securities firewall:** no share-price language, no stock promotion, no selective
  disclosure; every investor-facing or potentially-material item is attorney + Matt approved
  before release. The CLO prepares + redlines; counsel + Matt decide. INND/IR publishing is
  also gated to Capital + counsel + Matt.

## Document sources (where the legal record lives)
- **Mark Moore's OneDrive** (connected via `cfo-onedrive --user mark`): holds settlement +
  standstill/tolling agreements (e.g. Shennib, Naylor, Bender matters), INND shareholder-
  letter + PR drafts, payroll reports, and large historical archives. Primary source for
  prior agreements + litigation templates.
- **M365 mailboxes** (read via `m365-mail`, app-only, all 126 tenant-wide): legal
  correspondence. `matthew@innd.com` (legal-entity), `mark@innd.com`, `kim@innd.com`, plus
  `ap@innd.com` / `accounting@hearingassist.com` for contract/vendor + settlement threads.
- **Legal store** (the `legal` skill): the CLO's own matter files, dockets, drafts, exhibit
  indexes, and privilege logs. On **Azure Blob** (off Google), account `otchealthlegalstore`,
  with a `company` container (committable-adjacent) and a SEPARATE `personal` container (the
  confidential divorce + civil matters, access-controlled, never in git or shared context).

## Matter index (the live book — populate + maintain via `legal matters`)
Open a matter file per matter with: client, jurisdiction, type, adverse parties, status,
key deadlines, and the document set. Known/expected matters:
- **CORP/SEC:** Ainnova/OTCHealth transaction docs + disclosure; INND public-co reporting +
  Reg FD/Section 16 hygiene; OTCHealth + INND + HearingAssist corporate housekeeping
  (minutes, consents, NV annual lists, intercompany + related-party/due-to-officer
  agreements — coordinate with the CFO).
- **LITIGATION/CONTRACT:** the **GA FLSA back-wage collective** (N.D. Ga. Gainesville,
  company defendant) above; prior + active settlements (Shennib/Naylor/Bender per the
  document record); employment separations + releases; commercial contracts + redlines.
- **PERSONAL (confidential, `personal/` store only):** Matt's **CA divorce** (community-
  property division incl. his OTCHealth/INND interests; disclosure FL-140/142/150; support;
  custody if applicable) and the **CA civil case** (claims, SOL, discovery, motions). Hold
  these entirely separate from company systems + agents; surface the conflict that his
  company shares are marital-estate property while the companies are not parties.

## Free legal research arsenal (all free; this is your power)
You have, at no cost, a research stack rivaling paid platforms. Use it relentlessly and
verify every authority.

### Wired into the `legal` skill now (no signup needed)
- **`legal cite "<case>"`** — verify a citation EXISTS before citing it (CourtListener;
  anti-hallucination guardrail). NO MATCH = do not cite.
- **`legal caselaw "<query>" [--court <id>]`** — search 9M+ opinions across 3,358
  jurisdictions (CourtListener). Returns real cases + parallel citations + links.
- **`legal edgar "<query>" [--form 10-K]`** — full-text search 20+ years of SEC filings
  (free, no key). The securities superpower: pull precedent disclosure/risk-factor/
  agreement language and comparables from real public filings.

### Free primary-source databases (fetch directly with WebFetch)
- **CourtListener / Free Law Project** (free.law) — case law, **PACER/RECAP dockets** (read
  the GA FLSA docket here for free), judges, oral arguments, the **Citation Lookup +
  Verification API** (Eyecite) and **Citation Network API** (tables of authorities + citing
  references = a free approximation of "still good law"). A FREE API token raises limits.
- **Caselaw Access Project** (case.law, Harvard) — all official US case law through 2020, open.
- **SEC EDGAR** (sec.gov / data.sec.gov) — all filings, full-text search, company facts/XBRL.
  Free, no key, 10 req/s, just a User-Agent.
- **GovInfo API** (api.govinfo.gov) — official **United States Code**, **CFR/eCFR**, bills,
  Federal Register. Free api.data.gov key.
- **Federal Register API** (federalregister.gov/developers) — rules + proposed rules, free, no key.
- **Congress.gov API** (api.congress.gov) — bills + status, free key.
- **California**: **leginfo.legislature.ca.gov** (Family Code, CCP, Evidence Code — fetch by
  section); **courts.ca.gov/rules-forms** + **selfhelp.courts.ca.gov** (free Judicial Council
  **FL-series** + civil forms, fillable PDFs); the California Rules of Court.
- **Nevada**: **leg.state.nv.us** (Nevada Revised Statutes — NRS 78 corporate, etc.).
- **Georgia/federal**: **N.D. Ga. Local Rules** + the assigned judge's standing order
  (ndga.uscourts.gov); the FLSA + DOL Wage-and-Hour guidance (dol.gov/agencies/whd); the
  docket via CourtListener/RECAP + PACER.
- **Cornell LII** (law.cornell.edu) — USC, CFR, UCC, state codes, Wex dictionary.

### Recommended MCP connectors (free; the biggest power-up, ask Matt to connect)
Connecting these gives the agent native legal tools, like the fleet's other MCPs:
- **CourtListener MCP** (hosted at `mcp.courtlistener.com`) — 10 tools over 9M+ opinions,
  dockets, judges, citation networks, oral arguments, semantic search. The single best add.
- **SEC EDGAR MCP** (github stefanoamorelli/sec-edgar-mcp) — filings + financials + insider
  trades with exact precision.
- **Open Legal Compliance MCP** (github TCoder920x/open-legal-compliance-mcp) — one server
  over GovInfo (USC/CFR) + CourtListener + SEC EDGAR + Congress.gov + 50-state legislation.

### Free API tokens to obtain (free signups; then store in Secret Manager)
- **CourtListener token** (courtlistener.com, free account) -> `legal-courtlistener-token`
  (the skill + MCP use it for higher limits + the Eyecite citation-lookup endpoint).
- **GovInfo / api.data.gov key** (free) -> `govinfo-api-key` (USC/CFR fetch).
SEC EDGAR, Federal Register, leginfo, and NRS need NO key.

## On come-online (the startup ritual)
1. Read this bootstrap fully.
2. `node skills/legal/legal.mjs matters` (load the matter list) and `legal docket due`
   (what is due/overdue) to load the live state.
3. For the active matter, pull its file + chronology + document set; confirm jurisdiction +
   the SOL/deadlines first.
4. Reconfirm the hard lines (not a licensed attorney; verify every citation; privilege;
   company-vs-personal separation; securities firewall) before drafting or advising.
5. Work the method: issue-spot -> facts -> authority -> CRAC -> adversarial test -> options
   -> route the decision to licensed counsel + Matt.

Keep this bootstrap + the matter index current as matters and the law develop.

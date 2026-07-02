# Accounting-Team Grounding Brief (PUBLIC, MNPI-safe)

> For the Sonnet subagents authoring the super-agent personas. Everything below is PUBLIC (filed on SEC EDGAR, CIK 0001609139) and safe for the public octools repo. Do NOT add any post-2020 (FY2021+) figures — those are MNPI and live only in the cfo-ring Azure data room.

## Mission of the team
Rebuild the InnerScope (INND) + HearingAssist (HA) + OTCHealth books in Xero, PER TRANSACTION, FY2021 -> present, anchored to the last completed audit (12/31/2020, PKC), with every source document ATTACHED inside Xero, so the company can hand the Xero keys to a future PCAOB auditor at minimal cost and re-enter SEC reporting after a capital raise. Cost-neutral: parallel Sonnet workers, CFO conductor. Portable to Claude Code (these personas live in the octools repo + are served via the gateway agent_persona tool).

## Audit history (EDGAR-confirmed, public)
- D. Brooks and Associates CPA's, P.A. (Palm Beach Gardens, FL) — auditor SINCE 2015; audited FY2016, FY2017, FY2018 (10-Ks filed 2017/2018/2019). Audit fee ~$28,606/yr. Going-concern substantial doubt every year.
- Paris, Kreit & Chiu CPA LLP (PKC) (New York) — auditor SINCE 2021; audited FY2019 + FY2020 (FY2020 10-K filed 2022-09-14). Going-concern substantial doubt. Net loss $4,953,692 (FY2020) / $7,924,339 (FY2019).
- No 10-K ever filed for standalone FY2019, FY2021, or FY2022. The PKC/Fruci "2021-2022 audit" was started (PBC list Mar 2023) but never completed/filed -> ABANDONED as authority, USED only as guidance.

## What the prior auditors actually examined (the risk map to train on)
1. GOING CONCERN — substantial-doubt opinion every year (operating losses, negative cash flow, working-capital deficit). ASC 205-40.
2. DERIVATIVES / CONVERTIBLE NOTES — the dominant technical area. Recurring "derivative expense" (FY2020 $2,289,869; FY2019 $3,602,512) including amortization of debt discounts; debt extinguishment (FY2018 $530,468). Convertible notes with embedded conversion features -> ASC 815-15/815-40, ASC 470, ASC 820 fair value.
3. ACQUISITIONS / GOODWILL / INTANGIBLES — iHear Medical (400,000 preferred Series C + $1,000,000 convertible note; assumed inventory/equipment/customer database), HearingAssist (400,000+ customer base), Amos Audiology (Sep 10, 2018), Intela-Hear (commonly-owned), MFHC stores. Intangibles: customer list, non-compete, Technology Access Fee. ASC 805/350/360.
4. EQUITY / CAP TABLE — preferred Series C issuance, convertible-note conversions to common, related-party share exchanges. ASC 505/260.
5. RELATED PARTY — Moore Holdings LLC, Intela-Hear (commonly owned), Amos Audiology, prior MFHC store transactions, officer/intercompany. ASC 850.
6. LEASES — ASC 842 adopted; FY2020 ROU asset $434,504 operating lease.
7. REVENUE — ASC 606 adopted 1/1/2018, "no significant impact" per filings. DTC hearing-device + PSAP sales.
8. No Critical Audit Matters section (smaller reporting company; standard audit report).

## Standing rules every persona must encode
- Ground every FIGURE via the cfo-gateway lane (kb_search_privileged finance-cfo-source-docs / finance-otchealth-cfo-source-docs). Public audit history may be cited; post-2020 INND specifics are MNPI.
- NEVER expose MNPI/securities outside the cfo ring (Reg FD). PHI/MedReview out of scope.
- All financial WRITES (Xero posting that moves real books toward filing, money movement) are reviewed; money movement + any external/IR release gated to Matt.
- Segregation of duties: assurance roles (EXAM/QC) NEVER post entries.
- In-Xero audit-trail standard: every transaction carries its source doc as a Xero attachment + WP-<cycle>-<n> index + a one-line memo naming the treatment/standard; per-account lead schedules pre-build the tie-out; bank lines cleared to attached statements; mirror to the Financial Azure Blob data room.

## Persona file format (what each subagent writes, one .md per role)
Front-matter style header then sections:
- `# <HANDLE> — <Full Role Name>`
- **Identity & reports-to** (under CFO; conductor model)
- **Mission** (1-2 sentences)
- **Standards mastery** (deep, cite ASC/AU-C/SEC by number)
- **INND-specific focus** (grounded in the risk map above — what THIS company's books demand)
- **Operating procedure** (step-by-step how it does the work in Xero, incl. the in-Xero attachment standard)
- **Inputs / Outputs** (what it consumes, what it produces)
- **Segregation & gates** (what it must NOT do; where it hands to a human)
- **Cross-engine note** (portable: ground via cfo-gateway; no MNPI in public artifacts)
Aim 600-900 words per role. Be the smartest, most specific version possible.

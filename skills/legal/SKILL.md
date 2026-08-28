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
node skills/legal/legal.mjs docket due 30 --json     # same, machine-readable (includes source/verified)
node skills/legal/legal.mjs docket verify ca-divorce 2026-07-15 "FL-142" --personal   # confirm a staged candidate
node skills/legal/legal.mjs note ainnova-deal "counsel reviewing disclosure timing"
```

### Docket row provenance: source + verified
Every docket row carries `source` (`manual` | `courtlistener` | `extracted`) and `verified`
(bool). A row a human docketed directly (`docket add` with no flags) is `manual`/`verified:true`,
exactly the original behavior; rows written before this field existed are treated the same way
at read time (no migration touches old data). Rows staged by the two tools below land
`verified:false` -- a CANDIDATE, not yet an actionable deadline -- until a human confirms them
with `docket verify` (or, for an extracted candidate, `deadline-extract.mjs confirm`).
`docket due` flags any unverified row inline (`[UNVERIFIED, courtlistener]`) so a CLO scanning
the list never mistakes a candidate for a confirmed deadline.

## Proposing deadlines from a document (never auto-committed)
```
node skills/legal/deadline-extract.mjs extract --file _TEXT/some-filing.txt --matter ainnova-deal
node skills/legal/deadline-extract.mjs extract --text "Respond no later than July 15, 2026." --json
cat _TEXT/some-filing.txt | node skills/legal/deadline-extract.mjs extract --matter ainnova-deal --label-llm
node skills/legal/deadline-extract.mjs confirm ainnova-deal --date 2026-07-15 --what "Response to motion due"
```
`extract` runs a deterministic (regex + real calendar-date validation) scan over a document's
TEXT -- produce that text first via doc-indexer's `_TEXT/<path>.txt` sidecar (`--profile legal`),
which already does the OCR/PDF-extraction work; this tool takes text in, never a raw PDF. It only
PRINTS candidates (`source:'extracted'`, `verified:false`); it never writes to a matter. Optional
`--label-llm` rewrites a candidate's context into a short label via gpt-4o (never gpt-4.1-mini,
banned for quality work) and fails open if unavailable. `confirm` is the human decision that adds
ONE reviewed candidate to the docket (via legal.mjs's shared `docketAdd`, `verified:true`).

## Watching a CourtListener docket for new entries
```
node skills/legal/courtlistener-watch.mjs poll ainnova-deal --docket 12345          # first poll, saves the docket id
node skills/legal/courtlistener-watch.mjs poll ainnova-deal                         # reuses the saved docket id + last_checked
node skills/legal/courtlistener-watch.mjs poll ainnova-deal --dry-run --json        # preview, writes nothing
```
Polls the CourtListener docket-entries API for anything filed since the matter's `last_checked`
and stages new entries into the docket as `source:'courtlistener', verified:false`
(confirm-before-page: real court activity, but not treated as an actionable deadline until a
human confirms it with `docket verify`). Free without a token; set `LEGAL_COURTLISTENER_TOKEN`
for reliable production polling (rate limits + PACER-backed dockets).

## Storage + confidentiality (HARD)
- Store: **AWS S3** (2026-08-28 port; Azure Blob is dead -- Azure subscription 55c84f6b was
  permanently deleted 2026-08-13). The mirror account NAME `otchealthlegalstore` (still read from
  `AZURE_LEGAL_STORAGE_ACCOUNT`, no longer a credential -- just the historical lookup-key name kept
  for continuity with the gateway's own S3 port) with two containers, `company` and `personal`,
  each holding `matters/<id>.json`, is routed through `skills/kb-memory/s3-blob.mjs`'s MIRROR
  table -- the SAME (account, container) -> (bucket, keyPrefix) allow-list
  `otchealth-mcp-server`'s `src/legal/s3-blob-store.ts` uses in production, so this toolkit and the
  gateway read/write the EXACT SAME physical S3 objects, never a parallel copy. `company` lands in
  the shared bucket `otchealth-finance-legal-dr-55c84f6b`; company reads/writes use the standard
  toolkit AWS credential chain (ECS task role / `AWS_*`/`OTC_AWS_*` env).
- **Personal matters (divorce, civil) live in the SEPARATE `personal` container**, which resolves
  to its OWN dedicated bucket `otchealth-legal-personal-dr-55c84f6b` and is confidential +
  privileged. They are never committed to git, never echoed into shared agent context, and never
  co-mingled with company records. Only the CLO (and Matt) should touch them.
- **PERSONAL WRITES ARE CURRENTLY IAM-GATED READ-ONLY, and that is intentional, not a bug.** The
  live IAM grant on the personal-legal DR bucket is GetObject+ListBucket ONLY for every
  toolkit/job identity ("PersonalLegalRingReadOnly"), pending an explicit Matt approval to widen
  it. A `--personal` write (`matter new`, `docket add`, `note`) therefore reaches AWS for real and
  gets a genuine 403 AccessDenied, which propagates uncaught out of `putBlob`/`putMatter` -- every
  CLI command's existing try/catch already prints the error and exits non-zero, so this is never a
  silent no-op. Reads (`matter show`, `matters --personal`, `docket due`) work normally. The
  sibling `legal-deadline-pager` skill's own personal cooldown store hits the identical gate and
  surfaces it with a distinct named message (`PERSONAL_WRITE_IAM_GATE_MESSAGE` in that skill's
  `personal-store.mjs`) -- see that skill's SKILL.md for the full read/write asymmetry writeup.

## Guardrails
- Citation-verify before relying on any case; "unverified" beats a confident fake.
- Personal-matter confidentiality is absolute (privilege + Matt's private affairs).
- This skill organizes + verifies; it does not practice law. Licensed CA/NV counsel reviews
  + files anything bound for a court, agency, or counterparty.

---
name: doc-indexer
description: Fleet document data-room engine - READ + CATALOG + INDEX + RETRIEVE a whole document store, for any agent. Resumable, idempotent, profile-driven. For every object it extracts text (free PDF text-layer; Azure Document Intelligence OCR for scans/images/tables; LibreOffice for office docs incl. legacy .doc/.xls/.ppt; tesseract fallback), persists a _TEXT/ sidecar so content is permanently readable + greppable, classifies by the profile taxonomy (entity + category + materiality), writes a catalog (JSONL + CSV), and builds a node:sqlite FTS5 full-text index with a `search` command. Profiles - finance (CFO audit room on otchealthcfodata / the GCS bucket), legal (CLO legal store on otchealthlegalstore, company + personal containers), generic (any store). Output co-locates inside the indexed store/container, inheriting its access control. Wielded by the CFO, the CLO, and any agent with a document store. Non-PHI ring; INND content is MNPI; the legal personal container is privileged/confidential.
---

# doc-indexer — read, catalog, index, and retrieve a document store (fleet)

Turns any organically-grown document store into an audit-ready, catalogued, searchable, properly
filed archive. One engine, profile-driven, so the CFO uses it on the financial audit room and the
CLO uses it on the legal files. Built to the CTO architecture call (2026-06-19): best-free reading,
flat catalog + SQLite FTS retrieval, reorg applied during a single storage cutover.

## Pipeline (per object, resumable)
1. download -> sha256 (dedup key)
2. **read/extract text** (best-free-plus-credit stack):
   - PDF: `pdftotext -layout` (free); a quality gate routes scanned/image-only PDFs to OCR.
   - scans + png/jpg/tiff: **Azure Document Intelligence** (`prebuilt-read`, or `prebuilt-layout`
     for tables) -> **tesseract** offline fallback.
   - office (docx/xlsx/pptx + legacy doc/xls/ppt/rtf/odt): **LibreOffice headless** -> pdftotext.
   - csv/txt/md/json/html/eml: direct.
3. **persist `_TEXT/<path>.txt` sidecar** -> content is permanently readable + greppable (`rg`),
   re-indexable without re-OCR. (Disable with `--no-text`.)
4. **classify** by the profile taxonomy: entity/matter + category + materiality. Unmatched ->
   `_INBOX-UNCLASSIFIED`; off-topic -> `_NON-ACCOUNTING`.
5. append a catalog row to `_CATALOG/catalog.jsonl` and insert into the FTS5 index.

## Two retrieval layers
- **Free portable core (always built):** `_TEXT/` sidecars + `node:sqlite` FTS5 index -> the `search`
  command (keyword/phrase), plus `rg` over sidecars. Zero infra, offline, lives in the room.
- **Azure AI Search brain (the managed upgrade, 2026-06-19 decision):** `push-search` ships the corpus
  (metadata + content + embeddings) into an Azure AI Search index with **hybrid keyword + vector +
  semantic** ranking; `cloud-search` queries it. Agents get meaning-based retrieval via one API; a
  query-time Azure OpenAI vectorizer means callers just pass text. People browse the reorg'd taxonomy
  on **OneDrive** (`cfo-onedrive`) + `catalog.csv`.

## Commands
```
node skills/doc-indexer/indexer.mjs index   --profile <p> [--azure|--gcs] [--prefix x] [--limit n] [--reindex] \
                                            [--ocr-model prebuilt-read|prebuilt-layout] [--no-ocr] [--no-text]
node skills/doc-indexer/indexer.mjs search "<query>" --profile <p> [--azure|--gcs] [--limit n]   # free FTS5 (offline)
node skills/doc-indexer/indexer.mjs status        --profile <p> [--azure|--gcs]   # cataloged vs total + breakdowns
node skills/doc-indexer/indexer.mjs build-index   --profile <p> [--azure|--gcs]   # rebuild index.sqlite from sidecars
node skills/doc-indexer/indexer.mjs build-csv     --profile <p> [--azure|--gcs]   # _CATALOG/catalog.csv
node skills/doc-indexer/indexer.mjs propose-mapping --profile <p> [--azure|--gcs] # old->taxonomy mapping CSV
# Azure AI Search brain (needs azure-search-endpoint/-admin-key + an Azure OpenAI embedding deployment)
node skills/doc-indexer/indexer.mjs search-init   --profile <p> [--azure|--gcs] [--index name]   # create the index
node skills/doc-indexer/indexer.mjs push-search   --profile <p> [--azure|--gcs] [--index name]   # embed + push corpus
node skills/doc-indexer/indexer.mjs cloud-search "<query>" --profile <p> [--azure|--gcs] [--limit n]  # hybrid+semantic
```

## Profiles (storage + taxonomy)
- **finance** (CFO): Azure `otchealthcfodata`/`cfo-source-docs` (key `azure-cfo-storage-key`) or the
  GCS bucket `otchealth-cfo-source-docs`. Audit taxonomy 00-15 + entity (INND/HearingAssist/iHEAR/
  OTCHealth/Personal/QBO-Mixed).
- **legal** (CLO): Azure `otchealthlegalstore`, container `company` (default) or `personal` (the
  confidential divorce + civil matters), key `azure-legal-storage-key`. Legal taxonomy (pleadings,
  motions, discovery, orders, family-law disclosures, contracts, evidence, filings, research,
  corporate governance, securities, IP, correspondence).
- **generic**: any store; pass `--azure-account` / `--container` / `--bucket` / `--key-secret`.
  No taxonomy (everything -> `_INBOX-UNCLASSIFIED`) until rules are added for that profile.

### Per-agent usage
```
# CFO financial audit room (GCS now; flip --gcs->--azure after migration)
node skills/doc-indexer/indexer.mjs index  --profile finance --gcs
node skills/doc-indexer/indexer.mjs search "convertible note 8%" --profile finance --gcs

# CLO legal files (company container)
node skills/doc-indexer/indexer.mjs index  --profile legal --azure --container company
node skills/doc-indexer/indexer.mjs search "motion to compel" --profile legal --azure --container company
# CLO confidential personal matters (divorce + civil) -- artifacts stay IN the personal container
node skills/doc-indexer/indexer.mjs index  --profile legal --azure --container personal
```

## How the output is handled (co-location)
All artifacts are written INSIDE the same store/container being indexed:
- `_CATALOG/catalog.jsonl` (the record + resume checkpoint), `_CATALOG/catalog.csv` (humans),
  `_CATALOG/index.sqlite` (the FTS5 search index), `_CATALOG/mapping-proposed.csv` (the reorg plan),
- `_TEXT/<path>.txt` (the extracted text of every doc).

This means the access control of the source store automatically extends to its catalog/index/text.
The legal `personal` container's catalog + index + sidecars stay in `personal`, confidential and
segregated, never co-mingled with `company` or shared to other agents. Retrieval is per-store: each
agent runs `search` against its own profile/container.

## Catalog row (JSONL) + retrieval
`{ path, backend, ext, size, sha256, mtime, entity, category, material, text_chars, ocr, engine, title, desc, sidecar, ts, err }`
- Agents: `search "<terms>"` (FTS5: `"phrases"`, `prefix*`, AND/OR/NOT) -> ranked path + snippet.
- Analysts: query `catalog.jsonl` with DuckDB, or open `catalog.csv` in a spreadsheet.
- Direct read: open / `rg` the `_TEXT/` sidecars.

## Reorg = mapping manifest, applied during migration
`propose-mapping` writes `_CATALOG/mapping-proposed.csv` (`old_path,new_path,entity,category,material`).
The owning agent reviews/edits it; the CTO executes the move+rename as part of a single storage
cutover (object stores have no "move"; one read+write at the new path avoids moving everything twice).
The rule classifier is a FIRST PASS; the owning agent refines categories before the move.

## Credentials (env, else self-resolved from Secret Manager via the claude-driver SA)
- `GCP_CLAUDE_DRIVER_SA_JSON` (always; GCS access + resolving keys from SM)
- finance: `azure-cfo-storage-account`/`-key`, `cfo-source-bucket`
- legal: `azure-legal-storage-account`/`azure-legal-storage-key`
- OCR: `azure-docintel-endpoint` / `azure-docintel-key` (otchealth-docintel, eastus). ROTATE-BEFORE-LAUNCH.

## Guardrails
- **Non-PHI ring only.** Never point at a MedReview/PHI source. PHI-scan non-accounting media before
  ingest; drop anything that surfaces PHI.
- **INND = MNPI**; stores + catalogs stay private (never public). The legal **personal** container is
  **privileged + confidential** - never co-mingle with company, never expose to other agents.
- Cost: text-layer + LibreOffice are free; OCR is reserved for the image tier (`prebuilt-read`
  ~$1.50/1k pages). Use `prebuilt-layout` (~$10/1k) only where tables matter.
- The full bulk pass is best run headless (survives session reclaim; avoids the in-session
  bulk-download classifier gate).

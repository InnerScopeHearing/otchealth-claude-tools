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

## Understanding tier: Azure Content Understanding (CU)
The model-grade understanding engine (2026-06-19 decision). Per doc, in ONE call, CU returns clean
Markdown plus structured fields - classify into the profile taxonomy, document type, summary, date,
counterparty, amount, materiality - using a Foundry model deployment (gpt-4.1-mini default). It
replaces the regex first-pass with real understanding and overwrites the `_TEXT/` sidecar with CU
Markdown (so AI Search + FTS index the high-quality text). Runs on the Foundry resource
(`azure-foundry-endpoint` / `azure-foundry-key`).
```
node skills/doc-indexer/indexer.mjs cu-defaults  --profile <p>                 # point CU at the model deployments (one-time)
node skills/doc-indexer/indexer.mjs cu-init      --profile <p>                 # create the custom audit analyzer
node skills/doc-indexer/indexer.mjs cu-calibrate --profile <p> [--limit 200]   # real cost on a sample -> projects full-corpus $
node skills/doc-indexer/indexer.mjs understand   --profile <p> [--azure|--gcs] [--limit n] [--reindex]  # full CU pass, resumable
```
Recommended flow: `index --no-ocr` (fast free inventory) -> `cu-calibrate` (know the bill) ->
`understand` (full CU pass) -> `push-search` (into Azure AI Search). CU bills per page; gpt-4.1-mini
is ~80% cheaper than gpt-4.1. `cu-calibrate` reads CU's `usage` object for the real number.

## Two retrieval layers
- **Free portable core (always built):** `_TEXT/` sidecars + `node:sqlite` FTS5 index -> the `search`
  command (keyword/phrase), plus `rg` over sidecars. Zero infra, offline, lives in the room.
- **Amazon OpenSearch brain (DEFAULT since 2026-08-27; Azure AI Search died with subscription
  55c84f6b):** `push-search` ships the corpus (metadata + content + embeddings) into the
  `otchealth-brain` OpenSearch domain with **BM25 keyword + k-NN vector** hybrid ranking (client-side
  RRF merge, OpenSearch has no built-in semantic reranker); `cloud-search` queries it. Room/index names
  are identical to the old Azure ones (`${profile}-${container}`). A room already CHUNKED (fed by
  `enrich.mjs`'s OpenSearch write path or the migration bulk loader -- the 5 main knowledge rooms) is
  detected automatically and `push-search` skips it cleanly rather than attempting an invalid flat
  write. `--search-backend azure` remains selectable for a genuinely still-Azure room and fails loud
  (never silently) when unconfigured. `--embeddings-provider openai|foundry` (default openai) is an
  independent axis. People browse the reorg'd taxonomy on **OneDrive** (`cfo-onedrive`) + `catalog.csv`.

## enrich.mjs metadata enrichment: LLM providers, and the Bedrock BATCH lane

`enrich.mjs` (the S1/OpenSearch metadata-enrichment pass -- `ensure-schema`/`run`/`reindex-room`/
`verify`, see that file's own header for the full pipeline) calls an LLM once per new/changed
document. `--llm-provider openai|azure|bedrock` selects the provider (default `openai`); the
`bedrock` lane is the chosen processor for the two PRIVILEGED rooms this pipeline reaches
(`finance-cfo-source-docs`, `legal-company`) because it runs inside this fleet's own AWS account --
see `PILOT-bedrock-enrich.md` for the full rationale and the bounded interactive pilot to run before
trusting a real backfill.

### The Bedrock BATCH lane (`--bedrock-batch`, 2026-09-03)

Bedrock's **batch inference** is the same model family at roughly **half the on-demand price**
(verified live 2026-09-03 against AWS's own current documentation), the right shape for a large,
latency-tolerant backfill (finance ~36,454 docs, legal-company ~9,873). It is a genuinely different
mechanism from the interactive per-call lane -- a control-plane job that reads/writes a caller-
staged S3 location, not a per-document HTTP round trip -- and from OpenAI's own batch API (a hosted-
file upload/poll cycle), so it has its own flag, its own client (`bedrock-batch-client.mjs`), and
its own section here.

**The flag.** `--bedrock-batch` (also `ENRICH_BEDROCK_BATCH=1` / `BEDROCK_BATCH=1`), only meaningful
together with `--llm-provider bedrock` and the `run` command. Off by default; nothing in this
codebase enables it on a schedule. `--dry-run` alongside it shows what would be submitted (row
count, JSONL size, an estimated cost) and makes **zero** network calls -- no S3 upload, no
`CreateModelInvocationJob`, and it needs neither the staging bucket nor the IAM role configured.
Without `--dry-run`, it uploads one JSONL file, submits one Bedrock batch job, polls it, and applies
the result back onto the catalog exactly like the interactive lane's own `_callFailed`/
`_parseFailed`/enriched-marker contract (see `enrich-llm.mjs`'s `parseBedrockBatchModelOutput` --
no downstream code, including the review queue or the run's final summary line, has a
batch-specific branch).

**Why prompt-based JSON, not forced tool-use.** Verified live against
<https://docs.aws.amazon.com/bedrock/latest/userguide/batch-inference.html> (fetched 2026-09-03):
*"Batch inference does not support tool calling (function calling) or structured output
(`response_format`). Each record in the input JSONL file is processed independently without
multi-turn interaction, so features that require back-and-forth exchanges between the model and
client are not available."* This holds even after Bedrock's 2026-02 Converse-format support for
batch input (which this lane uses -- `modelInvocationType: "Converse"`, verified against
<https://docs.aws.amazon.com/bedrock/latest/userguide/batch-inference-data.html>'s own worked
Converse example): that update added a request/response SHAPE, not tool support. So the batch
prompt asks for a single JSON object directly -- exactly `enrichSystemPrompt()`'s existing "Output
ONLY a JSON object, no prose" instruction, already used by the openai/azure lanes' own
`response_format: json_object` -- and the reply (an ordinary Converse text content block) is parsed
by the SAME `extractJsonObject()`/`J()` salvage parser every provider already shares. No new parsing
strategy exists for batch.

**Required configuration** (env, or the equivalent fleet secret -- resolved ONLY when actually
submitting a NEW job, never on a pure resume-and-poll run):
- `ENRICH_BEDROCK_BATCH_BUCKET` / secret `bedrock-batch-s3-bucket` -- an S3 bucket the CALLER
  controls (never a document room's own bucket) that Bedrock reads the input JSONL from and writes
  output to.
- `ENRICH_BEDROCK_BATCH_ROLE_ARN` / secret `bedrock-batch-role-arn` -- the IAM role Bedrock itself
  assumes to run the job. Trust policy: principal `bedrock.amazonaws.com`, `sts:AssumeRole`,
  conditioned on `aws:SourceAccount` + `aws:SourceArn` scoped to
  `arn:aws:bedrock:<region>:<account>:model-invocation-job/*` (verbatim template at
  <https://docs.aws.amazon.com/bedrock/latest/userguide/batch-iam-sr.html>). Permissions: `s3:GetObject`/
  `s3:PutObject`/`s3:ListBucket` on the staging bucket, plus `bedrock:InvokeModel` on the chosen
  model/inference-profile ARN (the SAME `us.` cross-region profile the interactive lane already
  uses, e.g. `us.anthropic.claude-haiku-4-5-20251001-v1:0` -- Bedrock's batch support table lists it
  as cross-region-profile-only, not single-region, so the profile ARN is required, not optional).
  Neither of these is provisioned by this PR; provisioning them is a separate, deliberate step (see
  "Before a real backfill" below).
- Optional: `ENRICH_BEDROCK_BATCH_PREFIX` (default `doc-indexer-enrich-batches/`),
  `ENRICH_BEDROCK_BATCH_TIMEOUT_HOURS` (default 24, clamped to AWS's documented [24,168]),
  `ENRICH_BEDROCK_BATCH_POLL_MS` (default 60000), `ENRICH_BEDROCK_BATCH_MAX_WAIT_MS` (default: the
  timeout plus a 2h buffer -- this process's OWN patience before it gives up polling, distinct from
  the job's server-side timeout), `ENRICH_BEDROCK_BATCH_MAX_RECORDS` (default 2000 -- a safety cap,
  independent of `--limit`, so a bare `--bedrock-batch` cannot accidentally submit an entire
  privileged room in one irreversible, billed, hours-long job).

**There is also a real per-job MINIMUM record count.** Live-verified 2026-09-03: a genuine 2-record
submission was accepted by `CreateModelInvocationJob` and then ended `Failed` with "contains less
records (2) than the required minimum of: 100". AWS's docs do not publish a fixed number for this
(only "check your service quota"), so 100 is this account/model/region's OBSERVED value on that
date, not a guaranteed universal constant -- `enrich.mjs` warns (never hard-blocks) below it rather
than hard-coding an unverified-as-universal minimum. Size any real submission's `--limit` well above
it (`PILOT-bedrock-enrich.md`'s batch section uses 150+).

**The cost model.** `estBedrockBatchCostFor()`/`bedrockBatchDiscount()` in `enrich-llm.mjs` apply a
50% discount (env-overridable via `ENRICH_BEDROCK_BATCH_DISCOUNT`) ON TOP of the existing
`ENRICH_BEDROCK_RATE_IN`/`_OUT` on-demand rate pair -- never a second, independent rate table, so a
rate override is automatically reflected in both estimates. `--dry-run`'s printed estimate is a
DELIBERATE UPPER BOUND, not a quote: input tokens are approximated from the built request bodies'
character count (~4 chars/token, not a real tokenizer) and output tokens are assumed at the full
1200-token cap for every single record, which real usage is normally well under. After a real run,
the printed summary line's `tokens_in=.../tokens_out=...` are the REAL counts from AWS's own
`manifest.json.out` and per-line `usage` fields, checkable against the Bedrock billing console
directly, exactly like the interactive lane's own honesty line.

**Resuming an interrupted batch.** A Bedrock batch job runs entirely server-side once submitted --
it is not tied to this process's connection. The moment `CreateModelInvocationJob` returns a jobArn
(BEFORE any polling starts), its id and the exact set of catalog paths submitted are persisted to
`_CATALOG/.enrich-bedrock-batch.json` in the room's own storage (the same `getBuf`/`putBuf`/`delBuf`
primitives `_CATALOG/.enrich.lock` already uses, and already excluded from enrichment by
`isPipelineInternal`'s `_CATALOG/` prefix). If this process is killed, crashes, or is simply
rerun -- mid-poll or any time later -- the NEXT invocation of the identical command
(`node enrich.mjs run --profile <p> --llm-provider bedrock --bedrock-batch`) finds that marker and
RE-ATTACHES to the existing job instead of submitting a duplicate: it never re-uploads the input,
never calls `CreateModelInvocationJob` again, and simply resumes polling the same job id. The marker
is deleted only once every row it named has been reconciled one way or another (a real result, a
per-line error, or missing from the output -- see the reconciliation contract below); a Failed/
Stopped/Expired job's marker is deliberately LEFT IN PLACE as diagnosable evidence -- delete
`_CATALOG/.enrich-bedrock-batch.json` by hand once that failure has been investigated, or the next
run will hit the same terminal-failure error again. The one case that is never silently resumed is
THIS PROCESS's own patience running out while the job is still non-terminal
(`ENRICH_BEDROCK_BATCH_MAX_WAIT_MS`): that throws (an explicitly ambiguous outcome, not treated as
success or failure) and leaves the marker in place for the same reason.

**Reconciliation never marks a missing or errored row enriched.** A Bedrock batch job can end
`PartiallyCompleted` ("not all of your records could be processed in time" -- a real, terminal,
non-failure AWS status, not a bug) or, more rarely, simply omit a recordId from its own output. Every
row this pipeline submitted is reconciled against the actual output: present with a real result ->
parsed exactly like an interactive response; present with a per-line `error` -> `_callFailed`;
**absent from the output entirely -> also `_callFailed`, loudly logged (the missing recordIds are
named in stderr, capped at 5), never silently dropped and never marked enriched** -- it is retried on
the next run like any other unreachable-model case. Only a genuinely FAILED/Stopped/Expired job
(no usable output at all) aborts the whole run (a throw, mirroring the interactive lane's own
"FATAL: all N LLM calls failed" posture); a partial completion degrades to a `WARN: M/N LLM call(s)
failed` line instead, exactly the codebase's existing "all failed vs any failed" distinction.

**Before a real backfill:** provision the staging bucket + IAM role above, then run the SAME
comparison steps `PILOT-bedrock-enrich.md` already describes for the interactive lane (a small
control batch, a like-for-like re-run under `--bedrock-batch`, inspect before scaling up), starting
with `--dry-run` to sanity-check the row count and estimated cost before ever touching the network.
Nothing here is wired into `job/librarian.sh` or any scheduled task -- arming that is a separate,
deliberate, CTO-reviewed decision, same as the interactive Bedrock lane's own rollout gate.

## k-NN vector quantization (fp32 -> disk-optimized, OpenSearch 3.x only)

Closes FND-20260829-f7fa: every index on `otchealth-brain` was created fp32 (`in_memory` mode,
3072-dim text-embedding-3-large, ~29GB total across ~15 indexes; finance ~13GB, legal-personal
~9.1GB, legal-company ~4.4GB), and 7-day `KNNGraphMemoryUsagePercentage` peaked 96.9% on the single
r6g.large.search node. `skills/doc-indexer/quantize-indices.mjs` migrates each index, one at a time,
to OpenSearch's disk-optimized/quantized `knn_vector` mode (default `compression_level: "32x"`, a
~97% cut in vector memory), per the official docs (fetched and quoted 2026-09-02,
<https://docs.opensearch.org/latest/vector-search/optimizing-storage/disk-based-vector-search/> and
<https://docs.opensearch.org/latest/mappings/supported-field-types/knn-vector/>).

**REQUIRES OpenSearch 3.x.** `mode`/`compression_level` are 3.x mapping parameters; do not run this
against a 2.19 domain (index creation will reject the mapping with a 400).

**This seat cannot reach the OpenSearch data plane** (the egress proxy blocks `*.es.amazonaws.com`),
so the tool runs as a one-off ECS Fargate task via `run-quantize-task.mjs`, reusing the existing
`otchealth-job-brain-reindex` task definition with a container override (the image already carries
both files -- no Dockerfile change needed, see quantize-indices.mjs's own header). Read-only ECS/AWS
control-plane calls (DescribeTaskDefinition, etc.) ARE reachable from this seat and are how the
container name (`job`), command shape, and log group/stream prefix (`/ecs/otchealth`,
`brain-reindex/job/<taskId>`) below were verified live, without ever touching the data plane itself.

**Sequence** (per the official docs' own recommended flow, adapted for a resumable per-index tool):
1. `plan` (read-only audit; also the live evidence for FND-20260829-f7fa) --
   `node run-quantize-task.mjs plan`
2. Migrate ONE small, non-privileged index first, dry-run then commit --
   `node run-quantize-task.mjs migrate --index commons-coo-memory` (review the printed plan), then
   `node run-quantize-task.mjs migrate --index commons-coo-memory --commit`
3. Check CloudWatch (`KNNGraphMemoryUsagePercentage`, `SearchLatency`) before and after -- this tool
   does not automate that check.
4. `migrate --all --commit` (smallest-first; privileged finance/legal rooms are excluded by default,
   pass `--include-privileged` deliberately once ready for those, per Matt's own processor-choice
   gate on privileged-room LLM/infra changes -- quantization itself is not an LLM call, but treat the
   privileged rooms as a deliberate, separate step regardless).
5. Once memory pressure is confirmed down, downsizing the instance type is a separate, manual
   decision (domain config change, not this tool's job).

**Design (see quantize-indices.mjs's own header for the full rationale):** a `knn_vector` field's
method/engine/mode are fixed at index-creation time, so this creates a scratch twin (`<index>--q`),
reindexes into it, independently verifies it (doc-count convergence, a real sampled-doc `_source`
comparison, and a real kNN query's top-10 overlap), and ONLY THEN (gated on that verification, and
only with `--commit`) swaps it onto the original name (delete original -> recreate under the
quantized mapping -> reindex the twin back -> reverify -> delete the twin) -- there is no alias layer
anywhere in this fleet's retrieval code, so this delete-and-recreate swap is the only option, not a
choice; the original is NEVER deleted before its twin is proven. `_reindex` overwrites by `_id`, so
re-running it (both forward and on resume) is always safe on a LIVE, still-being-written-to index --
`reindexUntilCountsConverge()` retries (bounded) until source/dest doc counts agree rather than
trusting a single pass. Resumable state lives in the S3 commons mirror
(`_QUANTIZE_STATE/<index>.json`, via `skills/kb-memory/commons-store.mjs`) so a killed ECS task picks
up exactly where it left off. Finance/legal-MNPI rooms (the gateway's real `INDEX_LANES`, not just
the three names a first pass might guess) are excluded unless `--include-privileged` is passed.
```
node skills/doc-indexer/run-quantize-task.mjs plan [--json]
node skills/doc-indexer/run-quantize-task.mjs migrate --index <name> [--commit] [--compression 32x] [--include-privileged] [--min-overlap-pct 90]
node skills/doc-indexer/run-quantize-task.mjs migrate --all [--commit] [--compression 32x] [--include-privileged]
node skills/doc-indexer/run-quantize-task.mjs rollback --index <name> [--commit] [--force]   # restores <name> from <name>--q if it is missing/broken
# Runner-only flags: [--task-definition otchealth-job-brain-reindex] [--heartbeat-name quantize-indices]
#                    [--max-wait-minutes 180] [--poll-interval-seconds 10] [--no-tail]
```
Without `--commit`, `migrate`/`rollback` are dry runs: they report exactly what they would do and
mutate nothing beyond the scratch twin index. `quantize-indices.mjs` itself is also directly
runnable (same subcommands) from anywhere that DOES resolve `resolveOpenSearchConfig()` (an ECS task
via the task role, or a seat with real `OTC_AWS_*`/AWS credentials that can actually reach the data
plane) -- `run-quantize-task.mjs` exists specifically for the seats that cannot.

**Durable lesson from building this (2026-09-02):** while smoke-testing this tool's shell-argument
wiring, one real (non-mutating) call reached the live domain by accident and caught two API-shape
bugs before they could ever run for real: `_reindex`'s `slices` parameter is a QUERY-STRING
parameter, not a body field (`x_content_parse_exception: unknown field [slices]`); and
`opensearch-client.mjs`'s `osFetch()` had a latent bug, present since its SigV4 signer first grew a
`service` parameter, where it re-derived the request URL from the caller's raw (pre-canonicalization)
path instead of the canonical path it actually signed -- invisible for every prior caller because
their paths (plain index names, literal segments like `_bulk`) happen to contain no character
`canonicalUri()` ever changes, and would have produced a `SignatureDoesNotMatch` 403 the moment a
caller with a real special character (a task id's `nodeId:taskNumber`) came along. Both are fixed and
regression-tested (`tests/opensearch-client-sigv4.test.mjs`).

## Commands
```
node skills/doc-indexer/indexer.mjs index   --profile <p> [--azure|--gcs] [--prefix x] [--limit n] [--reindex] \
                                            [--ocr-model prebuilt-read|prebuilt-layout] [--no-ocr] [--no-text]
node skills/doc-indexer/indexer.mjs search "<query>" --profile <p> [--azure|--gcs] [--limit n]   # free FTS5 (offline)
node skills/doc-indexer/indexer.mjs status        --profile <p> [--azure|--gcs]   # cataloged vs total + breakdowns
node skills/doc-indexer/indexer.mjs build-index   --profile <p> [--azure|--gcs]   # rebuild index.sqlite from sidecars
node skills/doc-indexer/indexer.mjs build-csv     --profile <p> [--azure|--gcs]   # _CATALOG/catalog.csv
node skills/doc-indexer/indexer.mjs propose-mapping --profile <p> [--azure|--gcs] # old->taxonomy mapping CSV
# Search brain (default OpenSearch via AWS creds + OPENSEARCH_ENDPOINT; --search-backend azure needs
# azure-search-endpoint/-admin-key + an Azure OpenAI embedding deployment instead)
node skills/doc-indexer/indexer.mjs search-init   --profile <p> [--s3|--azure|--gcs] [--index name] [--search-backend opensearch|azure]
node skills/doc-indexer/indexer.mjs push-search   --profile <p> [--s3|--azure|--gcs] [--index name] [--search-backend opensearch|azure] [--embeddings-provider openai|foundry]
node skills/doc-indexer/indexer.mjs cloud-search "<query>" --profile <p> [--s3|--azure|--gcs] [--limit n] [--search-backend opensearch|azure]  # hybrid (BM25+kNN, RRF-merged)
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
- CU understanding: `azure-foundry-endpoint` / `azure-foundry-key` / `azure-foundry-gen-deployment`
  (otchealth-foundry, eastus, gpt-4.1-mini). Retrieval brain: `azure-search-endpoint` /
  `azure-search-admin-key` + `azure-openai-embedding-deployment`. ROTATE-BEFORE-LAUNCH.

## Guardrails
- **Non-PHI ring only.** Never point at a MedReview/PHI source. PHI-scan non-accounting media before
  ingest; drop anything that surfaces PHI.
- **INND = MNPI**; stores + catalogs stay private (never public). The legal **personal** container is
  **privileged + confidential** - never co-mingle with company, never expose to other agents.
- Cost: text-layer + LibreOffice are free; OCR is reserved for the image tier (`prebuilt-read`
  ~$1.50/1k pages). Use `prebuilt-layout` (~$10/1k) only where tables matter.
- The full bulk pass is best run headless (survives session reclaim; avoids the in-session
  bulk-download classifier gate).

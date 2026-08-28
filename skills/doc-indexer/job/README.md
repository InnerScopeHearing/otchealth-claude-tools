# doc-indexer Container Apps Job — heavy-pass runner + autonomous librarian

The robust, headless runtime for the fleet knowledge base. Two jobs in one image:

1. **Backfill (manual trigger):** the one-time full pass over a data room -
   `index` -> `understand` (Content Understanding) -> `push-search` (into Azure AI Search).
   Runs headless so it survives session reclaim and is NOT subject to the interactive
   auto-mode classifier (it is infrastructure, not an agent doing bulk downloads).
2. **Librarian (scheduled cron trigger):** the autonomous self-improvement loop - on a
   schedule it re-runs the same pass, so newly-arrived docs are understood, embedded, and
   indexed with no human. This is the "system keeps making itself better" engine.

Runs on the existing **otchealth-jobs-env** (Container Apps environment, otchealth-automation-rg).
Lean image; the only secret it needs is the GCP service-account JSON, from which it self-resolves
every Azure credential (Foundry/Search/DocIntel/storage) out of Secret Manager.

## Deploy (Azure Cloud Shell, copy-paste)

```
# 0. clone the repo into Cloud Shell (one-time; uses the github-app or a PAT)
#    git clone https://github.com/InnerScopeHearing/otchealth-claude-tools.git && cd otchealth-claude-tools

# 1. create a container registry (once)
az acr create -n otchealthacr -g otchealth-automation-rg --sku Basic --admin-enabled true

# 2. build the image in the cloud (from repo root)
az acr build -r otchealthacr -t doc-indexer:latest -f skills/doc-indexer/job/Dockerfile .

# 3a. BACKFILL job (manual) - the full CFO data-room pass.
#     Paste the claude-driver SA JSON as the gcpsa secret (one line).
az containerapp job create -n doc-indexer-finance -g otchealth-automation-rg \
  --environment otchealth-jobs-env --trigger-type Manual --replica-timeout 7200 --replica-retry-limit 1 \
  --image otchealthacr.azurecr.io/doc-indexer:latest \
  --registry-server otchealthacr.azurecr.io \
  --cpu 2 --memory 4Gi \
  --secrets "gcpsa=<PASTE_ONE_LINE_SA_JSON>" \
  --env-vars "GCP_CLAUDE_DRIVER_SA_JSON=secretref:gcpsa" \
  --args "understand,--profile,finance,--gcs"

# run the backfill (do `index --no-ocr` first if the catalog is not yet built, then understand, then push-search)
az containerapp job start -n doc-indexer-finance -g otchealth-automation-rg --args "index,--no-ocr,--profile,finance,--gcs"
az containerapp job start -n doc-indexer-finance -g otchealth-automation-rg --args "understand,--profile,finance,--gcs"
az containerapp job start -n doc-indexer-finance -g otchealth-automation-rg --args "push-search,--profile,finance,--gcs"

# 3b. LIBRARIAN job (scheduled cron, e.g. hourly) - the autonomous self-improving loop.
az containerapp job create -n doc-indexer-librarian -g otchealth-automation-rg \
  --environment otchealth-jobs-env --trigger-type Schedule --cron-expression "0 * * * *" --replica-timeout 3600 \
  --image otchealthacr.azurecr.io/doc-indexer:latest --registry-server otchealthacr.azurecr.io \
  --cpu 2 --memory 4Gi \
  --secrets "gcpsa=<PASTE_ONE_LINE_SA_JSON>" \
  --env-vars "GCP_CLAUDE_DRIVER_SA_JSON=secretref:gcpsa" \
  --args "understand,--profile,finance,--gcs"
```

Notes
- The same image serves the **legal** profile (`--profile legal --azure --container company` / `personal`)
  for the CLO - create a `doc-indexer-legal` job the same way. Company and personal each get their own
  index/catalog/sidecars; the personal container is privileged (CLO-only), never co-mingled.
- `index`/`understand`/`push-search` are all **resumable** (catalog checkpoint), so a job that is
  retried or rescheduled never repeats finished work.
- ROTATE-BEFORE-LAUNCH: the gcpsa job secret is the claude-driver SA; treat it as sensitive.
- Region: the job env is westus2; Search/Foundry are eastus - cross-region API calls, fine.

### CRITICAL: `--args` must be SEPARATE tokens, not a comma string
`az containerapp job create/update --args` takes a space-separated list (each token is one element of
the container `args` array). Do NOT pass `--args "librarian.sh,finance"` - in Cloud Shell PowerShell
that is stored as a SINGLE literal arg `librarian.sh,finance`, so `/bin/sh` tries to open a file with a
comma in its name and the job fails instantly (Failed, with no app logs because the container never
runs the script). Pass each token separately and quoted:

```
--command "/bin/sh" --args "/app/skills/doc-indexer/job/librarian.sh" "legal" "--container" "company"
```

(daily-digest worked despite this bug only because its args were a single token, `nightly.sh`.)

### Speeding up the `understand` (Content Understanding) pass
CU analyze+poll is ~30-60s per document; the pass runs a **bounded worker pool** (default 8 in parallel,
tune with `--concurrency N` or the `CU_CONCURRENCY` env var). 429s self-retry honoring `Retry-After`.
The pass is resumable, so even if a librarian run hits `replicaTimeout` it picks up the unfinished tail
next run. For a large room, raise `--replica-timeout` and/or `--concurrency` rather than expecting one
run to finish thousands of docs in a single execution.

### `deep-pass.sh` vs `enrich.mjs`: two DIFFERENT passes, do not conflate them
Two `doc-indexer` job families both use the word "deep"/"enrich" in the ledger and are easy to
conflate; they are complementary, not the same pipeline:

- **`deep-pass.sh` -> `deep-pass.mjs`** (jobs `deep-finance`, `deep-legal-company`,
  `deep-legal-personal`; schedules exist but are held at a placeholder cron pending a manually-verified
  first run -- see FND-20260821-97e9/-783d -- the intended cadence is ~90 min per
  `setup/heartbeat-registry.json`): HIGH-POWER re-summarization (2026-08-28: AWS Bedrock, a Claude
  model per room -- Sonnet 4.5 for legal, Haiku 4.5 for finance; the gpt-4.1-on-Azure-Foundry path this
  line used to name is dead and kept only as a `--llm-provider azure` history/rollback stub) + a vision
  pass for signature/execution-status detection. `legal-personal` is categorically excluded from this
  pass regardless of provider (attorney-privileged; see `isLlmExcludedRoom()` in `deep-pass.mjs`). It
  patches `_CATALOG/catalog.jsonl` in place (`summary_deep`, `counterparty`, `materiality`,
  `execution_status`, `signatories`, ...) and, on room completion, calls
  `indexer.mjs push-search --reindex` (a no-op today on the S1 chunked rooms per the CHUNKED-ROOM
  GUARD in `indexer.mjs`, and now also fails loud+fast rather than timing out, since that call targets
  the permanently-retired Azure AI Search -- see deep-pass.mjs's own header for the tracked follow-up).
  Storage is AWS S3 by default (`--storage-backend s3`, the same mirror `enrich.mjs`/`indexer.mjs` use);
  `--storage-backend azure` remains selectable for read-only inspection of pre-lockdown history only.
- **`enrich.mjs`** (`ensure-schema` / `run` / `reindex-room` / `verify`, see the file header and
  `metadata-schema.mjs`): the S1 brain METADATA ENRICHMENT pipeline (2026-07-21) that adds the
  22-field universal-core + per-domain pack (commerce only, today) as blob custom metadata on the
  `_TEXT/` sidecar, projected onto every chunk row via the skillset's index projections. It PULLS
  `deep-pass.mjs`'s output (`materiality`, `execution_status`, `signatories`, `sig_confidence`,
  a rich `summary`) as free "rewire" fields instead of re-asking the model, so `deep-pass.sh` running
  first on finance/legal makes `enrich.mjs`'s later pass on those same rooms CHEAPER, not redundant.
  There is no `enrich.mjs` call anywhere in `deep-pass.sh` or `deep-pass.mjs`; the two never invoke
  each other.

**Where `enrich.mjs` is wired into a scheduled job today:** `job/librarian.sh` (used by
`librarian-finance`, `librarian-commerce`, `librarian-legal-company`, `librarian-legal-personal`) and
`job/nightly.sh` (used by `daily-digest`, the only room-refresh job for `commons-company-journal`)
both carry the identical opt-in gate:

```sh
if [ "$ENRICH" = "1" ]; then
  node enrich.mjs ensure-schema --profile <room> --azure
  node enrich.mjs run           --profile <room> --azure
fi
```

Default is OFF everywhere except commerce, which was the 2026-07-21 proving run (114 docs, room
`commerce-commerce-source-docs`). **To roll enrichment out to finance / legal-company /
legal-personal / commons, set `ENRICH=1` on that job's env** (after building this branch's image and
after a parity spot-check of a doc or two against the live index, per the code comment -- do not flip
every room at once):

```
az containerapp job update -n librarian-finance -g otchealth-automation-rg --set-env-vars "ENRICH=1"
az containerapp job update -n librarian-legal-company -g otchealth-automation-rg --set-env-vars "ENRICH=1"
az containerapp job update -n librarian-legal-personal -g otchealth-automation-rg --set-env-vars "ENRICH=1"
az containerapp job update -n daily-digest -g otchealth-automation-rg --set-env-vars "ENRICH=1"
```

`finance`/`legal`/`commons` have no `DOMAIN_PACKS` entry yet in `metadata-schema.mjs` (only
`commerce` does), so flipping `ENRICH=1` on those rooms today runs the 22-field universal core only
(no domain-specific extras) -- `fieldsForDomain()` degrades to that safely, it does not error. Adding
each domain's field pack (design doc Sections 4A/4B/4D) is a separate, later, explicitly scoped
wide-rollout step, not a prerequisite for turning enrichment on.

Rebuild the image before flipping any `ENRICH` flag on a job that has not picked up this change yet:

```
az acr build -r otchealthacr -t doc-indexer:latest -f skills/doc-indexer/job/Dockerfile .
```

(Jobs pinned to a `@sha256` digest, per the fleet convention, need their `--image` updated to the new
digest, not just a `:latest` rebuild -- see `setup/drift-recon.mjs`.)

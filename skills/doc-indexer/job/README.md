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

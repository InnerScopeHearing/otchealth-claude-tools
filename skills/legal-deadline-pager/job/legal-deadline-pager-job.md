# legal-deadline-pager-sweep Container Apps Job — deploy (copy-paste)

Reuses the existing `doc-indexer:latest` image family's environment (`otchealth-jobs-env`,
`otchealth-automation-rg`), the same pattern `skills/decision-clock/job/` uses: dependency-free Node
needing only the claude-driver SA (or a managed identity / AZURE_SP_* with Key Vault Secrets User on
`kv-otc-55c84f6bef`); no new image is required if `doc-indexer:latest` is already built.

```
# One-time: create the daily sweep job (cron 20 23 * * *, alongside decision-clock-sweep at 15 23).
# SHIPS DISARMED: this creates the job WITHOUT LEGAL_PAGER_ENABLED, so it pages nobody yet.
az containerapp job create -n legal-deadline-pager-sweep -g otchealth-automation-rg \
  --environment otchealth-jobs-env --trigger-type Schedule --cron-expression "20 23 * * *" \
  --replica-timeout 900 --replica-retry-limit 1 \
  --image otchealthacr.azurecr.io/doc-indexer:latest --registry-server otchealthacr.azurecr.io \
  --cpu 1 --memory 2Gi \
  --secrets "gcpsa=<PASTE_ONE_LINE_SA_JSON>" \
  --env-vars "GCP_CLAUDE_DRIVER_SA_JSON=secretref:gcpsa" \
  --command "/bin/sh" \
  --args "/app/skills/legal-deadline-pager/job/legal-deadline-pager-sweep.sh"

# Run it on demand (still disarmed; watch the log for what it WOULD page):
az containerapp job start -n legal-deadline-pager-sweep -g otchealth-automation-rg

# ARM IT (separate, deliberate step; only do this once the tracking output has been reviewed):
az containerapp job update -n legal-deadline-pager-sweep -g otchealth-automation-rg \
  --set-env-vars LEGAL_PAGER_ENABLED=1

# Disarm it again at any time:
az containerapp job update -n legal-deadline-pager-sweep -g otchealth-automation-rg \
  --remove-env-vars LEGAL_PAGER_ENABLED
```

Notes
- **`--args` must be a separate token, not a comma string** (the doc-indexer job's documented footgun,
  see `skills/decision-clock/job/decision-clock-job.md`). Only one arg is needed here, low-risk, but
  keep the pattern consistent.
- Same one secret as every other job in this fleet: `GCP_CLAUDE_DRIVER_SA_JSON`. Everything else
  (Cosmos endpoint/key, the legal store account/key, the cto-lane gateway credentials) resolves from Key
  Vault via `kvSecret()` (managed identity, then `AZURE_SP_*`, then az-CLI/OIDC), with the same SA-backed
  fallback used fleet-wide.
- The job env has no Log Analytics (same known limitation as the doc-indexer jobs); diagnose a failed
  run by re-running `node skills/legal-deadline-pager/pager.mjs sweep --commit --json` directly in a
  session with the SA hydrated, and by checking `node skills/legal-deadline-pager/pager.mjs heartbeat`
  for staleness.
- Confirm `LEGAL_PAGER_ENABLED` is unset (or anything other than the literal string `1`) before this job
  is first scheduled; only add it after reviewing at least one dry-run/commit-only sweep's output.

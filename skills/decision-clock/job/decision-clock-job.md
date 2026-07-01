# decision-clock-sweep Container Apps Job — deploy (copy-paste)

Reuses the existing `doc-indexer:latest` image family's environment (`otchealth-jobs-env`,
`otchealth-automation-rg`) since the sweep is dependency-free Node needing only the claude-driver SA;
no new image is required if `doc-indexer:latest` is already built (it carries the whole
`otchealth-claude-tools` checkout). If a lighter image is preferred later, build one from this repo's
root the same way the doc-indexer image is built (`az acr build -r otchealthacr -t
decision-clock:latest -f skills/decision-clock/job/Dockerfile .`), but the copy-paste below reuses
`doc-indexer:latest` to avoid a second image to maintain.

```
# One-time: create the daily sweep job (cron 15 23 * * *, just before daily-digest at 59 23).
az containerapp job create -n decision-clock-sweep -g otchealth-automation-rg \
  --environment otchealth-jobs-env --trigger-type Schedule --cron-expression "15 23 * * *" \
  --replica-timeout 900 --replica-retry-limit 1 \
  --image otchealthacr.azurecr.io/doc-indexer:latest --registry-server otchealthacr.azurecr.io \
  --cpu 1 --memory 2Gi \
  --secrets "gcpsa=<PASTE_ONE_LINE_SA_JSON>" \
  --env-vars "GCP_CLAUDE_DRIVER_SA_JSON=secretref:gcpsa" \
  --command "/bin/sh" \
  --args "/app/skills/decision-clock/job/decision-clock-sweep.sh"

# Run it on demand (dry-run first without --dispatch by editing the script, or just watch the log):
az containerapp job start -n decision-clock-sweep -g otchealth-automation-rg
```

Notes
- **`--args` must be a separate token, not a comma string** (the doc-indexer job's documented footgun:
  `az containerapp job create/update --args` takes a space-separated arg list; passing a single
  comma-joined string makes `/bin/sh` fail to find the file). Only one arg is needed here, so this is
  low-risk, but keep the pattern consistent with the other jobs.
- Same one secret as every other job in this fleet: `GCP_CLAUDE_DRIVER_SA_JSON`. Everything else
  (Cosmos endpoint/key, the fleet-dispatch commons blob creds) resolves from Secret Manager.
- The job env has no Log Analytics (same known limitation as the doc-indexer jobs); diagnose a failed
  run by re-running `node skills/decision-clock/decision.mjs sweep --json` directly in a session with
  the SA hydrated.

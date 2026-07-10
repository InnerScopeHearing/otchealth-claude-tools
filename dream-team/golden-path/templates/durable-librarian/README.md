# templates/durable-librarian/ — Durable Functions skeleton for the librarian fan-out

DRAFT skeleton only. Ports the existing `librarian.sh` (index → understand → push-search per
data-room profile) into a Durable Functions orchestrator that fans the 4 rooms
(finance / commerce / legal-company / legal-personal) out in parallel instead of running as 4
separate Container Apps Jobs on staggered cron minutes. See `/tmp/phase6/DESIGN.md` §1 for the
full rationale, the Consumption-SKU caps to respect, and why daily-digest/fleet-medic/
agent-state-janitor/innd-stock-daily are explicitly OUT of scope for this migration.

**This is a coexistence design, not a flag-day cutover.** The existing Container Apps Jobs
(`librarian-finance`, `librarian-commerce`, `librarian-legal-company`, `librarian-legal-personal`)
keep running unchanged while this is piloted; only disable them once the Durable Functions path
has been observed clean for at least one full week (staggered cron already avoids overlap today,
so there is no urgency pressure to cut over fast — the value here is the dashboard + checkpointed
resume + true single-orchestrator fan-out, not fixing an active outage).

## Files

- `src/functions/librarianOrchestrator.js` — the orchestrator (fan-out/fan-in over the 4 rooms).
- `src/functions/librarianActivity.js` — ONE activity that shells out to the SAME
  `indexer.mjs {index|understand|push-search}` calls `librarian.sh` already makes. No indexer
  logic is rewritten; this is a coordination layer only.
- `src/functions/librarianStarter.js` — HTTP trigger that starts (or no-ops if already running)
  an orchestration instance, replacing the cron trigger on the Container Apps Job.
- `host.json` — Durable Task Scheduler connection config.
- `infra/function-app.bicep` — Flex Consumption Function App + Durable Task Scheduler + task hub.

## What this does NOT change

- The indexer logic itself (`skills/doc-indexer/indexer.mjs`) is untouched — the activity function
  is a thin `child_process` wrapper around the exact same three CLI calls `librarian.sh` makes.
- The MAX_INDEX_MB OOM guard, the CU_CONCURRENCY worker pool, the CU_MAX_MINUTES soft time
  budget — all stay exactly as they are inside `indexer.mjs`. The orchestrator does not need its
  own timeout logic layered on top; Durable timers are used only for the SCHEDULE (replacing
  cron), not to bound each activity's runtime (that stays indexer.mjs's own job).
- Ring separation: `legal-personal` stays its own activity call against its own container, same
  as today; nothing about this migration co-mingles rooms.

## Deploy (once function-app.bicep params are supplied — draft only, not executed)

```bash
# 1. Create the Durable Task Scheduler (Consumption SKU) + one task hub — ONE per subscription,
#    shared across every Durable Functions workload in the fleet, not per-app. Quota: 10
#    schedulers / 5 task hubs per region per subscription on Consumption.
az extension add --name durabletask
az durabletask scheduler create --name sched-otchealth-jobs --resource-group otchealth-automation-rg \
  --location westus2 --ip-allowlist "[0.0.0.0/0]" --sku-name "consumption"
az durabletask taskhub create --resource-group otchealth-automation-rg \
  --scheduler-name sched-otchealth-jobs --name fleet-orchestration

# 2. Deploy the Flex Consumption Function App (Bicep — see infra/function-app.bicep)
az deployment group create -g otchealth-automation-rg -f infra/function-app.bicep \
  -p functionAppName=fn-fleet-librarian storageAccountName=<existing-or-new-account> \
     schedulerEndpoint=<scheduler-endpoint-from-step-1>

# 3. Grant the function app's managed identity the "Durable Task Data Contributor" role,
#    scoped to the scheduler resource (NOT the whole subscription).
IDENTITY=$(az functionapp identity show -g otchealth-automation-rg -n fn-fleet-librarian --query principalId -o tsv)
az role assignment create --assignee "$IDENTITY" --role "Durable Task Data Contributor" \
  --scope "/subscriptions/<sub>/resourceGroups/otchealth-automation-rg/providers/Microsoft.DurableTask/schedulers/sched-otchealth-jobs"

# 4. Deploy the function code (zip via the deployment storage container app.bicep wires up, or
#    `func azure functionapp publish fn-fleet-librarian --build remote` from a session with func CLI)

# 5. Kick a librarian pass manually to prove it end-to-end BEFORE wiring any schedule:
curl -X POST "https://fn-fleet-librarian.azurewebsites.net/api/orchestrators/librarianFanOut"
# returns {"id": "...", "statusQueryGetUri": "...", ...} — poll statusQueryGetUri until
# runtimeStatus == "Completed", confirm all 4 rooms report success in the output.

# 6. Only after step 5 is proven clean for a week: add a Timer trigger (or an external cron
#    caller hitting the starter URL) and correspondingly pause (not delete) the parallel
#    Container Apps Jobs cron triggers, so rollback is a one-line re-enable.
```

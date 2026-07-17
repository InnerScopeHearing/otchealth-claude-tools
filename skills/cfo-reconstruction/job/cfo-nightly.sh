#!/bin/sh
# cfo-reconstruction Container Apps Job entrypoint (Tier-1, nightly cron): advances the CFO's
# multi-year financial-reconstruction ANALYSIS by one bounded, resumable, idempotent step and
# stages the result in the CFO data room for Matt/CFO sign-off.
#
# READ-ONLY, ANALYSIS ONLY -- STRUCTURALLY, NOT BY CONVENTION. This script runs exactly one command:
# `node reconstruct.mjs sweep`. reconstruct.mjs reaches Xero ONLY through xero-readonly.mjs's
# hardcoded allowlist of gateway tools the gateway itself labels "Read-only." The gateway's
# write-capable Xero tool is never imported by this skill. Nothing this script (or anything it
# calls) does can create, update, or void a Xero record, and there is no flag on this job that
# changes that. The CFO's actual posting workflow -- the thing that DOES write to the books, gated
# to Matt's per-step sign-off -- is a separate, pre-existing system in a DIFFERENT resource group
# (rg-otchealth-apps-prod, not this job's otchealth-automation-rg; exact names in
# runbooks/cfo-reconstruction-job.md) that this job never touches, imports, or shells out to.
#
# Secrets: NONE stored on this job spec. It authenticates two ways, both keyed off the job's
# managed identity (id-otc-jobs-kv, already granted Key Vault Secrets User on kv-otc-55c84f6bef):
#   - the gateway's "cfo" lane bearer (skills/gateway-connect/connect.mjs -> Key Vault secrets
#     oauth-lane-cfo-id / oauth-lane-cfo-secret) for every Xero read;
#   - the CFO data room + OneDrive + decision-clock + kb-memory credentials, each self-resolved from
#     Key Vault by the skill it belongs to (skills/kb-memory/azure-secret.mjs's kvSecret()).
# See runbooks/cfo-reconstruction-job.md for the full az containerapp job create spec (not applied
# by this PR -- infra is a separate, explicit CTO step).
#
# Staging IS the default-on write mode with no flag needed (this job's whole purpose is to stage
# output every night, same as every other librarian/nightly job in this fleet -- see
# runbooks/cfo-reconstruction-job.md "Why staging is on by default, unlike legal-deadline-pager's
# --commit gate" for the reasoning). Append --dry-run via extra job args (this script passes "$@"
# straight through) to preview without writing anything, e.g. for a manual
# `az containerapp job start ... --args '/app/skills/cfo-reconstruction/job/cfo-nightly.sh' '--dry-run'`
# smoke test before trusting the cron.
set -e
[ -n "$GCP_CLAUDE_DRIVER_SA_JSON_B64" ] && export GCP_CLAUDE_DRIVER_SA_JSON=$(printf "%s" "$GCP_CLAUDE_DRIVER_SA_JSON_B64" | base64 -d)
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
echo "[cfo-reconstruction] $(date -u +%FT%TZ) sweeping the reconstruction analysis queue"
node "$ROOT/skills/cfo-reconstruction/reconstruct.mjs" sweep --json "$@"
echo "[cfo-reconstruction] sweep complete"

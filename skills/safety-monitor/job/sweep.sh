#!/bin/sh
# safety-monitor sweep (ECS Fargate task, EventBridge Scheduler, hourly).
#
# Scans recent Intercom conversations for customer-reported safety hazards, tags each match with the
# safety-escalation tag, and publishes one SNS alert per match so a human sees it. Reads exactly one
# secret (intercom-access-token) from AWS SSM via kb-memory's kvSecret; SNS publish uses the task
# role. No other credential, no LLM, no customer write beyond the tag.
#
# WHY --commit IS ON HERE. The CLI defaults to a dry run precisely so that a human running it by hand
# cannot accidentally tag or alert. A scheduled sweep that stayed in dry-run would detect hazards and
# tell nobody, which is the exact failure this job exists to end -- so the scheduled invocation is the
# one place --commit belongs. SAFETY_MONITOR_DRY_RUN=1 forces it back off without editing the task
# definition, for a live-but-harmless first run.
#
# runSweep() never throws and always returns a summary, so a partial failure still reports what it
# did. It exits non-zero when any conversation failed, which the heartbeat wrapper turns into a
# 'fail' beat -- a sweep that cannot reach Intercom must not look like a clean all-clear.
set -e
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
echo "[safety-monitor] $(date -u +%FT%TZ) - sweeping Intercom for customer safety escalations"
if [ "$SAFETY_MONITOR_DRY_RUN" = "1" ]; then
  echo "[safety-monitor] SAFETY_MONITOR_DRY_RUN=1 -- detecting only, will NOT tag or alert"
  node "$ROOT/skills/safety-monitor/monitor.mjs" sweep "$@"
else
  node "$ROOT/skills/safety-monitor/monitor.mjs" sweep --commit "$@"
fi
echo "[safety-monitor] done"

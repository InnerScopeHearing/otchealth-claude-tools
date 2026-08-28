#!/bin/sh
# Deep-pass job (ECS scheduled task, per data room): HIGH-POWER re-summarization + signature/execution
# detection + confidence-gated outlier flagging via a Bedrock Claude model (2026-08-28 port off dead
# Azure Foundry -- see deep-pass.mjs's own header for the full port history and the flood-guard fix
# this replaces). Resumable (skips rows already marked .deep). Arg 1 = doc-indexer profile
# (legal | finance); remaining args pass through to deep-pass.mjs (e.g. --container company
# --max-minutes 200 --concurrency 10). NOTE: --container personal under --profile legal is REFUSED by
# deep-pass.mjs itself (attorney-privileged, categorically excluded from all LLM enrichment) -- this
# script does not special-case that; the .mjs's own hard guard is the enforcement point.
#
# Credentials: AWS SSM (via the ECS task role) for storage/LLM secrets, no GCP SA of any kind needed --
# S3 storage and Bedrock both authenticate through the task role automatically (see s3-blob.mjs's and
# bedrock-client.mjs's own headers). Runs on AWS Bedrock on-demand billing (Activate credit), zero Max
# draw. The DO-NOT-ARM-YET status of this job's EventBridge schedule (FND-20260821-97e9,
# FND-20260821-783d) is unaffected by this script -- arming is a separate, deliberately gated step.
set -e
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
PROFILE="${1:-legal}"
shift 2>/dev/null || true
# Default a soft time budget for SCHEDULED runs (verify-pass REQUIRED FIX #5, 2026-08-28 Bedrock port):
# once the EventBridge schedule is eventually armed at rate(90 minutes) (setup/heartbeat-registry.json),
# its target's ContainerOverrides pass no --max-minutes (arming deliberately does not touch the target,
# per the design doc's section 4 gate), so without a default HERE an unbounded room sweep could run past
# the next tick. Baked into this script rather than the schedule target itself: it ships automatically
# on the next image rebuild (build-doc-indexer-ecr.yml already rebuilds on merge), with no EventBridge
# edit required. An explicit --max-minutes on the invocation (a manual RunTask, in particular) always wins.
case " $* " in
  *" --max-minutes "*) : ;;  # caller already set one -- respect it
  *) set -- "$@" --max-minutes 80 ;;
esac
echo "[deep-pass] profile=$PROFILE $*"
node "$ROOT/skills/doc-indexer/deep-pass.mjs" --profile "$PROFILE" "$@"
echo "[deep-pass] done: $PROFILE"

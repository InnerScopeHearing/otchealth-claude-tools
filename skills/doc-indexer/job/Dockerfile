# doc-indexer headless runner: the fleet-KB heavy-pass + the autonomous "librarian".
# Runs as an Azure Container Apps Job on otchealth-jobs-env (manual for the backfill,
# scheduled cron for continuous self-improvement). Lean image: pdftotext + tesseract +
# unzip; CU handles office docs + scans in the `understand` pass, so no LibreOffice needed.
#
# Build (Cloud Shell, from repo root):
#   az acr build -r <acr> -t doc-indexer:latest -f skills/doc-indexer/job/Dockerfile .
# Creds: GCP_CLAUDE_DRIVER_SA_JSON (job secret) -> indexer self-resolves every Azure cred
# (foundry/search/docintel/storage) from Secret Manager. No other secrets in the image.
# node:24-slim, not 22: the indexer's FTS5 index uses node:sqlite, which is flagless only on
# Node >=23.4 (experimental + flag-gated on 22). Cloud Shell is v24, so this keeps the container
# and the Cloud Shell test path identical.
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils tesseract-ocr unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY setup/ /app/setup/
COPY skills/doc-indexer/ /app/skills/doc-indexer/
COPY skills/cfo-store/ /app/skills/cfo-store/
COPY skills/daily-digest/ /app/skills/daily-digest/
COPY skills/github-app/ /app/skills/github-app/
# kb-memory: the brain-reindex job runs semantic.mjs reindex from this image to keep the
# memory-exec AI Search index fresh (agent lessons/decisions + focus-group/shark catalog feed it).
COPY skills/kb-memory/ /app/skills/kb-memory/
# vault-sync: daily-digest's nightly.sh regenerates the credential registry from the secret store
# via vault-registry.mjs. Without this COPY the step logs a (guarded, non-fatal) MODULE_NOT_FOUND.
COPY skills/vault-sync/ /app/skills/vault-sync/
# fleet-medic: the auto-dispatch memory medic job (fleet-medic.sh -> medic.mjs scan --dispatch).
# medic.mjs execs kb-memory/mem.mjs team-health (copied above) for its deterministic health spine.
COPY skills/fleet-medic/ /app/skills/fleet-medic/
# aws-image-canary (EventBridge schedule otchealth-image-canary, rate 2h, containerOverride
# `sh -c node /app/skills/aws-image-canary/image-canary.mjs --strict`): pages when a pinned ECR
# tag referenced by any task def/schedule has expired or is near the lifecycle fuse. The COPY list
# here is selective, so a schedule override pointing at a skill NOT copied dies MODULE_NOT_FOUND
# at runtime while RunTask reports success -- exactly the silent class the canary exists to catch.
COPY skills/aws-image-canary/ /app/skills/aws-image-canary/
# decision-clock (cron daily): decision.mjs sweep --dispatch reads Cosmos decisions_pending and
# execFileSync's fleet-dispatch/dispatch.mjs to send ONE batched per-owner overdue-gate nudge.
COPY skills/decision-clock/ /app/skills/decision-clock/
# signal-radar (cron ~30 min): radar.mjs scan --emit runs the 5 detectors and execFileSync's
# fleet-dispatch/dispatch.mjs to route above-threshold signals to the owning agent's inbox.
COPY skills/signal-radar/ /app/skills/signal-radar/
# fleet-dispatch: the shared per-owner inbox dispatcher both decision-clock and signal-radar shell
# out to (execFileSync node .../fleet-dispatch/dispatch.mjs send <owner> <msg> --from <src>).
COPY skills/fleet-dispatch/ /app/skills/fleet-dispatch/
# grant-tracker: signal-radar's grant-burn-expiry detector reads grant-tracker/grants.json to flag
# grants whose term lapsed but still show status=active (may now be billing at full cash rate).
COPY skills/grant-tracker/ /app/skills/grant-tracker/
# ledger-compaction: the daily Container App Job (compaction.sh -> run-compaction.mjs) that reads each
# agent's kb-memory ledger and writes a non-destructive compacted summary. Imports kb-memory (above).
COPY skills/ledger-compaction/ /app/skills/ledger-compaction/
# compute-allocator + fleet-telemetry: fleet-dispatch's send now consults compute-allocator on TASK
# dispatches (fan-out/model/critic recommendation), and allocate.mjs resolves the model tier via
# fleet-telemetry/task-router.mjs and live signals via signal-radar (copied above). The dispatch import
# is dynamic + fail-open, so these are only needed when a JOB (signal-radar/decision-clock) shells a
# --task dispatch; copying them lets that path produce the recommendation instead of silently skipping it.
COPY skills/compute-allocator/ /app/skills/compute-allocator/
COPY skills/fleet-telemetry/ /app/skills/fleet-telemetry/
# ring-memory-index: the daily semantic reindex of each ring-ISOLATED agent memory ledger (CLO legal,
# CFO finance) into its own AI Search index, so ring agents recall their OWN memory by meaning (the
# per-ring equivalent of memory-exec). Self-resolves each ring store's creds from SM via the SA; ring-safe.
COPY skills/ring-memory-index/ /app/skills/ring-memory-index/
# cfo-reconstruction (cron nightly): reconstruct.mjs sweep -- advances the CFO's book-reconstruction
# ANALYSIS (read-only Xero snapshots + an optional staged manifest drain) and stages a batch for
# sign-off. See runbooks/cfo-reconstruction-job.md. Needs gateway-connect (the cfo-lane bearer) and
# cfo-onedrive (the CFO Incoming mirror) below; cfo-store/decision-clock/kb-memory are already
# copied above.
COPY skills/cfo-reconstruction/ /app/skills/cfo-reconstruction/
COPY skills/gateway-connect/ /app/skills/gateway-connect/
COPY skills/cfo-onedrive/ /app/skills/cfo-onedrive/
# growth-room (cron nightly): growth-room.mjs sweep -- pulls read-only cross-app growth signal
# (Capgo OTA statistics, RevenueCat subscription/MRR, PostHog per-app funnel) and stages ONE dated
# digest into the commons brain. Only needs kb-memory (already copied above) + cfo-store (already
# copied above) for its own imports/execFileSync calls.
COPY skills/growth-room/ /app/skills/growth-room/
# innd-stock (EventBridge schedule otchealth-innd-stock-daily, cron 22:30 UTC Mon-Fri): appends the
# day's INND close to the CFO price-history workbook in the S3 commons. Added 2026-09-01 because the
# ECS job was running a STALE COPY of this script -- a pre-S3-port build baked into an S3 env file as
# SKILL_MJS_B64 -- so the merged S3 port never reached production and every weekday run died on
# `Azure download 403 AccountIsDisabled`. Baking the skill into the image is what every other job
# here does and makes the deployed code track main (build-doc-indexer-ecr.yml rebuilds on merge).
# The alternative, a runtime `git clone`, fails outright: node:24-slim ships no git (proved live,
# task f0a5b0cf exit 127, "/bin/sh: 1: git: not found").
COPY skills/innd-stock/ /app/skills/innd-stock/
# safety-monitor (EventBridge schedule otchealth-safety-monitor, hourly): job/sweep.sh runs
# monitor.mjs sweep --commit, scanning recent Intercom conversations for customer-reported safety
# hazards, tagging matches and publishing one SNS alert each. Added 2026-09-02 after a pre-deploy
# rehearsal ran the registered task def and got `/bin/sh: 0: cannot open
# /app/skills/safety-monitor/job/sweep.sh: No such file` -- the exact trap the aws-image-canary
# comment above warns about, walked into by the person who read it. Its only imports are
# kb-memory's azure-secret/aws-secret/sigv4, all already copied above.
COPY skills/safety-monitor/ /app/skills/safety-monitor/
# datadog: pure library, no job of its own. fleet-medic (copied above, scheduled every 30 min) and
# token-keeper both `import { ddMetric } from "../datadog/dd-emit.mjs"` as of claude-tools #448, so
# WITHOUT this line the fleet-medic task crash-loops on ERR_MODULE_NOT_FOUND the moment the image
# rebuilds -- a second instance of the safety-monitor trap directly above, one level down: the skill
# itself was copied, the thing it imports was not. Caught by simulating the image's file layout after
# the merge, and now enforced by the import-closure test in tests/dockerfile-job-coverage.test.mjs.
COPY skills/datadog/ /app/skills/datadog/
# semantic-trust: pure library (trust.mjs), no job. kb-memory's contradiction-scan.mjs imports
# groupAssertions/scoreClaim from it, and job/contradiction-scan.sh ships inside the image, so the
# same MODULE_NOT_FOUND waits there. LATENT today, not live: verified 2026-09-02 that no EventBridge
# schedule targets contradiction-scan (it is deliberately disarmed pending Matt's arming decision).
# Copying a pure library arms nothing -- it only removes the trap that would fire on the day it is armed.
COPY skills/semantic-trust/ /app/skills/semantic-trust/
# Bake the one dependency (xlsx) so a scheduled run never npm-installs mid-job. innd-stock.mjs keeps
# its lazy-install fallback for a fresh checkout, but production should never need it.
RUN cd /app/skills/innd-stock && npm install --omit=dev --no-audit --no-fund
ENTRYPOINT ["node", "/app/skills/doc-indexer/indexer.mjs"]

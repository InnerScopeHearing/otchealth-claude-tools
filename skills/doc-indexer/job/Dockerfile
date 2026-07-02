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
# fleet-medic: the auto-dispatch memory medic job (fleet-medic.sh -> medic.mjs scan --dispatch).
# medic.mjs execs kb-memory/mem.mjs team-health (copied above) for its deterministic health spine.
COPY skills/fleet-medic/ /app/skills/fleet-medic/
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
ENTRYPOINT ["node", "/app/skills/doc-indexer/indexer.mjs"]

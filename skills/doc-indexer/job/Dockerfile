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
ENTRYPOINT ["node", "/app/skills/doc-indexer/indexer.mjs"]

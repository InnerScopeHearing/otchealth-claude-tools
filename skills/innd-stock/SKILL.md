---
name: innd-stock
description: Maintains the CFO's INND (InnerScope Hearing Technologies, OTC: INND) daily stock-price history as one continually-updated Excel workbook. HYBRID source - Massive (a Polygon.io white-label) for the most recent ~2 years (TRUE volume-weighted VWAP + per-day TRADE COUNT + OTC consolidated tape) merged with Yahoo Finance for the deep history back to 2017-03-15. Captures OHLCV, VWAP, trade count, daily change, two dollar-value measures (Close x Vol and the accurate Vol x VWAP traded value), and a press-release column. Stores in the CFO source-doc bucket (GCS) and appends each new trading day (idempotent). Public market data for INTERNAL CFO record-keeping only, not investor-facing publishing or stock promotion (securities firewall safe). Non-PHI ring.
---

# INND daily stock-price history (CFO records)

One Excel workbook, continually updated, of INND's daily market performance for the CFO's
records. **Public market data only, internal record-keeping** (not IR publishing, not stock
promotion). Non-PHI ring; INND material stays internal (securities firewall).

## What it captures (per trading day)
Date, Open, High, Low, Close, **Split-Adj Close**, Volume, **VWAP**, **Trades** (count), Daily
Change ($ and %), **Dollar Volume (Close x Vol)**, **Traded Value (Vol x VWAP)**, Day Range,
a populated **Press Release / Corporate Event** column, and a per-row Source tag. Plus two
extra sheets: "About" (sources, basis, the two dollar-value methods) and **"Corporate Actions"**
(the verified reverse split + the dated press-release log).

## Price basis = AS-TRADED (with a split-adjusted column)
All OHLC / Volume / VWAP are **as-traded** (what actually changed hands that day). INND did a
**1-for-2500 reverse split on 2024-08-22** (verified: Polygon reference + Seeking Alpha). Yahoo
reports a split-adjusted series, so its deep history is de-split back to as-traded here (price /
2500, volume x 2500 before 2024-08-22; this ties out exactly to Polygon's raw feed). The
**Split-Adj Close** column is the continuous comparable series, and **Daily Change is computed on
it**, so the reverse split is not shown as a fake ~2500x one-day move (the as-traded Close does
jump on the split date by design, since that is what the tape shows). The reverse split is loaded
from `innd-events.json` via a split-factor function, so adding a future split is a one-line edit.

## Sources (HYBRID - best of both)
- **Massive** (`api.massive.com`) is a **Polygon.io white-label** - the same REST API + S3
  flat-files surface, same data, billed through massive.com. The plan authorizes **~2 years**
  of daily aggregates and includes, for INND specifically:
  - **TRUE VWAP** (`vw`): the real daily volume-weighted average price, not an approximation.
  - **Trade count** (`n`): the day's number of executed transactions (a real liquidity gauge
    for a thinly traded stock - some recent days have under 50 trades).
  - The **OTC consolidated tape** (`otc:true`).
  These cover the most recent ~24 months and every new day going forward.
- **Yahoo Finance** daily OHLCV + adjusted close covers the **deep history before** Massive's
  window (INND from **2017-03-15**). VWAP there is the typical-price proxy `(High+Low+Close)/3`,
  flagged per-row in the Source column; trade count is blank.
- The two are **merged by date; Massive wins on the overlap.** If the Massive keys are absent
  or a call fails, the skill degrades gracefully to Yahoo-only.

## The two dollar-value columns (read this)
- **Dollar Volume (Close x Vol)** = a simple proxy that prices the whole day's shares at the
  closing price. Can be materially wrong for a volatile sub-penny stock.
- **Traded Value (Vol x VWAP)** = the REAL money that changed hands = shares traded x VWAP
  (the average price each share actually traded at). This is the accurate turnover figure; for
  Massive rows it uses the true VWAP. Example: on 2026-06-11 the close was 0.0002 but the day's
  VWAP was 0.0001, so Close x Vol said ~$1,196 while the real traded value was ~$598.
  Neither column is a native feed field; both are computed here.

## Honest limits
- **History depth:** true VWAP + trade count cover ~2 years (the plan's REST window). The deep
  history (2017 -> ~2yr ago) is Yahoo OHLCV with the proxy VWAP and no trade count. Polygon
  flat-files (full history with transactions) exist in the bucket but downloads are NOT
  authorized on the current plan tier (listing is); a higher tier or the OTC-history add-on
  would unlock true VWAP + trades all the way back. See the CTO.
- **Share-structure caveat:** prices are AS-TRADED and NOT split-adjusted (INND has done
  reverse splits / large dilution - e.g. ~$625 in 2017, ~$0.50 mid-2024, sub-penny now). Adj
  Close == Close. Cross-period comparisons need a split-adjusted series + share-count history.
- INND is **not** an SEC/EDGAR filer; the Press Release / Event column is sourced from OTC
  Markets / company IR (added separately).

## Storage (GCS or Azure Blob)
`STORAGE_BACKEND` selects where the workbook lives:
- `gcs` (default): `gs://otchealth-cfo-source-docs/innd-stock/INND-daily-stock-history.xlsx`
  (override the bucket with `CFO_SOURCE_BUCKET`). Auth: `GCP_CLAUDE_DRIVER_SA_JSON`.
- `azure` (the funded-credit lane, used by the scheduled job): Azure Blob
  `azure://otchealthcfodata/innd-stock/INND-daily-stock-history.xlsx` (storage account in
  `otchealth-automation-rg`, westus2). Auth: `AZURE_STORAGE_ACCOUNT` + `AZURE_STORAGE_KEY`
  (+ `AZURE_STORAGE_CONTAINER`, default `innd-stock`), SharedKey. Set `MIRROR_GCS=1` to also
  write the legacy GCS copy each run during the transition.
One file that grows over time, either way.

## Commands
```
node skills/innd-stock/innd-stock.mjs backfill      # build the full-history workbook + upload (run once)
node skills/innd-stock/innd-stock.mjs update         # append new trading days + refresh the recent Massive window, re-upload (run daily after close)
node skills/innd-stock/innd-stock.mjs status         # show last date + row count in the stored workbook
node skills/innd-stock/innd-stock.mjs local <file>   # write the full workbook to a local path (no upload)
```
Credentials (hydrated from `otchealth-shared-prod` by `setup/fetch-secrets.mjs`):
`GCP_CLAUDE_DRIVER_SA_JSON` (GCS read/write), `MASSIVE_API_KEY` (+ optional `MASSIVE_API_KEY_2`
for rate-limit failover; ~5 req/min/key). The S3 flat-files creds (`massive-s3-*`) are stored
but fetched on demand only. `xlsx` (SheetJS) auto-installs on first run.

## Keeping it updated (the daily skill)
Run `update` once per business day after the US market close (~4pm ET). It downloads the stored
workbook, fills any new Yahoo day, then overlays the recent Massive window (true VWAP + trade
count, refreshing the tail), and re-uploads. Idempotent, safe to re-run.

### Automated on Azure (LIVE)
The update runs automatically on an **Azure Container Apps Job** (the funded-credit lane):
- Job `innd-stock-daily` in RG `otchealth-automation-rg` (westus2), environment
  `otchealth-jobs-env`. Schedule: cron `30 22 * * 1-5` (weekdays 22:30 UTC, after the US close).
- It runs `node:20-slim`, injects the skill from job secrets (base64), `npm i xlsx`, and runs
  `update` with `STORAGE_BACKEND=azure` -> writes Azure Blob. No registry or repo clone needed.
- Trigger a manual run: `POST .../Microsoft.App/jobs/innd-stock-daily/start` (ARM, azure-sp).
- IMPORTANT: the skill code is baked into the job's `skill-mjs-b64` / `skill-events-b64`
  secrets, so it is FROZEN at deploy time. When this skill or `innd-events.json` changes,
  re-deploy the job (re-PUT it with fresh base64) so the job runs the new code.

## Guardrails
- Public market data, internal CFO records only. Never publish, post, or use for stock
  promotion; INND is a public company (securities firewall).
- Non-PHI ring.
- Massive/Polygon credentials live in Secret Manager, flagged for rotation; never in chat or a repo.

---
name: innd-stock
description: Maintains the CFO's INND (InnerScope Hearing Technologies, OTC: INND) daily stock-price history as one continually-updated Excel workbook. Backfills full daily OHLCV + adjusted close + volume + a VWAP column + dollar volume + daily change from Yahoo Finance (free, INND from 2017-03-15), stores it in the CFO source-doc bucket (GCS), and appends each new trading day (idempotent). Public market data for INTERNAL CFO record-keeping only, not investor-facing publishing or stock promotion (securities firewall safe). Non-PHI ring.
---

# INND daily stock-price history (CFO records)

One Excel workbook, continually updated, of INND's daily market performance for the CFO's
records. **Public market data only, internal record-keeping** (not IR publishing, not stock
promotion). Non-PHI ring; INND material stays internal (securities firewall).

## What it captures (per trading day)
Date, Open, High, Low, Close, Adjusted Close, Volume, VWAP, Daily Change ($ and %),
Dollar Volume (Close x Volume), Day Range, a Press Release / Corporate Event column, and the
source tag. A second "About" sheet records the source, the VWAP note, and the share-structure
caveat.

## Source + honest limits
- **Yahoo Finance** daily OHLCV + adjusted close. Free, covers INND from **2017-03-15** to
  present (pre-2017 is not available there; this fully covers the 2020 ask + 3 extra years).
- **VWAP** is the daily TYPICAL-PRICE approximation `(High+Low+Close)/3`. True intraday
  volume-weighted VWAP and per-day **trade counts** are not in the free daily feed. Upgrades:
  Yahoo *intraday* bars (free) give a true VWAP for recent days + ~2yr via hourly bars;
  Polygon.io gives true daily `vw` + trade count `n` (free key = 2yr, paid = 5yr+). See the
  CTO if you want these wired.
- **Share-structure caveat:** prices are AS-TRADED and NOT split-adjusted (INND has done
  reverse splits; Yahoo does not carry them, so Adj Close == Close). Cross-period comparisons
  need a split-adjusted series + share-count history (ask the CTO).
- INND is **not** an SEC/EDGAR filer; the Press Release / Event column is sourced from OTC
  Markets / company IR (added separately).

## Storage
Canonical workbook lives in the CFO source-doc bucket:
`gs://otchealth-cfo-source-docs/innd-stock/INND-daily-stock-history.xlsx`. It is one file that
grows over time. (Override the bucket with `CFO_SOURCE_BUCKET`.)

## Commands
```
node skills/innd-stock/innd-stock.mjs backfill      # build the full-history workbook + upload (run once)
node skills/innd-stock/innd-stock.mjs update         # append any new trading days, re-upload (run daily after close)
node skills/innd-stock/innd-stock.mjs status         # show last date + row count in the stored workbook
node skills/innd-stock/innd-stock.mjs local <file>   # write the full workbook to a local path (no upload)
```
Credentials: `GCP_CLAUDE_DRIVER_SA_JSON` (GCS read/write). `xlsx` (SheetJS) auto-installs on
first run.

## Keeping it updated (the daily skill)
Run `update` once per business day after the US market close (~4pm ET). It downloads the stored
workbook, fetches the last ~60 days from Yahoo, and appends only trading days not already
present (idempotent, safe to re-run). Schedule it via n8n (daily cron) or a GitHub Actions
scheduled workflow; the CTO can wire the schedule.

## Guardrails
- Public market data, internal CFO records only. Never publish, post, or use for stock
  promotion; INND is a public company (securities firewall).
- Non-PHI ring.

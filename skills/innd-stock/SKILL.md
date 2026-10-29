---
name: innd-stock
description: Maintains the CFO's INND (InnerScope Hearing Technologies, OTC: INND) daily stock-price history as one continually-updated Excel workbook. HYBRID source - Massive (a Polygon.io white-label) for the most recent ~2 years (TRUE volume-weighted VWAP + per-day TRADE COUNT + OTC consolidated tape) merged with Yahoo Finance for the deep history back to 2017-03-15. Captures OHLCV, VWAP, trade count, daily change, two dollar-value measures (Close x Vol and the accurate Vol x VWAP traded value), and a press-release column. Stores the canonical workbook and publishes byte-verified copies plus a CSV sidecar to the CFO source-doc reader paths. Public market data for INTERNAL CFO record-keeping only, not investor-facing publishing or stock promotion (securities firewall safe). Non-PHI ring.
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
2500, volume x 2500 before 2024-08-22; spot-checked against Polygon on 2024-06-24). The
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
- **Traded Value (Vol x VWAP)** = shares traded x provider VWAP for Massive rows, or an
  estimated turnover figure using the typical-price proxy for older Yahoo rows. It is stock
  trading turnover, not cash raised by the company. Example: on 2026-06-11 the close was 0.0002 but the day's
  VWAP was 0.0001, so Close x Vol said ~$1,196 while the real traded value was ~$598.
  Neither column is a native feed field; both are computed here.

## Honest limits
- **History depth:** true VWAP + trade count cover ~2 years (the plan's REST window). The deep
  history (2017 -> ~2yr ago) is Yahoo OHLCV with the proxy VWAP and no trade count. Polygon
  flat-files (full history with transactions) exist in the bucket but downloads are NOT
  authorized on the current plan tier (listing is); a higher tier or the OTC-history add-on
  would unlock true VWAP + trades all the way back. See the CTO.
- **Share-structure caveat:** OHLC, Volume, and VWAP are AS-TRADED. The separate Split-Adj Close
  column is adjusted for the verified 2024-08-22 1-for-2500 reverse split, and Daily Change uses
  that comparable series. The point check on 2024-06-24 matched Yahoo's split-adjusted close / volume
  to Massive's raw as-traded values after applying the split factor; this spot check does not verify
  every historical row. Cross-period market-cap comparisons also need share-count history.
- INND is **not** an SEC/EDGAR filer; the Press Release / Event column is sourced from OTC
  Markets / company IR (added separately).

## Storage and CFO reader copies
The canonical binary workbook is the logical S3 mirror URI
`s3://otchealthcfodata/innd-stock/INND-daily-stock-history.xlsx` (the `s3-blob.mjs` mapping resolves
this to the physical finance-legal DR bucket).
Each `backfill` or `update` also writes identical workbook bytes to
`otchealthcfodata/cfo-source-docs/innd-stock/INND-daily-stock-history.xlsx` and a CSV text sidecar
to `otchealthcfodata/cfo-source-docs/_TEXT/innd-stock/INND-daily-stock-history.xlsx.txt`. The
publisher reads the canonical workbook and both CFO reader objects back and requires exact byte equality, reporting each workbook SHA-256 hash.
This verifies storage bytes only; it does not prove that any downstream reader indexed or can access
the copies. A publication write or readback failure fails the command.

Daily bars dated after the latest completed 16:00 session in `America/New_York` are excluded, so an
update during market hours cannot append a partial current-day bar. On weekends and holidays the
cutoff may be a calendar date without a session; available bars remain unchanged.

## Commands
```
node skills/innd-stock/innd-stock.mjs backfill      # build the full-history workbook + upload (run once)
node skills/innd-stock/innd-stock.mjs update         # append new trading days + refresh the recent Massive window, re-upload (run daily after close)
node skills/innd-stock/innd-stock.mjs status         # show last date + row count in the stored workbook
node skills/innd-stock/innd-stock.mjs local <file>   # write the full workbook to a local path (no upload)
```
The skill uses the existing AWS credential chain from `s3-blob.mjs` and the existing
`MASSIVE_API_KEY` (+ optional `MASSIVE_API_KEY_2` for rate-limit failover); it introduces no new IAM
grant, secret, or provider. `xlsx` (SheetJS) auto-installs on first run.

## Keeping it updated (the daily skill)
Run `update` once per business day after the US market close (~4pm ET). It downloads the stored
workbook, fills any new Yahoo day, then overlays the recent Massive window (true VWAP + trade
count, refreshing the tail), and re-uploads. Idempotent, safe to re-run.

### Automated on AWS (LIVE)
The existing scheduled update runs through EventBridge at **22:30 UTC weekdays** and starts the
`otchealth-job-innd-stock-daily` ECS task, ARM64, using the doc-indexer image. A scoped release
can pin the stock task to its verified immutable image digest.
The task uses the existing runtime configuration and AWS role; this skill adds no grant or key.
The schedule/task can lag code changes until its image is rebuilt and task definition updated.

## Guardrails
- Public market data, internal CFO records only. Never publish, post, or use for stock
  promotion; INND is a public company (securities firewall).
- Non-PHI ring.
- Massive/Polygon credentials use the existing AWS SSM bindings; never put values in chat or a repo.

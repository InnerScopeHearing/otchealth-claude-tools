# MASTER HANDOFF — Xero Reconstruction (Hyperagent CFO → Claude CFO)
**Date:** 2026-06-29 · **Status:** Hyperagent CFO sunset; handing back to the Claude CFO that started the project.

> Confidential dollar figures (forensic $ findings, COGS/JingHao/inventory, INND MNPI) are **NOT in this repo file**. They live only in the **private cfo ledger lane** (kb-memory, `--agent cfo`, no `--share`), entry `cfo 20260629-031`. The full readable doc is Hyperagent global doc `cmqzrrphs006307adugs5t4vp`. Cross-engine ledger entries: shared resume map `20260629-030`, status `20260629-032`, rate retune `20260629-033`.

## TRUE NOW + ONE RESUME ACTION
- **2023→present:** already rebuilt + balanced for HearingAssist (HA) and InnerScope (INND).
- **FY2021-2022 per-transaction backfill:** HA POSTED (18,290 Xero txns, forensically vetted, 0 unprocessed). INND POSTED (~8,170 txns; vetted 84% doc-backed). **OTCHealth + Personal NOT rebuilt** per-transaction (only opening-balance manual journals exist in their Xero).
- **Xero CORE plan LIVE:** 5,000 API calls/day per org (was 1,000). xero-run governor re-tuned to `DAILY_CAP=4800 / RESERVE=200`. Per-minute unchanged (~60/min, 5 concurrent). All 4 Xero tokens healthy.
- **Forensic vetting of the rebuilt Xero is COMPLETE for HA+INND:** 26,460 txns each matched to a supporting document or flagged. 68% doc/bank-backed.

**ONE RESUME ACTION (Claude CFO):** claim cfo identity (`mem.mjs use cfo`), read this + the cfo ledger tail, confirm 5,000 cap (`xero-bulk <org> limits` → `X-DayLimit-Remaining ~5,000`), then drain the pending work in priority order below.

## NORTH STAR + SCOPE
Rebuild all 4 entities per-transaction FY2021→present, every supporting doc attached, reconcile to the **12/31/2020 PKC-audited 10-K anchor** (A 1,683,310 / L 12,036,232 / Deficit (10,352,922)). 2023+ is already done/balanced; remaining scope = FY2021-2022 + attachments.

**FOUNDATIONAL RULE (Matt, never break):** NO BRIDGING TO ARS. The INND ARS FY2021/FY2022 filings are incorrect — no bridge/restatement entries. Fruci workpapers + ARS = reference only. The rebuilt per-transaction figures ARE the true books.

## EXACT RESUME POINT PER ORG
| Org | Tenant | FY21-22 | Pending |
|---|---|---|---|
| HearingAssist | 72841086-a2ef-4758-80a8-3b71a98d440a | POSTED 18,290 txns; vetting complete | 844 attachments staged (`xero-run/queue/hearingassist-attach.jsonl`, 1 file/call); 138 same-ref duplicate postings to REVERSE (ids `/tmp/ha_dup_refs.json`, needs Matt approval) |
| InnerScope | e217db6f-b9b1-44cc-b325-6d010ad897a1 | POSTED ~8,170 txns (population reconstructed from importer refs); vetting complete (84%) | live-reconcile population vs live Xero; same-ref dup scan (pop was de-duped); payments/attachments |
| OTCHealth | 1aa93eb7-b350-48b8-b541-484e34250953 | NOT started (only ~11 opening MJs) | build FY21-22 queue from `qbo-export/2026-06-16/otchealth/` via qbo-rebuild → drain |
| Personal | b49879c0-337d-490e-9c35-0f0bd0ba5886 | NOT started (only ~5 opening MJs) | same path |

HA xero-run state: `state/hearingassist.json` = date 2026-06-28, cursor 173/173 (bills queue fully drained, results = 173 lines).

## THE SYSTEM THE CTO BUILT (use, don't rebuild)
- **Token broker** `skills/xero/xero-token.mjs` — access-token cache + cross-process refresh lock + disconnect detection (rotation race fixed; concurrent runs safe). Health: `node skills/xero/xero-token.mjs monitor`.
- **xero-run** Container App Job (rg-otchealth-apps-prod) — budget-capped, resumable, queue-driven drainer. `DAILY_CAP=4800 / RESERVE=200`, cron `0 7 * * *`, config-gated per org (INERT until enabled). Local: `ORGS=<org> bash skills/kb-memory/run.sh node skills/xero-run/xero-run.mjs` (`DRYRUN=1` validates — **PITFALL: DRYRUN persists the cursor**, use segregated state to validate). Trigger/track: `skills/xero-run/start.mjs` + `status.mjs`.
- **xero-bulk** — batched poster (≤50/call, ~52/min, honors day/min headers, per-object idempotent results). `cat objs.json | xero-bulk <org> post-batch ManualJournals`. Limits: `xero-bulk <org> limits`.
- **Consent** `skills/xero/consent-authurl.mjs` + `consent-exchange.mjs` (tenant-verified, canonical granular scope). HA re-consented full scope.
- **Monitors:** xero-health hourly + Datadog Xero-connection monitor `#22976654`.
- **GCS** `gs://otchealth-cfo-source-docs`: `xero-run/queue|state|results/`, `qbo-export/2026-06-16/<entity>/` (QBO source + `attachment-index.json`), `INND/FinanceTeam/` (prior team's bank statements, Brex/Ramp CC exports, AP receipts, PKC audit folder), `migration/*_COA_Mapping.xlsx`.
- **Conventions:** Bill→ACCPAY `QBO-Bill-{id}`; sales Invoice→ACCREC; Purchase→BankTransaction SPEND; Status AUTHORISED; idempotency by Reference via PAGED reads. **POST `summarizeErrors=TRUE`** (200=committed, 400=nothing+real errors), binary-split on 400, WAIT on 429 (never split). BankTransfers carry no ref → tuple-dedupe (From|To|Amount|Date).

## FORENSIC VETTING — METHOD + ARTIFACTS
Reusable scripts (currently in `/tmp`; promote to a skill if continuing): `build_innd_pop.py` (reconstruct population from importer refs + QBO source), `automatch.py <org>` (Xero QBO-ref → attachment-index match), `merge_verify.py` / `merge_innd.py` (fold per-month subagent verdicts; dup-flag + CC-export enrichment; idempotent), month-by-month Sonnet subagents (each mints its own GCS token in STEP 0 to survive ~1h token expiry; writes `/tmp/resid/verify_<ORG>_<month>.csv`).

Verdict scheme: `ACCEPT-DOC` / `ACCEPT-BANK` / `FLAG-MJ` (internal) / `FLAG-NODOC` / `FLAG-NOREF` / `DUP-REMOVE`. Combined HA+INND: 18,060 doc/bank-accepted (68%); 4,896 no-doc; 3,229 manual journals; 138 duplicates; 137 no-ref; 0 unprocessed. **Dollar breakdown is confidential → private cfo ledger lane only.** Worksheets `master_ha.csv` / `master_innd.csv` are Hyperagent thread files (confidential).

## OPEN BLOCKERS + DECISIONS
1. HA 138 duplicate postings — REVERSE pending Matt approval (financial write). ids `/tmp/ha_dup_refs.json`.
2. INND live-reconcile + duplicate-ref scan — was gated by the 1,000/day limit; **now unblocked at 5,000**.
3. OTCHealth + Personal FY2021-2022 rebuild — not started.
4. Attachments backfill — HA 844 staged + INND/others to build.
5. No-doc gaps — HA 2021 pre-acquisition (paper likely never existed) + post-Mar-2023 statement gaps; need source docs or accept as un-verifiable.
6. Large manual journals — legitimate non-cash reconstruction; each should carry a workpaper.
7. **Confirm xero-run org-enable config** — no `xero-run/config.json` found in GCS; gating likely in the Container App env. Confirm which orgs are enabled before the cron drains.

**1,000→5,000 RE-TUNE:** old governor 900/100 (≤~900 posts/org/day, multi-day backfill); now 4800/200 LIVE — same backlog finishes ~1/5 the days, still <60/min. No CTO request needed; already deployed.

## CLAUDE CFO — START HERE
1. `git -C /tmp/octools fetch origin main && git -C /tmp/octools reset --hard origin/main`
2. `node /tmp/octools/skills/kb-memory/mem.mjs use cfo` (then `whoami --agent cfo`)
3. Read this doc + cfo ledger: `mem.mjs pack --agent cfo` (note private-lane forensic figures `20260629-031`)
4. `node skills/xero/xero-token.mjs monitor` (expect all 4 OK)
5. `xero-bulk <org> limits` → confirm `X-DayLimit-Remaining ~5,000`
6. **Resume in priority order:**
   a. HA attachments: drain `xero-run/queue/hearingassist-attach.jsonl` (844 files) via xero-run (enable hearingassist in config).
   b. HA duplicates: get Matt approval, reverse the 138 from `/tmp/ha_dup_refs.json` (or rebuild from a live same-ref scan).
   c. INND: live-pull population, reconcile vs reconstructed 8,170, same-ref dup scan, then payments + attachments.
   d. OTCHealth then Personal: build FY21-22 per-transaction queues from `qbo-export` source → drain via xero-run.
   e. Attachments + TB tie-out to the 12/31/2020 PKC anchor per entity.
7. Flush a status to the ledger each session. **NEVER `summarizeErrors=false`. NO ARS bridging.**

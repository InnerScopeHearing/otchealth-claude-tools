# Daily Summary — 2026-06-27

**Repo:** otchealth-claude-tools  
**Branch:** main  
**Period:** last 24 hours (since 2026-06-26 22:46 PDT)

---

## What changed

### Single commit: `98baea5` — 2026-06-26 22:46 PDT

> feat(gap): cred-health token-age emitter (otc.fleet.token_age_hours, daily via token-keeper cron) + plaid-banking SM-self-hydrate portability fix

This was the initial import of the entire toolkit (517 files, 54 626 insertions). Two specific **gap-fills** were called out in the commit title:

---

### 1. Cred-health token-age emitter (`skills/datadog/cred-health.mjs`)

**Problem solved:** Rotating OAuth tokens (Xero 60-day sliding, QuickBooks 100-day) die silently if nothing re-persists the rotated value. The previous failure mode was the Stripe MCP "invalid refresh token" incident — the token expired with no warning.

**What was added:**
- New script `skills/datadog/cred-health.mjs` reads the `createTime` of the latest Secret Manager version for each rotating secret and emits **`otc.fleet.token_age_hours`** (Datadog gauge, tagged `secret:<id>`) for:
  - `xero-refresh-token-otchealth`
  - `xero-refresh-token-innd`
  - `xero-refresh-token-hearingassist`
  - `xero-refresh-token-personal`
  - `quickbooks-refresh-token`
- Static keys (PAT / SA / ASC) are intentionally excluded — this is breakage-prevention (age of last rotation), not a security-rotation reminder, per the CEO 30-day no-rotation-reminder directive.
- Integrated into the **token-keeper daily cron** so the metric is emitted automatically alongside each refresh pass.
- Fail-open per secret — a missing or unreachable secret logs a warning and does not abort the run.

**Observability impact:** Datadog can now alert before a token hits its idle-expiry cliff. The Xero 60-day window means an alert at e.g. 40 days gives a 20-day remediation window.

---

### 2. Plaid-banking SM self-hydrate portability fix (`skills/plaid-banking/plaid.mjs`)

**Problem solved:** On HyperAgent, the session environment only provides `GCP_CLAUDE_DRIVER_SA_JSON`; `PLAID_CLIENT_ID` / `PLAID_SECRET` are NOT pre-hydrated into env vars. The previous code exited with "Missing credentials" when run from HyperAgent.

**What was added:**
- A `getCreds()` lazy-loader that first checks env vars (Claude Code path), then falls back to self-hydrating `plaid-client-id` and `plaid-secret` from GCP Secret Manager using the claude-driver SA JWT — identical pattern to the fix already applied in `skills/xero/xero.mjs`.
- Makes `plaid.mjs` fully portable across Claude Code and HyperAgent with zero config difference.
- Secret values are never printed or logged (SM call only returns the value to memory).

---

## No regressions noted

The rest of the 517-file import (app-kit, avatar-pipeline, dream-team, skills, tests, workflows) is the established toolkit baseline. No files were modified or deleted.

---

## Action items / follow-ups

| # | Item | Owner |
|---|------|-------|
| 1 | Wire `cred-health.mjs` Datadog alert: `otc.fleet.token_age_hours > 1000` (Xero ~42 days) | CTO |
| 2 | Confirm `skills/datadog/` is called in `skills/token-keeper/run.sh` daily job | CTO |
| 3 | Verify `plaid-client-id` secret exists in `otchealth-shared-prod` SM (no `plaid-client-id` vs `plaid-client_id` typo) | CTO |

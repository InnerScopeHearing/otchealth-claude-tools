---
name: quickbooks
description: Drive MULTIPLE QuickBooks Online company files (realms) from one place for the CFO data pipeline. One Intuit app authorized to many companies (OTCHealth, InnerScope/INND, HearingAssist, and Matthew's personal books), each with its own realmId + refresh token. Read (query) and write (bills, expenses, journal entries) per company. Wielded by the CFO / finance agent. Solves the single-company limit of the prebuilt QuickBooks connector. Entity scoping is HARD: OTCHealth writes open; INND + HearingAssist (INND subsidiary) writes gated + logged (public company, counsel); personal books carry the related-party / due-to-officer loans that must reconcile against the company side.
---

# QuickBooks Online, multi-company (CFO)

The prebuilt QuickBooks MCP connector is single-company (one OAuth = one realm). The CFO
needs four company files, so we use our OWN Intuit app + the QBO REST API, where one app
is authorized to many companies. Each company has its own realmId + refresh token in the
vault; this helper targets any company by key.

## The four companies (keys)
- `otchealth` -> OTCHealth Inc. (writes OPEN)
- `innd` -> InnerScope / INND (PUBLIC co; writes GATED + logged, counsel)
- `hearingassist` -> HearingAssist (INND subsidiary; consolidates into INND; gated ring)
- `personal` -> Matthew Moore personal books (the loans/payments back and forth book as
  due-to/due-from officer and reconcile against the company side)

## Auth model
1. **Refresh -> access token:** POST the company's refresh token to
   `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` (grant_type=refresh_token,
   Basic auth = base64(client_id:client_secret)) -> a ~1-hour access token.
2. **Call the API:** `https://quickbooks.api.intuit.com/v3/company/{realmId}/...` with
   `Authorization: Bearer <access_token>`.

**ROTATION GOTCHA (#1 operational risk):** Intuit issues a NEW refresh token on use and
resets the 100-day clock. A recurring sync MUST persist the rotated refresh token back to
the vault or it dies in ~100 days. The CLI flags rotation on stderr; the n8n recurring
job writes the new token back to Secret Manager.

## Credentials (Secret Manager -> env, hydrated each session)
Stored in `otchealth-shared-prod`, loaded by `setup/fetch-secrets.mjs`:
- `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` (`qbo-client-id`, `qbo-client-secret`) — the one app
- `QBO_ENV` (`qbo-env`; `production` or `sandbox`)
- Per company: `QBO_REALM_<KEY>` + `QBO_REFRESH_<KEY>` (e.g. `qbo-realm-otchealth` ->
  `QBO_REALM_OTCHEALTH`, `qbo-refresh-otchealth` -> `QBO_REFRESH_OTCHEALTH`), for
  OTCHEALTH / INND / HEARINGASSIST / PERSONAL.

## Setup (one-time, Matt)
1. Ensure the 4 QBO companies exist. QuickBooks Online Accountant holds multiple client
   companies (plus a personal one) under one login cost-efficiently.
2. Create ONE Intuit Developer app (developer.intuit.com) -> client_id + secret. Add the
   OAuth 2.0 Playground redirect URI.
3. Authorize the app to each company via the Intuit OAuth 2.0 Playground -> a realmId +
   refresh token per company.
4. The CTO stores client_id/secret + the 4 {realmId, refresh} pairs in the vault, then
   verifies with `company-info` per company.

## Procedure
```
node skills/quickbooks/qbo.mjs <company> company-info                       # connection probe
node skills/quickbooks/qbo.mjs <company> query "SELECT * FROM Account MAXRESULTS 50"
node skills/quickbooks/qbo.mjs <company> query "SELECT * FROM Bill WHERE TxnDate > '2026-01-01'"
echo '<json>' | node skills/quickbooks/qbo.mjs <company> request POST '/bill'   # create (gated)
```

## Guardrails (HARD)
- **Entity scoping.** OTCHealth writes open. INND + HearingAssist writes GATED + logged
  (public company; external financials need a human CPA + counsel). Never auto-post to INND
  or HearingAssist's books.
- **Source-of-truth.** Every posted entry ties to a real source document in the CFO Ledger.
  Ambiguous items go to Matt. Nothing fabricated.
- **Stage, then post.** Transactions/bills stage in the Notion CFO Ledger for review; the
  CFO posts to QBO after review, not blindly.
- **Money gate.** The CFO records and maintains; it never moves money or makes
  securities/cap-structure decisions.
- **Non-PHI ring.** No PHI ever enters the books or this pipeline.
- Secrets (client secret, refresh tokens) live in Secret Manager, flagged for rotation,
  never in chat or a repo.

## Notes
- `minorversion=73` is set on calls. Sandbox base is `sandbox-quickbooks.api.intuit.com`.
- Reports (P&L, balance sheet) are `query`/report endpoints under the same realm path.

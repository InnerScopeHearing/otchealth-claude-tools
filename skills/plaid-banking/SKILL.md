---
name: plaid-banking
description: Aggregate every bank + credit card for OTCHealth Inc. and InnerScope/INND through Plaid, so the CFO agent gets real-time balances and transactions for the books. Mints one access token per institution via the Link flow, then pulls cursor-based transaction deltas. Wielded by the CFO / finance agent. NON-PHI finance data only. Entity scoping is HARD: tag every account to OTCHealth vs INND; INND writes to the books are gated + logged (public company). All transactions stage into the Notion CFO Ledger for review, never auto-posted.
---

# Plaid banking (CFO data pipeline)

The CFO agent's tool for seeing all cash movement across both companies. Mercury is
already readable via its own MCP; Plaid covers the rest, the cards and personal/other
bank accounts that are invisible today and where the real burn is.

## Auth model (simple, no OAuth header)
Plaid puts `client_id` + `secret` in each request body. There are two phases:
1. **Link (once per institution, Matt does it):** create a `link_token`, run Plaid
   Link in a browser, log into the bank, get a short-lived `public_token`, then
   `exchange` it for a durable `access_token`. Store that token in the vault.
2. **Sync (recurring, automated):** call `/transactions/sync` with the access token +
   a cursor. Each run returns only what changed since the cursor (added / modified /
   removed), so it is a real-time delta feed, not a repeated full dump.

## Credentials (Secret Manager -> env, hydrated each session)
Stored in `otchealth-shared-prod`, loaded by `setup/fetch-secrets.mjs`:
- `PLAID_CLIENT_ID`   (`plaid-client-id`)
- `PLAID_SECRET`      (`plaid-secret`)
- `PLAID_ENV`         (`plaid-env`; `sandbox` until production access is approved, then `production`)
- Per-institution access tokens are stored as `plaid-access-token-<inst>` (e.g.
  `plaid-access-token-chase`) and fetched on demand with
  `node setup/get-secret.mjs plaid-access-token-<inst> -` (never emitted into the flat
  credentials.env). Pass the value to `sync`/`balances` as an argument.

## Procedure

1. **Link each institution (Matt, browser):**
   ```
   node skills/plaid-banking/plaid.mjs link-token cfo-otchealth   # -> link_token
   # Matt completes Plaid Link in a browser -> public_token
   node skills/plaid-banking/plaid.mjs exchange <publicToken>     # -> access_token (store in vault)
   ```
   Store the returned `access_token` as `plaid-access-token-<inst>` and record the
   institution + which ENTITY it belongs to (OTCHealth vs INND).

2. **Read balances (safe, anytime):**
   ```
   node skills/plaid-banking/plaid.mjs balances <accessToken>
   ```

3. **Sync transactions (the recurring feed):**
   ```
   node skills/plaid-banking/plaid.mjs sync <accessToken> [cursor]
   ```
   First run omits the cursor; persist `next_cursor` and pass it next time. The n8n
   recurring job iterates every stored institution token and stages new transactions
   into the Notion CFO Ledger (`Source = Bank feed`).

## Staging + guardrails (HARD)
- **Stage, never auto-post.** Transactions land in the CFO Ledger as `Staged`. The CFO
  reviews and posts to QuickBooks; nothing books to the ledger of record automatically.
- **Entity scoping.** Every account/token is tagged OTCHealth vs INND. OTCHealth
  bookkeeping is open; INND is a PUBLIC company, so any posting to its books is gated +
  logged, and external financials need a human CPA + counsel sign-off.
- **Intercompany.** Flag transfers between OTCHealth and INND (and capital
  contributions) for explicit intercompany treatment, do not net them silently.
- **Non-PHI ring.** No PHI ever touches this pipeline. It is finance data only.
- **Secrets.** `client_id`, `secret`, and every access token live in Secret Manager,
  flagged for rotation, never in chat or a repo.

## History limits (HARD Plaid facts, verified live 2026-06-17)
- **Plaid maxes out at 24 months (730 days) for BOTH transactions AND statements.**
  Plaid rejects a longer statements window with "Statements product only supports a
  maximum of 2 years of data." So Plaid CANNOT provide 3-4 years by any product.
- The old 90-day shortfall was because the link token never set `days_requested`
  (Plaid defaults to 90). The skill now requests the max (730) on every link.
- **`days_requested` / statements apply at LINK time.** An already-connected item only
  has the history it was linked with, so extending an existing connection requires a
  re-auth: `update-link <accessToken> [statements]` -> open the hosted URL -> re-consent.
  New links get 730 days automatically.
- **For 3-4 year history, do NOT use Plaid.** Use the QBO exports (back to 2015) + Xero
  in the GCS `cfo-store` bucket. Architecture: QBO/Xero = multi-year history of record;
  Plaid = the most recent 24 months (live reconciliation) + 24 months of PDF statements.

## Statements (PDF) + extra commands
The Statements product IS enabled on the account. Pull PDF statements (24 months) per item:
```
node skills/plaid-banking/plaid.mjs statements-list <accessToken>
node skills/plaid-banking/plaid.mjs statements-download <accessToken> <statementId> [outFile.pdf]
```
Other commands: `item <accessToken>` (config/products), `accounts <accessToken>`
(account list), `transactions <accessToken> [days]` (date-window pull via /transactions/get,
default+max 730), `update-link <accessToken> [statements]` (re-auth to backfill 730d / add statements).

Connected items (each token in SM as `plaid-access-token-<inst>`), entity-tagged, all
fresh-connected 2026-06-17 for the max 24-month history (+ statements where the institution
supports it):
- **OTCHealth:** `wellsfargo` (24mo + statements), `chase-amazon` (24mo + statements),
  `schwab` (~14mo, Schwab's institutional max; NO Plaid statements), `mercury-otchealth`
  (24mo + statements)
- **InnerScope (INND, internal only / securities firewall):** `mercury-innerscope`
  (24mo + statements; includes the DealMaker REG D + REG A raise accounts), `brex-innerscope`
  (24mo, low activity; NO Plaid statements)
- **HearingAssist (INND subsidiary):** `brex-hearingassist` (24mo; NO Plaid statements)

Lessons learned (2026-06-17): `update-link` (update mode) does NOT backfill extended history
on an already-connected item, so each was re-created as a FRESH connection (a fresh link's
initial pull honors days_requested=730). Schwab + Brex do NOT support the Statements product
(Plaid filters them out of a statements link, or returns ADDITIONAL_CONSENT_REQUIRED), so use
transactions-only links for them. Mercury DOES support statements via Plaid (the Mercury MCP
does not provide statements or detailed transactions, which is why Plaid Mercury was added).
Mercury and Brex are multi-entity logins: Mercury's company toggle separates OTCHealth vs
InnerScope cleanly, but Brex's session reuse does NOT, so InnerScope's Brex required a fresh
sign-in in an incognito window with the separate InnerScope Brex login.

## Notes
- `PLAID_ENV=production` is live (the production-access request is approved).
- Plaid access tokens are durable (no expiry) but revocable; rotate on any suspected
  exposure and on offboarding an institution.

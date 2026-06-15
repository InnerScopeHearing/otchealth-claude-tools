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

## Notes
- `PLAID_ENV=sandbox` works immediately with test credentials; `production` requires
  Plaid to approve the production-access request for the account.
- Plaid access tokens are durable (no expiry) but revocable; rotate on any suspected
  exposure and on offboarding an institution.

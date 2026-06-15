---
name: amazon-sp-api
description: Operate the OTCHealth Inc. Amazon Seller Central account through the Selling Partner API (SP-API) — listings, inventory, orders, pricing, reports — for selling the TReO PSAP products (and the rest of the catalog). Wielded by the CRO / commerce agent. Auth is LWA refresh-token -> access-token only (no AWS SigV4). Use when the task is creating/updating Amazon listings, checking FBA inventory, pulling orders, repricing, or running seller reports. COMPLIANCE: TReO is a PSAP, NOT a hearing aid — listing copy must carry no medical / FDA / hearing-aid / hearing-loss claims; route copy through the compliance lane before publishing.
---

# Amazon SP-API (OTCHealth seller account)

The single tool for managing the OTCHealth Inc. Amazon US seller account programmatically.
The CRO / commerce agent uses this to list, price, stock, and fulfill the TReO PSAPs (and
the wider catalog), and to read orders + reports.

## Auth model (simple — no AWS SigV4)
SP-API auth is two hops, both handled by `sp-api.mjs`:
1. **Refresh token -> access token**: POST the LWA refresh token to
   `https://api.amazon.com/auth/o2/token` (grant_type=refresh_token) -> a 1-hour access token.
2. **Call SP-API** with `x-amz-access-token: <access_token>` against the North-America host
   `https://sellingpartnerapi-na.amazon.com`. Amazon removed the old AWS IAM/SigV4 requirement,
   so there is NO request signing — just the bearer-style access token header.

## Credentials (Secret Manager -> env, hydrated each session)
Stored in `otchealth-shared-prod` and loaded as env vars (added to `setup/fetch-secrets.mjs`
when the tokens land):
- `AMZ_LWA_CLIENT_ID`      (`amzn1.application-oa2-client...`)
- `AMZ_LWA_CLIENT_SECRET`
- `AMZ_SP_REFRESH_TOKEN`   (`Atzr|...`)
- `AMZ_SELLER_ID`          (Merchant token, needed for Listings Items writes)
- `AMZ_MARKETPLACE_ID`     (default `ATVPDKIKX0DER` = Amazon US)
- `AMZ_SP_REGION`          (default `na`)

## Procedure

1. **Verify the connection FIRST** (do this once, right after the creds are stored, before
   relying on anything):
   ```
   node ~/.claude/skills/amazon-sp-api/sp-api.mjs verify
   ```
   This calls `GET /sellers/v1/marketplaceParticipations`. A 200 listing the seller's
   marketplaces = creds good. A 403/401 = the refresh token / client secret is wrong or the
   app role isn't granted yet.

2. **Read operations** (safe, no approval needed):
   ```
   node .../sp-api.mjs orders [createdAfterISO]     # GET /orders/v0/orders (default: last 7 days)
   node .../sp-api.mjs inventory                    # GET /fba/inventory/v1/summaries
   node .../sp-api.mjs request GET '/catalog/2022-04-01/items?identifiers=...&identifiersType=ASIN&marketplaceIds=ATVPDKIKX0DER'
   node .../sp-api.mjs request GET '/products/pricing/v0/price?MarketplaceId=ATVPDKIKX0DER&Asins=...'
   ```

3. **Write operations** (listings, pricing, inventory) — generic passthrough; body from stdin:
   ```
   echo '<json body>' | node .../sp-api.mjs request PUT  '/listings/2021-08-01/items/<sellerId>/<sku>?marketplaceIds=ATVPDKIKX0DER'
   echo '<json body>' | node .../sp-api.mjs request PATCH '/listings/2021-08-01/items/<sellerId>/<sku>?marketplaceIds=ATVPDKIKX0DER'
   ```
   Listings Items API (`/listings/2021-08-01`) creates/updates a SKU; the product-type schema
   comes from the Product Type Definitions API (`/definitions/2020-09-01/productTypes/...`).

## Compliance (HARD — do not skip)
- **TReO is a PSAP, NOT a hearing aid.** Amazon treats OTC hearing aids as a regulated category
  and the FTC polices amplifier claims. Listing titles, bullets, A+ content, and backend search
  terms must carry **no** "hearing aid", "hearing loss", "treats/restores hearing", FDA, or
  medical-device language. Frame as a personal sound amplifier.
- **Route listing copy through the compliance lane** (compliance-officer / CCO) BEFORE any
  PUT/PATCH that publishes copy. The agent drafts and operates; the claims posture is gated.
- Non-PHI ring. No PHI ever touches Amazon listings, metadata, or analytics.

## Notes
- Access tokens last ~1 hour; `sp-api.mjs` mints a fresh one per run (no caching needed for CLI use).
- Rate limits: SP-API is per-operation token-bucket. On HTTP 429, back off and retry; the script
  surfaces the status + `x-amzn-RateLimit-Limit` header.
- Amazon Ads (sponsored-product PPC) is a SEPARATE API (Amazon Ads API, different OAuth scope) —
  add it as its own skill when we turn on advertising.

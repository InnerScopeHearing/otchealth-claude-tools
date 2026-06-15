# CRO Handoff: Amazon Seller Central is connected (SP-API)

You are taking over the OTCHealth Inc. Amazon Seller Central account. The SP-API
connection is already built, live, and verified. Read this, then own the channel.

No secret values live in this file. Credentials live in the Notion vault and (once
stored) in Secret Manager. This is the operating brief, not a credential dump.

## 1. What is live (verified 2026-06-15)
- The OTCHealth Inc. Amazon seller account is connected via the Selling Partner API
  (SP-API). Auth is a private, self-authorized app ("OTCHealth Seller Integration",
  App/Solution ID `amzn1.sp.solution.0397c0b8-3c71-41a6-a66e-8b8e751b0cd6`). Its
  Developer Central status reads "Draft", which is the normal, fully-functional state
  for a private self-use app (only public Appstore distribution needs "Published").
- The store is active in 4 marketplaces: US (`ATVPDKIKX0DER`), Canada
  (`A2EUQ1WTGCTBG2`), Mexico (`A1AM78C64UM0Y8`), Brazil (`A2Q3Y263D00KWC`). Default
  to US.
- Confirmed read roles, all returned HTTP 200: Sellers (marketplace participation),
  Orders, FBA Inventory, Catalog (product search). As of setup there were 0 orders and
  0 FBA units.

## 2. How to access it (the tool)
- Skill: `skills/amazon-sp-api/` in `otchealth-claude-tools`. Read `SKILL.md` first.
- Helper: `node skills/amazon-sp-api/sp-api.mjs <cmd>`:
  - `verify` (confirm connection), `orders [createdAfterISO]`, `inventory`, and
    `request <METHOD> <path>` for any SP-API endpoint (request body on stdin for writes).
- Auth model: LWA refresh-token to access-token (no AWS SigV4). Access tokens auto-mint
  per run and last about 1 hour. Host: `sellingpartnerapi-na.amazon.com`.

## 3. Credentials
- All values are in the Notion "API Tokens & Credentials" vault, subpage
  "Amazon SP-API (OTCHealth Seller) added 2026-06-15": LWA Client ID, Client Secret,
  and the canonical refresh token. They are flagged ROTATE BEFORE LAUNCH.
- They are NOT yet in `otchealth-shared-prod` Secret Manager (the setup session lacked
  the GCP service account). FIRST housekeeping step: write them into Secret Manager as
  `amzn-lwa-client-id`, `amzn-lwa-client-secret`, `amzn-sp-refresh-token`. The hydration
  mapping in `setup/fetch-secrets.mjs` already points those ids at the env vars
  `AMZ_LWA_CLIENT_ID` / `AMZ_LWA_CLIENT_SECRET` / `AMZ_SP_REFRESH_TOKEN`. After that,
  every session auto-hydrates and you just run the commands.
- Still missing, for WRITES only: the Merchant token / Seller ID (`AMZ_SELLER_ID`),
  from Seller Central, Settings, Account Info, Business Information. Reads do not need it;
  creating/updating listings does.
- Defaults already set in the skill: `AMZ_MARKETPLACE_ID=ATVPDKIKX0DER`, `AMZ_SP_REGION=na`.

## 4. What you can do now vs what is gated
- Read ops (orders, inventory, catalog search, competitive pricing) are safe and autonomous.
- Write ops (create/update listings, set price, set inventory) require: (a) the Merchant
  token stored, and (b) compliance sign-off on copy. Never publish listing copy without
  the compliance lane.

## 5. Compliance firewall (HARD, do not cross)
- TReO is a PSAP, NOT a hearing aid. Listing titles, bullets, A+ content, and backend
  search terms must carry zero "hearing aid", "hearing loss", "treats/restores hearing",
  FDA, or medical-device language. Frame strictly as a personal sound amplifier.
- Route all listing copy through the compliance officer before any PUT/PATCH that
  publishes. You draft and operate; the claims posture is gated.
- Non-PHI ring only. No PHI ever touches Amazon listings, metadata, or analytics.
- No em dashes or en dashes in any published listing copy.

## 6. Strategic context to start from
- TReO ALREADY has a live ASIN on Amazon, listed by other sellers (previous liquidators
  of the inventory). Your first decision is likely NOT to create a new listing, but to add
  OTCHealth's offer to the existing ASIN and compete for the Buy Box on price and fulfillment.
- Caveat: the existing detail-page copy was written by those third-party sellers and may
  contain non-compliant claims you do not control. Assess whether to attach to the existing
  ASIN as-is, pursue brand control of the listing, or create a compliant variation. Flag the
  compliance exposure of the existing copy before committing inventory.
- Inventory context: OTCHealth holds a large owned PSAP/hearing-device inventory from the
  liquidation. Amazon is one liquidation channel alongside the OTCHealthMart Shopify store.

## 7. Suggested first tasks
1. Store the credentials in Secret Manager (section 3) and re-run `verify` to confirm hydration.
2. Pull the Merchant token and store it as `amzn-seller-id`.
3. Find the existing TReO ASIN(s):
   `node sp-api.mjs request GET '/catalog/2022-04-01/items?keywords=TReO&marketplaceIds=ATVPDKIKX0DER&includedData=summaries,salesRanks'`
   then get competitive pricing + current offers/Buy Box for the ASIN.
4. Recommend attach-to-ASIN vs new-listing, with a price and FBA-vs-FBM plan, and route any
   copy through compliance.

## 8. Housekeeping
- PR #59 on branch `claude/cto-amazon-sp-api` (otchealth-claude-tools) carries the skill,
  the helper, the Data Protection / Incident Response policy that backs the Amazon Security
  Controls attestations, the hydration wiring, and this handoff. Merge it to land on main.
- Rotate the refresh token and client secret after first live use (they were handled in chat
  during setup).

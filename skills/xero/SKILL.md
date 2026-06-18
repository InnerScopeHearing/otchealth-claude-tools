---
name: xero
description: Drive the CFO's Xero books across all entities (OTCHealth, InnerScope/INND, HearingAssist, Matthew personal) through ONE multi-tenant OAuth connection. Xero is multi-tenant, one app + one refresh token reaches many organizations; each API call sets a Xero-tenant-id. Read (get) and write (request) per org. Wielded by the CFO / finance agent. Entity scoping: all four orgs are in the CFO write lane. INND deregistered from SEC reporting in 2021 and self-discloses under the OTC Markets Alternative Reporting Standard with no counsel or accounting staff, so the CFO has full authority to prepare and post INND + HearingAssist books (Matt directive 2026-06-18); the money gate + securities firewall still apply. Personal books carry the related-party / due-to-officer loans that must reconcile against the company side. INND is SELF-PREPARED (not audited), so no auditor-continuity constraint.
---

# Xero, multi-org (CFO)

Chosen platform for the CFO (Brex perk: 100% off 6 months). Xero is QBO-class, multi-entity,
API-first. ONE OAuth connection reaches ALL the orgs you authorize (multi-tenant), so the CFO
drives every entity from a single token.

## Structure (researched 2026-06-16)
- **One Xero ORG (subscription) per entity** - there is no single subscription that covers all
  four. BUT one LOGIN + one API connection switches across all of them, and Xero gives an
  automatic multi-org discount when all orgs share the same subscriber email.
- **Cheapest multi-entity route = the Xero Partner program (FREE):** register as a partner,
  manage all 4 orgs in Xero HQ, use cheap **Xero Ledger** plans for the lighter entities, get a
  free practice subscription + consolidation/reporting tools. The Xero equivalent of QBOA.
  Stack this with the Brex 100%-off perk for minimal cost.
- **No built-in consolidation** out of the box, so a CONSISTENT chart of accounts across the
  entities matters (see COA note below) to consolidate via reports/tools.

## Auth model
- One Intuit-style OAuth2 app at developer.xero.com -> client_id + client_secret. Authorize it
  against ALL FOUR orgs in one consent screen -> ONE refresh token covering all tenants.
- Refresh -> access token at `https://identity.xero.com/connect/token` (Basic client creds).
- Discover orgs: `GET https://api.xero.com/connections` -> tenantId per org.
- Call the Accounting API at `https://api.xero.com/api.xro/2.0/...` with `Bearer` +
  `Xero-tenant-id: <tenantId>`.
- **ROTATION GOTCHA:** Xero rotates the refresh token on EVERY use (60-day expiry resets). The
  recurring job MUST persist the new refresh token to the vault. The CLI flags rotation on stderr.

## Credentials (Secret Manager -> env, hydrated each session)
- `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REFRESH_TOKEN` (one app, one multi-tenant token):
  `xero-client-id`, `xero-client-secret`, `xero-refresh-token`.

## Procedure
```
node skills/xero/xero.mjs connections                                  # list orgs (tenantId + name)
node skills/xero/xero.mjs "OTCHealth" get Organisation                 # connection probe per org
node skills/xero/xero.mjs "OTCHealth" get Accounts                     # chart of accounts
node skills/xero/xero.mjs "InnerScope" get Reports/TrialBalance        # verify after migration
echo '<json>' | node skills/xero/xero.mjs "OTCHealth" request POST Invoices   # write (gated)
```
`<tenant>` = an org-name substring or an exact tenantId.

## Migration from QBO
- Active companies (InnerScope, Personal): use Xero's FREE supported QuickBooks->Xero conversion
  (Dataswitcher) for chart of accounts + history; `qbo export` is the backup.
- Suspended companies (OTCHealth, HearingAssist): QBO API is off while suspended; reactivate one
  month for an API pull, or read-only-UI export, then import.
- VERIFY: trial balance ties per entity before declaring done.

## Chart of accounts (CFO design task, do during migration)
The 4 entities currently have DIFFERENT charts of accounts. For a group with intercompany +
consolidation (INND parent, HearingAssist sub, OTCHealth, personal loans), standardize to a
MASTER chart of accounts with consistent numbering, entity-specific accounts only where needed,
and consistent intercompany + due-to/due-from-officer accounts across all four. The migration is
the moment to implement it.

## Guardrails (HARD)
- Entity scoping: ALL FOUR orgs (OTCHealth, INND, HearingAssist, personal) are in the CFO's
  WRITE lane. **INND deregistered from SEC reporting in 2021 and self-discloses under the OTC
  Markets Alternative Reporting Standard (ARS); there is NO outside counsel and NO accounting
  staff, so the CFO agent holds FULL authority to prepare and POST INND + HearingAssist books**
  (Matt directive 2026-06-18). The old "gated, route to counsel" rule is RETIRED — there is no
  counsel to route to. INND is self-prepared (not audited), so no auditor-continuity constraint.
- What STILL holds regardless: the **money gate** (record, never move money or commit the
  company), the **securities firewall** (no INND stock promotion; the INND price workbook is
  internal CFO record only), and the **DATA RULE** (securities-sensitive specifics live in the
  data room, never in git). Accuracy is paramount: INND/HA financials are published to OTC
  Markets investors under ARS, so hold the same audit-grade rigor used for OTCHealth.
- Stage, then post; source-of-truth (every entry ties to a doc); non-PHI ring. Secrets in the
  vault, refresh token flagged for rotation.

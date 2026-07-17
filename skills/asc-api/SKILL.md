---
name: asc-api
description: App Store Connect API client built on the NEW 4.4.1 (2026-07-15) resource model - version-based In-App Purchase / subscription / subscription group metadata (InAppPurchaseVersion, SubscriptionVersion, SubscriptionGroupVersion parents + v2 localizations/images) and the UNIFIED reviewSubmissions workflow (IAP versions ride in the same submission as an app version, In-App Events, custom product pages, Game Center items - up to 200 items per submission). Use for creating/updating IAP + subscription metadata, localizations, and assembling review submissions across every fleet app (PlantID SKUs, Companion tier ladder, Flatstick chat entitlements, AWARE pro, InnerEase ie-05). NEVER add calls to the deprecated pre-4.4.1 resources (v1 inAppPurchase/subscription localizations, images, and all *Submissions resources) - Apple is removing them. Submitting to App Review (submission submit) is a RELEASE ACTION gated on CTO/Matt go (ASC_SUBMIT_CONFIRM=yes). Auth = ES256 JWT from the fleet team ASC key in Azure Key Vault (asc-api-key-p8 / asc-key-id 9MR7PJHRYH / asc-issuer-id). Run - node skills/asc-api/asc.mjs <verify|version|localize|localizations|submission|request>.
---

# asc-api — App Store Connect on the new version-based model

As of **App Store Connect API 4.4.1 (released 2026-07-15)**, IAP and subscription
metadata is versioned, and product review submission is unified with everything else.
This skill is the fleet's ONLY sanctioned path for ASC product/metadata/submission work.
It was verified against Apple's official OpenAPI spec v4.4.1 (spec file dated 2026-07-15).

## The new model in 60 seconds

1. **A product's metadata lives on a VERSION, not on the product.**
   `POST /v1/inAppPurchaseVersions` (rel: `inAppPurchase`),
   `POST /v1/subscriptionVersions` (rel: `subscription`),
   `POST /v1/subscriptionGroupVersions` (rel: `subscriptionGroup`).
   A version create-request has NO attributes — it is a container. You then hang
   localizations/images off it. The live version keeps serving while you draft the next.

2. **Localizations + images are v2, scoped to the version.**
   `POST /v2/inAppPurchaseLocalizations` (attrs: `name`, `locale`, `description`; rel: `version`),
   `POST /v2/subscriptionLocalizations`, `POST /v2/subscriptionGroupLocalizations`,
   `POST /v2/inAppPurchaseImages`, `POST /v2/subscriptionImages` (upload-asset flow).
   Read back via `GET /v1/<kind>Versions/{id}/localizations|images`.

3. **ONE submission for everything.** `POST /v1/reviewSubmissions` (app + platform), then
   `POST /v1/reviewSubmissionItems` per item. 4.4.1 adds `inAppPurchaseVersion`,
   `subscriptionVersion`, `subscriptionGroupVersion` to the 15 supported item types
   (alongside `appStoreVersion`, `appEvent`, `appCustomProductPageVersion`,
   `backgroundAssetVersion`, 5 Game Center version types, experiments). Up to 200
   items per submission; overflow = open another submission.
   `PATCH /v1/reviewSubmissions/{id} {submitted:true}` sends the whole batch to review.

4. **Deprecated (Apple: "will be removed in an upcoming release")** — do not write new
   code against: `/v1/inAppPurchaseLocalizations`, `/v1/inAppPurchaseImages`,
   `/v1/inAppPurchaseSubmissions`, `/v1/subscriptionLocalizations`,
   `/v1/subscriptionImages`, `/v1/subscriptionSubmissions`,
   `/v1/subscriptionGroupLocalizations`, `/v1/subscriptionGroupSubmissions`.
   (They still respond today — that is a migration grace window, not an endorsement.)

## Commands

```
node skills/asc-api/asc.mjs verify                                  # auth check, lists apps
node skills/asc-api/asc.mjs version create sub <subscriptionId>     # new draft version
node skills/asc-api/asc.mjs version list   sub <subscriptionId>
node skills/asc-api/asc.mjs localize sub <versionId> en-US "Pro Annual" 
node skills/asc-api/asc.mjs localizations sub <versionId>
node skills/asc-api/asc.mjs submission create <appId> IOS
node skills/asc-api/asc.mjs submission add <submissionId> sub-version <versionId>
node skills/asc-api/asc.mjs submission add <submissionId> app-version <appStoreVersionId>
node skills/asc-api/asc.mjs submission status <appId>
ASC_SUBMIT_CONFIRM=yes node skills/asc-api/asc.mjs submission submit <submissionId>   # GATED
node skills/asc-api/asc.mjs request GET /v1/subscriptionGroups/22162847/versions      # escape hatch
```

## Guardrails (non-negotiable)

- **`submission submit` = release action.** Same discipline as iOS build dispatch:
  CTO/Matt go first. The tool refuses without `ASC_SUBMIT_CONFIRM=yes`.
- **Pricing changes are a money gate (Matt).** This skill deliberately ships no pricing
  verbs; use `request` only with explicit Matt approval recorded in the ledger.
- **Health-app product copy routes through the claims firewall** before it becomes a
  localization (iHEARtest/AWARE/InnerEase compliance rails: no treatment/diagnosis
  claims, no em/en dashes in customer-facing copy).
- **medreview ASC work stays in the CTO lane** (different key posture historically;
  non-developer ring).
- The team key `9MR7PJHRYH` signs everything; it cannot create app records
  (`POST /v1/apps` is API-forbidden — always a Matt UI step).

## Per-app process runbook: PROCESS.md (same directory)

PROCESS.md carries the migration map (old endpoint -> new endpoint), the standard
"metadata change -> review" flow, and each app's product inventory with IDs.

# ASC 4.4.1 Migration Map + Fleet IAP/Subscription Process

> Source of truth: Apple's OpenAPI spec v4.4.1 (2026-07-15) + the 4.4.1 release notes,
> both fetched and verified 2026-07-17. The Apple Developer Relations email of 2026-07-15
> announced this change; this doc is the fleet's operational answer to it.

## 1. Migration map — old endpoint -> new endpoint

| Deprecated (removal upcoming) | Replacement (use this) |
|---|---|
| `POST/GET/PATCH/DELETE /v1/inAppPurchaseLocalizations*` | `POST/GET/PATCH/DELETE /v2/inAppPurchaseLocalizations*` (rel: `version` -> `inAppPurchaseVersions`) |
| `POST/... /v1/inAppPurchaseImages*` | `POST/... /v2/inAppPurchaseImages*` (scoped to an `inAppPurchaseVersion`) |
| `POST /v1/inAppPurchaseSubmissions` | `POST /v1/reviewSubmissionItems` with rel `inAppPurchaseVersion` |
| `POST/... /v1/subscriptionLocalizations*` | `POST/... /v2/subscriptionLocalizations*` (rel: `version` -> `subscriptionVersions`) |
| `POST/... /v1/subscriptionImages*` | `POST/... /v2/subscriptionImages*` (scoped to a `subscriptionVersion`) |
| `POST /v1/subscriptionSubmissions` | `POST /v1/reviewSubmissionItems` with rel `subscriptionVersion` |
| `POST/... /v1/subscriptionGroupLocalizations*` | `POST/... /v2/subscriptionGroupLocalizations*` (rel: `version` -> `subscriptionGroupVersions`) |
| `POST /v1/subscriptionGroupSubmissions` | `POST /v1/reviewSubmissionItems` with rel `subscriptionGroupVersion` |

New parents (no old equivalent — the versioning layer itself):
`POST /v1/inAppPurchaseVersions` | `POST /v1/subscriptionVersions` | `POST /v1/subscriptionGroupVersions`
List versions: `GET /v2/inAppPurchases/{id}/versions` | `GET /v1/subscriptions/{id}/versions` | `GET /v1/subscriptionGroups/{id}/versions`

Unchanged and still correct: `POST /v2/inAppPurchases` (create the IAP itself),
`/v1/subscriptions` + `/v1/subscriptionGroups` (create products/groups), price-point and
availability resources (note `subscriptionAvailabilities` is separately deprecated in
4.4 — check spec before use), `reviewSubmissions` core.

Also new in 4.4/4.4.1, relevant to us:
- `GET /v1/subscriptionPricePoints/{id}/adjustedEqualizations` — see how a base-price
  change re-equalizes across all territories BEFORE committing it (PlantID A/B pricing,
  Companion tier ladder — use this in any repricing analysis for Matt).
- Monthly subscriptions with a 12-month commitment (new offer shape — a candidate for
  Companion's "annual value without the annual sticker" experiments; Matt gate).
- `socialMedia` / `socialMediaAgeRestricted` attributes on app-info — Companion's family
  feed may require declaring these at next app-version submission; check at Wave 2.

## 2. The standard flow: "change subscription metadata and ship it"

```
1. version create   ->  node skills/asc-api/asc.mjs version create sub <subscriptionId>
2. localize         ->  ... localize sub <versionId> en-US "<display name>" "<description>"
                        (copy passes the claims firewall FIRST for health apps)
3. (images)         ->  v2 subscriptionImages upload flow (reserve -> upload -> commit)
4. bundle           ->  ... submission create <appId> IOS
                        ... submission add <sid> sub-version <versionId>
                        ... submission add <sid> app-version <appStoreVersionId>   # optional, same batch
5. GATE             ->  CTO/Matt go recorded in ledger
6. submit           ->  ASC_SUBMIT_CONFIRM=yes ... submission submit <sid>
7. ledger           ->  mem.mjs remember "<what shipped + submission id>" --agent <lane>
```

Why this is better than the old flow (worth internalizing): metadata edits no longer
race the live product (drafts are isolated versions), and one submission can carry the
app binary version AND its new IAPs AND an in-app event — one review cycle instead of
three uncoordinated ones. Up to 200 items; overflow -> second submission.

## 3. Per-app product inventory (who uses this process)

| App | ASC app | Products | Notes |
|---|---|---|---|
| PlantID Care | 6781126153 | group "PlantID Pro" 22162847; `plantid_annual_3499`, `plantid_annual_2999` (A/B live) | LIVE REVENUE. Any metadata change rides the new flow. Repricing analysis: use adjustedEqualizations first. |
| Companion | no ASC record yet (Matt UI gate) | 5-tier ladder in `packages/shared/src/pricing.ts` (Care/Voice/Family/Legacy, $44.99 Legacy) | When the record exists: create products via v1/subscriptions + groups, then ALL metadata via the new version flow from day one. |
| Flatstick | app record exists (tf/1.0+19 live) | Pro + chat tiers `chat_text` $0.99 / `chat_photo` $1.99 / `chat_video` $4.99 | RevenueCat wired; ASC-side metadata changes use this skill. |
| AWARE | 6772572839 | `pro` entitlement (RevenueCat) | Product metadata changes via new flow; submission bundles with its first Depot app version when that ships. |
| InnerEase | NO ASC record (verified live 2026-07-17 — absent from the team's app list; Matt UI gate, same as Companion) | ie-05 plan: 3 SKUs, single `pro` entitlement | Wave-1 pilot: when monetization flips on, set up products + metadata natively on the new model (never touches deprecated endpoints at all). |
| iHEARtest | 6767132632 | none in-repo (free screening) | No IAP work; binary untouchable (clinical review). |
| FourVault | 6774324799 | RevenueCat subscriptions; COPPA parental gate | Metadata via new flow; parental-gate copy is compliance-load-bearing. |
| Fictionary | 6776440303 (record EXISTS — verified live 2026-07-17, "Fictionary Translator", despite zero builds ever shipped) | none (non-commercial v1) | N/A until the commercial trigger; the record being pre-created removes one Matt gate when that day comes. |

Also on the team account (legacy, not in the app fleet): HearingAssist STREAM
(1626580571), myiHEAR (6443743416), hearIQ (1556196475).

Live verification snapshot (2026-07-17, via this skill): PlantID group 22162847 already
carries an auto-created subscriptionGroupVersion `6ee67560...` in PREPARE_FOR_SUBMISSION —
Apple migrated existing products onto the version model server-side. `plantid_annual_2999`
(6781126906) and `plantid_annual_3499` (6781126414) both sit in MISSING_METADATA (the
known-expected state: review screenshot due at submission time). Completing those via
`version create sub` + `localize` + image upload + one bundled reviewSubmission is the
first real-world use of this process when Matt green-lights PlantID's next submission.
| medreview | CTO lane | Stripe, not IAP | Out of scope here. Its `scripts/setup-appstore-*.mjs` use still-active endpoints (`/v1/subscriptions`, groups, prices) — no calls to the deprecated eight, but the OWNER should adopt this skill for any future metadata/submission work. Flagged to CTO. |

## 4. RevenueCat interaction

RevenueCat reads products from ASC via its own ASC API key integration (RC uses key
`3BX7556WXU`, team-scoped read — verified 2026-06-17). The new versioning model does
NOT change RevenueCat wiring: RC cares about product IDs and entitlements, not
metadata versions. Metadata/review flows move to this skill; RC offering/entitlement
management stays in the RevenueCat lane.

## 5. Fleet exposure audit (2026-07-17, at adoption time)

Grepped every repo + the toolkit for the eight deprecated resources: ZERO callers.
`medreview/scripts/setup-appstore-*.mjs` uses `/v1/subscriptions|subscriptionGroups|
subscriptionPrices` (still active). `flatstick/ios-depot.yml` + `aware
asc-external-review-poller.yml` use `/v1/apps|builds|betaAppReviewSubmissions`
(unaffected; note `betaAppReviewSubmissions` is TestFlight beta review, a different
resource family from the deprecated IAP submissions). So the fleet starts CLEAN on the
new model — no remediation debt.

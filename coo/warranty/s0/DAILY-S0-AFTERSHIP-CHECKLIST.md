# Warranty Operations Daily S0: AfterShip Public-Domain, Policy and Window Readback

Status: Required every day while AfterShip remains installed and before every pilot or launch decision.
Mode: anonymous read-only. No customer record, valid order, claim, notification, label, refund, inventory or configuration write.

## Why this exists

On 2026-08-08 both AfterShip default domains were publicly actionable even while Admin said Unpublished and exposed stale 30-day policy content. After the corrected draft was resaved, both domains visibly changed to Page not found, but runtime stayed on order date. Root cause: AfterShip Returns requires AfterShip Tracking to persist Delivery date.

CRO first discarded the unsavable draft and installed nothing. After scope review and Matt authorization, CRO installed Tracking under a bounded configuration: Free 50 Monthly at $0, auto-upgrade OFF, Tracking notifications OFF/locked, tracking page unlaunched, one existing shipment auto-synced. Returns then persisted Delivery date + 75 days with no fulfillment fallback.

Post-install runtime readback now shows:

- `return_window_base_on=delivery_date`: PASS.
- access denied / unpublished: PASS.
- approved translated 75-day summary: PASS.
- canonical policy URL and contact/privacy/terms URLs: PASS.
- `policy_text` still contains stale `unused and undamaged` copy: S0 FAIL.
- `returns_page_block_search_engine=false`: S1 FAIL.

Therefore `Unpublished` is not evidence of non-reachability, and visible Page not found is not evidence that hidden runtime policy is correct. AfterShip returns HTTP 200 with a soft-404 page, so HTTP status alone is not an acceptable check. Order-date approximation is prohibited against the approved 75-days-from-delivery policy.

## Daily command

From the `otchealth-claude-tools` repository root:

```bash
node coo/warranty/s0/aftership-s0-probe.mjs \
  --output coo/warranty/s0/evidence/aftership-s0-latest.json
```

The command exits nonzero on HOLD. `--allow-hold` is for evidence capture only and must not be used by a production monitor.

The launch-blocking automation is `.github/workflows/warranty-aftership-s0.yml`. It runs deterministic tests plus the live anonymous probe on relevant pull requests, a daily schedule, and manual dispatch; uploads JSON even when the probe fails; and then fails the job if live state is not clean. A successful run is required evidence but grants no automatic launch authority.

## Public endpoints checked

1. `https://hearingassist.aftership.com/`
2. `https://hearingassist.aftership.com/return-policy`
3. `https://hearingassist.returnscenter.com/`
4. `https://hearingassist.returnscenter.com/return-policy`

Any custom hostname, app proxy or new vendor domain must be added before it can receive traffic.

## S0 checks

| Check | PASS condition | Failure class | Owner |
|---|---|---|---|
| Visible public access | Page visibly says Page not found; no order lookup or return action | S0 launch hold | Warranty Operations Lead |
| Runtime access | `returns_page_status=unpublished`, access status `denied`, code `returns_page_not_published` | S0 launch hold | Care Team admin 11167146 |
| Runtime projection timestamp | `returns_page_setting_updated_at` exists and parses; evidence is newer than the last Admin/vendor change | S0 launch hold | Warranty Operations Lead |
| Cross-domain projection parity | Both default domains and both paths expose one identical normalized runtime projection fingerprint | S0 launch hold | Warranty Operations Lead |
| Delivery-date dependency | Authorized delivery-date source exists and its procurement/scope gate is signed; for current vendor this means approved AfterShip Tracking or an approved least-privilege alternative | S0 launch hold | Matt + Operations + Privacy/Security + Finance |
| Window basis | Public runtime equals Admin-approved `delivery_date`; `order_date` is never accepted as a fallback | S0 launch hold | Care Team admin 11167146 |
| Window duration | Public/runtime eligibility and policy consistently use 75 days from delivery | S0 launch hold | Care + Counsel + Operations |
| Policy summary | Runtime translation exactly equals the approved claims-checked 75-day summary; extra editor instructions or suffixes fail | S0 launch hold | Care/Communications |
| Forbidden copy | No 30-day, unused/undamaged, original-packaging, resellable, discounted-item, seven-day or other superseded condition | S0 launch hold | Care/Communications + Legal |
| Policy URL | Exact `https://otchealthmart.com/policies/refund-policy`, no punctuation or redirect drift | S0 launch hold | Care Team admin 11167146 |
| Search indexing | Unpublished portal blocks search indexing | S1 before pilot; S0 before launch | Care Team admin 11167146 |
| Contact/privacy/terms | Approved non-null URLs | S1 before pilot; S0 before launch | Communications + Privacy + Legal |
| Notification inventory | All return and warranty event toggles match the signed release matrix | S0 launch hold | Notification configuration owner |
| Notification ownership | Named primary and backup for monitor, content, release and incident handling | S0 launch hold | Matt + Operations |
| Evidence freshness | Readback less than 24 hours old and after the latest Admin/vendor change | S0 launch hold | Warranty Operations Lead |

## Daily triage

1. Run the probe before any AfterShip Admin work, pilot, announcement or launch packet.
2. If any S0 check fails, preserve the JSON receipt, keep both domains denied/404, do not publish, and open one reconciliation exception.
3. Compare five planes explicitly: Admin, anonymous public page, public runtime JSON, canonical Shopify policy, and notification configuration.
4. A correct Admin screenshot cannot override contradictory public runtime.
5. A visible 404 cannot override stale or contradictory runtime policy.
6. Do not correct drift automatically. Draft the exact bounded change, obtain the named authorization, apply once, and re-read all five planes.
7. If Delivery date requires a new app or paid dependency, stop at `AFTERSHIP-TRACKING-PROCUREMENT-SCOPE-GATE.md`; no install, trial, scope grant or spend occurs without explicit owner approval.
8. Never substitute order date for delivery date. Missing dependency or delivery data is HOLD, not approximation.
9. Record the `warranty-aftership-s0` workflow run ID and retained receipt in the launch packet; missing, skipped, stale or failed is HOLD.
10. Require two consecutive clean daily readbacks after the final correction before a launch packet may cite this gate as ready.

## Current baseline, 2026-08-08

- Anonymous visible domains: Page not found on both default domains and both policy paths.
- HTTP behavior: 200 soft 404, not a real HTTP 404.
- Runtime access control: denied / returns_page_not_published.
- Tracking dependency: installed and authorized after scope review; Free 50 Monthly at $0; auto-upgrade OFF; notifications OFF; tracking page unlaunched; one shipment auto-synced.
- Runtime window: `delivery_date`; Delivery+75 persisted with no fulfillment fallback.
- Overall probe: `HOLD_S0` only because runtime `policy_text` still contains stale unused-and-undamaged copy across all four endpoints.
- Additional S1: search blocking remains false; seven notification owner/backup roles remain unresolved.
- Canonical policy URL and contact/privacy/terms URLs now pass runtime readback.
- Consecutive clean S0 receipts: 0 of 2.
- Evidence: `evidence/aftership-s0-2026-08-08-post-tracking.json`.

No public or pilot gate closes until these mismatches are reconciled and read back.
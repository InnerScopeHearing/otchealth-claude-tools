# Warranty Operations Daily S0: AfterShip Public-Domain, Policy and Window Readback

Status: Required every day while AfterShip remains installed and before every pilot or launch decision.
Mode: anonymous read-only. No customer record, valid order, claim, notification, label, refund, inventory or configuration write.

## Why this exists

On 2026-08-08 both AfterShip default domains were publicly actionable even while Admin said Unpublished. They exposed stale 30-day policy content. After the claims-checked 75-day draft was resaved, both domains visibly changed to Page not found, but live page state still disagreed with Admin:

- Admin expectation: Delivery date + 75 days.
- Public runtime: `return_window_base_on=order_date`.
- Public runtime `policy_text`: stale `unused and undamaged` copy.
- Public runtime translated summary: corrected 75-days-from-delivery copy.
- Public runtime policy URL: `https://otchealthmart.com/policies/refund-policy.` with a trailing period.
- `returns_page_block_search_engine=false` while unpublished.
- contact, privacy and terms URLs are null.

Therefore `Unpublished` is not evidence of non-reachability, and visible Page not found is not evidence that hidden runtime policy is correct. AfterShip returns HTTP 200 with a soft-404 page, so HTTP status alone is not an acceptable check.

## Daily command

From the `otchealth-claude-tools` repository root:

```bash
node coo/warranty/s0/aftership-s0-probe.mjs \
  --output coo/warranty/s0/evidence/aftership-s0-latest.json
```

The command exits nonzero on HOLD. `--allow-hold` is for evidence capture only and must not be used by a production monitor.

The launch-blocking automation is `.github/workflows/warranty-aftership-s0.yml`. It runs the deterministic tests plus the live anonymous probe on relevant pull requests, a daily schedule, and by `workflow_dispatch`, uploads the JSON receipt even when the probe fails, and then fails the job if the live probe is not clean. The workflow grants no automatic launch authority; its successful run is one required receipt, not a publication action.

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
| Window basis | Public runtime equals Admin-approved `delivery_date` | S0 launch hold | Care Team admin 11167146 |
| Window duration | Public/runtime eligibility and policy consistently use 75 days | S0 launch hold | Care + Counsel + Operations |
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
7. Record the `warranty-aftership-s0` workflow run ID and uploaded receipt in the launch packet; a missing, skipped, stale or failed run is HOLD.
8. Require two consecutive clean daily readbacks after the final correction before a launch packet may cite this gate as ready.

## Current baseline, 2026-08-08

- Anonymous visible domains: Page not found on both default domains and both policy paths.
- HTTP behavior: 200 soft 404, not a real HTTP 404.
- Runtime access control: denied / returns_page_not_published.
- Overall probe: `HOLD_S0` because runtime window basis, legacy policy_text and malformed policy URL disagree with the approved Admin/policy expectation.
- Additional S1: search blocking false; contact/privacy/terms links absent; notification owners/backups unresolved.
- Evidence: `evidence/aftership-s0-2026-08-08.json`.

No public or pilot gate closes until these mismatches are reconciled and read back.
# AfterShip Admin, Public Page, and Runtime State Inconsistency — 2026-08-08

## Verdict

**Confirmed partial vendor-state projection / readback inconsistency. Launch status: HOLD_S0.**

This is not merely a browser cache issue and not merely an Admin-label issue. One AfterShip save propagated some fields while other customer-enforcement fields remained stale:

- Public visibility changed from actionable order lookup to Page not found.
- `returns_page_status` changed/read back as `unpublished`.
- access status changed/read back as `denied` with `returns_page_not_published`.
- translated summary changed to the approved 75-days-from-delivery copy.
- `returns_page_setting_updated_at` advanced to `2026-08-09T01:01:01.739001Z`.
- `return_window_base_on` remained `order_date`, contradicting Admin Delivery date + 75 days.
- `policy_text` remained the stale unused-and-undamaged default.
- `policy_url` gained the correct path but retained a trailing period.
- search-engine blocking remained false.
- contact, privacy, and terms URLs remained null.

Because new and stale values coexist in the same runtime projection after the same saved-draft event, the customer-facing runtime cannot be treated as an atomic reflection of Admin state. The likely failure classes are independently persisted vendor settings, a stale projection/cache for a subset of fields, a versioned draft object that does not fully drive the public runtime, or an Admin control mapped to a different underlying field. The available evidence does not identify which vendor-internal mechanism is responsible, so the permanent control is authoritative readback, not inference from the Admin UI.

## Evidence

- CRO synthetic pilot: document `cmsl2xi0z0wpp06adkysp6t6m` version 3.
- CRO ledger: `cro__20260809-001-daad`.
- Operations S0 decision: `coo__20260809-006-0095`.
- Public endpoints checked:
  - `https://hearingassist.aftership.com/`
  - `https://hearingassist.aftership.com/return-policy`
  - `https://hearingassist.returnscenter.com/`
  - `https://hearingassist.returnscenter.com/return-policy`
- Before containment: default domains exposed an unauthenticated order-lookup form and stale 30-day policy.
- After draft save: all four visible pages show Page not found; HTTP remains 200 soft-404, so status code alone is insufficient.
- No real customer, order, claim, return request, message, label, shipment, refund, credit, inventory, payment, or PHI was used.

## Control decision

Five planes must reconcile before pilot or publication:

1. approved policy source;
2. AfterShip Admin configuration;
3. anonymous visible public page;
4. public runtime JSON / effective enforcement projection;
5. notification inventory, template hashes, release ownership, and suppressions.

The public runtime is the authoritative customer-facing evidence for window basis and rendered policy behavior. An Admin screenshot proves operator intent only. A visible Page not found proves no ordinary public interaction only. Neither can override contradictory runtime state.

## Launch-blocking smoke contract

The canonical smoke is `coo/warranty/s0/aftership-s0-probe.mjs`, enforced by `.github/workflows/warranty-aftership-s0.yml`.

It fails launch on:

- any visible public order lookup or return action while unpublished;
- runtime status/access that is not unpublished/denied;
- missing or unparseable runtime configuration timestamp;
- divergence of the normalized runtime projection fingerprint across either default domain or checked path;
- `return_window_base_on` not equal to `delivery_date`;
- translated summary not exactly equal to the approved claims-checked summary;
- any forbidden stale policy phrase;
- policy URL mismatch, punctuation, or redirect drift;
- missing search blocking while unpublished;
- missing approved contact/privacy/terms links;
- incomplete notification ownership or release controls.

The workflow preserves its JSON artifact even when the live smoke fails, then fails the job. A successful workflow grants no automatic launch authority. Two consecutive clean daily readbacks after the final correction remain required.

## Current outcome

The current anonymous readback is `HOLD_S0`. Keep both AfterShip domains inaccessible, keep Shopify warranty routes absent, and do not enable customer traffic until the vendor projection is reconciled and independently re-read cleanly twice.

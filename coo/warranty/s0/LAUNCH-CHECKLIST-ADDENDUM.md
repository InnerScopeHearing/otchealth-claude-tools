# Warranty Launch Checklist Addendum: AfterShip Domain, Policy, Window and Notification Drift

Applies to: controlled pilot entry and final public-launch confirmation.
Source: CRO pilot `cmsl2xi0z0wpp06adkysp6t6m` version 3 plus Operations live readback on 2026-08-08.

## Stop-ship rule

Any Admin/public/runtime/policy/notification mismatch is a launch blocker. `Unpublished` is not containment evidence by itself. A visible Page not found is not a clean policy readback by itself. HTTP 200 with a Page not found body is a soft 404 and must be evaluated by content/runtime state, not status code.

## Required evidence before controlled pilot

- [ ] Inventory every AfterShip public hostname, default domain, custom hostname, app proxy and policy path.
- [ ] Anonymous readback of each domain/path shows Page not found and no order lookup, gift return, policy action or return-start action.
- [ ] Runtime returns page status is unpublished and access is denied with `returns_page_not_published`.
- [ ] Runtime `return_window_base_on` equals Admin-approved `delivery_date`.
- [ ] Runtime and visible policy use 75 days from delivery.
- [ ] No stale 30-day, purchase-date, unused/undamaged, original-packaging, resellable, discounted-item or seven-day condition survives in any runtime field, translation, FAQ, template or link.
- [ ] Policy URL exactly equals `https://otchealthmart.com/policies/refund-policy` and resolves without punctuation/redirect error.
- [ ] Unpublished portal blocks search indexing.
- [ ] Contact, privacy and terms URLs are approved and non-null.
- [ ] Every return/warranty notification event is inventoried with toggle state and template hash.
- [ ] Rejection/adverse, Safety, recall, financial and appeal notifications are OFF or protected by the signed human release matrix.
- [ ] Named primary and backup own daily S0, configuration, content, ordinary release, adverse release, Safety/recall release, Finance release and wrong-recipient incidents.
- [ ] Probe evidence is newer than 24 hours and newer than the last Admin/vendor change.
- [ ] Two consecutive clean daily readbacks exist after the final correction.

## Additional evidence before public launch

- [ ] All controlled-pilot entry evidence above remains green on launch day.
- [ ] AfterShip domain/policy/window/notification readback is included in both reconciled operating closes.
- [ ] A negative-path test proves a vendor default-domain or translation reset pages the owner and blocks traffic.
- [ ] A rollback drill proves publication can be removed and all domains re-read without customer data or unresolved request state.
- [ ] Vendor support documents which field is authoritative when Admin and public runtime disagree.
- [ ] Final launch packet includes exact Admin screenshots, anonymous page screenshots, runtime JSON excerpt, policy hash, notification inventory, probe receipts and named sign-offs.

## Current open defects found by readback

1. Runtime `return_window_base_on=order_date` conflicts with Admin Delivery date + 75 days.
2. Runtime `policy_text` still says unused and undamaged.
3. Runtime policy URL ends with a trailing period.
4. Search-engine blocking is false while unpublished.
5. Contact, privacy and terms URLs are null.
6. Notification owner/backup roles remain unassigned.

The default domains currently show Page not found, but these six defects keep the gate on HOLD.
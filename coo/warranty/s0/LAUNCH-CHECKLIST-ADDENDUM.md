# Warranty Launch Checklist Addendum: AfterShip Domain, Policy, Window and Notification Drift

Applies to: controlled pilot entry and final public-launch confirmation.
Source: CRO pilot `cmsl2xi0z0wpp06adkysp6t6m` version 3 plus Operations live readback on 2026-08-08.

## Stop-ship rule

Any Admin/public/runtime/policy/notification/dependency mismatch is a launch blocker. `Unpublished` is not containment evidence by itself. A visible Page not found is not a clean policy readback by itself. HTTP 200 with a Page not found body is a soft 404 and must be evaluated by content/runtime state, not status code.

AfterShip Returns cannot persist Delivery date basis without AfterShip Tracking. CRO first discarded the unsavable draft. After scope review and Matt authorization, CRO installed Tracking on Free 50 Monthly at $0, turned auto-upgrade and notifications OFF, kept the tracking page unlaunched, and persisted Delivery date + 75 days with no fulfillment fallback. Order-date approximation remains prohibited.

## Required evidence before controlled pilot

- [ ] Inventory every AfterShip public hostname, default domain, custom hostname, app proxy and policy path.
- [x] Anonymous readback of each domain/path shows Page not found and no order lookup, gift return, policy action or return-start action.
- [x] Runtime returns page status is unpublished and access is denied with `returns_page_not_published`.
- [x] Runtime `returns_page_setting_updated_at` is parseable and newer than the dependency/policy change.
- [x] Both default domains and both checked paths expose one identical normalized runtime projection fingerprint.
- [x] An authorized Delivery-date data source exists. AfterShip Tracking was scope-reviewed and installed under Matt authorization on Free 50 Monthly at $0 with auto-upgrade OFF.
- [x] Runtime `return_window_base_on` equals Admin-approved `delivery_date`; no order-date approximation or fulfillment fallback exists.
- [x] Runtime translated policy exactly equals the approved 75-days-from-delivery summary, with no editor suffix or stale variation.
- [ ] No stale 30-day, purchase-date, unused/undamaged, original-packaging, resellable, discounted-item or seven-day condition survives in any runtime field, translation, FAQ, template or link.
- [x] Policy URL exactly equals `https://otchealthmart.com/policies/refund-policy` without punctuation drift.
- [ ] Unpublished portal blocks search indexing.
- [x] Contact, privacy and terms URLs are non-null in runtime readback.
- [ ] Every return/warranty notification event is inventoried with toggle state and template hash.
- [ ] Rejection/adverse, Safety, recall, financial and appeal notifications are OFF or protected by the signed human release matrix.
- [ ] Named primary and backup own daily S0, configuration, content, ordinary release, adverse release, Safety/recall release, Finance release and wrong-recipient incidents.
- [x] Post-Tracking probe evidence is newer than 24 hours and newer than the dependency/policy change.
- [ ] The `warranty-aftership-s0` workflow has a successful exact-head run and retained JSON artifact; missing or failed is HOLD.
- [ ] Two consecutive clean daily readbacks exist after the final correction.

## Additional evidence before public launch

- [ ] All controlled-pilot entry evidence above remains green on launch day.
- [ ] AfterShip domain/policy/window/notification readback is included in both reconciled operating closes.
- [ ] A negative-path test proves a vendor default-domain or translation reset pages the owner and blocks traffic.
- [ ] A rollback drill proves publication can be removed and all domains re-read without customer data or unresolved request state.
- [ ] Vendor support documents which field is authoritative when Admin and public runtime disagree.
- [ ] Negative tests prove Tracking uninstall, trial/billing expiry, scope loss, missing carrier event and stale cache fail closed and never revert eligibility to order date.
- [ ] Final launch packet includes exact Admin screenshots, dependency/scope approval, anonymous page screenshots, runtime JSON excerpt, policy hash, notification inventory, probe receipts and named sign-offs.

## Current open defects found by readback

1. Runtime `policy_text` still says unused and undamaged on all four anonymous domain/path readbacks, producing four S0 failures.
2. Search-engine blocking is false on all four readbacks, producing four S1 failures.
3. Seven notification owner/backup roles remain unassigned.
4. Consecutive clean daily receipts: 0 of 2.

Dependency, Delivery date basis, 75-day translated summary, policy URL, contact/privacy/terms URLs and unpublished/access-denied state now pass. The remaining defects keep the gate on HOLD.
# AfterShip Tracking Dependency: Procurement and Scope Gate

Status: DEPENDENCY SATISFIED. Public/pilot launch remains HOLD.
Decision date: 2026-08-08

## Root cause

AfterShip Returns cannot persist the required Delivery date return-window basis unless the separate AfterShip Tracking app is installed. The Returns UI shows an explicit `Try for free` warning; Save is disabled without the dependency; public runtime remains `return_window_base_on=order_date`.

The CRO first discarded the unsavable draft and did not install without authority. After completing scope review and receiving Matt's authorization, CRO installed AfterShip Tracking under the bounded configuration recorded below.

## Non-negotiable policy rule

OTCHealth's approved return window is 75 days from delivery. Order date is not an acceptable approximation, fallback, proxy or temporary launch rule. A later delivery, failed delivery, reshipment, pre-order, carrier delay or missing tracking event can make order-date logic materially shorten the promised window.

If Delivery date cannot be persisted and read back exactly, AfterShip Returns cannot be the authoritative eligibility engine for this policy and the portal remains unpublished.

## Owner decision and bounded installation outcome

Matt authorized the dependency after CRO completed scope review. CRO then:

- installed AfterShip Tracking;
- explicitly selected **Free 50 Monthly** at **$0/month**;
- turned plan auto-upgrade OFF;
- locked Tracking notifications OFF;
- left the tracking page unlaunched;
- observed one existing shipment auto-sync;
- saved Returns as Delivery date + 75 days with no fulfillment fallback;
- re-read anonymous runtime as `return_window_base_on=delivery_date` with access denied/unpublished.

The dependency is now the authorized delivery-date source. No order-date approximation is authorized.

## Procurement evidence required before any recommendation

- Exact plan, free-trial duration, trial conversion, recurring price, usage/overage and cancellation terms.
- Whether Tracking must stay installed and paid for Returns to preserve Delivery date.
- Whether uninstall, billing lapse or scope loss silently reverts existing policy to order date.
- Contract/DPA/subprocessor changes and whether data crosses between Returns and Tracking organizations or products.
- Export, retention, deletion, support SLA and vendor-exit terms.
- Written vendor statement naming the authoritative delivery timestamp and conflict behavior.
- Proof that the delivery event covers partial shipments, reships, pre-orders, missing scans, failed delivery, pickup, international, manual fulfillment and carrier corrections.

## Shopify and data-scope review required

- Complete Shopify scopes requested by AfterShip Tracking, including OAuth/Admin API scopes.
- Protected customer data fields and historical orders accessed.
- Carrier accounts, tracking numbers, addresses, emails/phones, location events and delivery metadata collected.
- Webhooks, script tags, theme app extensions, app proxy, pixels, checkout/customer-account surfaces and navigation changes.
- Data written back to Shopify or exposed to other AfterShip products.
- Notifications, branded tracking pages, automations, analytics, AI features and marketing defaults.
- Credential/API-key creation, storage, rotation and revocation.
- Least-privilege configuration and every optional feature disabled by default.

## Security and operational review required

- Role access, audit log and separation between configuration, content, release and incident authority.
- Domain inventory and public-reachability behavior before and after installation.
- Failure modes for missing/late/contradictory carrier events.
- Duplicate events, webhook delay/replay, stale cache and reconciliation behavior.
- Kill switch, support escalation, outage fallback and rollback/uninstall procedure.
- Exact evidence proving uninstall restores the prior state and does not leave domains, scripts, data or notifications active.

## Staging-only acceptance sequence and remaining proof

1. Snapshot installed apps, scopes, themes, navigation, scripts, webhooks, domains and policy/runtime state.
2. Install only after explicit Matt approval of scope and any recurring spend.
3. Disable all tracking pages, notifications, marketing, AI and automations not required for the policy proof.
4. Keep AfterShip Returns and every public domain denied/unpublished.
5. Save Delivery date + 75 days in Admin.
6. Re-read Admin, public visible pages, public runtime JSON, canonical Shopify policy and notification configuration.
7. Prove `return_window_base_on=delivery_date`; prove 75-day behavior on delivered, partially delivered, undelivered, reshipped and corrected synthetic orders.
8. Run negative tests for dependency removal, scope loss, billing/trial expiry, missing carrier event and stale cache. All must fail closed, never revert to order-date eligibility.
9. Uninstall/rollback test in staging; verify no orphan domain, script, webhook, data flow or notification remains.
10. Produce two consecutive clean daily S0 readbacks before any pilot recommendation.

## Current decision

- Tracking app installed: YES.
- Tracking app installation authorized: YES, by Matt after scope review.
- Authorized delivery-date source: AfterShip Tracking.
- Dependency satisfied: YES.
- Plan: Free 50 Monthly, $0/month.
- Plan auto-upgrade: OFF.
- Tracking notifications: OFF/locked.
- Tracking page: UNLAUNCHED.
- Existing shipments auto-synced: 1.
- Returns runtime: DELIVERY DATE.
- Returns policy: Delivery date + 75 days, no fulfillment fallback.
- Unsavable pre-authorization draft: DISCARDED.
- Delivery+75 dependency gate: CLOSED.
- Daily S0: HOLD_S0 because public runtime `policy_text` still projects stale unused-and-undamaged copy.
- Consecutive clean S0 receipts: 0 of 2.
- Public/pilot launch: HOLD / NO-GO.

# AfterShip Tracking Dependency: Procurement and Scope Gate

Status: TRACKING FREE DEPENDENCY INSTALLED UNDER MATT AUTHORIZATION; DELIVERY-DATE BASIS SATISFIED; OTHER S0 GATES REMAIN HOLD.
Decision date: 2026-08-08

## Root cause

AfterShip Returns cannot persist the required Delivery date return-window basis unless the separate AfterShip Tracking app is installed. The Returns UI showed the explicit warning `To use this option, you need to install the AfterShip Tracking app. Try for free.` Save was disabled without the dependency and the public runtime remained `return_window_base_on=order_date`.

The CRO first discarded the unsupported draft. Matt then explicitly authorized a bounded installation after the broad Shopify-permission review. AfterShip Tracking auto-synced one shipment. The plan was explicitly changed from the initial trial to `Tracking Free 50 Monthly`, `$0/month`, 50 shipments/month, with auto-upgrade off. Tracking notifications remained off/locked and no tracking page was launched. Returns then persisted Delivery date + 75 days with no fulfillment fallback, and anonymous runtime readback changed to `return_window_base_on=delivery_date`.

## Non-negotiable policy rule

OTCHealth's approved return window is 75 days from delivery. Order date is not an acceptable approximation, fallback, proxy or temporary launch rule. A later delivery, failed delivery, reshipment, pre-order, carrier delay or missing tracking event can make order-date logic materially shorten the promised window.

If Delivery date cannot be persisted and read back exactly, AfterShip Returns cannot be the authoritative eligibility engine for this policy and the portal remains unpublished.

## Owner decision executed

Matt selected the bounded Tracking dependency after scope review. The dependency is cost-contained on the Free 50 Monthly plan, auto-upgrade is off, notifications are off, the tracking page is unlaunched, and the return portal remains unpublished. This decision closes only the delivery-date dependency; it does not authorize publication or customer traffic.

The exact no-approximation alternative remains the OTCHealth-owned authority kernel or manual Care review using a verified delivery event. It is the rollback path if Tracking loses scope, is uninstalled, exceeds its free quota, stops producing delivery events, or silently reverts the runtime. No path authorizes order-date approximation.

## Procurement review outcome and remaining obligations

Completed: `Tracking Free 50 Monthly`, `$0/month`, 50 shipments/month, plan auto-upgrade off. No paid recurring commitment was accepted. The initial trial selection was replaced explicitly rather than left to convert.

Still required before any public traffic or long-term reliance:

- Written confirmation that Free 50 continues to provide the delivery event required by Returns, plus quota-exhaustion and cancellation behavior.
- Whether Tracking must stay installed and paid for Returns to preserve Delivery date.
- Whether uninstall, billing lapse or scope loss silently reverts existing policy to order date.
- Contract/DPA/subprocessor changes and whether data crosses between Returns and Tracking organizations or products.
- Export, retention, deletion, support SLA and vendor-exit terms.
- Written vendor statement naming the authoritative delivery timestamp and conflict behavior.
- Proof that the delivery event covers partial shipments, reships, pre-orders, missing scans, failed delivery, pickup, international, manual fulfillment and carrier corrections.

## Shopify and data-scope review outcome

Matt approved installation after review of the displayed broad permission categories: customer/browser data; products, inventory and collections; orders, fulfillments, draft orders and order edits; discounts, gift cards and price rules; web pixels and Online Store content/navigation; markets and locations.

Remaining evidence:

- Preserve the exact Shopify permission-screen receipt and map the human-readable permissions to OAuth/Admin API scope codes.
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

## Staging-only execution receipt and remaining acceptance

Completed:

1. Broad Shopify permission categories reviewed and Matt authorized the bounded install.
2. AfterShip Tracking installed; one shipment auto-synced.
3. Plan explicitly changed to `Tracking Free 50 Monthly`, `$0`, auto-upgrade off.
4. Tracking notifications remained off/locked; no tracking page launched.
5. AfterShip Returns remained unpublished/access denied.
6. Delivery date + 75 days saved with no fulfillment fallback.
7. Anonymous runtime changed to `return_window_base_on=delivery_date` on both default domains and both policy paths.

Still required:

8. Correct stale `policy_text`, enable search blocking, and assign notification owners; retain exact canonical URL/summary/link parity.
9. Produce two consecutive clean daily S0 readbacks.
10. Run negative tests for dependency removal, scope loss, free-quota exhaustion, missing carrier event and stale vendor projection. All must fail closed, never revert to order-date eligibility.
11. Complete an uninstall/vendor-exit test in a safe environment and verify no orphan domain, script, webhook, data flow or notification remains.

## Current decision

- Tracking app installed: YES, Matt-authorized after broad-scope review.
- Tracking plan: FREE 50 MONTHLY, `$0`, auto-upgrade OFF.
- Auto-synced shipment count at install: 1.
- Tracking notifications: OFF/LOCKED.
- Tracking page: NOT LAUNCHED.
- Unsupported pre-install draft: DISCARDED.
- Returns Admin: DELIVERY DATE + 75 DAYS, no fulfillment fallback.
- Returns runtime: `delivery_date` on all four checked public endpoints.
- Delivery+75 dependency gate: PASS.
- Public-domain access: DENIED/UNPUBLISHED.
- Remaining S0: stale `policy_text`.
- Remaining S1: search blocking false and notification ownership incomplete.
- Clean receipts: 0 of 2.
- Public/pilot launch: HOLD / NO-GO until the remaining drift is corrected and two clean receipts exist.

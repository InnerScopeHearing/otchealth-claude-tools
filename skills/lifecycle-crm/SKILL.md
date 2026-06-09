---
name: lifecycle-crm
description: Operates the customer database for revenue, the fastest cash lever. Runs Customer.io email + SMS lifecycle, segments, journeys, reactivation of the 85K legacy/customer list, welcome / abandoned-cart / post-purchase / winback flows, subject-line and offer A/B. Wielded by the Lifecycle/Closer agent. Compliance-gated (CAN-SPAM, TCPA for SMS, the securities firewall).
---

# lifecycle-crm — turn the owned database into orders

The 85K customer/legacy database in Customer.io (workspace 193366) is the biggest
owned, zero-cost revenue asset, and email is the highest-ROI channel. This skill
runs it. **Email leads; outbound SMS/voice wait on consent (see voice-ops).**

## When to invoke
Any revenue or reactivation campaign to the customer base, or building the
always-on lifecycle flows.

## What it does
- **Segment** the list (buyers vs legacy, recency, product interest, voice-call
  attributes already on contacts) and clean it (suppress unsubscribes, hard bounces).
- **Reactivation campaign** to the legacy base around real offers (the $199-299
  hearing-aid clearance, TReO/accessories that don't need FDA first).
- **Always-on flows:** welcome, abandoned-cart, post-purchase + review request,
  winback, replenishment. Fire from Shopify/app events via n8n.
- **A/B** subject lines, offers, send times; let the data pick winners.
- **Measure** to revenue (open -> click -> order -> $), not vanity metrics.

## Hard guardrails
- **CAN-SPAM:** valid physical mailing address + one-click unsubscribe on every send.
- **SMS = TCPA:** only to numbers with prior express consent; honor opt-out. Legacy-
  list consent provenance is unverified, so SMS waits on a consent pass.
- **No medical/device claims;** "may help" framing; never "FDA-cleared." No PHI in
  any message, segment, or property.
- **Securities firewall:** product/offer content only. No INND/stock/raise language.
- No em or en dashes in any published copy.

## Output
Live segments + campaigns + flows in Customer.io, tied to revenue, handed to
Commerce/Finance-Ops for the cash scoreboard.

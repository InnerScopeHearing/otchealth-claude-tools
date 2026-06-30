# CONSUMABLES SELLING PLAN SPEC — Shopify-Native Replenishment + Day-0 Complete-Your-Kit Attach

**Owner:** CRO (recurring engine) + CTO (Shopify Admin API + Stripe rail) · **Lane:** `cro`
**Store:** hearingassist.myshopify.com / otchealthmart.com · **Rail:** existing Stripe
**Status:** SPEC (commit-ready). Standing up the live Selling Plan Group and publishing the attach
flow are Matt-gated / live-infra steps, NOT done here.

> **Why this matters.** Per the Moore Playbook and the Execution Program, the consumables
> replenishment subscription is the FIRST recurring SKU in the machine, the load-bearing LTV /
> valuation lever that is currently vapor. It runs on the SAME proven Stripe rail as the one-time
> TReO order, attaches at the moment of first purchase (day-0 complete-your-kit), and turns a
> dormant one-time store into a recurring revenue engine. It is a low-risk, non-PHI, PSAP-safe
> lane: consumables are accessories (domes, tubes, batteries, cleaning, dehumidifier), so there is
> no medical / hearing-aid / FDA claim anywhere in this flow.

---

## 0. Compliance and copy guardrails (apply to every customer-facing string in this flow)

- All published copy (subscription option labels, attach offer, cart, post-purchase, lifecycle
  emails) is **DASH-CLEAN**: no em dashes, no en dashes; commas, periods, line breaks only.
- **PSAP-only.** Consumables are described as the parts that keep your amplifiers comfortable and
  working. ZERO treat / diagnose / cure / hearing-loss / hearing-aid / FDA / medical language.
- Every customer-facing string routes through the live `claims_check` gate (SOP-1) before publish.
- **Non-PHI ring only.** Attach / renew / churn events go to a non-PHI PostHog project; no health
  data, no PHI, no patient context in any payload.
- Subscription terms (renewal cadence, that it auto-renews, how to cancel, the subscriber
  discount) are stated plainly at the point of opt-in to satisfy auto-renewal disclosure norms.

---

## 1. Objective and scope

Stand up a **Shopify-native Selling Plan Group** for consumables replenishment (30 / 60 / 90-day
cadences, ~10 to 15 percent subscriber discount) bound to the existing consumable SKUs, plus a
**day-0 complete-your-kit attach flow** that offers the matching replenishment at the moment a
customer buys TReO. Native Shopify subscriptions (Selling Plans) are used so the offer renders as
the standard Subscribe and Save control on the PDP and runs on the existing Stripe rail, with no
new third-party subscription app cost.

**In scope:** the Selling Plan Group + selling plans, binding to consumable SKUs, the PDP
Subscribe and Save render, the day-0 attach (post-purchase + Customer.io fallback), event
instrumentation.

**Out of scope (separate specs):** AWARE app subscription (RevenueCat, second recurring SKU),
CareNow (BLOCKED, Securities Act 17(b)), day-14 milestone and day-45 churn-save drips (lifecycle
spec), abandoned-cart recovery (lifecycle spec).

---

## 2. The SKUs the Selling Plan binds to (consumables, canonical pricing)

| Consumable | One-time price | Default replenishment cadence | Notes |
|---|---|---|---|
| Replacement domes | $9.99 to $14.99 | 30 days | Wear item, replaced most often |
| Replacement tubes | $14.99 | 60 days | Wear item |
| Batteries | $4.99 (BOGO available) | 30 days | Highest-frequency consumable |
| Cleaning kit / supplies | $12 to $14 | 90 days | Maintenance |
| Dehumidifier | $59.99 | 90 days | Maintenance, lower frequency |

- Subscriber discount: **10 to 15 percent** off the one-time price on each delivery (final percent
  is a Matt/pricing gate; spec uses 10 to 15 percent as the band).
- Cadence is per-product defaulted (above) but the customer can choose 30 / 60 / 90 at opt-in.
- All five consumable products / variants are the binding targets; TReO itself is a one-time SKU
  and is NOT placed on a selling plan (the device is bought once; only the consumables recur).

---

## 3. Selling Plan Group structure

One Selling Plan Group, "Subscribe and Save (Replenishment)," containing three selling plans by
cadence. Each consumable product is added to the group; the per-product default cadence (Section 2)
is surfaced as the pre-selected option, with the other two cadences available.

```
Selling Plan Group: "Subscribe and Save (Replenishment)"
  merchantCode: replenishment
  appId: (native / none — Shopify-native selling plan)
  options: ["Delivery every"]
  Selling Plan: "Every 30 days"
    options: "30 days"
    billingPolicy: RECURRING, interval DAY, intervalCount 30
    deliveryPolicy: RECURRING, interval DAY, intervalCount 30
    pricingPolicies: FIXED, adjustmentType PERCENTAGE, adjustmentValue 10 to 15
  Selling Plan: "Every 60 days"
    options: "60 days"
    billingPolicy: RECURRING, interval DAY, intervalCount 60
    deliveryPolicy: RECURRING, interval DAY, intervalCount 60
    pricingPolicies: FIXED, adjustmentType PERCENTAGE, adjustmentValue 10 to 15
  Selling Plan: "Every 90 days"
    options: "90 days"
    billingPolicy: RECURRING, interval DAY, intervalCount 90
    deliveryPolicy: RECURRING, interval DAY, intervalCount 90
    pricingPolicies: FIXED, adjustmentType PERCENTAGE, adjustmentValue 10 to 15
```

**Customer-facing labels (DASH-CLEAN, claims_check before publish):**
- Group heading on the PDP: "Subscribe and Save"
- Option labels: "Deliver every 30 days," "Deliver every 60 days," "Deliver every 90 days"
- Savings badge: "Save [10 to 15] percent on every delivery"
- Plain-language terms line: "Ships and renews automatically on the schedule you pick. Cancel
  anytime from your account or by calling 1-800-864-4337."

---

## 4. Implementation — Shopify Admin GraphQL (`sellingPlanGroupCreate`)

Stand the group up with `graphql_mutation sellingPlanGroupCreate`, then attach products. Reference
shape (final variable values, especially the discount percent and product GIDs, are set at build
time by CTO; this is the spec, not the live call):

```graphql
mutation CreateReplenishmentGroup($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput) {
  sellingPlanGroupCreate(input: $input, resources: $resources) {
    sellingPlanGroup { id appId merchantCode name options sellingPlans(first: 10) { edges { node { id name } } } }
    userErrors { field message }
  }
}
```

```jsonc
// $input
{
  "name": "Subscribe and Save (Replenishment)",
  "merchantCode": "replenishment",
  "options": ["Delivery every"],
  "sellingPlansToCreate": [
    {
      "name": "Every 30 days",
      "options": "30 days",
      "category": "SUBSCRIPTION",
      "billingPolicy": { "recurring": { "interval": "DAY", "intervalCount": 30 } },
      "deliveryPolicy": { "recurring": { "interval": "DAY", "intervalCount": 30 } },
      "pricingPolicies": [{ "fixed": { "adjustmentType": "PERCENTAGE", "adjustmentValue": { "percentage": 12 } } }]
    },
    { "name": "Every 60 days", "options": "60 days", "category": "SUBSCRIPTION",
      "billingPolicy": { "recurring": { "interval": "DAY", "intervalCount": 60 } },
      "deliveryPolicy": { "recurring": { "interval": "DAY", "intervalCount": 60 } },
      "pricingPolicies": [{ "fixed": { "adjustmentType": "PERCENTAGE", "adjustmentValue": { "percentage": 12 } } }] },
    { "name": "Every 90 days", "options": "90 days", "category": "SUBSCRIPTION",
      "billingPolicy": { "recurring": { "interval": "DAY", "intervalCount": 90 } },
      "deliveryPolicy": { "recurring": { "interval": "DAY", "intervalCount": 90 } },
      "pricingPolicies": [{ "fixed": { "adjustmentType": "PERCENTAGE", "adjustmentValue": { "percentage": 12 } } }] }
  ]
}
```

```jsonc
// $resources — attach the consumable products (use real product GIDs)
{ "productIds": [
  "gid://shopify/Product/<DOMES>",
  "gid://shopify/Product/<TUBES>",
  "gid://shopify/Product/<BATTERIES>",
  "gid://shopify/Product/<CLEANING>",
  "gid://shopify/Product/<DEHUMIDIFIER>"
] }
```

**Notes / pitfalls for the build:**
- Use `category: SUBSCRIPTION` on each selling plan or the cadence will not render as a
  subscription option and the Stripe-backed recurring billing will not attach.
- The discount is expressed once per selling plan via `pricingPolicies.fixed` PERCENTAGE; the
  example uses 12 percent (midpoint of the 10 to 15 band) as a placeholder pending the pricing gate.
- To add more products later, use `sellingPlanGroupAddProducts`; to bind specific variants use
  `sellingPlanGroupAddProductVariants`.
- Verify the theme renders the selling-plan selector on each consumable PDP (Subscribe and Save
  control) on STAGING before any traffic. If the theme does not expose the selector, add the
  selling-plan block to the product template.
- Confirm recurring charges settle on the existing Stripe rail (the same rail the one-time TReO
  order uses) so no new payment integration or app fee is introduced.

---

## 5. Day-0 complete-your-kit attach flow

Goal: at the moment a customer buys TReO, offer the matching consumables on a replenishment plan
so the recurring SKU attaches on day 0, with a fallback for non-attachers.

### 5.1 Primary path — post-purchase / order-status upsell
- Surface a "Complete your kit" offer on the post-purchase or order-status page presenting the
  consumables bundle (domes, tubes, batteries, cleaning) pre-set to a 60-day plan with the
  subscriber discount applied.
- One-tap add to the same order / same Stripe rail where the post-purchase surface supports it;
  otherwise a single pre-filled cart link.
- **Copy (DASH-CLEAN, claims_check before publish):**
  - Heading: "Keep your TReO fresh. Complete your kit."
  - Body: "Domes, tubes, batteries, and cleaning supplies are the parts that keep your amplifiers
    comfortable and working. Add them on Subscribe and Save and they arrive on schedule, [10 to
    15] percent off every delivery. Cancel anytime."
  - CTA: "Add my replenishment kit"

### 5.2 Fallback path — Customer.io day-0 email (for non-attachers)
- If a customer completes the TReO purchase but does NOT add the kit, fire a day-0
  complete-your-kit email from Customer.io (ws 193366) within a few hours of order confirmation.
- Email only (SMS is TCPA-blocked). Send is Matt-gated like all lifecycle sends.
- **Subject:** Your TReO is on the way. Here is what keeps it fresh.
- **Preview:** Add domes, tubes, and batteries on Subscribe and Save, [10 to 15] percent off every
  delivery.
- **Body (DASH-CLEAN):**
  ```
  Hi [First Name],

  Your iHEAR TReO is on the way. Thank you.

  To keep them comfortable and working day after day, you will want a few simple parts on hand.
  Domes, tubes, batteries, and cleaning supplies are the wear items, and the easiest way to never
  run out is Subscribe and Save.

  Pick a schedule, 30, 60, or 90 days, and your replenishment kit arrives on time, [10 to 15]
  percent off every delivery. Cancel anytime from your account or by calling 1-800-864-4337.

  [ Set up my replenishment kit ]

  Warmly,
  The iHEAR TReO Team
  ```
  *(Customer.io shared footer auto-renders the physical postal address + one-click unsubscribe,
  same as draft-141.)*

### 5.3 Flow logic
```
TReO purchase completed
  -> show post-purchase "Complete your kit" upsell (5.1)
       -> attach: customer on a replenishment plan (DONE, no email)
       -> no attach: Customer.io day-0 complete-your-kit email (5.2)
```

---

## 6. Event instrumentation (non-PHI PostHog project)

Instrument the recurring funnel so attach / renew / churn are measurable (PostHog = source of
truth, SOP-2 / SOP-6). Metadata only; no PHI, no health context.

| Event | When | Key properties (non-PHI) |
|---|---|---|
| `selling_plan_viewed` | Subscribe and Save selector rendered on a consumable PDP | product, cadence_options |
| `complete_kit_offer_shown` | Day-0 attach surface displayed | source (post_purchase / email), bundle |
| `subscription_attached` | Customer opts into a selling plan | product, cadence_days, discount_pct, day0 (bool) |
| `subscription_renewed` | A recurring charge succeeds | product, cadence_days, cycle_number |
| `subscription_churned` | Customer cancels / fails | product, cadence_days, lifetime_cycles, reason |

Derived metrics: day-0 attach rate, attach rate by source (post-purchase vs email fallback),
renewal rate by cadence, churn by cycle, consumables revenue and contribution into the $25K
tracker (CFO).

---

## 7. Build + verification checklist (staging before any live traffic)

- [ ] Confirm the five consumable products / variants and their GIDs.
- [ ] Run `sellingPlanGroupCreate` (Section 4) in a dev/staging context; confirm three selling
      plans created with `category: SUBSCRIPTION` and the chosen discount percent.
- [ ] Attach all five consumable products; verify the Subscribe and Save selector renders on each
      PDP with the correct default cadence pre-selected.
- [ ] Place a test subscription order on staging; confirm the recurring charge schedules on the
      existing Stripe rail and the discount applies.
- [ ] Build the post-purchase "Complete your kit" upsell; verify one-tap attach and the cart link.
- [ ] Build the Customer.io day-0 fallback email; verify it fires only for non-attachers and
      carries the shared CAN-SPAM footer + one-click unsubscribe.
- [ ] Wire the five PostHog events to the non-PHI project; verify they fire end-to-end.
- [ ] All customer-facing strings pass `claims_check` (PSAP-only, no medical claims, DASH-CLEAN).
- [ ] CCO clears subscription copy; auto-renewal terms disclosed at opt-in.

---

## 8. Dependencies and gates

- **Depends on:** the proven one-time checkout + connected Stripe payout bank (so recurring
  charges actually settle and refunds are fundable). Do not launch the recurring engine on a rail
  that cannot pay out.
- **Matt-gated / live-infra (NOT done here):** running the live `sellingPlanGroupCreate` mutation
  against the production store, publishing the post-purchase upsell, turning on the Customer.io
  day-0 send, the final discount percent within the 10 to 15 band, and any pricing change.
- **CCO-gated:** claims_check clearance on every string; auto-renewal disclosure sign-off.

---

## 9. What is done here vs what is still gated

- **DONE here:** the full spec, the Selling Plan Group + three-cadence structure bound to the five
  consumable SKUs, the exact `sellingPlanGroupCreate` GraphQL shape with build pitfalls, the
  day-0 complete-your-kit attach flow (post-purchase upsell + Customer.io fallback with finished
  DASH-CLEAN copy), the event instrumentation map, and the staging verification checklist.
- **STILL GATED (NOT done here, by design):** standing up the live Selling Plan Group on the
  production Shopify store and publishing the attach flow are Matt-gated / live-infra steps that
  depend on the proven checkout + connected Stripe payout bank and CCO copy clearance.

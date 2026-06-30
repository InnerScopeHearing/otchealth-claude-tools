# OTCHealth Unit Economics Model
## Reignition Phase 0 to 1 (TReO PSAP + membership)

**Owner:** CFO  
**Sponsor:** Matt  
**Lane:** `cfo` (write-through `--tags moore-playbook unit-econ`)  
**Produced:** 2026-06-30  
**Grounded in:** MOORE-PLAYBOOK.md, EXECUTION-PROGRAM.md, medvi-operations/PLAN.md, OTCHEALTH-CASH-PLAYBOOK.md, revenue-tracker.mjs  
**Ring:** Non-PHI. INND content is framework-level only (no share counts, prices, or valuations).

---

> ## READ THIS FIRST
> **EVERY dollar figure, rate, and count in this document is an ILLUSTRATIVE PLANNING ASSUMPTION, not a promise, projection, or measured result.** The store has done $227,290 all-time across 1,484 orders but **$0 in the last 90 days and 0 TReO units**. The mission is REIGNITION of a proven-but-dormant store, not first-dollar. No real reignition data exists yet. The single output of this model that matters is: **what to instrument and what the kill rules are**, so that the SECOND this model meets real numbers (one proven checkout, one seed wave), every assumption gets replaced by a measured value. Until then, treat the conclusions as a frame, not a forecast.
>
> **TReO is a Personal Sound Amplifier (PSAP).** Nothing in this model is a hearing-aid, medical, FDA, or hearing-loss claim. This is an internal finance document.

---

## 0. The numbers that are REAL (the anchor)

These are the only hard facts. Everything downstream of them is assumption.

| Real fact | Value | Source |
|---|---|---|
| Cash in bank | ~$2.41 (Mercury), effectively $0 | PLAN.md sec 0 |
| Revenue, last 90 days | $0 | PLAN.md sec 0 |
| Burn | ~$50,000 / month | PLAN.md sec 0 |
| Runway | ~0 | PLAN.md sec 0 |
| All-time paid revenue | $227,290 across 1,484 orders | revenue-tracker.mjs, PLAN.md |
| Warm mailable list | 66,224 (of ~85K DB) | MOORE-PLAYBOOK, PLAN.md |
| TReO Complete Pair price (PAIR99) | $99 (anchor $598) | CASH-PLAYBOOK |
| TReO single side | $99 (was $299) | CASH-PLAYBOOK |
| Guarantee | 60-day money-back, free shipping | CASH-PLAYBOOK |
| Membership target price | ~$19.99/mo | MOORE-PLAYBOOK sec 5, EXECUTION-PROGRAM |
| $25K gate | Cumulative NEW reignition revenue unlocks OTC-line prep | CASH-PLAYBOOK SOP-7 |

**Implied historical average order value:** $227,290 / 1,484 = **$153.16/order** (ILLUSTRATIVE reference only; the historical mix predates the PAIR99 $99 promo).

---

## 1. The conversion bridge (66,224 -> first reignition cash)

This is a worked example, not a forecast. The whole point is to SHOW THE MATH so the seed wave replaces every rate.

### Stated assumptions (ILLUSTRATIVE)

| Stage | Assumed rate | Basis for the guess |
|---|---|---|
| List -> opener | 30% open | Warm but ~20-day-decayed reactivation list; 25-35% is a defensible reactivation band, email-only |
| Opener -> clicker | 10% of openers | Single-CTA advertorial; price-anchor hook ("$299 a side at CVS, $99 here") |
| Clicker -> TReO buyer | 5% of clickers | Cold-ish reactivation into a checkout that is UNPROVEN; deliberately conservative |
| Buyer -> membership attach | 20% of buyers | Post-purchase consumables/AWARE attach; no live recurring SKU yet, so this is the softest number |
| Monthly membership churn | 5% / mo | Health-DTC reactivation cohort; the single most important number to beat |

### Worked bridge (one full send of 66,224)

```
  66,224 mailable
    x 30% open            =  19,867 openers
    x 10% click           =   1,987 clickers
    x  5% buy             =      99 TReO buyers   <-- ~100 orders, NOT 200k anything
    x 20% attach          =      20 new members
```

**Gross TReO revenue from one send:** 99 x $99 = **$9,801** (ILLUSTRATIVE).  
**New members from one send:** **~20** (ILLUSTRATIVE).

### Sensitivity (because the rates are guesses)

| Buyer rate (clicker->buyer) | Buyers | Gross TReO rev |
|---|---|---|
| 2% | 40 | $3,960 |
| **5% (base)** | **99** | **$9,801** |
| 10% | 199 | $19,701 |

A single send plausibly produces **$4K to $20K of TReO gross** depending only on the one rate we have zero data on. That range is exactly why the seed wave (step in EXECUTION-PROGRAM) fires BEFORE the full 66,224: the seed measures clicker->buyer, and that one measured number recomputes this whole table.

---

## 2. Why we DO NOT assert 200,000 subscribers

The playbook's billion-dollar frame uses an illustrative "~200,000 members x ~$19.99/mo" line as the long-run valuation lever. **That is a destination, not a Phase-0 number, and this model refuses to assert it.** Here is the arithmetic that keeps us honest.

At 5% monthly churn, subscriber count reaches a **steady state = (monthly gross adds) / churn**:

| Monthly gross new members | Steady-state subscriber base @ 5% churn |
|---|---|
| 20 (one reignition send/mo) | ~400 |
| 200 | ~4,000 |
| 1,000 | ~20,000 |
| **10,000** | **~200,000** |

**To stand at 200,000 members you must add ~10,000 NET-of-churn members EVERY month, indefinitely.** One reignition of the warm list adds ~20. The 200K number therefore requires a fully-running paid-acquisition machine sustained over years, which is precisely what is GATED behind: checkout proven, brand-health ready, paid spend authorized, and the $25K gate cleared. **This model commits only to: instrument the attach rate and the churn rate from the first real members, and let the steady-state formula tell us the truth as those two numbers arrive.**

---

## 3. TReO contribution margin AFTER returns

The headline is $99. The number that funds the company is the contribution AFTER refurb, batteries, shipping, fees, AND the 60-day return rate.

### Per-order cost stack (ILLUSTRATIVE, Complete Pair at $99)

| Line | Assumed cost | Note |
|---|---|---|
| Refurb cost (owned inventory, recondition L+R pair) | $22.00 | Owned 10,298-unit pool; refurb/3PL RFQ pending, this is a placeholder |
| Batteries | $5.00 | ~$4.99 BOGO consumable cost basis |
| Shipping (free to customer, paid by us) | $8.00 | Small parcel, free-shipping promise |
| Pick / pack / handling (3PL) | $3.00 | Per-order fulfillment |
| Stripe fee | $3.17 | 2.9% x $99 + $0.30 |
| **Total COGS + fees** | **$41.17** | |
| **Contribution BEFORE returns** | **$57.83** | $99.00 - $41.17 |

### Applying the 60-day money-back return rate

**Assumption:** 12% of orders return within 60 days (ILLUSTRATIVE; PSAP/senior cohort, money-back guarantee tends to run higher than typical DTC, so 12% is a deliberate planning haircut, not a floor).

On a return we refund the full $99 and we do NOT recover: shipping ($8) + pick/pack ($3) + Stripe fee (mostly non-refundable, $3.17). We DO restock the refurbished unit (it goes back to inventory), so the refurb + battery cost is treated as recoverable inventory, not a loss, on return.

```
Non-recoverable loss per returned order = $8 + $3 + $3.17 = $14.17

Blended contribution per order placed:
  = (1 - 0.12) x $57.83  -  0.12 x $14.17
  = 0.88 x $57.83  -  $1.70
  = $50.89 - $1.70
  = $49.19  per order placed   <-- the number that funds the company
```

**TReO contribution margin after returns: ~$49.19 per order placed (ILLUSTRATIVE), a ~49.7% contribution margin on $99.**

### Return-rate sensitivity (the swing factor)

| Return rate | CM after returns / order | CM % |
|---|---|---|
| 5% | $53.24 | 53.8% |
| **12% (base)** | **$49.19** | **49.7%** |
| 20% | $44.60 | 45.1% |
| 30% | $38.85 | 39.2% |

**The first thing the real cohort must produce is the actual 60-day return rate**, because at 30% returns the contribution is still positive but a third lower, and that directly moves the days-to-$25K math.

---

## 4. CAC and payback

### Reignition CAC (Phase 0-1): effectively $0 incremental

The 66,224 send runs on the owned list over Customer.io on existing grants. **Incremental cash CAC for the reignition = ~$0** (the playbook non-negotiable: cost-neutral on grants until Matt authorizes spend). Therefore in Phase 0-1, **every dollar of contribution margin is retained**, and payback is immediate on order one. This is the cheapest cash the company will ever buy, which is exactly why reignition is rank-1.

### Paid-acquisition CAC (Phase 4+, GATED, modeled for the guardrails)

This is modeled ONLY so the PAID-SPEND GUARDRAILS have a defensible kill rule. No paid dollar is authorized here.

| Assumption | Value |
|---|---|
| Cost per initiated checkout (CPIC) | $8.00 (ILLUSTRATIVE target) |
| Initiated-checkout -> completed buyer | 55% |
| **Implied paid CAC per buyer** | **$8.00 / 0.55 = $14.55** |

```
Payback (TReO only) = CAC / CM-after-returns
                    = $14.55 / $49.19
                    = 0.30 orders   --> paid back on the FIRST order
```

**At an $8 CPIC and ~49% contribution, a paid TReO order pays back its own acquisition cost immediately, before any subscription revenue.** That is the test the guardrails enforce: paid scales only while CPIC stays low enough that a single TReO order clears CAC. The membership attach is then pure upside on top of an already-paid-back order.

---

## 5. Subscription LTV (~$19.99/mo membership)

### Stated assumptions (ILLUSTRATIVE)

| Assumption | Value |
|---|---|
| Membership price | $19.99 / mo |
| Membership fulfillment cost (consumables / coaching content) | $4.00 / mo |
| Stripe fee | $0.88 / mo (2.9% x $19.99 + $0.30) |
| **Monthly contribution per member** | **$15.11** |
| Monthly churn | 5% |
| **Average member lifetime** | 1 / 0.05 = **20 months** |

```
Subscription LTV (contribution basis)
  = monthly contribution / churn
  = $15.11 / 0.05
  = $302.21  per member   (ILLUSTRATIVE)
```

### Churn sensitivity (the #1 compounder per the playbook)

| Monthly churn | Avg life | LTV (contribution) |
|---|---|---|
| 3% | 33.3 mo | $503.67 |
| **5% (base)** | **20.0 mo** | **$302.21** |
| 8% | 12.5 mo | $188.88 |
| 12% | 8.3 mo | $125.92 |

The playbook is right that churn is the lever: dropping from 8% to 3% monthly **more than doubles** member LTV. Every retention drip (day-14 / day-45 churn-save) is a direct LTV multiplier.

### Blended value of a reignition buyer who attaches

```
Buyer who attaches a membership (base case):
  TReO contribution after returns   = $49.19
  + Subscription LTV                 = $302.21
  = $351.40 total contribution    (ILLUSTRATIVE)
```

With a 20% attach rate, the **blended contribution per TReO buyer** (attachers + non-attachers) is:

```
  $49.19  +  0.20 x $302.21  =  $49.19 + $60.44  =  $109.63 per buyer
```

So a reignition buyer is worth **~$110 of contribution on average** (ILLUSTRATIVE), against ~$0 reignition CAC. That is the whole thesis in one line: the warm list is free, the contribution is real, and the membership attach is where the durable value lives.

---

## 6. Days to the $25K gate (worked from the bridge)

Using the base bridge (99 buyers, ~$9,801 gross TReO per full send) and the **CFO instrumentation rule that the $25K gate counts NEW reignition revenue only** (see REVENUE-TRACKER-PATCH.md, the all-time $227,290 does NOT count):

| Scenario | TReO gross per send | Membership MRR added | Sends to reach $25K cumulative |
|---|---|---|---|
| Base (5% buy) | $9,801 | ~$400/mo | ~2.6 full sends, or seed waves accumulating |
| Low (2% buy) | $3,960 | ~$160/mo | ~6.3 sends |
| High (10% buy) | $19,701 | ~$800/mo | ~1.3 sends |

**Interpretation:** even the conservative case clears $25K from the warm list inside a small number of waves WITHOUT any paid spend. The $25K gate is a reignition-revenue milestone, not a paid-acquisition milestone. This is why the model insists the tracker measure NEW revenue from the reignition start date, not the all-time total (which would falsely read ~100% on day one and green-light FDA spend on phantom revenue).

---

## 7. Phase-0 CASH BRIDGE (~$50K/mo burn at ~$0 cash, survived to first cash)

The hard reality: ~$50,000/mo burn, ~$2.41 in bank, ~0 runway. This is how Phase 0 is survived without new outside cash, framed as the dollar-trigger ladder.

### Principle: incremental cash cost of the reignition = $0

Every Phase-0 system runs on existing GRANTS, not cash:

| Function | Funded by | Cash cost |
|---|---|---|
| Funnel hosting, AI Search, cron, CS realtime | Azure $25K credit (scalable to $150K) | $0 |
| CI / builds | GitHub $10K credit | $0 |
| Analytics / observability | PostHog $50K credit | $0 |
| Ad / coaching voiceover | ElevenLabs 33M-char grant | $0 |
| Email reignition | Customer.io (existing) | $0 |
| Payments / store | Stripe + Shopify (existing) | $0 |

**Net new cash cost to fire the reignition: $0.** The reignition does not require spending money; it requires Matt clearing the four no-cash gates (connect Stripe payout bank, prove checkout, deploy the claims gate, make CS/refunds operationally true) and giving the send-go.

### The bridge ladder ($0 -> first cash -> $25K)

| Trigger / state | What it funds | Cash posture |
|---|---|---|
| **$0 (today)** | Nothing new. Reignition fires on grants. The burn is pre-existing (payroll/overhead), NOT caused by the reignition. | Survive on grants; do not add spend |
| **First reignition cash settles to Mercury** (one payout cycle post-send) | Confirms the cash-out rail is real (payouts_enabled=TRUE, payout lands). This is the first dollar that touches the bank in 90+ days. | Stop the bleed on "is the rail even real"; reconcile Shopify->Stripe->Mercury |
| **Cumulative ~$5K-$10K NEW reignition revenue** | Refund reserve is funded from real margin; CS reachability is staffable from real cash, not borrowed. Brand-health becomes self-funding. | First discretionary cash; prioritize refund desk + CS so the guarantee is operationally true |
| **Cumulative $25K NEW reignition revenue** | SOP-7 fires: OTC-line prep unlocks (gated on a NAMED human clinical reviewer). FDA ~$10K authorized ONLY at this trigger. | First authorized spend, and it is funded by realized PSAP cash, not credit or debt |

### The honest cash-bridge truth (flag-and-hold)

The reignition does NOT, by itself, cover a $50K/mo burn from one send (~$4K-$20K gross). **Surviving the gap between today and self-funding burn requires one of three Matt/counsel levers, all OUTSIDE this model and all gated:**

1. **Compress time-to-cash:** fire reignition waves back-to-back the moment checkout is proven (the bridge is days, not months, if the gates clear this week).
2. **The 10,298-unit owned inventory pool:** liquidation via Amazon + Shopify is a separate, larger cash lever the CRO owns (sourced via a 3-vendor refurb/3PL RFQ + 100-unit pilot). This is the realistic path to burn-coverage, not the email alone.
3. **Capital lever (INND):** framework-level only. Any capital action is MNPI, attorney + Matt gated, and explicitly OUTSIDE this finance model. **No share counts, prices, or valuations are modeled here.**

**CFO position:** Phase 0 is survived by (a) keeping incremental cash cost at $0, (b) clearing the four no-cash gates THIS WEEK to start the days-not-months cash clock, and (c) treating the owned-inventory liquidation as the burn-coverage lever while the membership base compounds. The reignition email is the spark; it is not the whole fire.

---

## 8. What replaces every assumption (the instrumentation contract)

The entire value of this model is that it tells the CFO exactly what to measure first. In priority order:

1. **Clicker -> buyer rate** (from the seed wave) -> recomputes the whole bridge and days-to-$25K.
2. **Actual Stripe fee + shipping + tax** on the first real order -> trues up CM after returns.
3. **60-day return rate** (first cohort matures) -> the single biggest swing on contribution.
4. **Membership attach rate** (first post-purchase flow) -> turns the 20% guess into the LTV multiplier.
5. **Monthly churn** (first member cohort at day 30/45) -> the LTV and the steady-state subscriber formula.
6. **Payout settlement to Mercury** -> proves the cash actually reaches the bank.

Each measured number is written to the `cfo` ledger and replaces its assumption here. **This document is a frame to be overwritten by reality, not a forecast to be defended.**

---

*Living deliverable. Every figure is an ILLUSTRATIVE ASSUMPTION until replaced by a measured value. Non-PHI ring. TReO = PSAP, never a hearing-aid/medical/FDA claim. INND = framework-level only.*

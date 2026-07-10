# PAID-SPEND-GUARDRAILS.md
## Cost-per-initiated-checkout kill/scale rules + the spend-stays-$0 gate

**Owner:** CFO  
**Sponsor:** Matt (authorizes every dollar)  
**Lane:** `cfo` (write-through `--tags moore-playbook paid-spend`)  
**Produced:** 2026-06-30  
**Grounded in:** EXECUTION-PROGRAM.md (CFO->CRO interconnect, Phase 5 row, gap rows), MEDVI PLAN.md (SOP-2, rank-8 lever), CASH-PLAYBOOK SOP-2, OTCHEALTH-UNIT-ECON.md  
**Ring:** Non-PHI.

---

## 0. The one rule above all rules

> **PAID SPEND STAYS $0 until ALL THREE are TRUE, in writing, in this order:**
> 1. **CHECKOUT PROVEN** — one real, full-price, non-refunded TReO order, verified end-to-end by the CTO (Shopify `financial_status=paid` + fulfilled; Stripe charge succeeded + NOT refunded; `payouts_enabled=true`; a payout actually settled to Mercury). A $1 owner test is NOT proof.
> 2. **BRAND-HEALTH READY** — CS reachable within the advertised promise on a live test AND at least one refund demonstrably issuable, AND the CCO has cleared the 60-day-guarantee / "help is a call or email away" claims as operationally true (FTC Act 5, Mail-or-Telephone Order Rule 16 CFR 435, Magnuson-Moss).
> 3. **MATT AUTHORIZES** — an explicit, recorded `TYPE: DECISION` from Matt approving a specific dollar budget and a specific channel. Paid spend is a HARD GATE; no agent self-authorizes a single dollar.
>
> Until all three are GREEN, the maximum authorized paid budget is **$0.00**. This is non-negotiable and is enforced as a precondition, not a guideline. Firing paid traffic into an unproven checkout or a dead CS line burns cash AND brand at the same time.

---

## 1. Why these guardrails exist before any dollar

The playbook's rank-8 lever is paid ads + the creative factory, explicitly **after** checkout is proven and brand-health is fixed (MEDVI PLAN sec 2). Medvi's whole model was industrial creative testing with kill/scale on **cost per initiated checkout** as the source of truth (CASH-PLAYBOOK, Medvi tactic #2). The CFO->CRO interconnect (EXECUTION-PROGRAM) is blunt: **PAID-SPEND GUARDRAILS must EXIST before any paid-ad dollar is authorized.** This document is that prerequisite: a defensible kill rule on paper so paid scale can never run without one.

---

## 2. The source-of-truth metric

**Primary kill/scale metric: Cost Per Initiated Checkout (CPIC)**, measured in PostHog (the $50K observability lane), per ad set, over a rolling 48-72h window.

- **Initiated checkout** = the PostHog event fired when a user reaches the Shopify/Stripe checkout, NOT a pageview and NOT a click. It is the closest leading indicator of a real buyer that we can read fast enough to kill within 72h.
- **Why CPIC, not CAC, as the trigger:** CAC needs completed+settled+non-refunded orders, which lag by the payout cycle and the 60-day return window. CPIC is readable in hours. We kill/scale on CPIC and **reconcile to true CAC weekly** once orders settle (CFO->CRO: the measured seed-wave email->buyer CVR replaces the assumed CVR and recomputes everything).

---

## 3. The economic ceilings (derived from the unit-economics model)

All figures ILLUSTRATIVE, from OTCHEALTH-UNIT-ECON.md. These are the breakeven walls the kill rules sit inside.

| Quantity | Value | Source |
|---|---|---|
| TReO contribution margin after returns | $49.19 / order | unit-econ sec 3 |
| Initiated-checkout -> completed buyer | 55% (assumed, replace with measured) | unit-econ sec 4 |
| **Max CPIC at TReO breakeven** | $49.19 x 0.55 = **$27.05** | a buyer who pays back ONLY on TReO margin |
| **Target CPIC (scale aggressively below)** | **$8.00** | TReO order pays back CAC ~3x over |
| **Membership attach upside (not required for breakeven)** | +0.20 x $302.21 LTV = +$60.44 / buyer | unit-econ sec 5 |

**Key principle:** we set the kill ceiling at the **TReO-only** breakeven ($27.05 CPIC), so the membership LTV is pure upside and never required to justify the spend. If a buyer pays back on the $99 order alone, the subscription attach is profit, not a crutch.

---

## 4. KILL / SCALE rules (per ad set, 48-72h window)

Evaluated on a rolling 48-72h window with a minimum of ~50 initiated checkouts before any scale decision (below that, the sample is noise, HOLD).

| CPIC over 48-72h | Action | Rationale |
|---|---|---|
| **> $27.05** (above TReO breakeven) | **KILL immediately** | Loses money on every order even before returns; no path to profit |
| **$16.00 - $27.05** | **HOLD / iterate**, do not scale | Marginal; fix creative/offer/landing before adding budget |
| **$8.00 - $16.00** | **MAINTAIN** budget, keep testing variants | Profitable on TReO alone; healthy |
| **< $8.00** (target) | **SCALE** budget +50% per 48-72h step, re-measure | Strong; TReO pays back CAC ~3x, membership is upside |

### Hard secondary kill triggers (override the CPIC table)

Any ONE of these kills the ad set regardless of CPIC:

- **Refund / return rate on the cohort > 20%** over the window (the unit-econ base is 12%; at >20% the contribution erodes and brand-health risk rises). Pause and diagnose before continuing.
- **CS first-response SLA breached** (the brand-health precondition stops being true) -> THROTTLE all outbound, paid included, until restored (CCO rule).
- **Spam-complaint or chargeback rate spike** (chargebacks > 0.75%, the Stripe/Visa warning threshold) -> kill the channel/creative driving it.
- **A claims_check failure** on any live creative -> pull the creative immediately (compliance is a hard gate; the FTC holds the brand liable, including for affiliate/creator copy).

### Scale governance

- **Budget steps are capped per decision:** no ad set scales more than +50% per 48-72h evaluation, so a transient cheap-CPIC window cannot blow the budget before true CAC reconciles.
- **Aggregate daily cap:** total paid spend across all channels cannot exceed the specific dollar budget Matt authorized in his `TYPE: DECISION`. Reaching 80% of the daily cap triggers a CFO notice to Matt before any further scale.
- **Weekly true-up:** every Friday the CFO reconciles CPIC-driven decisions against settled, non-refunded CAC and member attach, and recomputes the ceilings with measured numbers. The illustrative $8 / $27.05 walls move to wherever the data puts them.

---

## 5. The kill-rule decision in one line (operator-pasteable)

```
IF cpic_48_72h > 27.05  OR  cohort_return_rate > 0.20  OR  cs_sla_breached
   OR  chargeback_rate > 0.0075  OR  claims_check_failed
THEN KILL
ELIF cpic_48_72h < 8.00  AND  initiated_checkouts >= 50
THEN SCALE +50% (capped at Matt-authorized daily budget)
ELSE HOLD / iterate
```

PostHog is the source of truth for `cpic_48_72h` and `initiated_checkouts`; Shopify/Stripe for `cohort_return_rate` and `chargeback_rate`; the brand-health SOP for `cs_sla_breached`; the claims_check gate for `claims_check_failed`.

---

## 6. The gate state (what "$0 until proven" looks like operationally)

| Precondition | Owner / verifier | Current state (2026-06-30) | Gate |
|---|---|---|---|
| CHECKOUT PROVEN (real, full-price, unrefunded, settled to Mercury) | Matt (order) + CTO (verify) | NOT PROVEN (only charge ever was a refunded owner test; `payouts_enabled=FALSE`) | RED |
| BRAND-HEALTH READY (CS reachable + refund issuable + CCO clears guarantee claims) | COO/CS + CCO | NOT READY (the #1 historical complaint; claims conditionally gated) | RED |
| MATT AUTHORIZES a specific budget + channel | Matt | NOT GIVEN | RED |
| **=> Maximum authorized paid spend** | CFO enforces | | **$0.00** |

**All three must flip GREEN, recorded as a `TYPE: DECISION`, before the first dollar moves.** The CFO publishes this gate state into the forcing GATE-STATE morning brief; two reds auto-escalate to Matt.

---

## 7. Relationship to the other artifacts

- The ceilings here are DERIVED from OTCHEALTH-UNIT-ECON.md; when the seed wave replaces the assumed clicker->buyer and the real return rate lands, the CFO recomputes the $8 / $27.05 walls and reissues this table.
- This guardrail is the CFO->CRO precondition: no paid creative goes live until CHECKOUT PROVEN + BRAND-HEALTH READY + MATT AUTHORIZES, and then only inside these kill/scale rules.
- Compliance is orthogonal and absolute: every paid creative (owned AND affiliate) passes claims_check first (TReO = PSAP, amplification/wellness language only, zero treat/diagnose/cure); a claims_check failure is a hard kill independent of CPIC.

---

*Non-PHI ring. All economic figures ILLUSTRATIVE, derived from OTCHEALTH-UNIT-ECON.md. Paid spend is a HARD GATE: $0 until checkout proven AND brand-health ready AND Matt authorizes. TReO = PSAP, never a hearing-aid/medical/FDA claim.*

# Medvi Operations — PLAN (COO deliverable)

**Owner:** COO (The Quarterback) · **Sponsor:** Matt · **Lane:** `coo` (write-through `--tags medvi-ops`)
**Produced:** 2026-06-28 · **Reconciled against:** coo + cro ledgers, company brain, README/PLAYBOOK/SOURCES.

---

## 0. The one number
**Cash in bank: $0** (Mercury ~$2.41). Revenue last 90 days: **$0**. Burn ~$50K/mo, ~0 runway.
The store is **PROVEN BUT DORMANT** — ~$227,290 all-time across 1,484 orders, but $0 in 90 days,
0 TReO units. **The mission is REIGNITION, not first-dollar.** The entire machine is built and
sits behind one $99 action (prove checkout) + a send-go. 19 days, zero cash moves executed.

---

## 1. Medvi-parallel map (mechanic → our equivalent → status → gap)

| # | Medvi growth mechanic | Our equivalent | Status | Gap to close |
|---|---|---|---|---|
| 1 | Single-wedge paid funnel: ad→advertorial→quiz→offer, sub-first | iHEAR TReO advertorial + 5-Q quiz → offer → Shopify/Stripe | **BUILT/LIVE** (focus-group v4/v5, ~90%) | Checkout UNPROVEN; no paid traffic yet; no live recurring back-end |
| 2 | Industrial creative testing (20-50/wk, kill/scale on cost-per-checkout) | AI creative factory → claims gate → staged ad sets | claims gate **LIVE**; factory **NOT BUILT**; spend **GATED** | Build creative factory; PostHog cost-per-initiated-checkout as source of truth; spend Matt-gated |
| 3 | Advertorial IS the landing page (2-4x vs PDP) | Advertorial = the funnel page | **BUILT/LIVE** | None structural — needs traffic + a proven checkout behind it |
| 4 | Creator/affiliate flywheel (100s of micro-creators, flat + 15-25%) | Affiliate program, claims-gated creator copy | **NOT BUILT** | Build creator-brief engine **+ FTC affiliate-audit/persona-verification SOP** (the one Medvi risk that transfers); launch after first cash |
| 5 | Offer/pricing psychology (free lead, back-end sub, anchor-discount, auto-renew) | iHEARtest free magnet; PAIR99 ($299/side CVS → $99 pair); CareNow/AWARE back-end | TReO offer + PAIR99 **LIVE**; iHEARtest **~next week**; subs **INTERNAL/FUTURE** | Ship iHEARtest magnet; stand up a recurring back-end (consumables/AWARE); final pricing Matt-gated |
| 6 | AI CS + compliance firewall (scripted, logged, pre-approved) | VoiceRAG CS + Sarah voice fleet + claims_check | **LIVE** (underloaded until funnel fires) | **BRAND-HEALTH**: CS reachability + refund backlog must be PROVEN reliable before scaling paid (the #1 BBB/Trustpilot complaint) |
| 7 | Retention: milestone framing + day-14/45 churn-save (35%+) | Customer.io lifecycle drips + consumables + AWARE | reactivation **DRAFT**; milestone/churn drips **NOT BUILT**; consumables/AWARE **not live** | Build abandoned-cart + milestone + churn-save drips; stand up consumables subscription |
| 8 | Compliance as moat (screen ads/advertorials hardest, owned + affiliate) | `claims_check` gate (SOP-1), channel-aware PSAP/FTC ruleset | **LIVE** | Extend to affiliate/creator identity + persona vetting (not yet defined) |

**9-stage loop status:** IGNITE (list ready, send gated) → MAGNET (iHEARtest ~next wk) → FUNNEL (live) →
CLOSE (Stripe live, **checkout UNPROVEN**) → SUPPORT (VoiceRAG/fleet live; **brand-health risk**) →
RETAIN (not built) → ASCEND ($25K gate) → MEASURE (revenue tracker live, CFO lane) → COMPLY (claims gate live).

---

## 2. Prioritized deploy sequence by speed-to-cash (owner per lever)

| Rank | Lever | Time-to-cash | Owner | Gate |
|---|---|---|---|---|
| 1 | **Prove the TReO checkout** (one real full-price order) | unlocks everything | **Matt** (COO orchestrates) | Matt-only, ~10 min |
| 2 | **Fire reignition to 66,224** (warm HearingAssist list) | days → FIRST REAL CASH | CRO / lifecycle | Gated on #1 + Matt send-go (email only; CAN-SPAM clean) |
| 3 | **Gumroad SOP store live** (5 SOPs drafted) | days, zero gates, parallel | digital-products + Matt | Matt creates acct + uploads PDFs (~60 min) |
| 4 | **Brand-health fix** (reachable CS + clear refund backlog) | guardrail — protects #2 | COO / CS | Prereq before scaling paid; partially Matt (refund $) |
| 5 | **iHEARtest magnet launch** (free screening, top-of-funnel) | ~1 wk | developer / CTO | Ships ~next week |
| 6 | **Lifecycle drips** (abandoned-cart, milestone, day-14/45 churn-save) | weeks | lifecycle / CRO | Customer.io; sends Matt-gated |
| 7 | **Amazon TReO channel** | fund/file after first $ | CRO + CLO + Matt | See open question #4 (Apply-to-Sell vs Brand Registry) |
| 8 | **Paid ads + creative factory + creator flywheel** | after checkout proven + brand-health fixed | CRO | Real ad spend = Matt-gated |
| 9 | **Recurring back-end** (consumables, AWARE; CareNow at launch) | LTV layer | CRO / CPO | CareNow share-bundle = Securities Act 17(b) flag (counsel) |
| 10 | **$25K gate → OTC line prep** | milestone | CFO tracker + CPO + Matt | clinical sign-off; behind a flag |

---

## 3. First moves for Matt (WHAT, not how — sized to the Mon 9:30-11:30am PT cash block)

1. **Place ONE real full-price TReO Complete Pair order** on otchealthmart.com (code PAIR99 → $99), real card, complete it. Report the order #. *This is THE gate — ~10 min.*
2. **Give the send-go** for the reignition email to the 66,224 once the order confirms (email only). *~5 min decision — but only after the brand-health line is reachable so the warm list doesn't hit a dead support number.*
3. **Stand up Gumroad** — create the account + upload the 5 SOP PDFs, turn on instant delivery. *Parallel, ~60 min, zero gates, cash in days.*

That's the full 2-hour block. Everything else runs through the fleet without you.

---

## 4. Org + cadence (runs without Matt except at gates)

- **COO (quarterback):** owns this project; daily checks the gate is moving; dispatches; morning brief (the number + 1-3 moves + a green/red per-agent line); idempotency.
- **CRO:** funnel/offer/email/Amazon/ads/creative. **lifecycle** (under CRO): Customer.io drips.
- **digital-products:** Gumroad. **CFO:** daily P&L + $25K tracker + CAC/LTV. **CPO:** clinical gate (OTC, iHEARtest).
- **CCO:** claims-gate enforcement on ALL copy (owned + affiliate). **CTO/developer:** funnel hosting, iHEARtest, VoiceRAG, revenue tracker, creative-factory infra. **CS/COO:** brand-health (reachability + refunds) + nightly VoiceRAG content sync (SOP-3).
- **Daily:** COO morning brief; checkout-proof status; revenue heartbeat.
- **Weekly:** funnel-experiment review (kill/scale, SOP-2); brand-health metrics (CS response time, refund backlog); cohort/CAC-LTV; $25K progress.
- **SOPs SOP-1…SOP-8** are the runbooks that make each loop run hands-off; Matt is touched only at the hard gates below.

---

## 5. Open questions / decisions (Matt or counsel)

1. **Send-go:** approve firing the reignition email to 66,224 once checkout is proven? (email only; TCPA blocks SMS).
2. **Final pricing:** confirm PAIR99 $99 pair as the live promo (Matt-gated).
3. **Paid-ad budget:** when/how much to authorize — only after checkout proven AND brand-health fixed.
4. **Amazon path reconciliation:** the CRO/brain view says it's gated on Matt signing 3 PDFs + uploading a commercial invoice (Apply-to-Sell); the COO/CLO view says it's gated on the **iHEAR trademark** (abandoned 2019 → file fresh, ~$300-2k, Brand Registry accepts pending). **Which path, who, when?** Fund after first dollars.
5. **Brand-health:** who clears the refund backlog and staffs reachable CS? VoiceRAG answers inquiries, but refunds need a human/finance action.
6. **CareNow/AWARE launch timing** + the **Securities Act 17(b)** flag on the CareNow share-bundle promo (counsel).
7. **Hard-gate security:** rotate the GCP SA + PostHog keys (28-cred ops leak, deferred) — BLOCKS any investor/public exposure.
8. **Affiliate program:** build the FTC affiliate-audit + creator-persona-verification SOP BEFORE launching creators (the one Medvi failure mode that transfers directly).

---

## 6. Non-negotiables honored
Compliance moat (claims_check on every owned + affiliate claim) · market only what ships today (TReO now,
iHEARtest ~next week; CareNow/SaveRx internal) · TReO is a PSAP, never a hearing-aid/medical/FDA claim ·
checkout-proof before any send · brand-health (CS + refunds) before scaling paid · hard gates = prepare + flag
only (paid spend, mass sends, final pricing, investor/IR/INND, device claims, new financial commitments) ·
cost-neutral on existing grants until Matt approves spend.

---
*Living deliverable — the COO updates this as levers move. Source of truth = the `coo` ledger (`--tags medvi-ops`) + the canonical doc cmqumip7l06ci07adzkjlvv8r.*

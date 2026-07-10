# OTCHealth Portfolio — Deep Research Pass (v3, repo-verified, full catalog)
### Pricing, objectives, markets, comps, and opportunity — the PSAP, the OTC hearing aid line, the apps, and the sales channel, individually and as a group

**Author:** COO (The Quarterback) · **Date:** 2026-07-10 · **Status:** v3 — corrects v2's device
classification after Matt's second correction. Feeds the OTCHealth Playbook + Deck.
**Lane:** `coo` (`--tags moore-playbook,apps-deep-dive`) · **Scope:** OTCHealth entity ONLY per
`RACI.md` §0 — FourVault/Flatstick/Fictionary/PlantID/HaulAI (personal projects) and InnerScope
(INND) corporate content are excluded by design. `medreview` was researched at the market-category
level only — its repo, code, and data were never accessed, per the standing PHI wall.

> **Correction from Matt (2026-07-10), round 2: "iHEAR Matrix is an OTC Hearing Aid. All of our
> physical products are OTC Hearing Aids, except for TReO which is a PSAP."** v2 wrongly called
> Matrix "a second PSAP product line." A full Shopify-catalog pass also found **five more
> physical products v1/v2 missed entirely** — EAZE Classic, STREAM RIC, CONNECT ITE (a legacy
> HearingAssist-branded line, currently unavailable), plus iHEAR Linx and iHEAR Axis
> (pre-launch, Q4 2026). All five are OTC hearing aids, consistent with Matt's rule. **There are
> 7 physical hearing products total, not 2** — TReO is the sole PSAP; everything else is an OTC
> hearing aid. This also resolves a real error in v2: the FDA OTC Establishment Registration gate
> belongs to the OTC hearing aid line (Matrix, and any relaunch of the legacy line), not to
> TReO's PSAP inventory — the existing `MOORE-PLAYBOOK-12MONTH.md` already had this right
> ("FDA-register and launch the **OTC** iHEAR Matrix"); this doc's v1/v2 had conflated the two.

---

## 0. The group-level view

### 0.1 Four layers, not two
- **Layer 1 — The PSAP:** iHEAR TReO. Unregulated as a medical device; cannot make hearing-loss
  claims; this is the only product in the portfolio with that framing.
- **Layer 2 — The OTC hearing aid line:** iHEAR Matrix (pre-order), plus three legacy
  HearingAssist-branded devices — EAZE Classic, STREAM RIC, CONNECT ITE (currently unavailable) —
  plus two pre-launch waitlist products, iHEAR Linx and iHEAR Axis (Q4 2026). All six are FDA
  OTC-hearing-aid-category devices (21 CFR Part 800 Subpart E), a materially different compliance
  regime than the PSAP: they're allowed — and in fact FDA-mandated — to carry hearing-aid
  labeling, red-flag-condition warnings, and specific consumer disclosures; they are NOT allowed
  to ship without FDA OTC Establishment Registration.
- **Layer 3 — Software apps:** iHEARtest (free), AWARE (subscription), InnerEase (subscription,
  early build), OTCHealth Companion (subscription). MedReview sits apart — B2B, PHI-walled.
- **Layer 4 — AI voice sales channel:** three ElevenLabs/Twilio phone agents (Promo Sarah, Main
  Sarah, Helen) that close hardware sales by phone.

### 0.2 The regulatory line that matters most for the deck
**TReO (PSAP) and the OTC hearing aid line are governed by opposite compliance rules, and the
deck needs to say so precisely, not blend them:**
- **TReO:** must never use "hearing aid," "treats/restores/cures hearing loss," or FDA/medical
  device language. Marketing risk is *overclaiming*.
- **Matrix + the legacy line + Linx/Axis:** as actual OTC hearing aids, they're required to carry
  the FDA's mandated OTC hearing aid labeling (21 CFR 801.420 — the "hearing aid" term itself,
  red-flag conditions requiring a physician referral, an adults-only statement, a return-policy
  notice) and must complete **FDA OTC Establishment Registration (~$10K)** before shipping any
  unit. Compliance risk here is *incomplete registration/labeling*, the opposite failure mode
  from TReO's.
- This FDA registration gate is sequenced in the existing Playbook to arm at the $25K NET
  reignition-revenue trigger (from TReO sales) — **the registration itself is for the OTC line,
  not for TReO's own inventory**, which needs no such registration to sell or refurbish.

### 0.3 Pricing — corrected, repo-verified, full catalog
| Product | Layer | Status | Actual price (repo-verified) |
|---|---|---|---|
| **iHEAR TReO** | **PSAP** | Live, dormant | Single $99/side; Pair $149 list → **$99 via PAIR99** (evergreen) |
| **iHEAR Matrix** | OTC hearing aid | Pre-order, ships "late Aug 2026," gated on FDA OTC Establishment Registration | $349 list → **$174.50 via MATRIX50** |
| **EAZE Classic** (BTE thin-tube) | OTC hearing aid | Currently unavailable/sold out | ~$399.99 (anchor $499.99) |
| **STREAM RIC** (Bluetooth) | OTC hearing aid | Currently unavailable/sold out | ~$649.99 (anchor $799.99) |
| **CONNECT ITE** (Bluetooth) | OTC hearing aid | Currently unavailable/sold out | ~$599.99 |
| **iHEAR Linx** (earbud-style) | OTC hearing aid | Pre-launch waitlist, Q4 2026 | ~$239 (anchor $599) |
| **iHEAR Axis** (BTE-style) | OTC hearing aid | Pre-launch waitlist, Q4 2026 | ~$599 (anchor $699) |
| **iHEARtest** | App | Live | Free core; unshipped paywall stub ($4.99/mo) + a planned V1.3 tier ($9.99/$79.99/$149.99) |
| **AWARE** | App | TestFlight only | **Decided and coded:** $9.99/mo, $79.99/yr, $149.99 lifetime |
| **InnerEase** | App | Early build | SKU structure set, dollar amounts not yet decided |
| **OTCHealth Companion** | App | Most launch-ready, never built for iOS | **Decided and coded, 5 tiers:** Free → Care $9.99 → Voice $14.99 → Family $24.99 → Legacy $39.99/mo |
| **MedReview** | B2B, PHI-walled | Dev-gated | No consumer pricing; category benchmark $150-700/provider/month |

**Open question, not yet resolved:** are EAZE/STREAM/CONNECT genuinely discontinued, or paused
inventory that could relist? This pass found live product pages with prices but "unavailable"
status — worth a direct question to Commerce/CTO before the deck states anything about their
future.

### 0.4 URGENT — unchanged from the last pass, still needs a same-day fix
Promo Sarah's live call script still quotes three superseded iHEAR Matrix tiers ($179/$225/$279)
instead of the current $349/$174.50 structure — a customer-facing pricing bug, not a doc issue.
Already dispatched to Commerce/CRO/CTO; repeating here because it's the single highest-priority
item in this whole research thread.

### 0.5 A compliance flag already known, reaffirmed here, not new
The Shopify catalog also contains "OTCHealth CareNow" membership products that bundle INND
shares — the repo's own `research/PHASE3_CATALOG_FIXES.md` already flags this as a Section 17(b)
securities-compliance concern. This matches the standing gate already documented elsewhere
(CareNow is "counsel-blocked, 17(b)" in `MOORE-PLAYBOOK-12MONTH.md` and `RACI.md`) — **not a new
problem, just confirming the existing gate is correctly recognized in the actual product
catalog too.** No action needed beyond continuing to keep CareNow off any live storefront path
until counsel clears it.

### 0.6 The bundle opportunity — unchanged from v2
See v2 §0.5 — an "OTCHealth Plus" software bundle (AWARE + Companion + eventually InnerEase) is
easier to cost now that two of three have real prices. Separately, on the hardware side, a
TReO → Matrix upsell path (PSAP entry point, OTC hearing aid upgrade once FDA-registered) is a
natural cross-sell the existing funnel logic doesn't yet explicitly model — worth adding to the
funnel diagram once Matrix actually ships.

### 0.7 The one number that still matters most, unchanged
No repo, in any research pass, contains a measured iHEARtest→TReO conversion rate. Still the top
CFO/CRO priority before the $1B bridge math goes anywhere external.

### 0.8 Aggregate market opportunity — reframed slightly for the corrected catalog
TReO's PSAP category remains the primary proven revenue engine (~$272M-$864M US narrow market).
**The OTC hearing aid line (Matrix + legacy + Linx/Axis) sits in a different, larger, and more
regulated category** — the same global OTC hearing aid market cited in v1 (~$6.09B→$15.8B by
2034 broad, including the narrower device-only slice) — but is pre-revenue today (nothing has
shipped yet) and gated on FDA registration. Frame the OTC line as a real, sizeable, but
not-yet-realized second act, not blended into TReO's current numbers.

### 0.9 Documentation-drift — now five confirmed instances across this session
Adding to the four found in v2: the FDA-registration-gate misattribution in v1/v2 of this very
doc is itself a fifth instance of the same pattern this doc has been flagging all night (GCP,
credits, AWARE/TReO status, and now this doc's own device classification). Recommend, again, a
single source-of-truth field per fact rather than continuing to catch these one at a time.

---

## 1. The PSAP — iHEAR TReO
Personal sound amplification product, deliberately not marketed as a hearing aid. **Confirmed
live pricing:** Single $99/side; Pair $149 list → **$99 via PAIR99** (evergreen). Status:
proven-but-dormant — $227,290 all-time / 1,484 orders, ~$0 in the last 90 days; Stripe payout
connect is still the live blocker. **It requires no FDA registration to sell**, only a 3PL/refurb
partner (already scoped in `REFURB-3PL-RFQ.md`).
**Comp table, market, opportunities:** unchanged from v1 — undercuts every DTC PSAP/OTC
competitor at $99/pair; US OTC/PSAP category ~$272M-$864M narrow, growing 8-18% CAGR.

### 1.1 The 10,298-unit pool — corrected, this is NOT TReO-specific
Real inventory data from the CFO (JingHao manufacturer invoices, primary-source, `OTCHealth_
Inventory_Valuation_InHouse_v1.docx` 2026-06-17 + `3.6.26 - InnerScope Total Inventory Value.xlsx`)
shows the "10,298-unit pool" referenced throughout the Moore Playbook is the **combined count
across every physical SKU in the portfolio**, not TReO alone: TReO Left (1,294) + TReO Right
(1,324) + iHEAR aXis (2,315) + linX (2,589) + matriX (1,705) + legacy HearingAssist Stream (547),
Control (145), Connect (36), Eaze 302 (47), Eaze 2 (287), 802 (4), Micro (5) = **10,298 exactly**.
**This corrects an assumption this doc (and the broader Playbook) has carried all along.**

Real per-unit costs (JingHao invoices): $140 Control/STREAM/aXis/matriX; $142 CONNECT/linX/
EAZE-NS; $99 EAZE; $112 HA-302; $180 HA-802 ReCharge Plus; $135 "MICRO PSAP" (naming conflict —
see below); $54.60 "Lee Majors (legacy)" (unidentified product, zero current units — possibly a
celebrity-endorsement legacy SKU, unconfirmed). Refurb cost: TReO ~$5-7/unit (simple repack,
disposable battery); rechargeable units (the majority) ~$20-27/unit (battery replacement +
repack) — ~$257K total refurb investment across all 10,298 units. Cost basis: $1.4-1.9M;
CFO's own xlsx computes total retail value at **$4,314,845** — notably higher than the "$2-3M
retail lever" figure used elsewhere in the Playbook. **This resolves part of GAP-REVIEW.md's
flagged P0 ("the 85-90% margin on TReO is asserted with zero COGS build") — real costs now
exist — but surfaces two new open items, not yet resolved:**
1. **"MICRO PSAP" naming conflict.** CFO's cost sheet labels the Micro SKU (5 units) a PSAP,
   which conflicts with Matt's stated rule that only TReO is a PSAP. Not resolved here — asked
   CRO/CFO directly rather than assuming either way.
2. **Pricing-model mismatch.** CFO's inventory-valuation model prices aXis/linX/matriX at
   $499/$399/$599 retail-per-unit; the live Shopify catalog (repo-verified earlier today) prices
   Matrix at $349 list/$174.50 promo, Linx at ~$239, Axis at ~$599. These don't match. Asked CRO
   which is current/authoritative — do not treat either as settled until that comes back.

**URGENT, separate from product questions:** the same CFO doc states storage arrears + "lien
risk"/"the active lien cliff" on the facilities physically holding this inventory (Treelake +
Security Public Storage, ~$1,100/mo combined). This is a real risk to the underlying asset
itself, not a pricing/deck issue — flagged directly to CFO, not resolved here.

## 2. The OTC hearing aid line
**iHEAR Matrix** — $349 list → $174.50 via MATRIX50, pre-order, ships "late Aug 2026," gated on
FDA OTC Establishment Registration (~$10K) plus a named clinical reviewer sign-off, per the
existing Playbook sequencing (arms at the $25K NET reignition-revenue trigger from TReO sales).
**EAZE Classic / STREAM RIC / CONNECT ITE** — a legacy HearingAssist-branded sub-line, currently
listed as unavailable in the Shopify catalog at $399.99-$649.99. Whether these relist under the
same FDA registration or need their own separate registration/labeling review is an open
question for CTO/Commerce — flag before assuming they simply "come back."
**iHEAR Linx / iHEAR Axis** — pre-launch waitlist products (~$239-$599), targeting Q4 2026,
presumably sequenced behind the same FDA registration gate as Matrix.
**Positioning for the deck:** this line is the actual "hearing aid" business — TReO's PSAP
framing deliberately avoids this category, so Matrix/Linx/Axis are where OTCHealth can make real
hearing-related claims (under FDA's mandated labeling) that TReO legally cannot. This is a
distinct, second product story worth its own deck section rather than folding into TReO's.

## 3. The AI voice sales channel
Three ElevenLabs Conversational AI phone agents (Twilio-backed): **Promo Sarah** (800-520-7996,
TReO promo line — **currently has the stale Matrix-pricing bug, §0.4**), **Main Sarah**
(800-864-4337, general inbound order capture), **Helen** (800-640-9731, repointed to Matrix
sales). All three run caller-ID lookup → reconfirm → order capture → Shopify draft-order payment
link → hangup — a phone-assisted checkout layer for a senior demographic. A real, active
commerce channel; include it in any GTM discussion of the hardware line.

---

## 4. iHEARtest — the funnel magnet
Free, self-administered hearing screening app, confirmed build v1.5.21/Build 51. Core stays free
by design (the funnel strategy); two unshipped monetization artifacts exist in-repo (a $4.99/mo
"Sharpen Your Hearing" paywall stub, and a fully speced but unbuilt V1.3 RevenueCat tier at
$9.99/$79.99/$149.99). The "canonical shared engine" claim is unconfirmed — no other app repo
shows it consuming iHEARtest's test engine as a dependency yet.
**Comp table, market, funnel benchmarks:** unchanged from v1 — Mimi, SonicCloud, Oto Health,
Soundly's Feb 2026 acquisition as proof of screening-traffic value.

## 5. AWARE — post-purchase auditory rehabilitation
**Pricing decided and coded:** $9.99/mo, $79.99/yr, $149.99 lifetime (PR #31, merged 2026-06-30).
Two small open items: ASC/RevenueCat backend verification pending; a "$5/mo Supporter" tier is
advertised in copy with no purchasable product behind it (likely a bug). PR #33 cleanly merged,
no contradiction. PostHog ID unconfirmable from the repo (injected only at CI time).
**Comp table, positioning:** unchanged from v1 — LACE/clEAR/Angel Sound/manufacturer-bundled
comps; hybrid bundled-plus-paid-tier model, now backed by real prices.

## 6. InnerEase — tinnitus relief / sound therapy
**Real working code exists**, not doc-only — a shipped 5-tab structure, a minimal audio engine
stub, 18 passing tests including an automated claims-firewall guard, merged as recently as
2026-07-10. SKU structure is decided; **dollar amounts are not** — genuinely still open, unlike
AWARE/Companion. Clinical CBT/ACT content is spec-only, correctly gated on CMO sign-off. A
strategic note: Matt's actual plan may be to rebuild InnerEase on the new Standardized Premium
App Template rather than keep extending this iHEARtest-forked codebase.
**Comp table, positioning:** unchanged from v1 — hardware-agnostic tinnitus relief is the real
differentiator versus every manufacturer-bundled comp.

## 7. OTCHealth Companion — senior AI companion
**Pricing decided and coded, 5 tiers:** Free (14-day trial) → Care $9.99/mo ($79.99/yr) → Voice
$14.99/mo ($129.99/yr) → Family $24.99/mo ($219.99/yr, "most popular") → Legacy $39.99/mo
($359.99/yr), plus a $4.99 consumable overage. One live decision still open: the Legacy tier is
flagged internally as a margin trap (~20% net at $39.99) with a recommended reprice to $44.99.
**iOS build blocker, concrete:** 4 missing GitHub CI secrets (`ASC_KEY_ID`, `ASC_ISSUER_ID`,
`ASC_P8_KEY`, `APPLE_TEAM_ID`) + a not-yet-created App Store Connect app record (bundle ID is
registered, the app record is not). PostHog ID confirmed: 468389. A live unrevoked JWT sits in
`.mcp.json` — part of the already-tracked fleet-wide 6-token JWT rotation issue.
**Comp table, positioning:** unchanged — a different competitive category (SilverShield/
SeniorSafe/Luna) from the hearing-health apps, not a hearing-aid companion app.

## 8. MedReview — market context only (PHI wall respected, unchanged)
Clinical documentation AI category: ~$1-3B today, 20-29% CAGR, $5-15B by 2030-35; US subset
~$500-620M. Comps: Nuance DAX, Abridge, Ambience Healthcare, Suki AI, Nabla, $150-700/
provider/month. Audiology-specific niche real but nascent.

---

## 9. What's needed before this goes in a real deck (updated priority order)
1. **URGENT, not deck-related:** fix Promo Sarah's stale Matrix pricing today (§0.4).
2. **CRO/CFO:** measure or credibly estimate the iHEARtest→TReO conversion rate (§0.7) — still
   the top deck-blocking item.
3. **Commerce/CTO:** confirm whether EAZE/STREAM/CONNECT are truly discontinued or relaunchable,
   and under what FDA registration path, before the deck says anything about them (§2).
4. **Matt/CPO:** decide the Companion Legacy-tier reprice and the AWARE Supporter-tier bug.
5. **CTO:** the Companion iOS-build checklist (4 secrets + ASC app record) is now concrete and
   executable; also verify AWARE's backend ASC/RevenueCat config matches its client-side prices.
6. **CCO/`claims_check`**: pass on every comp-derived claim, with special attention to keeping
   TReO's PSAP framing and the OTC hearing aid line's claims strictly separated (§0.2) — this is
   now the single most important compliance distinction in the whole hardware line.

---
*Living document. v3 supersedes v1/v2's device-classification claims for Matrix and the newly
found EAZE/STREAM/CONNECT/Linx/Axis line — all corrected and repo-verified this pass. Source of
truth = this file + `MOORE-PLAYBOOK.md` + `MOORE-PLAYBOOK-12MONTH.md` + `GAP-REVIEW.md` +
`REFURB-3PL-RFQ.md` + the individual repos + the `coo` ledger (`--tags apps-deep-dive`). Scoped
to OTCHealth only per `RACI.md` §0.*

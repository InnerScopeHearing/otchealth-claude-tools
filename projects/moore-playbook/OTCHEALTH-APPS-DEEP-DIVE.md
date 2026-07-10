# OTCHealth Portfolio — Deep Research Pass (v2, repo-verified)
### Pricing, objectives, markets, comps, and opportunity — the PSAP hardware line, the apps, and the sales channel, individually and as a group

**Author:** COO (The Quarterback) · **Date:** 2026-07-10 · **Status:** v2 — corrected against the
actual repos after v1 relied too heavily on a summary doc. Feeds the OTCHealth Playbook + Deck.
**Lane:** `coo` (`--tags moore-playbook,apps-deep-dive`) · **Scope:** OTCHealth entity ONLY per
`RACI.md` §0 — FourVault/Flatstick/Fictionary/PlantID/HaulAI (personal projects) and InnerScope
(INND) corporate content are excluded by design. `medreview` was researched at the market-category
level only — its repo, code, and data were never accessed, per the standing PHI wall.

> **Correction from Matt (2026-07-10): iHEAR TReO is a PSAP — a physical hardware product — not
> an app.** v1 of this doc implicitly grouped it with the apps. This version separates the
> product line into three distinct layers: **(1) the PSAP hardware line** (TReO, and a second
> product, Matrix, found this pass), **(2) the five software apps**, **(3) the AI voice sales
> channel** (found this pass, previously undocumented in this doc).
>
> This version also corrects two real pricing errors from v1: **AWARE's and OTCHealth
> Companion's subscription pricing were NOT "unset" — both are fully decided and coded.** v1's
> finding came from a stale summary doc; this pass went directly into each repo and found the
> real numbers, sourced below with exact file paths.

---

## 0. The group-level view

### 0.1 Three layers, not two
- **Layer 1 — Hardware (PSAPs, sold via Shopify):** iHEAR TReO, iHEAR Matrix.
- **Layer 2 — Software apps:** iHEARtest (free), AWARE (subscription), InnerEase (subscription,
  early build), OTCHealth Companion (subscription, most sophisticated pricing in the portfolio).
  MedReview sits apart — B2B/enterprise, PHI-walled, no consumer pricing.
- **Layer 3 — AI voice sales channel:** three ElevenLabs/Twilio phone agents (Promo Sarah, Main
  Sarah, Helen) that close TReO/Matrix sales by phone — a real, live commerce channel this doc
  did not previously document at all.

### 0.2 This is still two markets (unchanged from v1) — plus a hardware-only sub-note
Hearing-health (TReO, Matrix, iHEARtest, AWARE, InnerEase) vs. senior AI companion/scam-protection
(OTCHealth Companion, a different comp set entirely — SilverShield/SeniorSafe/Luna, not hearing
brands). MedReview is a third, B2B category. Frame as diversification, not TAM-stitching.

### 0.3 Pricing — corrected, repo-verified
| Product | Layer | Status | Actual price (repo-verified) |
|---|---|---|---|
| **iHEAR TReO** | Hardware | Live, dormant | Single $99/side; Pair $149 list → **$99 via code PAIR99** (evergreen, no expiry) |
| **iHEAR Matrix** | Hardware | Pre-order, ships "late Aug 2026," gated on FDA OTC Establishment Registration | $349 list → **$174.50 via code MATRIX50** |
| **iHEARtest** | App | Live | **Free** for core screening/simulator/PDF export. A "Sharpen Your Hearing" add-on has a real paywall UI stub (not yet purchasable) hardcoded at **$4.99/mo, $39/yr, 7-day trial**. A separate planned V1.3 RevenueCat tier is speced at **$9.99/mo, $79.99/yr, $149.99 lifetime** — neither is shipped yet. |
| **AWARE** | App | TestFlight only | **DECIDED AND CODED: $9.99/mo, $79.99/yr (7-day trial), $149.99 lifetime.** Resolved in PR #31 (merged 2026-06-30). One real open item: App Store Connect backend pricing config not independently verified to match the client-side values yet. |
| **InnerEase** | App | Early build (real code, not just docs) | SKU structure decided (`innerease_pro_monthly/annual/lifetime`, one "pro" entitlement) — **dollar amounts not yet set.** RevenueCat not yet integrated in code. |
| **OTCHealth Companion** | App | Most sophisticated pricing in the portfolio, never built for iOS | **DECIDED AND CODED, 5 tiers:** Free (14-day trial) → Care $9.99/mo ($79.99/yr) → Voice $14.99/mo ($129.99/yr) → Family $24.99/mo ($219.99/yr, "most popular") → Legacy $39.99/mo ($359.99/yr) + $4.99 consumable overage. Apple product IDs defined but not yet created in App Store Connect (a pending human step, not a pricing gap). Internal code comment flags the Legacy tier as a margin trap at $39.99 (~20% net margin) and recommends repricing to $44.99 before any ad spend. |
| **MedReview** | B2B, PHI-walled | Dev-gated | No consumer pricing; category benchmark $150-700/provider/month (external research only, no internal access) |

**What this means for the deck:** two of the three "unresolved" pricing questions from v1 are
actually resolved. Only InnerEase (early-stage, expected) and iHEARtest's paid tier (deliberately
unshipped, funnel stays free) are genuinely open. AWARE and Companion can go into deck math with
real numbers today.

### 0.4 URGENT — a live pricing bug on the phone sales channel, not just a documentation issue
**Promo Sarah's live call script still quotes three legacy iHEAR Matrix tiers (Founding Backer
$179, Early Bird $225, Pre-Sale $279) that were already consolidated to a single $349/$174.50
tier in the Shopify repo weeks ago.** This isn't a stale doc sitting in a repo — it's a phone
agent that could be actively quoting a real caller the wrong Matrix price *right now*. Source:
`voice-agent-evals/prompts/promo_sarah/v6_8_LIVE.txt` vs. `otchealthmart-shopify/HANDOFF.md`.
**Recommend fixing this before anything else in this doc** — it's the only finding here with
live customer-facing exposure, everything else is planning/deck-readiness.

### 0.5 The bundle opportunity — now costed with real numbers
With AWARE ($9.99/$79.99/$149.99) and Companion (5 tiers, $9.99-$39.99/mo) both now confirmed
real, an "OTCHealth Plus" bundle is easier to model than in v1: e.g. a combined tier priced below
AWARE-Care-equivalent + Companion-Care ($9.99+$9.99=$19.98/mo) at something like $14.99-16.99/mo
once InnerEase also has real pricing. Still Matt's/CPO's call, not decided here.

### 0.6 The one number that still matters most, unchanged from v1
No repo, in either research pass, contains a measured iHEARtest→TReO conversion rate. The Moore
Playbook's $1B bridge (200K subscribers ≈ $480M ARR) still rests on this unmeasured number. This
finding is unaffected by today's repo-level corrections — still the top CFO/CRO priority.

### 0.7 Aggregate market opportunity — unchanged framing from v1, still no Frankenstein TAM
See v1 §0.6 logic — TReO/Matrix's real US OTC hearing-aid/PSAP category (~$272M-$864M narrow,
8-18% CAGR), the software apps sized as LTV-expansion on that customer base (not separate TAMs),
MedReview sized only in its own B2B context ($1-3B today, $5-15B by 2030s).

### 0.8 Documentation-drift — now a confirmed, recurring, three-instance pattern
After GCP/credits (earlier tonight) and the AWARE/TReO status conflicts (v1), this pass found
**four more**: (1) the Promo Sarah/Matrix pricing bug above — the most serious instance found
yet since it's customer-facing; (2) iHEARtest's build number was stale in prior docs (actually
Build 51/v1.5.21, not 50); (3) Companion's "2 open issues" turned out to be 0 issues/2 unrelated
PRs; (4) AWARE's README still shows superseded $4.99/$39.99/$79 pricing that HANDOFF.md already
corrected. **Recommend this become a standing CTO workstream** (a single source-of-truth status
field per fact, checked by CI, not another one-off doc fix) — four separate document families
have now shown the same failure mode.

---

## 1. Hardware — iHEAR TReO and iHEAR Matrix (PSAPs, not apps)

### 1.1 iHEAR TReO
Personal sound amplification product, deliberately not marketed as a hearing aid. **Confirmed
live pricing** (Shopify product config, `otchealthmart-shopify`): Single $99/side; Pair $149 list
cut to **$99 via PAIR99** (fixed $50 off, evergreen, no expiry). Status: proven-but-dormant —
$227,290 all-time / 1,484 orders, but ~$0 in the last 90 days; Stripe payout connect is still the
live blocker per the most recent logs.
**Comp table, market, opportunities, risk:** unchanged from v1 — see the archived detail in git
history if needed; TReO undercuts every DTC competitor (Audien, MDHearing, Jabra, Eargo, Sony) at
$99/pair, in a US OTC hearing-aid/PSAP market of roughly $272M-$864M (narrow) growing 8-18% CAGR.

### 1.2 iHEAR Matrix (new to this doc — found via the Shopify repo, not previously documented here)
A second PSAP product line. **Confirmed pricing:** $349 list → **$174.50 via MATRIX50** (50%
off). Status: **pre-order only**, targeting a "late August 2026" ship date, explicitly gated on
completing FDA OTC Establishment Registration (~$10K, itself gated on hitting $25K in TReO
reignition revenue first — see the existing sequencing in `MOORE-PLAYBOOK.md`). Sits at a higher
price tier than TReO — likely a mid-tier positioning between TReO's rock-bottom price and the
$499-$999+ premium competitors (Nuheara, Sony, Lexie).

### 1.3 The AI voice sales channel (new to this doc)
Three ElevenLabs Conversational AI phone agents (Twilio-backed), each with a specific role:
- **Promo Sarah** (800-520-7996) — outbound-style closing script for the TReO $99 promo; hides
  Matrix unless asked. **Contains the live pricing bug in §0.4 — needs an urgent fix.**
- **Main Sarah** (800-864-4337) — general inbound order-capture line, same underlying flow.
- **Helen** (800-640-9731) — "iHEAR Specialist," repointed to Matrix sales after the tier
  consolidation (but her *own* fallback script, per Promo Sarah's shared prompt family, may carry
  the same staleness — worth checking Helen's specific prompt file too, not yet done in this
  pass).
All three follow the same core flow: caller-ID lookup → address/email reconfirm → order capture
→ Shopify draft-order payment link → hangup — effectively a phone-assisted checkout layer built
specifically for a senior demographic that may not complete an online checkout unassisted. This
is a real, currently-active commerce channel and should be included in any deck discussion of
TReO's go-to-market, not treated as a footnote.

---

## 2. iHEARtest — the funnel magnet

**What it is:** Free, self-administered at-home hearing screening app. **Confirmed current build:
v1.5.21 / Build 51** (not 50 — corrected this pass). PHI-safe by design.
**Monetization, corrected:** Core screening stays free by design — this remains the funnel
strategy. But two real monetization artifacts exist in-repo that v1 missed entirely: (1) a
"Sharpen Your Hearing" 28-day training add-on with a working paywall UI stub, hardcoded at
$4.99/mo / $39/yr / 7-day trial, purchase path explicitly disabled — not live; (2) a fully speced
V1.3 RevenueCat plan (`iheartest_pro_monthly $9.99`, `_annual $79.99`, `_lifetime $149.99`) — also
not shipped. Zero RevenueCat/IAP dependency currently exists in `package.json` — both are
roadmap, not reality, but the exact prices are already decided whenever the team is ready to flip
the switch.
**"Canonical shared engine" claim — flag:** other app repos show no evidence of actually
consuming iHEARtest's hearing-test engine as a shared dependency. Treat this as an architectural
goal, not a built fact, until verified against AWARE/InnerEase's actual audio/test code.
**Comp table, market, funnel benchmarks, regulatory notes:** unchanged from v1 (Mimi, SonicCloud,
Oto Health, Soundly's Feb 2026 acquisition as proof of screening-traffic value).

---

## 3. AWARE — post-purchase auditory rehabilitation

**Pricing — corrected, this is the headline finding for this app.** **$9.99/mo, $79.99/yr
(7-day trial), $149.99 lifetime — already decided and coded**, not "pending Matt decision" as v1
reported. Resolved in PR #31 (merged 2026-06-30). Two small open items: (1) the App Store
Connect/RevenueCat dashboard backend hasn't been independently verified to match these
client-side values yet; (2) a "$5/mo Supporter" tier is advertised in copy across four languages
with no corresponding purchasable product — likely a real bug (an unbuyable advertised tier),
worth a quick Developer fix.
**PR #33 status — corrected:** cleanly merged 2026-06-30, no contradiction (v1's flagged conflict
was resolved by the time of this pass). **PostHog ID — genuinely unconfirmable from the repo**
(the real key is injected only at CI build time, never committed) — not a documentation gap, just
not visible from source.
**Comp table, market positioning, best-fit model, compliance guidance:** unchanged from v1 —
LACE/clEAR/Angel Sound/manufacturer-bundled comps; recommend the hybrid bundled-plus-paid-tier
model, now backed by AWARE's actual live prices instead of a recommendation.

---

## 4. InnerEase — tinnitus relief / sound therapy

**Build stage — corrected.** Not "documentation-only Phase-0 scaffold" as v1 reported. Real,
working code exists and is merged to `main` (PR #6, merged 2026-07-07): a shipped 5-tab structure
(Today/Relief/Flow/Program/Profile), a working (if minimal, "Phase 0 hello-tone stub") audio
engine, and 18 passing unit tests including an automated claims-firewall keyword guard. 15
commits, 8 PRs (0 open), most recent activity **today, 2026-07-10** — an active, not abandoned,
repo.
**Pricing — partially corrected.** SKU structure is decided (`innerease_pro_monthly/annual/
lifetime`, one entitlement) — but **no dollar figures exist yet**, and RevenueCat isn't
integrated in code. So: structure yes, price no — genuinely still open, unlike AWARE/Companion.
**Clinical content:** not built — CBT/ACT program is spec-only, correctly gated on CMO sign-off
before any code ships.
**New strategic flag:** an internal Standardized Premium App Template decision indicates Matt's
actual plan is to eventually rebuild InnerEase on the new template architecture rather than keep
extending this iHEARtest-forked codebase — worth factoring into any roadmap slide before
committing more engineering time to the current build.
**Comp table, positioning:** unchanged from v1 — ReSound Relief/Starkey Relax/Widex Zen (all
hardware-bundled) vs. Oto Health (independent); InnerEase's differentiator is being
hardware-agnostic, a real gap in the comp set.

---

## 5. OTCHealth Companion — senior AI companion

**Pricing — corrected, second headline finding.** Not "unset/recommended only." **A real, fully
coded 5-tier structure exists**, single-sourced in `packages/shared/src/pricing.ts`: Free
(14-day trial) → **Care $9.99/mo ($79.99/yr)** → **Voice $14.99/mo ($129.99/yr, 1 voice clone)**
→ **Family $24.99/mo ($219.99/yr, 3 clones, "most popular")** → **Legacy $39.99/mo ($359.99/yr,
6 clones)**, plus a $4.99 consumable for cloned-speech overage. This is more sophisticated
tiering than v1's generic $9.99-24.99/mo recommendation — use the real structure in the deck.
**One live business decision still open:** an internal code comment flags the Legacy tier as a
margin trap (~20% net margin at $39.99 given AI cost) and recommends repricing to $44.99 before
any ad spend — Matt/CPO call, not yet actioned.
**The iOS build blocker — now concrete, not vague.** v1 said "never had an iOS build" without a
cause. The actual blockers: (1) the CI workflow (`ios-depot.yml`) hard-fails immediately unless
four GitHub secrets are set (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_P8_KEY`, `APPLE_TEAM_ID`) — none
are set; (2) the App Store Connect app record itself hasn't been created (Apple's API returns
403 on the creation call) — bundle ID `com.otchealth.companion` is registered, but the app record
is not. **This is now a two-item, named checklist CTO/Matt can execute directly**, not an open
question.
**PostHog ID — confirmed: 468389** (matches prior documentation; the real write key isn't set
yet, a separate small follow-on).
**Security flag:** a live, unrevoked cleartext Bearer JWT sits in `.mcp.json` — part of the
already-tracked fleet-wide 6-token JWT rotation issue, not a new finding, but worth connecting to
that existing workstream.
**Comp table, positioning:** unchanged from v1 — this remains a different competitive category
(SilverShield/SeniorSafe/Luna) from the hearing-health apps, not a hearing-aid companion app.

---

## 6. MedReview — market context only (unchanged from v1, PHI wall respected)
No repo, code, or data access — pure external market research. Clinical documentation AI
category: ~$1-3B today, 20-29% CAGR, $5-15B by 2030-35; US subset ~$500-620M. Comps: Nuance DAX,
Abridge, Ambience Healthcare, Suki AI, Nabla, clustering $150-700/provider/month. Audiology-
specific niche is real but nascent. BAA mandatory before any PHI touch (already the case).

---

## 7. What's needed before this goes in a real deck (updated priority order)
1. **URGENT, not deck-related:** fix Promo Sarah's stale Matrix pricing before another live call
   goes out (§0.4) — flagging to Commerce/CRO/CTO now, this is a customer-facing bug today.
2. **CRO/CFO** (unchanged from v1, still the top deck-blocking item): measure or credibly
   estimate the iHEARtest→TReO conversion rate before the $1B bridge math appears externally.
3. **Matt/CPO**: decide the Companion Legacy-tier repricing (§5) and the AWARE Supporter-tier bug
   (§3) — both are small, live, actionable pricing decisions now that the real numbers are known.
4. **CTO**: set the 4 missing GitHub secrets + create the Companion App Store Connect app record
   (§5) — this specific, now-concrete checklist could put the most launch-ready app in the
   portfolio into TestFlight quickly.
5. **CTO**: verify AWARE's backend ASC/RevenueCat pricing config matches the client-side values
   (§3); treat the four-instance documentation-drift pattern (§0.8) as a systemic fix, not another
   one-off.
6. **CCO/`claims_check`**: pass on every comp-derived claim, as before.

---
*Living document. v2 supersedes v1's pricing/status claims for AWARE, OTCHealth Companion,
iHEARtest, and InnerEase — those were repo-verified this pass. Source of truth = this file +
`MOORE-PLAYBOOK.md` + `MOORE-PLAYBOOK-12MONTH.md` + `GAP-REVIEW.md` + the individual repos
(`iheartest`, `aware-aural-rehab`, `innerease`, `otchealth-companion`, `otchealthmart-shopify`,
`voice-agent-evals`) + the `coo` ledger (`--tags apps-deep-dive`). Scoped to OTCHealth only per
`RACI.md` §0.*

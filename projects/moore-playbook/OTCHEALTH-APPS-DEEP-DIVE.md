# OTCHealth App Portfolio — Deep Research Pass
### Pricing, objectives, markets, comps, and opportunity — per app and as a group

**Author:** COO (The Quarterback) · **Date:** 2026-07-10 · **Status:** v1 — research complete,
feeds the OTCHealth Playbook + OTCHealth Deck
**Lane:** `coo` (`--tags moore-playbook,apps-deep-dive`) · **Scope:** OTCHealth entity ONLY per
`RACI.md` §0 — FourVault/Flatstick/Fictionary/PlantID/HaulAI (personal projects) and InnerScope
(INND) corporate content are explicitly excluded from this doc.

> Five parallel research passes (2026-07-10), each grounding in internal repo/doc reality first,
> then external market/comp research. Full subagent output is logged verbatim to the `coo`
> ledger (tags `apps-deep-dive`) if anyone wants the raw detail; this doc is the synthesized,
> deck-ready version.

---

## 0. The group-level view (read this first)

### 0.1 This portfolio is actually TWO markets, not one — say so in the deck
Four of six products (TReO, iHEARtest, AWARE, InnerEase) sit in the **hearing-health vertical**.
The fifth, **OTCHealth Companion**, is a senior-focused AI companion / scam-protection app — a
**different competitive category** (comps are SilverShield/SeniorSafe/Luna, not hearing-aid
brands) sharing only the demographic and the trust brand. **Frame this as diversification, not
dilution**: two distinct expansion vectors on one senior-health customer base, not one narrow
hearing-only thesis. MedReview is a third, B2B/enterprise category (clinical documentation AI)
serving audiology practices, not consumers directly.

### 0.2 The funnel (already documented in MOORE-PLAYBOOK.md, restated here for the deck)
**Ignite → Magnet (iHEARtest, free) → Funnel → Close (TReO, $99/pair) → Support → Retain (AWARE /
InnerEase / Companion subscriptions) → Ascend → Measure → Comply.** iHEARtest is the proven,
mature, PHI-safe top-of-funnel magnet feeding TReO purchases; AWARE/InnerEase/Companion are the
post-purchase retention/LTV layer. This is a coherent, defensible funnel story — **with one real
hole**: no screening→purchase conversion rate has ever been measured (see §0.5).

### 0.3 Pricing snapshot across the portfolio
| App | Model | Price (recommended or existing) | Stage |
|---|---|---|---|
| iHEAR TReO | One-time purchase | $99 single / $99 pair (promo PAIR99; anchor $598) | **Live, revenue-proven historically, currently dormant** |
| iHEARtest | Free (funnel tool) | $0 — deliberately no paywall | **Live**, most mature app in the fleet |
| AWARE | Subscription (RevenueCat wired, price unset) | Recommend: free core + ~$9.99/mo pro, or ~$150 lifetime anchor | TestFlight only, pricing is a live Matt decision |
| InnerEase | Subscription (not yet built) | Recommend: free tier + ~$6.99/mo or ~$69.99/yr (mirrors ReSound Relief) | Scaffold only, Wave 3 rebuild pending |
| OTCHealth Companion | Subscription (RevenueCat wired) | Recommend: ~$9.99-14.99/mo base, ~$19.99-24.99/mo family tier | Most launch-ready code in the fleet; **never had an iOS build** |
| MedReview | B2B/enterprise (PHI-walled, no consumer pricing) | Category benchmark: $150-700/provider/month | Dev-gated, BAA-only environment |

### 0.4 The bundle opportunity (new recommendation, not previously documented)
Three separate subscriptions (AWARE, InnerEase, Companion) at $7-25/mo each risks subscription
fatigue in a 50-75 demographic that the Companion research specifically flagged as price-sensitive
to multiple recurring charges. **Recommend evaluating an "OTCHealth Plus" bundle** (all three,
plus consumables replenishment) at a single price point below the sum of parts — e.g. $14.99-
19.99/mo — once at least two of the three apps are actually live. This is a pricing-strategy
option for Matt/CPO to weigh, not a decision made here.

### 0.5 The one number that matters most, and it's still missing
Every subagent that touched the funnel math flagged the same gap independently: **the
iHEARtest → TReO conversion rate has never been measured.** The Moore Playbook's $1B bridge
(200K subscribers ≈ $480M ARR) rests on this unmeasured number. External proxies range wildly —
optical retail's in-person exam-to-purchase capture rate runs 60-65%, but pure e-commerce
self-serve health/wellness conversion is closer to 0.5-4.5%, and iHEARtest is the latter kind of
experience, not the former. **Do not let a deck imply a conversion rate we haven't observed** —
this is a CFO/CRO measurement gap to close before the $1B math is used externally, not something
this doc can resolve.

### 0.6 Aggregate market opportunity — stated honestly (no Frankenstein TAM)
Resist the temptation to sum TAM figures across dissimilar apps into one "our market" number —
a sophisticated investor will immediately spot a stitched-together TAM. The defensible framing:
- **TReO's category (US OTC hearing aids/PSAPs, narrow definition):** ~$272M-$864M today,
  8-18% CAGR post-2022 FDA rule. This is the real, addressable core market.
- **AWARE/InnerEase/Companion are not separate markets we're entering — they are LTV-expansion
  plays on TReO's own customer base.** Size them as "% attach rate × existing/projected customer
  count," not as a share of the (much larger, mostly irrelevant) global wellness-app or
  companion-app market.
- **MedReview sits in a real, separately-sized enterprise category** (~$1-3B today, 20-29% CAGR,
  reaching $5-15B by 2030-35 broadly; US subset ~$500-620M) but is early-stage and PHI-walled —
  cite this market size only in a B2B/enterprise-specific context, never blended with the
  consumer TAM above.

### 0.7 Documentation-drift pattern (flag, don't fix here)
Two of five research passes independently hit the same problem tonight's earlier work already
surfaced with GCP/credits docs: **internal facts conflict across files.** TReO's Stripe-payout
status reads "done" in one file and "still open" in a more recent one; AWARE's PR #33 merge
status and PostHog project ID are documented inconsistently. This is now a recurring pattern
across three separate document families (infra registry, cash-gate status, app portfolio) —
worth a standing fix (a single source-of-truth status field per fact, not per-doc) rather than
another one-off correction. Flagging to CTO alongside the other doc-drift items already open.

---

## 1. iHEAR TReO — the core commerce product

**What it is:** OTCHealth's PSAP (personal sound amplification product) — deliberately **not**
marketed as a hearing aid (compliance-mandated). Sold via Shopify (otchealthmart.com).
**Pricing:** $99 single / $99 pair (PAIR99 promo, $598 anchor), ~$22/pair refurb cost from an
owned pool of ~10,298 legacy units. 60-day money-back guarantee.
**Status:** Proven-but-dormant — $227,290 all-time / 1,484 orders, but $0 revenue in the last 90
days, 2026 YTD is just $736. Stripe payouts still disabled pending Matt's bank connect (per the
most recent logs — an older file claims this is resolved; treat that as stale, see §0.7).

**Comp table:**
| Competitor | Price | Positioning |
|---|---|---|
| Audien Atom X | $99-$389/pair | Ultra-budget, no app required |
| MDHearing (Neo) | $199-$799 | Budget-mid, tiered |
| Otofonix | $297-$397/pair | Budget-mid, Bluetooth |
| Nuheara IQbuds Max | ~$499 | Mid-tier, was an InnerScope partner |
| Jabra Enhance | $199-$1,995 | Broad tiered, subscription-support |
| Sony CRE-C10/E10 | $999-$1,300 | Premium, self-fitting, Best Buy retail |
| Lexie (Bose) | $799-$999 | Premium, app-connected |
| **iHEAR TReO (ours)** | **$99/pair** | **Deepest budget tier, standalone** |

**Market:** US narrow OTC hearing aid category ~$272M-$864M (2025), 8-18% CAGR; global broader
category (incl. amplified earbuds) ~$6.09B→$15.8B by 2034 (11.2% CAGR). ~38M US adults have
hearing loss, only ~1 in 5 use a device (GAO-24-106854).

**Opportunities:** (1) Own the true price floor vs. Jabra/Eargo's confusing tiered/subscription
models. (2) Sister-brand InnerScope already has a Walmart (4,200+ stores) and Best Buy.com retail
precedent to reuse rather than invent a new channel strategy. (3) A consumables replenishment
subscription (domes/tubes/batteries, 30/60/90-day) already spec'd internally — real recurring-
revenue lever without raising the device's headline price.

**Risk:** Must stay strictly a PSAP — any device/treatment claim reclassifies it as an FDA-
regulated hearing aid under 21 CFR 800.30. FDA OTC Establishment Registration (~$10K) required
before the full legacy inventory can ship, gated on hitting $25K in new reignition revenue first.

---

## 2. iHEARtest — the funnel magnet

**What it is:** Free, self-administered at-home hearing screening app, live on TestFlight/App
Store (v1.5.21/Build 50). The fleet's most mature codebase and the **canonical hearing-test
engine** other apps are meant to consume rather than fork. PHI-safe by design (only a category
band ever leaves the device).
**Pricing:** Free by design — deliberately no paywall; the funnel IS the monetization.

**Comp table:**
| Competitor | Model | Scale |
|---|---|---|
| Mimi Hearing Test | Consumer app + B2B/OEM SDK licensing | 6M+ tests, 150K/mo, integrated into 45+ headphone products |
| SonicCloud/Sonitum | Freemium, $9.99/mo after trial | Johns Hopkins co-branded "Hearing Number" |
| Oto Health | ~$29/mo subscription (tinnitus-adjacent) | 50,000+ users, RCT underway |
| Soundly | Free, lead-gen to device/clinic | 15M+ reached; **acquired Feb 2026 by a UnitedHealthcare-linked buyer specifically for its funnel traffic** — direct proof buyers pay premiums for hearing-screening traffic |

**Conversion benchmark:** No hearing-screening-specific number is public. Optical retail's
in-person exam-to-purchase runs 60-65%; pure e-commerce self-serve health conversion is 0.5-4.5%.
iHEARtest is structurally closer to the latter — see §0.5, this gap needs real measurement.

**Opportunities:** (1) Mimi-style OEM/API licensing of the audiometry engine as a second revenue
line beyond the funnel role. (2) A freemium personalization tier (SonicCloud's model) as a
cheaper de-risking step before the unbuilt "Sharpen" auditory-training upsell. (3) B2B/white-label
screening to audiologist networks/pharmacies, mirroring "Mimi for Hearing Care."

**Regulatory:** A pure screening app reporting only a category band, no diagnosis, sits under
FDA's general-wellness/enforcement-discretion policy — a different, lighter bucket than OTC
hearing-aid *amplification* software (Class II).

---

## 3. AWARE — post-purchase auditory rehabilitation

**What it is:** Forked from iHEARtest, rebranded, ~38-screen auditory-training app (SNR engine,
training tasks, simulator, "family loop"). Targets the 50-75 age band as the post-purchase
complement to TReO/iHEARtest. Live on TestFlight (v1.3.0), not yet public.
**Pricing:** RevenueCat wired (`aware_pro_monthly/annual/lifetime`) but **price itself is
explicitly unset — flagged internally as a pending Matt/business decision.**

**Comp table:**
| Competitor | Model | Price |
|---|---|---|
| LACE AI Pro (Neurotone) | B2B2C via clinics, some DTC | ~$499 SRP, often ~$150 discounted or bundled free |
| clEAR | B2B2C, clinic-distributed | $24.99/mo |
| Angel Sound (nonprofit) | Free, self-directed | Free |
| Signia/Starkey/Oticon apps | Bundled with device purchase | Free with device |

**Best-fit model:** Hybrid — free core bundled with TReO purchase (matches manufacturer-app
norm), paywalled advanced modules below clEAR's $24.99/mo (e.g. ~$9.99/mo), or a lifetime anchor
near LACE's discounted ~$150 price point to reduce subscription fatigue in this age band.

**Critical honesty flag:** Zero current subscribers, no derived CAC/conversion math — this is
explicitly called out in the existing GAP-REVIEW.md as an "asserted, never modeled" line in the
$1B bridge. Don't let AWARE's subscriber math appear in a deck as anything but illustrative until
it's attached to a real TReO-attach-rate metric.

**Compliance:** Never claim "cures/restores/reverses" hearing loss or "treats/prevents" cognitive
decline. "May help support listening and communication skills" is the safe frame, citing
category-level clinical literature (not AWARE-specific trial data, since none exists yet).

---

## 4. InnerEase — tinnitus relief / sound therapy

**What it is:** Tinnitus relief and sound-therapy wellness app. **Earliest-stage app in the
portfolio** — currently a documentation-only Phase-0 scaffold; a full rebuild on the standard app
template is planned for "Wave 3." Planned features: soundscape engine, tinnitus assessment, a
CBT/ACT coping program (requires clinical sign-off before shipping). No pricing model exists yet.

**Comp table:**
| App | Maker | Price |
|---|---|---|
| ReSound Relief | GN ReSound | Free core + Relief Premium $6.99/mo or $69.99/yr |
| Starkey Relax / Widex Zen | Device makers | Free, bundled with hardware |
| Oto Health (tinnitus program) | Independent | Subscription, positioned like Calm/Headspace |

**Key distinction from the manufacturer apps above:** they all require/assume owned hardware.
**InnerEase has no hardware dependency** — recommend positioning it to own the hardware-agnostic
tinnitus-relief segment, a real gap in the comp set. Pricing recommendation: free tier (basic
soundscapes/education, clears the FDA general-wellness bar cleanly) + ~$6.99/mo or ~$69.99/yr
premium tier, directly mirroring ReSound Relief's proven price points.

---

## 5. OTCHealth Companion — senior AI companion

**Important correction to initial assumption:** this is **not** a hearing-aid-adjustment
companion app — it's a broader senior-focused AI companion (voice assistant "TalkButton," a
vision feature for interpreting photos with senior-safe routing, scam-detection guidance, a
family feed/check-ins). Non-PHI by design. **The most launch-ready code in the entire portfolio**
(RevenueCat paywall already implemented, PR merged to main) — but has **never had an iOS build
or App Store record.**

**Comp table (a different category than hearing — real comps are AI scam-protection/companion
apps, not hearing-aid brands):**
| App | Focus | Price |
|---|---|---|
| SilverShield AI | Deepfake/scam call detection, caregiver dashboard | $14.99-$49.99/mo |
| SeniorSafe | Real-time fraud-call protection | $9.95-$14.95/mo |
| SeniorTalk | AI companionship + scam detection | $14.90-$24.90/mo |
| Luna | Voice-first scam protection, caregiver alerts | €10-25/mo |

**Pricing recommendation:** Standalone subscription — base tier ~$9.99-14.99/mo (vision assistant
+ companionship), family/caregiver tier ~$19.99-24.99/mo (multi-contact alerts), mirroring
SilverShield's Basic/Pro split. This is largely an execution gap, not a strategy gap — the
monetization plumbing already exists.

**Opportunity:** The vision+voice combo is a real differentiator none of the pure scam-blockers
offer. Cross-sell into the existing hearing-aid customer base as a same-demographic add-on,
trading on shared brand trust rather than competing purely on scam-detection accuracy.

---

## 6. MedReview — market context only (PHI-walled, no internal access)

**Note on this section:** per the standing PHI wall, this research touched zero internal
MedReview systems, code, or data — pure external market research on the product *category*.

**Market:** AI-assisted clinical documentation, ~$1-3B today at 20-29% CAGR, reaching $5-15B by
2030-35; US subset ~$500-620M today.
**Comps:** Nuance DAX, Abridge ($5.3B valuation), Ambience Healthcare (~$1B valuation), Suki AI
(~$500M valuation), Nabla — clustering around $150-700/provider/month, split between self-serve
and enterprise-sales models.
**Audiology-specific niche:** Real but nascent (HearScribe, AudZone, Doctora, Auditdata) — better
pitched as "general clinical documentation AI applied to audiology" than a proven standalone
category.
**Compliance:** BAA mandatory before any PHI touch (already the case for MedReview's environment).
FDA's Jan 2026 CDS guidance treats pure documentation/summarization as non-device administrative
support — but any audiogram/image-interpretation feature risks crossing into regulated clinical
decision support territory; worth a CTO/counsel check before any such feature ships.

---

## 7. What's needed before this goes in a real deck
1. **Matt's pricing calls**: AWARE's price point, InnerEase's price point (once built), whether
   to pursue the OTCHealth Plus bundle concept (§0.4).
2. **CRO/CFO**: measure or credibly estimate the iHEARtest→TReO conversion rate before the $1B
   bridge math appears anywhere external (§0.5) — this is the single highest-priority fix.
3. **CTO**: reconcile the AWARE PostHog ID / PR #33 merge-status conflict and the TReO Stripe-
   status conflict (§0.7) — same doc-drift pattern flagged elsewhere tonight.
4. **CCO/`claims_check`**: pass on every comp-derived claim before external use, especially the
   AWARE/InnerEase "may help" language.
5. **CPO**: confirm OTCHealth Companion's launch timeline given it's the most launch-ready but
   least-shipped app in the portfolio — a real near-term opportunity being left on the table.

---
*Living document. Source of truth = this file + `MOORE-PLAYBOOK.md` + `MOORE-PLAYBOOK-12MONTH.md`
+ `GAP-REVIEW.md` + the `coo` ledger (`--tags apps-deep-dive`). Scoped to OTCHealth only per
`RACI.md` §0 — no personal-project or InnerScope-corporate content included by design.*

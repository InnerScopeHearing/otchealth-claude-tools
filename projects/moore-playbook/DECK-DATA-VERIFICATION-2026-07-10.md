# Deck Data Verification — Research Swarm Findings
### Sourced corrections and benchmarks for the OTCHealth/InnerScope Investment Deck and Underwriting Package

**Author:** COO (The Quarterback) · **Date:** 2026-07-10 · **Status:** v1 — research complete
**Lane:** `coo` (`--tags moore-playbook,deck-verification`) · **Purpose:** replace unsourced/
optimistic figures in the deck with cited, defensible data before it goes to a real underwriter.

> Six parallel research passes against the specific claims in `OTCHealth InnerScope Investment
> Deck.pdf` and `OTCHealth_Financial_Underwriting_Package.pdf`. Organized by severity, not by
> deck order — the two most serious findings are new discoveries, not refinements of what was
> already flagged in the earlier review.

---

## 1. Two new, serious findings (higher priority than anything flagged before this pass)

### 1.1 "ShelfReady" — could not be verified as a real company
The deck's B2B channel slide names "ShelfReady" as the distribution-as-a-service partner behind
the pharmacy wholesale program. Research found no company by this name operating in pharmacy
distribution-as-a-service anywhere. The closest legitimate analog for the described function is
Henry Schein's "Ready 360" program. Either this is a real, signed partner that simply has no
public footprint yet, an internal program name not yet operational, or a naming error — but as
written, this is an unverifiable named partner underpinning the entire B2B distribution thesis.
**This needs a direct answer from Commerce before the deck goes anywhere further.**

### 1.2 The "PSAO auto-opt-in" mechanism is not how PSAOs work
The deck describes "independent pharmacy auto-opt-in via PSAO contracts" as a go-to-market
lever. Every authoritative source on Pharmacy Services Administrative Organizations (HDA, GAO,
Milliman, PCMA) confirms PSAOs are contract-negotiation and reimbursement intermediaries between
independent pharmacies and PBMs — they do not create formularies, do not decide what products a
pharmacy carries, and do not auto-enroll member pharmacies into carrying a specific
manufacturer's product. This claim appears to be either a misunderstanding of what PSAOs do or
an unproven mechanism presented as an established one. **Needs direct validation with a named
PSAO, or removal from the deck.**

---

## 2. The exit-comp multiples — an independent verdict this doc will state plainly
The research pass's own conclusion: **"an underwriter's diligence team would flag the multiples
section within minutes."** The five acquisition *deal values* cited (RxSaver/GoodRx $50M,
GreatCall/Best Buy $800M, One Medical/Amazon $3.9B, Catalyst/SXC $4.4B, Catamaran/UnitedHealth
$12.8B) are all accurate against SEC filings and primary press releases. The *multiples* built on
top of them are not:
- **GoodRx (GDRX) "3.0x"** — actual current EV/Revenue is ~1.5-1.7x. Overstated by roughly 2x.
- **Hims & Hers (HIMS) "4.5x"** — actual current range is ~2.7-3.7x. Above every current source.
- **"6.0x BASE case... 3.6x trailing" (One Medical/Amazon)** — 3.6x is real but is a *forward*
  2022E revenue multiple, not trailing. One Medical's actual trailing revenue multiple was closer
  to 6.3x. This specific mislabeling (forward vs. trailing) is the kind of thing a competent
  underwriter catches immediately.
- **GreatCall "8.0x senior-care strategic premium"** — no public source discloses GreatCall's
  revenue or EBITDA at the time of the Best Buy deal. This multiple has no derivable public basis
  at all.
- **Catalyst Health/SXC "12.0x PBM-adjacent infrastructure"** — a contemporaneous sell-side report
  (Scott-Macon Healthcare Review, Q2 2012) pegged this deal at **~19.8x EBITDA**. The deck
  understates this one — correcting it actually strengthens the "premium multiple" argument, but
  the number as written is still wrong.

**Recommendation:** rebuild this slide's multiples against current market data (sources below),
relabel the One Medical figure as a forward multiple, substantiate or drop the GreatCall figure,
and correct the Catalyst/SXC figure — in that last case, correcting it helps the deck's own
argument rather than hurting it.

---

## 3. The funnel conversion rates — confirmed optimistic, one number is real-but-misapplied
The 85,711-contact database size is real and sourced (Customer.io workspace 193366). The four
conversion rates applied to it are not:

| Stage | Deck assumes | Realistic benchmark | Verdict |
|---|---|---|---|
| Email open+click | 25% | ~25-35% open rate is fine for this age group; but true combined open+click is more like 1.5-4% (open × click-to-open) | Conflated metric — split into open rate and CTR separately |
| Engagement→landing page | 40% | 5-10% (healthcare-vertical CTOR benchmarks) | Optimistic by 4-8x |
| Landing page→trial | 50% | 8-15% (health/wellness app benchmarks) | Optimistic by 3-6x |
| Trial→paying | 48.8% | 2-5% baseline for health/wellness apps, up to ~15% with strong onboarding | **The number itself is real** — it's First Page Sage's published rate for opt-out, credit-card-required B2B SaaS trials — **but it's being applied to the wrong category.** Health/wellness consumer trials convert 10-24x lower. |

Compounding four inflated/misapplied rates against the same contact base likely overstates the
Year 1 paying-member projection by one to two orders of magnitude versus a benchmark-grounded
estimate. Recommend rebuilding this funnel with the ranges above and labeling each stage as a
planning assumption pending real pilot data, not a measured result.

---

## 4. CareNow-specific findings
- **14:1 LTV:CAC is not credible.** Industry benchmarks for healthy DTC subscription-health put
  this at 3:1 (baseline) to 4:1 (strong) — anything meaningfully above that is exceptional and
  rare. Recommend revising to the 3:1-5:1 range.
- **Hims & Hers CAC (~$929) is roughly right** but is a third-party estimate, not a
  company-disclosed figure (Hims & Hers doesn't publish CAC directly) — a more current estimate
  is ~$929-979. Caveat it as a third-party estimate in the deck.
- **The Atrium Health "36.8% reduction in 30-day readmissions" stat is real** — sourced to a
  published pilot study (Anderson et al., *Pharmacy* (MDPI), 2019) — but it's a small pilot
  (n=76), studying post-hospital-discharge, high-medication-risk patients, not a general senior
  wellness-membership population. Real, but needs the "pilot study, n=76" caveat to avoid
  overstating what it demonstrates.
- **Realistic churn for a chronic-management senior telehealth membership is 25-40% annually**
  (60-75% retention) — worse than best-case healthcare SaaS, better than generic consumer
  telehealth. Stress-test the "lifetime locked rate" pricing model against this range.
- **New headwind not in the deck:** Medicare telehealth adoption in the 65+ population is lower
  than the general population, and stabilized at only 13-16% of Medicare beneficiaries using any
  telehealth annually post-2022 — worth factoring into Year 1 ramp assumptions.

---

## 5. SaveRx-specific findings
- **$4.0B market size is roughly right** for the narrow US Rx-discount-card category (a source
  puts it at $4.1B) but should be explicitly cited — broader/narrower category definitions in
  other reports vary 3-7x, so an uncited figure invites diligence pushback.
- **$1.50-2.50 per-fill commission is plausible but on the aggressive end** — it implies capturing
  15-30% of the total PBM switch fee, generous for a marketing/distribution-only partner with no
  clinical or claims infrastructure of its own.
- **The GoodRx Gold "2.8% steady-state conversion" figure cannot be verified against any public
  GoodRx disclosure** — GoodRx does not publish this. Label it as an internal estimate, not
  sourced to GoodRx, or soften/remove it.
- **Senior fill frequency (1.3 Rx/month) is materially understated** — real MEPS/AHRQ/CDC data
  shows seniors average 2.5-3.5 Rx/month (30.8-41.2 fills/year), with 43%+ on 5+ concurrent
  medications. This is the one correction that makes the model MORE favorable, not less, once
  fixed — but it's still factually wrong as written and worth correcting either way.
- **A real, named, legitimate white-label PBM partner exists and fits this exact model:**
  ScriptSave/WellRx (part of MedImpact Healthcare Systems) explicitly markets private-label
  websites and API integrations for discount-card marketers, with a ~54-65K pharmacy network.
  Worth citing as the concrete partner-model comp instead of "Leading PBM technology partner."

---

## 6. HearingAssist/iHEAR channel findings
- **"Velocity Sellers" is a real, small Amazon/marketplace management agency** (founded 2016,
  ~33 employees) — legitimate category of service, but no public evidence of any track record
  with OTC health/hearing devices specifically. Confirm this is an actual signed/named partner.
- **The $349 B2C / $200 B2B ASP spread (1.75x) is thinner than typical hearing-device wholesale
  economics (historically ~3-4x)** but plausible for an OTC-category good with standard
  pharmacy-chain wholesale discounting (40-50% is normal). Not unusually thin or thick, but on
  the aggressive side — especially layered against the stated 65% new-inventory margin, which
  requires a low ~$70 COGS to hold up.
- **The B2B growth pace ($257K Year 1 to $1.2M Year 5, ~36% CAGR) is realistic-to-conservative**
  given typical pharmacy-chain onboarding timelines (3-9 months per chain) — the real risk is
  whether the underlying wholesale agreements (Cardinal/Cencora/Topco) are actually executed yet,
  not the growth curve itself.

---

## 7. InnerScope fact-check — pure verification, no strategic commentary
Given this content is securities-sensitive, this section states only what was verified,
partially verified, or contradicted against SEC EDGAR and OTC Markets primary sources:
- **SEC reporting window:** deregistered via Form 15-12G filed **March 2021**, not "2016-2020" as
  the deck states — off by about a year.
- **Current OTC Markets tier:** confirmed filing under Pink Market Disclosure Guidelines in
  recent filings; **"OTCID tier" could not be independently confirmed.** One stale third-party
  source (TipRanks) still describes it as "OTCQB," which appears to be outdated boilerplate.
- **"~$967M cumulative trading volume":** unsourced anywhere checked. Mathematically plausible
  given historical share count and price levels, but not a figure any source actually reports.
- **"45,000 total beneficial holders":** no public corroboration found. Only the "129 holders of
  record" figure is confirmed (OTC Markets disclosure, 12/31/2025).
- **Rule 144(i) non-applicability:** a plausible inference from InnerScope's continuous operating
  history (FY2020 10-K explicitly states "Entity Shell Company: false") — but no explicit SEC or
  legal-opinion statement confirming 144(i) applicability was found. **This specifically needs
  counsel's determination, not an inference, before it's stated as fact in an offering document.**
- **iHEAR acquisition date:** the deck says September 30, 2021. Primary-source press release
  confirms the actual close was **October 5, 2021.**
- **FY2022 revenue ($15.3M) and net profit ($5.6M):** confirmed accurate against a primary-source
  press release.
- **"Walmart 757→4,218 stores":** the starting figure (757) is corroborated; **the 4,218 ending
  figure could not be found in any source** — available sources instead reference ~1,500+ Walmart
  Vision Centers, a different figure entirely.

---

## 8. What to do with this
This is a research and verification pass, not a rewrite of the deck — the deck itself is
Matt's document to revise. Recommended next steps, roughly in priority order:
1. Get a direct answer on "ShelfReady" and the PSAO auto-opt-in claim (§1) — these are the two
   most serious, since they're checkable and currently unsupported.
2. Rebuild the exit-multiples slide against current market data (§2) — an underwriter will check
   these specifically.
3. Relabel the funnel-conversion rates as planning assumptions with the corrected ranges (§3).
4. Fix the two factual InnerScope date/figure errors (§7: acquisition date, Walmart store count)
   — small, easy, and exactly the kind of thing that erodes trust if found independently.
5. Everything else in §4-6 is lower-severity — mostly "cite this better" or "soften this claim,"
   not "this is wrong."

---
*Research-only synthesis. Every finding above is sourced in the originating subagent research —
ask if full source detail on any specific figure is needed. This doc does not itself contain any
new InnerScope MNPI or valuation specifics beyond what was already in Matt's own deck.*

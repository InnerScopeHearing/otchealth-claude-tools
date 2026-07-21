---
name: app-factory
description: The productized, repeatable growth-and-release methodology (the "Medvi Playbook") the fleet already operates for its 8 consumer apps, packaged as a fleet skill. Seven layers, acquisition, onboarding, distribution, trust, monetization, reliability/audit, release, each mapped to real catalog capabilities the fleet already owns or has scoped. Use it two ways, (a) INTERNALLY, to spin up a new app's growth+release plan or audit an existing app for gaps, and (b) as the source for the B2B "App Factory as a Service" offer, a licensable SOP sold via the digital-products/Gumroad lane, or a run-it-for-you service alongside AWARE's audiologist licensing. Trigger on "app factory," "Medvi playbook," "growth and release methodology," "productize the pipeline," "sell the playbook," "B2B growth machine," or when scaffolding/auditing any fleet app's acquisition, distribution, or release setup. Wielded by every agent building or growing a fleet app; the B2B offer itself is owned by CRO (pricing and positioning), CTO (delivery pipeline), CLO (contract gate).
---

# app-factory, the Medvi Playbook, productized

The fleet already runs a real growth-and-release machine across 8 apps (iHEARtest, AWARE,
OTCHealth Companion, Flatstick, FourVault, InnerEase, PlantID, Fictionary), hardened through
real pain, the Depot ephemeral-cert-cap bug, the Codemagic-to-Depot cutover, the Flatstick
SKIP_INSTALL widget gotcha, the Mark Moore review ritual. This skill names that machine as a
repeatable methodology (the "Medvi Playbook," synthesized from the 2026-07-21 Capgo phase-2
catalog research, `research/capgo-phase2-2026-07-21/PHASE2-SYNTHESIS.md` section 5 and
`10-crosscut-b2b-medvi-internal.md`) so it can be run for the NEXT app without re-deriving it,
and packaged as a second, near-zero-marginal-cost revenue line built on top of engineering work
the fleet is already doing for internal reasons.

## When to invoke
- Scaffolding a new fleet app (alongside `scaffolder`), to plan its growth+release setup from
  day one instead of retrofitting it later.
- Auditing an existing live app for a growth or release throughput gap (a layer below is
  missing or thin).
- Building or refreshing the B2B "App Factory as a Service" offer, the SOP listing or the
  managed-service SOW.

## The seven layers

Each layer: what it is, the catalog capabilities that build it, the internal-run framing, and
the B2B-sold framing. None of this is speculative, every capability named is already flagged
adopt-now or adopt-later in the source research against a real fleet app.

### 1. Acquisition
Growing the top of funnel using capabilities the fleet already owns or can adopt near zero
cost, Native Market cross-promotion deep links across the shared publisher identity (one
identity, 8 apps today), plus partner-attributed Universal Links carrying a clinic or referral
code.
- Capabilities: `@capgo/capacitor-native-market`, the deep-linking attribution pattern
  (`source`/`campaign`/`ref` query params plus a first-launch attribution lookup).
- Internal-run: iHEARtest points a positive-screen user at AWARE, AWARE points a caregiver at
  Companion, Flatstick points a golfer at Fictionary. A portfolio flywheel, blended CAC drops as
  internal referral volume grows, and it compounds with every new app the factory ships. The
  `aso-growth` skill covers organic top-of-funnel alongside this.
- B2B-sold: the same attribution pattern, pointed outward, becomes the technical backbone of a
  clinic-referral program, a partner hands out a branded link, the attribution pattern credits
  that clinic for the resulting signup, feeding a rev-share or co-marketing relationship. A new
  B2B revenue mechanic, not just a distribution optimization.

### 2. Onboarding
Document Scanner-powered clinic intake, edge-detected, perspective-corrected scan-to-PDF for
forms, insurance cards, and questionnaires, replacing paper-based partner onboarding friction.
- Capabilities: the Capgo Document Scanner plugin (`scanDocument()`).
- Internal-run: the same primitive also raises OCR input confidence for Companion's scam-mail
  capture and, on MedReview's V1.1 Capacitor wrap, for the existing BAA-covered Cloud Vision
  call, on-device perspective correction before the call, zero new vendor, zero compliance-
  boundary change.
- B2B-sold: AWARE's clinic document-intake product, directly sellable on its own, not just an
  app feature, and it strengthens the audiologist-licensing pitch.

### 3. Distribution
Capgo channels as a runtime-configurable, per-tenant content bundle on top of one shared
binary (precedence, forced device mapping, then cloud override, then plugin `setChannel`, then
config `defaultChannel`, then cloud default). One AWARE (or any clinic-facing) binary, N
per-partner channels (`clinic-<name>`) carrying a branding/config/offering-id bundle, assigned
via the cloud-override device API (`POST /device/`) at partner account creation.
- Capabilities: `capgo-live-updates` device-targeted beta channels, `capgo-release-management`
  staged rollout (10/50/100, rollout percentage down to 0.01 percent bps, auto-pause on
  failure rate).
- Internal-run: the same mechanism collapses Mark Moore's iHEARtest review ritual and internal
  QA from a full Depot-build-and-TestFlight-wait cycle to an instant OTA push for JS-only
  changes, the single largest release-velocity multiplier identified anywhere in the Capgo
  research. Percentage rollout is also the backbone of cheap, safe paywall A/B testing.
- B2B-sold: onboarding a new clinic partner becomes an OTA channel push instead of an App
  Store review cycle, the fastest concrete lever to a real B2B distribution motion.
- Hard rule this layer inherits: `capgo-release-workflows` is the canonical routing skill.
  Never let Capgo hosted native builds, `capgo-native-builds`, or Capawesome CLI/Cloud
  substitute for the actual iOS build mechanism, see Guardrails.

### 4. Trust
The "OTCHealth Trust and Security" one-pager, SSL Pinning, an app-integrity check (Firebase App
Check on Companion's Vertex/ElevenLabs proxy), Native Biometric Keychain token storage, and
Privacy Screen tagging on the sensitive-surface registry, the SAME registry that already drives
PostHog replay masking, one source of truth, not two. Plus branded Incoming Call Kit and Twilio
Voice as a "verified call" differentiator (spike, not yet built).
- Capabilities: SSL Pinning plugin, Firebase App Check, `@capacitor/privacy-screen`, Native
  Biometric.
- Internal-run: closes a checkable HIPAA transmission-security safeguard on MedReview and a
  real senior-targeted MITM and screenshot-leak vector on Companion's notebook/consent
  surfaces, MedReview's medication list, and FourVault's kid photos.
- B2B-sold: the one-pager answers an enterprise security questionnaire once instead of per
  deal. Branded verified-call UI is a sellable differentiator to senior-care facilities and
  clinics that no consumer hearing or wellness competitor currently offers.

### 5. Monetization
The `subscription-app-revenue` skill's MRR-from-subscriber-count formulas, the 80-percent-of-
users-must-see-the-paywall diagnostic, one-change-per-release-cycle churn-testing discipline,
and ethical guardrails (no fake reviews, no dark patterns, honor store subscription-disclosure
rules) as the canonical fleet subscription-growth doctrine, plus RevenueCat server-side
entitlement enforcement, never a native or client-trusting purchase plugin, and, for the RTM
case specifically, the Health plus Alarm plus Pedometer plus Push adherence chain as a billable
CPT 98975-98981 extension (CFO/CLO/clinical-gated, the highest-dollar item in the whole Capgo
scan, see `PHASE2-SYNTHESIS.md` section 3 item 1).
- Internal-run: apply the doctrine identically across Companion (5-tier), Flatstick (3-tier
  chat), AWARE (pro), PlantID (2-product price test).
- B2B-sold: the same doctrine, repackaged, is what AWARE hands an audiologist partner, "how to
  think about your patients' subscription funnel," a component of the partner-success kit, not
  just an internal engineering reference.

### 6. Reliability and audit
Offline-durable, tamper-evident-sync local data capture, a local queue plus verified sync, as a
reimbursement-documentation and payer-audit defensibility feature for the RTM billing case
specifically, plus `capsec` (a 63-plus-rule CI security scanner mapping close to 1:1 onto
existing fleet hardened rules, SEC001 the never-commit-a-secret-value law, CAP009 live-update
security, LOG001/LOG002 PHI/PII-in-logs) so security review scales sub-linearly as the factory
adds a 9th, 10th, 11th app.
- Internal-run: `capsec`'s per-app category breakdown (SEC/STO/NET/CAP/AND/IOS/AUTH/WEB/CRY/LOG)
  belongs on the CTO's own portfolio-status board.
- B2B-sold: device or app attestation on the adherence-data submission chain makes an RTM
  billing claim defensible against a payer audit or clawback, a line item on the trust
  one-pager for a clinical B2B deal.

### 7. Release
`capacitor-apple-review-preflight` (a roughly 1,300-line guideline-cited checklist) as a
standing CTO pre-dispatch gate before every Depot dispatch, `capsec` as the CI security gate,
Depot plus fastlane match (spike, not yet adopted) as the signing and build backbone, Capgo
Live Updates as the rapid-iteration loop, and Capgo bundle-push events wired into `daily-digest`
so OTA release history compounds into company-brain the same way PR merges already do.
- Internal-run: every App Store rejection costs calendar days AND Depot macOS minutes (roughly
  10x the cost of Linux minutes) on a resubmission cycle, a real, compounding tax on factory
  throughput across 8-plus apps running in parallel.
- B2B-sold: any AWARE clinic-facing build gets the preflight before dispatch, every time, as a
  standing rule, because a rejected or pulled B2B app is a partner-relationship event, not just
  an internal delay.

## Productize it, the two revenue shapes

### Shape A, licensable SOP (documentation only)
- What: package the seven layers above, the `subscription-app-revenue` formulas, the review-
  preflight corpus, the OTA rapid-iteration loop, and the `capsec` rule catalog as a written
  playbook.
- Channel: the existing `digital-products`/Gumroad lane, the same zero-COGS pattern already
  proven on the pharmacy/OTC compliance SOP marketplace.
- Pricing model options: a flat one-time price per playbook, priced above the $49-149 pharmacy
  SOP band since this is an engineering methodology, not a template, or a tiered bundle, a core
  playbook plus per-layer add-on modules sold separately, for example the OTA/release module
  apart from the trust one-pager.
- Marginal cost: near zero, a content-assembly project drawing on work already done, not new
  engineering.
- Owner: CRO designs the offer and pricing, content is produced via `digital-products` plus
  `content-engine`.

### Shape B, run-it-for-you service (managed delivery)
- What: the fleet builds and operates the pipeline FOR a partner clinic or health-tech founder,
  Depot signing, a Capgo OTA channel, the Apple-preflight gate, a `capsec` scan, RevenueCat
  entitlement wiring, standalone or bundled with AWARE's existing audiologist-licensing motion.
- Pricing model options: a setup fee plus a monthly retainer (infrastructure-as-a-service
  framing), or a revenue share on the partner's resulting subscription revenue, aligning
  incentive with the growth-machine framing and mirroring the clinic-referral rev-share
  mechanic named in the Acquisition layer.
- Delivery mechanism: the same Capgo per-clinic channel model from the Distribution layer, one
  binary, N partner-branded OTA config bundles.
- Owner: CRO owns the offer and the partner relationship, CTO owns the pipeline, CLO gates the
  contract.

### Ownership split (both shapes)
- **CRO** owns the offer, pricing, partner qualification, positioning, close.
- **CTO** owns the pipeline, what gets delivered technically, Depot/Capgo/`capsec`/RevenueCat
  wiring, and the growth-room brain feed below.
- **CLO** gates the contracts, every partner SOW, MSA, or licensing agreement is a legal review
  before signature. Any INND or investor-facing framing of this revenue line is counsel-and-Matt
  gated per the standing securities firewall, this is a product and engineering play, never an
  IR claim.

## The brain-indexed growth room (compounding piece, not yet built)
A Tier-1 nightly Container Apps Job, the same proven pattern as `daily-digest`/
`innd-stock-daily`, Azure-credit-funded, zero Max-plan draw, that snapshots the Capgo
Statistics API (org and per-app stats, bundle-adoption curves), joins it with RevenueCat and
PostHog subscriber and funnel numbers already flowing in, and writes a structured daily doc
indexed the same way `memory-exec`/`commons-journal` are. Once live, any exec agent, CRO, CFO,
COO, CTO, can ask `company-brain` "how is AWARE's paywall doing this week" or "is the InnerEase
OTA rollout stalled" and get a cited, federated answer instead of pulling an unwired vendor
dashboard. Caveat carried from the source research, Capgo MAU is a DEVICE metric, not a human
metric, never conflate it with subscriber counts in a CFO- or CRO-facing report built on this
data. This job is a documented backlog item, not yet built, flagged here so a future session
wires it instead of re-deriving the idea.

## Checklist helper
```
node scripts/checklist.mjs --app <id> --mode internal|b2b-sop|b2b-managed \
  [--status acquisition=done,distribution=pending,...] [--out <file>]
```
Prints a per-layer readiness checklist for the named app and mode. `--status` marks any layer
`done`, `pending`, or `gap` (anything unmarked defaults to `pending`); `--out` writes the
checklist to a file instead of stdout. Use it to snapshot where a new app stands against the
seven layers, or to scope a B2B offer packet (which layers are proven enough to sell as a
run-it-for-you service today versus which still need internal hardening first).

## Guardrails (inherited fleet rules, do not relitigate)
- **Depot-exclusive, CTO-only iOS build policy.** Never let Capgo hosted native builds, the
  `capgo-native-builds` skill, or Capawesome CLI/Cloud substitute for Depot as the actual build
  mechanism, in either the internal or the B2B-managed shape. Fastlane match's certificate-
  management concept is worth a scoped spike against the existing Depot workflow, never as a
  parallel build system. Periodically audit octools for Capgo and Capawesome installed side by
  side, that duplicate-OTA-vendor risk undermines the "mature release engineering" story a B2B
  pitch depends on.
- **RevenueCat is the only entitlement enforcement path.** Never Native Purchases or any other
  client-trusting purchase plugin, internal or B2B, it regresses the server-side-only
  entitlement enforcement every subscription app and the whole growth-machine concept depends
  on for revenue integrity.
- **Ring walls hold.** PHI (MedReview, Companion PHI surfaces) and COPPA (FourVault) stay
  exactly as hard-gated as everywhere else in the fleet. A B2B partner ask that implies a
  third-party analytics or attribution plugin (AppsFlyer, Facebook Analytics, GTM, RudderStack,
  Contentsquare) or AdMob routes through the existing PostHog-primary and no-kid-ads rules
  before being accepted, it is never granted as a partner accommodation.
- **Securities firewall.** The B2B productization is a product and engineering play. Any INND or
  investor-facing claim about this revenue line is counsel-and-Matt gated, never autonomous.
- No em dashes or en dashes anywhere in this skill's own copy or any output it produces,
  published-style content, commas, periods, and line breaks only.

## Output
A per-app, per-layer status snapshot for internal use, or a scoped B2B offer packet, an SOP
listing draft (Shape A) or a managed-service SOW outline (Shape B), ready to hand to CRO, CTO,
and CLO.

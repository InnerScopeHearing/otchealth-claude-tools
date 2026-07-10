# The Medvi Mirror — OTCHealth Operations Playbook (consolidated)

> Canonical living source: Hyperagent global doc **"OTCHealth Cash Playbook — The Medvi Mirror (iHEARtrio → $25K → OTC)"** (ReadDocument id `cmqumip7l06ci07adzkjlvv8r`). This file is the packaged, repo-resident consolidation for the Medvi Operations project. Where the two differ, re-read the living doc — but everything material is captured here.

## 1. The strategy (Medvi, mirrored to us)
Medvi = a MARKETING + DISTRIBUTION layer on outsourced medical infra. ~$401M/yr, 2 people, single sticky wedge (GLP-1), surgical paid media, AI creative volume, AI customer service, compliance-as-feature. Their ceiling was the FDA warning letter for misleading claims.

Our mirror (laser focus): iHEARtest + AWARE are the real apps; everything else is a side project.
- **WEDGE / cash-today product:** iHEAR TReO (PSAP — Personal Sound Amplification Product). Sellable TODAY, no FDA 30-60 day path. Our GLP-1 equivalent for immediate cash.
- **ACQUISITION MAGNET:** iHEARtest (the free hearing screening) — the highest-intent top-of-funnel lead magnet possible. People who screen are self-qualifying buyers. iHEARtest IS the ad engine. (Medvi had to manufacture this; we already have it.)
- **OFFER:** screening result -> "you may benefit from amplification" -> iHEAR TReO offer -> Shopify/Stripe checkout (OTCHealthMart exists).
- **RETENTION / LTV:** AWARE (aural-rehab subscription) + consumables replenishment + (future) CareNow membership.
- **THE $25K GATE:** the OTC hearing-aid line (the regulated 30-60 day process) does NOT start until $25K is generated via PSAP sales / capital / loans. PSAP cash funds the OTC launch.
- **COMPLIANCE = THE MOAT (the Medvi lesson):** a PSAP may be marketed only as sound amplification for general wellness — NEVER treat/diagnose/cure. Every ad/claim runs through an automated claims-compliance gate before publish. That is what lets us scale paid media safely.

## 2. Medvi forensics — the deeper truth (what to copy vs what blew it up)
Medvi's explosion had two sides:
- **GROWTH** = regulatory arbitrage (compounded GLP-1 during the FDA shortage; the price gap WAS the product) + 5,000+ simultaneous Meta ads (~30% via AFFILIATES running fake AI "doctor" personas) + subscription auto-refill (~$149/mo, ~$1,600/yr/customer, ~250K customers, ~16% net).
- **LEGAL EXPLOSION** = FDA warning letter (misbranding / implied approval), fake-physician-persona exposes, a partner data breach (1.6M records), TCPA + anti-spam class actions, 35 state AGs pressuring Meta. Their core product is now gone (shortage resolved; compounding forced to stop). Medvi was on borrowed time from day one.

**The validating insight for OTCHealth:** the Medvi MARKETING machine transfers cleanly to PSAPs, and the PSAP version is STRUCTURALLY SAFER + more durable — NO FDA shortage clock, NO pharmacy single-point-of-failure, NO prescribing liability, NO PHI breach exposure, NO controlled-substance risk. OTC hearing aids were affirmatively authorized by FDA in 2022 (the regulatory question is answered, not pending). **The ONLY Medvi risk that transfers = affiliate/FTC compliance** (fake testimonials, unsubstantiated claims, implied clinical endorsement). So our claims-gate must screen ADS + ADVERTORIALS hardest, extend to AFFILIATE/creator auditing, and use FTC-safe comparison framing ("comparable amplification to clinic devices at a fraction of the cost" — factual, verifiable) — the inverse of Medvi's illegal "same as Ozempic" claim.

## 3. The 8 Medvi tactics we copy
1. **Single-wedge paid funnel:** ad -> ADVERTORIAL (editorial, not a product page) -> 2-min quiz -> offer reveal; subscription-first.
2. **Creative testing at industrial cadence:** 20-50 UGC-style creatives/wk, ~$50-100 each for 48-72h, kill/scale on cost-per-initiated-checkout.
3. **Advertorial IS the landing page** (2-4x conversion vs a product page).
4. **Creator/affiliate flywheel:** micro-creators (50-200K), flat fee + 15-25% affiliate; hundreds of them, not a few.
5. **Offer/pricing psychology:** free/near-free lead offer, money on the back-end subscription; anchor retail -> discount; auto-renew default.
6. **AI CS + compliance firewall:** scripted, logged, pre-approved answers only -> cost + provable compliance.
7. **Retention via milestone framing:** "Week 4: what typically happens"; churn-save at day 14 + 45 (35%+ save).
8. **Compliance as moat** — BUT Medvi's FDA letter hit FRONT-END ad/advertorial claim specificity, not the model. Lesson: screen ads + advertorials hardest, owned AND affiliate.

## 4. Canonical products + the full business design
Spelling is canonical: **iHEAR TReO** (capital T-R-e-O), never "iHEARtrio". Pulled live from hearingassist.myshopify.com.
- **WEDGE (sellable now) — iHEAR TReO PSAP** (vendor iHEAR Medical, ACTIVE): TReO single $99 (was $299); Complete Pair (L+R) $149 (was $598), promo code **PAIR99** (pair for $99). FTC-safe framing: "$299/side at CVS vs $99 here" — factual, allowed.
- **OTC hearing aids ($25K-gated ascension tier; iHEAR brand):** iHEAR Matrix $349/pair (active); iHEAR Axis $329 + iHEAR Linx $239 (reserve, Q4 2026). Parent Hearing Assist OTC line also live (EAZE/STREAM/CONTROL/CONNECT/MICRO).
- **Recurring / LTV (built, future-gated for customer-facing):** OTCHealth CareNow membership ($9.99-19.99/mo for life). Keep internal until launch.
- **Consumables (replenishment subscription, real SKUs):** ear domes, thin tubes, batteries, cleaning, dehumidifier, case.
- **Store:** hearingassist.myshopify.com (Hearing Assist + iHEAR + CareNow brands). **Stripe = the only payment rail.**

### The 9-stage revenue loop (funnel -> loop -> close -> ascend)
1. **IGNITE:** the owned DB (~85K; ~66,224 valid mailable HearingAssist email contacts) -> email-led reactivation (Customer.io) + SMS/call (TCPA-gated) -> drive to the free iHEARtest screening.
2. **MAGNET:** iHEARtest free screening (high-intent, self-qualifying).
3. **FUNNEL:** result -> "you may benefit from amplification" -> iHEAR TReO offer (advertorial + quiz).
4. **CLOSE:** Shopify + Stripe checkout.
5. **SUPPORT:** VoiceRAG voice/chat CS (live; gate-screened, PHI-handoff rules) + the existing AI voice fleet (Sarah/Helen/etc.).
6. **RETAIN/LTV:** post-purchase -> consumables replenishment + AWARE (+ CareNow when launched).
7. **ASCEND:** at cumulative $25K -> unlock the iHEAR OTC aid line to the warmed base.
8. **MEASURE:** daily P&L + $25K tracker + CAC/LTV (PostHog/Stripe/RevenueCat).
9. **COMPLY (the moat):** every claim — owned AND affiliate — passes `claims_check` before it ships.

### The exec org that runs it
- **CTO:** infra, the MCP gateway, the claims-compliance gate, funnel host, analytics jobs, deploys, security.
- **CRO:** growth/marketing — ad-creative loop, funnel experiments, affiliate/creator, email/SMS (gate-checked; spend + sends Matt-gated).
- **COO:** customer service + ops — VoiceRAG + Intercom + fulfillment coordination + lifecycle ops; quarterbacks Matt's day.
- **CFO/analytics:** daily P&L + $25K tracker + CAC/LTV/cohorts.
- **CPO/clinical gate:** signs off any clinical/OTC-device claim.

## 5. The idea catalog (every play, by speed-to-cash)
A. IMMEDIATE CASH: iHEARtest->TReO funnel; 85K/66K reactivation; abandoned-cart recovery; "which amplifier" quiz; TReO+AWARE bundle.
B. RECURRING/LTV: consumables subscription; AWARE upsell + AI voice coaching; winback/churn-save; review/reputation engine.
C. TRAFFIC ENGINES: SEO content hub (compliant, AI); AI creative factory -> gate -> paid social; creator/UGC brief engine; programmatic landing pages.
D. NEW CHANNELS: Amazon TReO listing; voice-commerce reorders; outbound voice (TCPA-gated); retail/clinic wholesale.
E. STACK-AS-PRODUCT (the big one): white-label the iHEARtest screening + VoiceRAG CS stack to clinics/retailers (recurring SaaS); lead-gen routing of opted-in screened prospects to audiologist networks (B2B).
F. FUTURE (post-$25K): the OTC hearing-aid line (FDA, behind a flag, Matt + clinical gate); dynamic pricing/offer optimization.
Top 5 speed-to-cash: (1) email blast to the mailable list with the TReO offer; (2) Amazon TReO listing; (3) iHEARtest->TReO 5-email drip; (4) TReO+AWARE bundle at checkout (AOV); (5) VoiceRAG/outbound to lapsed iHEARtest users.

## 6. The SOP library (the processes the fleet runs)
- **SOP-1 CLAIMS COMPLIANCE:** nothing (ad/advertorial/web/email/SMS/CS line/affiliate) ships unless it passes the claims-gate (PSAP = amplification/wellness only; ZERO treat/diagnose/cure). Gate logs every check; ads + advertorials screened hardest.
- **SOP-2 FUNNEL EXPERIMENT:** new angle -> advertorial + quiz variant on staging -> gate -> Matt approves spend -> launch -> kill/scale at 48-72h on cost-per-initiated-checkout. PostHog is source of truth.
- **SOP-3 CS CONTENT SYNC:** nightly pull of real Shopify/Intercom content into the VoiceRAG cs-knowledge index; compliance-screened; PHI-forced-handoff rules.
- **SOP-4 LIST/LIFECYCLE:** reactivation + abandoned-cart + iHEARtest->TReO drip in Customer.io; agent drafts + segments; MATT approves the send; milestone-framed retention + day-14/45 churn-save.
- **SOP-5 VOICE PRODUCTION:** pre-rendered ad VO + AWARE coaching = ElevenLabs char grant; live CS/IVR/outbound = Azure realtime (gpt-realtime). Every script gate-checked.
- **SOP-6 DAILY MONEY AUTOPILOT:** cron pulls Stripe+Shopify+PostHog+RevenueCat -> daily P&L, CAC/LTV, cohorts, cumulative vs $25K -> the number Matt wakes up to.
- **SOP-7 $25K GATE:** at cumulative $25K, alert Matt + unlock OTC-line prep behind a flag (Matt + clinical sign-off).
- **SOP-8 REVIEWS/SOCIAL PROOF:** post-purchase 7-day review request (email+SMS); showcase on the funnel.

## 7. Voice economics (decided)
- **ElevenLabs char grant** (~33M chars ≈ ~611 hours pre-rendered) = premium PRE-RENDERED audio (ad VO + AWARE coaching) where emotion drives conversion/retention. Do NOT burn it on live calls.
- **Azure AI Speech + gpt-realtime** (credit-funded) = ALL live conversation (VoiceRAG CS, IVR/ACS telephony, outbound). ~10-18x cheaper than ElevenLabs realtime. Avoid Azure Custom Neural Voice (~$2,900/mo endpoint) for now.

## 8. Build & deploy sequence (cost-neutral; speed-to-cash + dependency order)
- **TIER A — CASH ENGINE:** (0) claims-compliance gate [LIVE]; (1) iHEARtest->TReO funnel + quiz on Static Web Apps -> Shopify/Stripe; (2) VoiceRAG real TReO/Shopify content; (3) list-reactivation + abandoned-cart in Customer.io (DRAFT; send Matt-gated); (4) daily P&L + $25K tracker.
- **TIER B — RECURRING/LTV:** consumables subscription + AWARE bundle; review/reputation + winback.
- **TIER C — TRAFFIC:** SEO content hub; AI creative factory -> gate -> staged ad sets (spend Matt-gated); creator/UGC brief engine.
- **TIER D — CHANNELS:** Amazon TReO; voice-commerce reorder; outbound voice (TCPA-gated).
- **TIER E — STACK-AS-PRODUCT:** white-label screening + CS SaaS (B2B), scoped + pitched.
- **TIER F — FUTURE:** at $25K, trigger OTC-line prep behind a flag (Matt + clinical gate).

## 9. What's already built (assets to deploy, not rebuild)
iHEARtest screening (the magnet, ~live); the iHEAR TReO advertorial->quiz->offer funnel (focus-group-tuned, real product/pricing/images, live checkout links); the **claims-compliance gate (LIVE in the MCP gateway)**; VoiceRAG CS (live); the revenue tracker + $25K reignition gate (built; baseline: store is a PROVEN $227K/1,484-order store now DORMANT — the mission is REIGNITION, not first-dollar); the 85K/66K Customer.io database; the OTCHealthMart Shopify store (Stripe-only rail); the live AI voice fleet (Sarah/Helen/Roger/Taylor/Claire/Fin on Twilio+ElevenLabs+n8n); the gateway connector matrix (Shopify/Miro/n8n/GitHub/Customer.io/Cloudflare/Graph R+W); the focus-group-loop; the hardened infra (token broker, Datadog watchdog, OCR sweep).

## 10. Cost ledger (must stay $0 incremental)
Azure $25K credits -> funnel hosting (Static Web Apps free), the compliance gate, realtime CS, cron jobs, AI Search. GitHub $10K -> CI/automation. ElevenLabs char grant -> ad VO + CS voice. PostHog $50K -> analytics. Stripe/Shopify -> existing. **NET NEW CASH COST: $0 until Matt approves paid ad spend.**

## The Medvi lesson in one line
Run the same growth machine, on a safer product, with compliance enforced in code from day one — and fix the brand/support hole before you scale the spend.

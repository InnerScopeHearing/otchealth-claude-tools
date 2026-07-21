# Phase 2 Synthesis: Capgo Catalog to Fleet Use-Case Mining

Synthesized from 10 parallel miner passes over the Capgo plugin and skill catalog (~150 plugins,
~49 skills) against every OTCHealth Inc. and InnerScope (INND) surface: 8 consumer apps, the PHI
ring, B2B/Medvi-style growth plays, and the internal exec-agent app factory.

## 1. Executive Summary

The single biggest thesis: the Capgo catalog is not a grab bag of native plugins, it is a
pre-built OPERATING SYSTEM for exactly the three things a billion-dollar, multi-app factory needs
and does not yet have. First, a PREMIUM-FEEL FLOOR (haptics, safe-area, branded splash, dynamic
status bar, in-app review, privacy screen) that is currently at zero coverage across seven of eight
apps and is the cheapest, fastest lever to make every app stop looking like a hackathon build.
Second, a RELEASE-VELOCITY MULTIPLIER: Capgo Live Updates (OTA) plus a device-targeted beta
channel replaces the full Depot-build-and-TestFlight-wait cycle for JS-only fixes, which is the
single biggest throughput unlock available to a team running 6 to 7 apps in parallel with one CTO
gate on iOS builds. Third, a FACTORY MULTIPLIER: nearly every miner independently converged on the
same move, bake the winning patterns (capture pipeline, offline-first starter, security starter
pack, UI polish defaults, OTA config) into the app-template/scaffolder ONCE so every future app
inherits them instead of each App Lead re-deriving them per repo. That convergence across five
independent slices is itself the strongest signal in this report.

Beyond the floor-raising plays, the catalog also surfaces real NEW revenue: Health/HealthKit plus
Alarm plus Pedometer chains into a billable Remote Therapeutic Monitoring (RTM, CPT 98975-98981)
program for MedReview/Companion, a genuinely new insurance/B2B revenue line, not a feature. The
fleet's own hardened release pipeline (Depot, signing, Capgo OTA, Apple-preflight, capsec) is
itself a sellable "App Factory as a Service" or Medvi-style growth-machine product. And several
per-app moats fall out almost for free: iHEARtest cross-validating against Apple's own AirPods
HealthKit audiogram, Flatstick becoming a real GPS golf companion via Compass/Barometer/
Geolocation, PlantID using the Light Sensor for measured (not generic) care advice.

The catalog also surfaces real anti-patterns to actively avoid: anything that reintroduces a
second native-build path (Capgo hosted native builds, Capawesome) against the hardened
Depot-exclusive policy, anything that regresses server-side entitlement enforcement (native
purchases outside RevenueCat), anything that touches FourVault's COPPA wall (ads, uncontrolled
persistent identifiers, weak age-verification substitutes), and anything that could silently
route PHI-adjacent data (Health, Speech Recognition) to a non-BAA cloud path.

## 2. The Master Opportunity Matrix

De-duplicated across all 10 miners; items hit by more than one miner are merged and framed with
the sharpest angle. Sorted by call, then by rough impact within call.

### Adopt now

| Catalog item | Surface | Win | Effort |
|---|---|---|---|
| Haptics (@capacitor/haptics) | Fleet-wide, esp. Flatstick, Companion, AWARE, FourVault | Zero fleet coverage of the cheapest, most physically-felt quality signal; on Companion it is accessibility-adjacent, serving the senior hard-requirement rule directly | S |
| Safe Area Handling (env(safe-area-inset-*)) | Fleet-wide, highest stakes Flatstick (thumb-zone scoring) and PlantID (capture button) | Near-zero-risk, pure-CSS, OTA-shippable fix for the #1 visible "cheap app" tell; on Flatstick a mis-tap near the home indicator is money-adjacent | S |
| Branded Splash Screen | Fleet-wide, esp. Flatstick (coin-matched cinematic launch) | Highest-visibility first-impression fix, seen on every cold launch forever; apps are almost certainly on the generic default | M |
| Dynamic Status Bar theme-sync | Fleet-wide, esp. Flatstick (dark UI), MedReview (high-contrast toggle) | Prevents the classic invisible-icon failure exactly where brand-bar discipline is most explicit; must be wired to theme state | S |
| In App Review, fleet-wide standardization | All 8 apps (only iHEARtest has it today) | Cheapest, most proven ASO lever; directly compounds with the aso-growth skill | S |
| Native Market cross-promotion deep links | Fleet-wide, one shared publisher identity | Zero-CAC internal cross-sell network (AWARE to iHEARtest, Companion household to both) most portfolios never get | S |
| Camera Preview captureSample() | Companion (Pillar 1 visual assistant), PlantID (live identify loop) | The correct live-preview frame-grab primitive for point-camera-get-answer UX; no camera plugin currently named for either | S |
| Document Scanner scanDocument() | FourVault (card capture), Companion (scam-mail capture, better OCR input + forward artifact) | Edge-detected, perspective-corrected crops raise recognition confidence and OCR quality at zero new vendor cost | M |
| File Compressor | Companion feed, FourVault cards, PlantID photos | Client-side compression cuts storage/bandwidth cost and speeds first-response latency on the exact point-and-answer flows that sell the product | S |
| File Picker HEIC conversion | Fleet-wide (any photo-library picker) | Every app is iOS-first so every camera-roll default is HEIC; removes a silent server-side failure class before it becomes a support ticket | S |
| Fleet Capture Pipeline standard (Camera Preview/Doc Scanner + File Compressor + File Picker) | app-template/scaffolder, fleet-wide | Bakes one correct capture-to-upload pattern into the scaffolder once, removing recurring HEIC/unoptimized-upload bugs across every current and future app | M |
| Mute (silent-switch detection) | iHEARtest core screening flow | Closes a real correctness/safety gap, a silenced device can silently invalidate a hearing screen with no user signal | S |
| Speech Synthesis (on-device TTS) | InnerEase | Only TTS option satisfying InnerEase's explicit no-backend V1 rule, at zero cost/latency | S |
| Media Session (lock-screen playback controls) | InnerEase relief sessions, AWARE training audio | Cheap competitive-parity fix against Calm/Headspace-class peers | S |
| Native Audio (short SFX) | Fleet-wide via scaffolder | Standardizes low-latency UI feedback across all 8 apps instead of 8 bespoke implementations | S |
| Persistent Account | Companion (senior reinstall/login friction), fleet-wide subscription apps | Keeps a 70+ user logged in across reinstalls so lost login never manufactures the exact support call Companion exists to prevent; protects trial-to-paid conversion everywhere | S |
| Persistent UUID | Fleet-wide, Growth/ASO attribution | Privacy-safe, ATT-independent device identity surviving reinstall for accurate CAC/LTV without the consent-prompt tax on senior apps | S |
| Asset Cache | AWARE, InnerEase, Companion offline media | Seniors on bad wifi complete sessions/view feeds without buffering, protecting core retention moments | S |
| Uploader / Downloader (background, resumable) | Companion, PlantID, FourVault photo uploads | Eliminates silent-upload-failure at the core camera-to-answer conversion moment | S |
| capacitor-offline-first skill | Internal factory scaffolder | One-time skill install gives every future app session a built-in offline-first playbook | S |
| Alarm (must-fire reminders) | MedReview, Companion, InnerEase, PlantID | Background Task is opportunistic and may not fire on iOS; Alarm is the reliable mechanism every safety/adherence reminder needs and the delivery backbone RTM billing depends on | S |
| Background Task | PlantID watering/care reminders | Missed watering reminder is a literally-dead-plant retention failure; pair with Alarm | S |
| Shake (dev-only bug capture) | Internal QA/builder/guardian agents, all repos | Cheap "shake to report a bug" capture flow paired with Device Info for the QA intake pipeline (dev builds only, never production senior-facing) | S |
| Security Starter Pack (SSL Pinning + Privacy Screen tagging + biometric Keychain token store + App Attest/Check stub) | app-template/scaffolder | Bakes hardened-by-default security into every future app instead of retrofitting per app | M |
| Firebase App Check | OTCHealth Companion | One integrity layer covers Firestore/Storage AND the AI proxy, stopping bot-farm abuse of paid Vertex/ElevenLabs quota, near-zero extra work since Companion is Firebase-native | S |
| SSL Pinning | MedReview (PHI transport), Companion (senior MITM threat model) | Closes a checkable HIPAA transmission-security safeguard and a real senior-targeted MITM vector; becomes a line item on enterprise security questionnaires | S |
| Privacy Screen on sensitive-surface registry | Companion (feed/notebook/consent), MedReview (PHI screens), FourVault (kid photos) | Reuses the same sensitive-surface list that already drives PostHog replay masking to also block app-switcher-snapshot leaks | S |
| Native Biometric setCredentials/getCredentials as Keychain token store | Companion ephemeral AI tokens, fleet-wide session tokens | Secure-Enclave-backed storage replacing any Preferences/localStorage-style token storage; mobile analogue of MedReview's HTTP-only-cookie rule | S |
| Persistent UUID/Account as trial-abuse guard | Companion 14-day paywall, AWARE Pro, InnerEase, PlantID | Closes reinstall-to-reset-trial revenue leak on every hard-paywall product, nobody had flagged this | S |
| Watch transferUserInfo | Flatstick publishMoneyToWatch hook | Replaces hand-rolled WatchConnectivity with reliable-queued delivery, closing a documented open item | S |
| capsec (capacitor-security CI scanner, 63+ rules) | app-template + CI, all 8 apps + MedReview | Turns prose-only fleet security rules into automated CI gates; only tool that can audit the just-wired fleet-wide Capgo OTA config before an incident | M |
| capacitor-quality / capacitor-core marketplace bundles | app-template scaffolder, every builder/QA/guardian session | Install the whole accessibility+performance+security+testing+debugging+logs bundle as one standing capability instead of hand-porting into nine bespoke skills that drift from upstream | S |
| @capacitor/privacy-screen | MedReview (medication list), Companion (notebook/consent) | Closes a real, unimplemented screenshot/app-switcher leak on the two apps most explicit about this exposure class | S |
| capacitor-accessibility as template-default CI gate | AWARE, Companion, MedReview (stated but only MedReview enforces), plus 5 others with no floor | Bakes senior-first accessibility into the template once instead of relying on an unenforced CLAUDE.md rule | S |
| Live Update apply-on-restart audit (capacitor-best-practices) | All 8 apps' new Capgo OTA integration | Verifies OTA uses the non-disruptive background-download/apply-on-restart pattern before a bad config jars a senior mid-task | S |
| capacitor-apple-review-preflight | Companion/Flatstick/AWARE/PlantID paywalls, FourVault Kids Category, MedReview/Companion AI features, every app's Privacy Manifest | ~1,300 lines of guideline-cited checklists catching REJECTION-severity issues before submission, protecting time-to-revenue across 6-7 apps shipping in parallel | M |
| capgo-live-updates device-targeted beta channel (setChannel) | Mark Moore's iHEARtest review ritual, internal QA fleet-wide | Replaces full Depot-build + TestFlight-wait cycles with instant OTA pushes for JS-only fixes; the single largest release-velocity multiplier available | S |
| notifyAppReady() 10-second timing discipline | Every app with live Capgo OTA, esp. Companion (Firebase Auth init) | Prevents silent phantom rollbacks on slow-boot apps that would present as mystery "OTA doesn't apply" bugs | S |
| capgo-release-workflows designated canonical over capgo-cloud/capgo-native-builds | Every app's release-system planning | Prevents an agent from following Capgo's own hosted-build routing advice, which would bypass the Depot-exclusive, CTO-only policy | S |
| capgo-release-management staged rollout (10/50/100) | Every non-PHI consumer app's production OTA channel | Prevents a broken JS bundle from reaching every live user of a fast-growing multi-app portfolio in one shot | S |
| FourVault kids.md Apple preflight checklist | FourVault | Runs the COPPA-adjacent checklist before the first Kids Category submission, avoiding rejection or a live FTC exposure | S |
| capacitor-app-upgrade-v6-to-v7-to-v8 | Flatstick (Capacitor 6 to 8 migration in flight, PR #114) | Correct sequential-hop path unblocks the native-extension (watch/widget/Live Activity) roadmap | M |
| capgo-organization-management | Capgo org "OTCHealth Inc." administration | Prevents a self-inflicted release-blocking lockout when enforcing an org-wide policy (e.g. mandatory 2FA) | S |
| subscription-app-revenue skill | Companion/Flatstick/AWARE/PlantID paywalls, CFO/CRO doctrine | Free, ready-made MRR/paywall-exposure/churn-discipline playbook to adopt as canonical growth doctrine instead of reinventing per app | S |
| Capgo Statistics API into company-brain | Exec agents (CRO/CFO/COO/CTO) | One nightly job makes every exec agent instantly, citably answerable on cross-app funnel/OTA health via brain_search | M |
| Push/widget/Live Activity content discipline (no PHI-adjacent content on glanceable surfaces) | Companion, MedReview, InnerEase | Glanceable surfaces are MORE exposed than in-app screens; write the guardrail into CLAUDE.md before building, not after a compliance miss | S |
| Env plugin + Capgo CLI app-setting in scaffolder | Every future new app | Makes OTA + channel + env-config a factory default like Depot CI and PostHog already are | S |
| Capgo bundle-push events wired into daily-digest | Company-brain OTA-history gap | Closes a blind spot: OTA releases are currently un-journaled while PR merges already compound into brain knowledge | S |
| Ionic Design skill for Companion, WITH swipe-to-delete explicitly excluded | OTCHealth Companion | Adopt native-feeling layout guidance but document the exclusion of Ionic's default swipe-action component, which conflicts with the hardened no-swipe-to-delete rule | S |

### Adopt later

| Catalog item | Surface | Win | Effort |
|---|---|---|---|
| Document Scanner clinic intake | AWARE B2B audiologist licensing | Mobile scan-to-PDF intake (forms, insurance cards, questionnaires) is a sellable Medvi-style onboarding-friction-reducer | L (spike first) |
| Document Scanner on MedReview OCR pipeline | MedReview (V1.1 Capacitor wrap) | On-device perspective correction before the existing BAA-covered Cloud Vision call raises OCR accuracy, zero new vendor, zero compliance-boundary change | M |
| PDF Generator | Flatstick settlement receipts | Shareable "who-owes-whom" PDF reinforces the "we just do the math" trust framing | S |
| Video Thumbnails | ASO/content-engine internal tooling, fleet-wide | Auto-generates App Store preview posters per app/locale, scales with the factory | S |
| FFmpeg audio trim/normalize | Companion voice-clone consent recordings | Cleaner, normalized audio measurably improves ElevenLabs clone quality on the premium upsell tier | S |
| Tailwind design-token consolidation | Companion, Flatstick, future scaffolds | No React app but FourVault has a shared design-token approach; wiring into app-template gives every new app a locked design system day one | M |
| Health (HealthKit/Health Connect) for RTM billing chain | MedReview + Companion + AWARE | Chains with Alarm/Pedometer into a CPT 98975-98981-billable RTM program, a new insurance/B2B revenue line (CFO/CLO/clinical-gated) | L |
| Health HKWorkoutActivityType Golf | Flatstick (rides the already-shipped Watch app) | Free calories/HR/distance summary in Apple Fitness tied to a round, pure retention on existing infra | S |
| Device Info (thermal-state/low-memory telemetry) | app-template + all 8 apps | Crash-correlated device-condition context for free, complements PostHog/Sentry/Datadog; needs Capacitor 8+ (blocks Flatstick until migration lands) | M |
| Pedometer | Companion | "Mom's been active today" signal complementing daily check-in, reaches every install with low false-alarm risk | S |
| cocoapods-to-spm | Every app's ios/ tree before adding a native extension | Pre-empts the duplicate-symbol/signing friction Flatstick already hit | M |
| Share Target (inbound viral acquisition) | Companion (receive forwarded suspicious content), iHEARtest (replace fragile hand-rolled Share Extension) | Fixes a documented App-Store-review risk on iHEARtest and turns Companion's scam pillar into a soft viral loop | M |
| Partner-attributed deep links (Universal Links with clinic code) | AWARE B2B (Sprint 4+) | Standard mechanism behind partner/referral B2B acquisition, nothing implements it today | M |
| Widget Kit + Live Activities + Watch as paywalled premium tiers | Companion, AWARE, iHEARtest, Flatstick | Ambient home/lock-screen presence as a zero-marginal-cost brand impression AND a premium-tier justification, not just an engineering replacement | M |
| Push enabling RTM billing cadence | MedReview (V1.1) | RTM legally requires a minimum monthly engagement-day count; push is the mechanism that produces the billable cadence | M |
| Growth kit productization (push + attributed links + RevenueCat tiers + review timing) | B2B / Medvi-style playbook | Formalizes infra the fleet is already building per-app into a shared, licensable module | L |
| "OTCHealth Trust and Security" one-pager (SSL Pinning + App Check + Biometric + Privacy Screen) | B2B sales enablement | Answers enterprise security questionnaires once instead of per-deal | M |
| device-log-capture tooling (xcrun devicectl) | CTO+App Lead debugging loop, all consumer apps | Collapses the slowest debugging loop (device-only iOS bugs) from prose descriptions into structured logs an agent can read | M |
| Custom bundle storage on existing Backblaze B2 | Internal/CTO infra, FourVault | Consolidates OTA bundle storage onto a vendor relationship already paid for and trusted instead of Capgo's own overage tiers | S |

### Spike (validate before committing)

| Catalog item | Surface | Win | Effort |
|---|---|---|---|
| Twilio Video / RealtimeKit live video calling | Companion Pillar 2 family layer | Turns async photo/check-in into "the easiest way to see your grandkids," a stickier daily hook justifying Family/Legacy tiers | L |
| Incoming Call Kit + Twilio Voice branded calling | Companion scam-escalation trust flow; B2B senior-care/AWARE clinic packages | Fixes the "unbranded call looks like the scam it's preventing" trust problem; sellable as a Medvi-style "verified call" B2B feature | M |
| Audio Session plugin as AmplifyAudioPlugin.swift replacement | Companion, plus iHEARtest/AWARE AirPods routing bugs | Could consolidate three apps' bespoke AVAudioSession Swift into one maintained plugin if its API surface is fuller than docs show | S |
| Fast SQL as Flatstick's local-first live-scoring store | Flatstick | Durable local queue prevents a lost hole score in a dead zone, a genuine reliability differentiator for the money-math trust promise; unblocks publishMoneyToWatch | M |
| Offline-first tamper-evident sync as B2B reliability story | AWARE licensing, future RTM billing | Guaranteed-eventual-sync capture with tamper-evident timestamps is a sellable reliability/reimbursement-documentation feature | M |
| Health HealthKit AirPods audiogram cross-validation | iHEARtest | Cross-validating the in-app hearing screen against Apple's own clinical-grade AirPods audiogram is a hard-to-copy credibility moat; coarse match/mismatch only, raw dB stays on-device | M |
| Accelerometer fall detection | Companion | Reaches every install, not just Apple Watch owners; candidate for a net-new paid "Companion Guardian" tier, needs real false-positive tuning work first | L |
| Barometer environmental nudge | AWARE, InnerEase | Non-diagnostic "may notice more ringing today" hook grounded in tinnitus/Meniere's literature; must stay strict environmental framing to avoid an FDA/FTC claim violation, build claims review into the spike | S |
| Background Geolocation (Guardian safety tier) | Companion | Continuous senior location tracking is a dignity/trust risk as much as compliance; near-zero adoption plugin; must default opt-in, geofence-event-only, never a continuous trail | M |
| Compass + Barometer + Background Geolocation + Native Geocoder as GPS golf companion | Flatstick | Turns Flatstick into a real on-course companion competitive with 18Birdies/GolfShot; geofencing half needs a course-location database (a BD/partnership opportunity to flag) | M |
| App Attest / Mock Location Detector anti-cheat | Flatstick live scoring/bet integrity | Protects score integrity behind the "never weaken the money math" rule; Mock Location Detector is low-adoption (3 stars), validate before committing | M |
| Is Root / jailbreak detection, soft signal only | MedReview, Companion | Genuine anti-tamper signal around PHI/entitlement screens; must stay a soft warning, a hard block risks locking out legitimate seniors | S |
| Device/app attestation for RTM audit defensibility | B2B RTM billing | Attested adherence-data submission chains make billing claims defensible against payer audit/clawback | L |
| App Shortcuts / Home Screen Quick Actions | iHEARtest, Flatstick, AWARE, PlantID | Absent from the Capgo catalog itself; a small native-shim spike outside Capgo for a proven friction reducer | S |
| Screen Recorder (narrate-and-send to assistant/caregiver) | Companion | A more literal, more powerful "one less call to the adult child" than camera-at-a-screen | M |
| Streaming video player (IVS/JW/Mux) for live-round spectating | Flatstick | Plausible new premium/social tier on top of live scoring, needs a real roadmap decision before a paid streaming vendor commitment | L |
| Virtual Currencies for Flatstick Coin a la carte purchases | Flatstick | Bridges casual users into paying via pay-per-use before a subscription commitment, using an already-branded asset | M |
| Age Range / Age Signals to strengthen (not replace) FourVault's VPC gate | FourVault | Platform-native age-signal source without building bespoke age-attestation UX | M |
| capgo-widget-kit vs Flatstick's hand-rolled Xcode-injection pattern | Next app adding a widget (Companion, AWARE) | Could avoid a second/third team re-deriving the SKIP_INSTALL/cert-cap/App-Group gotchas | S |
| Native E2E testing (Appium/Detox biometric simulation on Depot) | MedReview mobile V1.1 pilot | Closes total absence of native-layer E2E; pilot on the app with the most test discipline before spending Depot minutes fleet-wide | M |
| fastlane match reference | Depot pipeline, all 8 apps | Ready-made fix for the already-diagnosed, currently band-aided Depot ephemeral-cert-cap problem | M |
| Capgo channel + device-assignment precedence for per-clinic OTA | AWARE/clinic B2B distribution | One AWARE binary with per-clinic OTA channels turns B2B onboarding from an App Store review cycle into an instant config push | S |
| webapp-to-capacitor wrapping OTCHealthMart | Commerce (TReO PSAP sales) | Opens a native-app commerce/discovery channel alongside the web storefront and Amazon SP-API channel | L |

### Skip / Avoid (anti-patterns and hard-constraint conflicts)

| Catalog item | Surface | Why | Effort |
|---|---|---|---|
| Capgo hosted native builds / capgo-native-builds skill / Capawesome CLI/Cloud | iOS/Android CI, fleet-wide | Directly conflicts with the hard Depot-exclusive, CTO-only-dispatch build policy; would reintroduce the dual-pipeline problem Codemagic retirement just solved | S |
| Streaming video vendor (IVS/JW/Mux) as a default fleet adopt | Fleet-wide except Flatstick's speculative case | No other app has a documented streaming need; pure sprawl on top of the established Bunny.net/Cloud Storage stack | S |
| Ricoh360 Camera plugin | None | Zero product fit, controls 360-degree hardware no app uses | S |
| Native Purchases as a RevenueCat substitute | Any monetized app | Regresses the hardened server-side entitlement enforcement rule by reimplementing receipt validation/webhooks per app | S |
| AdMob on FourVault | FourVault | Directly forbidden by the no-third-party-ads-on-kid-screens non-negotiable rule | S |
| Data Storage (SQLite) plugin unverified encryption claim | Companion notebook/consent, MedReview PHI-adjacent cache | Encryption support is unconfirmed; would displace Companion's already-named SQLCipher standard and risks a false sense of security on the BAA wall | S |
| Speech Recognition without on-device-only verification | MedReview mobile wrap | Could silently route PHI-adjacent speech (medication names, symptoms) to a non-BAA cloud speech backend | S |
| Persistent UUID / Age Range on FourVault kid screens without review | FourVault | Persistent cross-session device identifiers on a kids' app are COPPA-regulated even for internal analytics; needs coppa-kidsafety-reviewer sign-off first | S |
| Age Range / Age Signals as a COPPA VPC substitute | FourVault | The plugin's own docs say it is not a parental-verification workflow; using it to satisfy VPC rather than supplement it is a compliance anti-pattern | S |
| Third-party analytics/attribution family (appsflyer, contentsquare, facebook-analytics, gtm, rudderstack) | Any app, esp. FourVault | Conflicts with the PostHog-primary/Sentry-secondary decision and FourVault's no-third-party-analytics-on-kid-screens rule | S |
| Firebase Firestore/Storage Capgo wrappers, defaulted to without verification | Companion (feed/presence, voice-consent storage) | Capgo's own Firebase Analytics/Crashlytics wrappers are confirmed thin/low-adoption; verify adoption numbers on Firestore/Storage wrappers or fall back to official Firebase SDK before committing on Companion's most compliance-sensitive artifact | S |
| Fast SQL forced migration off Companion's pinned SQLCipher stack | Companion offline store | Storage layer is explicitly pinned and working; unmeasured performance claim does not justify churn | S |
| Shake gesture as a production senior-facing action | Companion (production) | Companion's own accessibility rule bans fine-motor-precision gestures (no swipe-to-delete, no double-tap); shake has the same exclusion problem, dev/QA-only | S |
| Haptics during iHEARtest stimulus presentation specifically | iHEARtest test-taking screens | Risks acting as an unintended non-auditory cue, a clinical-integrity risk; must route through the Mark review ritual, safe on non-test screens | S |
| Navigation Bar (Android nav color/visibility) | Fleet-wide | Correctly low priority, all apps are iOS-first with Android dormant; revisit only on a deliberate Android investment | S |
| Verisoul fraud-prevention service | Companion, Flatstick | Likely a metered paid vendor unlike the rest of the OSS catalog; treat as a budget decision, not a reflexive adopt | S |
| capgo-native-builds credential-storage trust claim | ASC signing keys, Play service-account JSON | Do not hand crown-jewel signing credentials to a third-party hosted build service on an unverified vendor claim | S |

## 3. New Surfaces / New Revenue (the missed-opportunity gold)

Ranked by rough (revenue potential x defensibility) / effort.

1. **RTM billing pipeline (MedReview/Companion, B2B/payer revenue).** Chain Health (HealthKit
   activity as an adherence proxy) plus Alarm (reliable reminder delivery) plus Pedometer plus
   Push (the engagement cadence RTM legally requires) into a clinician-supervised, CPT
   98975-98981-billable Remote Therapeutic Monitoring program. This is the highest-dollar item in
   the whole catalog scan: it turns "an app with reminders" into an insurance-reimbursable line of
   business. Gated hard on CFO/CLO/clinical sign-off and the PHI-ring discipline already used for
   the Hearing Number (category-band or BAA-routed data only, never PostHog/Sentry/non-BAA).
   Device attestation (spike, see security slice) adds payer-audit defensibility to the claim.

2. **Productize the fleet's own release pipeline as "App Factory as a Service."** Depot +
   fastlane-match signing + Capgo OTA + Apple-review-preflight + capsec scanning is infrastructure
   the fleet already owns and has hardened through real pain (the Depot cert-cap bug, the
   Codemagic-to-Depot cutover, the SKIP_INSTALL widget gotcha). Sold or licensed to partner clinics
   and health-tech founders needing a compliant, monetized, OTA-patchable app shipped fast, this is
   a second B2B revenue line built on sunk engineering cost, directly extending AWARE's own
   audiologist-licensing motion into a standalone product.

3. **Branded, verified in-app calling as a B2B "trust" product.** Incoming Call Kit + Twilio Voice
   fixes a real, non-obvious problem: an unbranded call from Companion's own scam-escalation safety
   net looks exactly like the scam it exists to prevent. Branded CallKit UI is directly sellable to
   senior-care facilities and AWARE clinics as a "verified call" feature, a differentiator no
   consumer hearing/wellness competitor currently offers.

4. **White-label B2B distribution via Capgo per-clinic OTA channels.** One AWARE (or MedReview
   V1.1) binary, N partner-branded OTA config bundles pushed instantly per clinic, instead of a
   separate App Store submission per partner. This is the fastest concrete lever to stand up a
   real B2B distribution motion and is close to free given the OTA infrastructure already rolling
   out fleet-wide.

5. **Sell the growth-and-release playbook itself as a licensable SOP.** subscription-app-revenue
   formulas + Apple-preflight discipline + the OTA rapid-iteration loop + the capsec rule catalog,
   bundled as a Gumroad digital product (reusing the proven zero-COGS pharmacy-SOP marketplace
   lane) or folded into AWARE's B2B offer. Pure margin from documentation of work already done.

6. **AWARE B2B clinic document-intake product.** Document Scanner-powered mobile scan-to-PDF
   intake (forms, insurance cards, hearing-history questionnaires) is a Medvi-style,
   onboarding-friction-reducer that is directly sellable on its own, not just an app feature, and
   strengthens the audiologist-licensing pitch.

7. **Companion live family video calling.** Turns the async photo/check-in family layer into "the
   easiest way to see your grandkids," a stickier daily hook that justifies the Family ($24.99) and
   Legacy ($39.99) tiers on more than clone count alone. Large effort (L) but large strategic
   surface area.

8. **Companion "share into the assistant" scam-triage loop + Screen Recorder narration.** Two
   variants of the same idea: turn the OS share sheet (a family member forwards something
   suspicious) or a narrated screen recording (a senior records what's confusing) into a direct
   input to the AI assistant. Both are literal, more powerful realizations of "one less call to the
   adult child" than the current camera-at-a-screen framing, and both are viral/retention loops
   using catalog capabilities nobody had proposed for Companion yet.

9. **Flatstick GPS golf-companion moat.** Compass + Barometer + Background Geolocation + Native
   Geocoder converts a betting/scorekeeping app into a real on-course navigation companion
   competitive with 18Birdies/GolfShot. The course-location database dependency is itself a
   BD/partnership/licensing opportunity worth flagging.

10. **iHEARtest HealthKit AirPods audiogram cross-validation.** Reading Apple's own
    HKAudiogramSampleType and cross-checking iHEARtest's in-app screen against it is a
    hard-to-copy, credibility-building moat feature no PSAP/hearing-screening competitor is
    positioned to build this cheaply, riding the existing category-band-only compliance posture
    (only a coarse match/mismatch signal ever leaves the device).

11. **PlantID lux-based personalized placement advice.** Light Sensor feeding a real measured lux
    reading into the CARE_PROVIDER=llm turns generic "bright indirect light" copy into a
    personalized recommendation, a known beloved differentiator in the plant-care category, at
    zero new vendor cost, deepening both live Pro subscription products.

12. **A brain-indexed nightly "growth room."** Capgo Statistics API plus RevenueCat plus PostHog
    fed into company-brain gives every exec agent (CRO/CFO/COO/CTO) instant, cited answers on
    cross-app funnel and OTA-rollout health instead of unwired vendor dashboards, a compounding
    intelligence asset rather than a single feature.

## 4. Factory Throughput

The clearest cross-slice pattern: five separate miners, working independently on different
catalog slices, converged on the identical structural move, stop shipping good ideas app by app
and bake them into the app-template/scaffolder once. Concretely:

- **Capture pipeline default**: Camera Preview or Document Scanner + File Compressor + File Picker
  HEIC handling, wired once into the scaffolder, removes recurring HEIC and unoptimized-upload
  bugs across every current and future camera-touching app (Companion, FourVault, PlantID,
  MedReview V1.1, and anything built after).
- **Offline-first starter kit**: Asset Cache + Uploader/Downloader + a verified local secure store
  + Persistent UUID + Persistent Account + the Env plugin, as one scaffolder default plus the
  capacitor-offline-first Capgo skill installed once for every future build session.
- **Security starter pack**: SSL Pinning + sensitive-surface Privacy Screen tagging (reusing the
  same registry that already drives PostHog replay masking, one source of truth instead of two) +
  Native Biometric Keychain token storage + an App Attest/Check integrity stub, shipped by default
  rather than retrofitted app by app.
- **UI/UX premium floor**: haptics, safe-area CSS discipline, branded splash, dynamic status bar,
  standardized in-app review timing, all folded into devkit + app-template so every future app
  starts premium-by-default at near-zero marginal cost per new app.
- **CI/quality gate**: capsec (63+ rule security scanner) plus the capacitor-quality/
  capacitor-core marketplace bundle (accessibility + performance + security + testing + debugging
  + logs) installed as one standing, versioned capability in the scaffolder and every builder/QA/
  guardian session, instead of nine bespoke fleet skills that drift from upstream over time.
- **Release infrastructure**: Env + Capgo CLI app-setting wired into the scaffolder makes OTA +
  channel + env-config wiring a factory default the same way Depot CI and PostHog already are.
  capacitor-apple-review-preflight becomes a CTO pre-dispatch gate. capgo-live-updates'
  device-targeted beta channel collapses the Mark-review and internal-QA loop from a full
  Depot-build-and-TestFlight-wait cycle to an instant OTA push for JS-only changes, the single
  biggest release-velocity multiplier identified anywhere in this scan.
- **Device-log-capture tooling** (xcrun devicectl wrapped as a skill) attacks the fleet's slowest,
  most repeated debugging loop, device-only iOS bugs (AVAudioSession, AirPods routing, Web Audio
  unlock) that every consumer-app CLAUDE.md independently complains about, turning "operator
  describes what they saw" into a structured log an agent can read directly.

Net effect: idea-to-shipped time drops on two axes at once. New apps start from a hardened,
premium-feeling, secure, offline-capable baseline instead of a blank Capacitor scaffold (fixing
the "idea to first build" axis), and JS-layer fixes to already-shipped apps reach users in minutes
via OTA instead of a multi-day Depot-build-plus-TestFlight cycle (fixing the "fix to live" axis).
Both axes compound directly with the "6 to 7 apps in parallel" portfolio mandate.

## 5. The Medvi Playbook

**Concept**: a productized, repeatable growth-and-release machine, run internally for every
OTCHealth/InnerScope consumer app and packaged as a sellable or licensable product for partner
clinics, audiologists, and health-tech founders who need a compliant, monetized, fast-iterating
mobile app without building the infrastructure themselves.

**What it is built from (all catalog capabilities already mapped above):**

- **Acquisition layer**: Native Market cross-promotion deep links across the fleet's shared
  publisher identity (B2C-run today); partner-attributed Universal Links carrying a clinic/referral
  code for B2B onboarding (the concrete mechanism AWARE's licensing track currently lacks).
- **Onboarding layer**: Document Scanner-powered clinic intake (forms, insurance cards,
  questionnaires) as a scan-to-PDF flow, replacing paper-based partner onboarding friction.
- **Distribution layer**: Capgo per-clinic OTA channels, one binary, N partner-branded config
  bundles pushed instantly, turning "new partner live" from an App Store review cycle into a
  config push.
- **Trust layer**: the "OTCHealth Trust and Security" one-pager (SSL Pinning + App Check + Native
  Biometric + Privacy Screen), answering enterprise security questionnaires once instead of
  per-deal; branded Incoming Call Kit + Twilio Voice calling as a "verified call" differentiator.
- **Monetization layer**: subscription-app-revenue's MRR/paywall-exposure/churn-discipline
  playbook, RevenueCat server-side entitlement enforcement (never native purchases directly), and
  (for the RTM case) the Health+Alarm+Pedometer+Push adherence chain as a billable extension.
  In-App Review timing and the aso-growth skill for organic top-of-funnel.
  
- **Reliability/audit layer**: offline-durable, tamper-evident-sync data capture (Fast SQL or
  equivalent local queue plus verified sync) as a reimbursement-documentation and payer-audit
  defensibility feature, not just plumbing, for the RTM billing case specifically.
- **Release layer**: capacitor-apple-review-preflight as the CTO's pre-dispatch gate, capsec as
  the CI security gate, Depot + fastlane match as the signing/build backbone, Capgo Live Updates as
  the rapid-iteration loop.

**B2C-run vs B2B-sold**: every layer above is already something the fleet needs and should run
for its own 8 apps (B2C-run, the "factory throughput" section above). The Medvi move is packaging
the SAME infrastructure as a second product: either (a) a documented, licensable SOP sold via the
existing digital-products/Gumroad lane at near-zero marginal COGS, or (b) a run-it-for-you service
sold alongside AWARE's audiologist licensing (or as its own standalone offer) to clinics and
health-tech founders who want a compliant, fast-shipping, monetized app without building the
pipeline themselves. Both variants monetize engineering work the fleet is already doing for
internal reasons.

## 6. Anti-Patterns and Hard-Constraint Conflicts

Do not trip these while executing on the opportunities above.

- **Depot-only iOS build policy.** Never adopt Capgo hosted native builds, the capgo-native-builds
  skill, or Capawesome CLI/Cloud as an actual build mechanism. This directly conflicts with the
  hardened, CTO-only, Depot-macOS-exclusive build policy and would reintroduce the exact
  dual-pipeline problem the Codemagic retirement solved. (Their cert-automation *concept*, e.g.
  fastlane match, is worth spiking; the *products* are not to be used.) Confirm capgo-cloud is not
  coexisting with capgo-release-workflows in octools without an audit; that duplicate-OTA-vendor
  risk undermines the "mature release engineering" story needed for credible B2B pitches.
- **Capgo, not Capawesome.** Capawesome is a direct OTA competitor to Capgo. Never let an agent
  drift toward Capawesome skills/plugins when the fleet's OTA vendor decision is Capgo.
  Repo-audit octools periodically to make sure both are not silently installed side by side.
- **PHI/BAA wall.** Health, Speech Recognition, and any local-storage-with-unverified-encryption
  plugin (the Data Storage SQLite claim) must never become a path for PHI-adjacent data to leave
  the device or land on a non-BAA cloud service. On MedReview specifically, verify on-device-only
  recognition before any mobile speech feature, and never adopt a plugin's unverified encryption
  claim in place of the already-named SQLCipher standard.
- **COPPA wall (FourVault).** No AdMob or any third-party analytics/attribution plugin on kid
  screens. Persistent UUID and Age Range/Age Signals are not automatically compliant just because
  they exist in the catalog; both need coppa-kidsafety-reviewer sign-off before wiring in, and Age
  Range/Age Signals must never be treated as a substitute for FourVault's existing verifiable
  parental consent gate (the plugin's own docs say it is not a parental-verification workflow).
- **Companion's accessibility rules.** No swipe-to-delete, no double-tap, no fine-motor-precision
  gestures on senior-facing production surfaces. This rules out using Shake as anything beyond a
  dev/QA-only bug-report trigger, and rules out adopting Ionic's default swipe-action list
  component wholesale (use the rest of Ionic Design, exclude that one piece, document why).
- **iHEARtest clinical integrity.** Do not add haptic feedback to the actual test-taking/stimulus
  screens without routing it through the Mark review ritual first; a haptic pulse during stimulus
  presentation risks acting as an unintended non-auditory cue, a distinct risk class from PHI.
- **Entitlement enforcement.** Never adopt Native Purchases (or any client-trusting purchase
  plugin) as a RevenueCat substitute anywhere in the fleet; it regresses the hardened
  server-side-only entitlement enforcement rule every subscription app and the whole Medvi-style
  growth-machine concept depends on for revenue integrity.
- **Securities firewall.** Nothing in this catalog scan touches INND-facing or investor content
  directly, but any B2B/Medvi productization work that involves INND branding, investor
  communications, or public statements about revenue from these new lines stays counsel-and-Matt
  gated per the standing securities firewall; the growth/B2B recommendations above are
  product/engineering plays, not IR claims.
- **Third-party streaming/fraud vendors as reflexive adopts.** Do not default-adopt a paid
  adaptive-bitrate video vendor (IVS/JW/Mux) or a fraud-prevention service (Verisoul) without a
  roadmapped feature and a budget decision; both are cost commitments layered on an otherwise
  mostly-free/OSS catalog and should be treated as deliberate spends, not routine adoptions.
- **Firebase wrapper verification.** Before relying on Capgo's Firestore/Storage wrappers for
  Companion's family feed and voice-consent recordings (its most compliance-sensitive artifact),
  verify real adoption numbers or default to the official Firebase SDK; Capgo's own Firebase
  Analytics/Crashlytics wrappers are confirmed thin and low-adoption, so do not assume parity
  without checking.

## 7. Prioritized Ranked Backlog

### P0 (start in the next 1 to 2 days)

1. Fold haptics, safe-area CSS discipline, branded splash, dynamic status bar, and standardized
   in-app review timing into devkit + app-template as scaffolder defaults, then back-port haptics
   and safe-area to all 8 live apps (all S effort, cheapest premium-feel floor available).
2. Stand up capgo-live-updates device-targeted beta channels for Mark's iHEARtest review ritual and
   internal QA fleet-wide; this is the single largest release-velocity multiplier and Capgo is
   already wired.
3. Ship the Fleet Capture Pipeline standard (Camera Preview/Document Scanner + File Compressor +
   File Picker HEIC handling) into the scaffolder and wire it into Companion and PlantID first
   (their core wedge is point-camera-get-answer).
4. Bake the Security Starter Pack (SSL Pinning, sensitive-surface Privacy Screen tagging reusing
   the existing replay-masking registry, Native Biometric Keychain token storage) into the
   scaffolder; ship SSL Pinning + Privacy Screen on MedReview and Companion specifically this week.
5. Wire capsec into CI for the app-template and at least one live app to prove the gate, then
   fleet-wide; it is the only tool that can currently audit the just-wired Capgo OTA config.
6. Ship Persistent Account + Persistent UUID on Companion first (closes the reinstall/login-loss
   gap that manufactures the exact support call Companion exists to prevent) then fleet-wide on
   every hard-paywall app.
7. Fix the Mute (silent-switch) gap on iHEARtest, a real correctness/safety issue on the core
   screening flow, S effort.
8. Wire Alarm (reliable reminders) into MedReview, Companion, InnerEase, and PlantID; it is the
   delivery backbone every subsequent retention and RTM-billing idea depends on.

### P1 (this sprint)

- Install capacitor-quality/capacitor-core marketplace bundle and capacitor-accessibility as a
  template-default CI gate.
- Ship capacitor-apple-review-preflight as a CTO pre-dispatch gate for every app currently
  shipping paywalls, kids-category content, or AI features.
- Wire Firebase App Check on Companion's Vertex/ElevenLabs proxy.
- Watch transferUserInfo to close Flatstick's open publishMoneyToWatch hook.
- Spike the RTM billing chain design (Health + Alarm + Pedometer + Push) with CFO/CLO/clinical to
  scope the highest-dollar opportunity in this report before committing engineering time.
- Spike the Incoming Call Kit + Twilio Voice branded-calling trust feature for Companion.
- Spike PlantID Light Sensor lux-based care advice (cheap, S effort, deepens two live subscription
  products).
- Wire Capgo Statistics API into company-brain via a Tier-1 nightly job.
- Document the FourVault kids.md Apple preflight checklist ahead of any Kids Category submission.

### P2 (next 30 to 60 days, or explicitly gated on a decision/spike outcome)

- Spike iHEARtest HealthKit AirPods audiogram cross-validation (credibility moat, needs a design
  pass for the coarse match/mismatch-only data rule).
- Spike Flatstick GPS golf-companion (Compass/Barometer/Geolocation/Geocoder) and flag the
  course-location database dependency to BD as a partnership opportunity.
- Spike Companion live family video calling and the Screen-Recorder-narration / Share Target
  "share into the assistant" loop; both are large-effort, high-strategic-surface bets that need a
  product decision, not just an engineering ticket.
- Scope and spike the AWARE B2B clinic document-intake product and the White-label per-clinic OTA
  distribution mechanism together, since they are the two fastest concrete levers to a real B2B
  distribution motion.
- Scope the "App Factory as a Service" / licensable growth-and-release SOP as a second revenue
  line; this is a packaging and pricing decision more than an engineering one at this point.
- Fastlane match spike to durably close the Depot ephemeral-cert-cap problem fleet-wide.
- Device-log-capture (xcrun devicectl) skill spike to attack the device-only iOS debugging loop.
- Flatstick Capacitor 6-to-8 migration completion (unblocks Device Info and further native
  extension work), then cocoapods-to-spm cleanup ahead of any future app's first native extension.

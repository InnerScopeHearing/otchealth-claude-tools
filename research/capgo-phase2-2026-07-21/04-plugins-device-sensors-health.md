# Phase 2 slice: health/HealthKit, sensors, compass, barometer, geolocation, background-task, keep-awake, motion

Source: otchealth-claude-tools/research/capgo-2026-07-21/03-capgo-plugins-web.md (150-plugin catalog) and
04-capgo-cloud-docs.md (platform capabilities). Cross-referenced against every app CLAUDE.md and the
otchealth-cto CLAUDE.md for fleet context. No em dashes or en dashes used anywhere below.

Mission framing per Matt: turn the fleet into billion-dollar companies/apps and an app-producing factory.
Every call below is made against that bar, not "is this plugin nice."

---

## 1. Health (`@capgo/capacitor-health`)

Wraps Apple HealthKit and Android Health Connect. `isAvailable()`, `requestAuthorization()`,
`checkAuthorization()`, `readSamples()`. 129.3k monthly downloads, one of the highest-adoption plugins in
the whole 150-plugin catalog. The Capgo page did NOT surface explicit PHI/privacy-compliance documentation,
a real gap; treat every use below as needing a direct read of Apple's HealthKit entitlement and
data-minimization rules before wiring, not an assumption that HealthKit is automatically "safe."

**PHI WALL, read first.** HealthKit/Health Connect data is PHI-ADJACENT even though HealthKit itself is not
automatically HIPAA-scoped. The fleet's own hard rule applies with full force: whatever this plugin reads
must obey the SAME ring the source app already lives in. For iHEARtest that means only `category_band`
leaves the device, raw HealthKit samples never do, same as the existing hearing-number ring. For MedReview
(true BAA ring) any HealthKit read must route through the BAA-covered Cloud Run backend or stay
strictly on-device; it can NEVER touch PostHog, Sentry (even scrubbed), or any non-BAA proxy. For Companion
(non-PHI in v1 per its own CLAUDE.md) a HealthKit read that surfaces anything symptom/condition-shaped would
CONTRADICT Companion's own non-negotiable rule 2 ("treat all data as non-PHI... no symptoms, no conditions
collected") and needs explicit product sign-off before it ships, not a silent add.

- **iHEARtest, AirPods audiogram cross-validation.** iOS 18+ writes an `HKAudiogramSampleType` when a user
  runs the AirPods Pro/Max Hearing Test. iHEARtest could read that Apple-generated audiogram (with consent)
  and cross-validate its own in-app hearing screen against it. This is a genuine credibility moat: "the only
  hearing screen that checks itself against Apple's own clinically built AirPods test." Nobody else in the
  PSAP/hearing-screening app category is doing this. Compliance handling: only a coarse agreement/disagreement
  SIGNAL (e.g., "matches" / "notably different, retest recommended") may leave the device or enter analytics;
  raw dB values from either source stay device-local, same ring rule as the existing Hearing Number. Call:
  spike first (verify entitlement + real device data availability on the 16 Pro dogfood phone), then
  adopt-later once the PHI-ring plumbing is designed. Effort M-L.
- **RTM billing pipeline (MedReview / Companion / AWARE), the single highest-dollar idea in this slice.**
  CPT codes 98975-98981 (Remote Therapeutic Monitoring) pay a clinician-supervised program for
  device-transmitted physiologic/therapeutic adherence data, generally requiring at least 16 days of data in
  a 30-day period. Health (steps/activity as an adherence/wellness proxy) + Alarm (reliable reminder firing,
  see below) + a logging backend are the THREE pieces needed to make MedReview or a Companion medication
  flow RTM-billable. This turns "an app with reminders" into "a billable remote-monitoring program," a new
  B2B/insurance revenue line, not a cosmetic feature. This is squarely a CFO + clinical-sign-off + billing
  integration project, not a pure engineering task, and needs a licensed clinician of record (MedReview's own
  CLAUDE.md already gates personalized dosing on non-PHI-ring separation; RTM adds a NEW compliance surface,
  insurance billing, that needs its own legal review). Flag to CFO/CLO as a structured B2B initiative, do not
  wire silently. Call: adopt-later (it is real, it is big, but it is cross-functional and gated). Effort L.
- **Companion, HealthKit fall-detection / cardiac-alert ingestion.** Apple Watch already writes fall-detected
  and irregular-rhythm events to HealthKit. Companion could read those (with explicit senior + caregiver
  consent) and turn a HealthKit event into an ADULT-CHILD PUSH ALERT, directly on-brand with Companion's
  entire pitch ("one less call to the adult child," peace-of-mind caregiving). This only helps users who
  already own an Apple Watch though; see Accelerometer below for a phone-only fallback that reaches every
  Companion user regardless of Watch ownership. Call: adopt-later (needs consent UX + the PHI-adjacent
  handling above). Effort M.
- **Flatstick, auto-logged Golf workouts.** HealthKit has a native "Golf" `HKWorkoutActivityType`. Flatstick's
  ALREADY-SHIPPED Apple Watch app (money glance, Digital Crown score entry) is the natural place to start
  and end a real HealthKit Golf workout, giving users a free calories/heart-rate/distance-walked summary
  inside Apple's own Fitness app, tied back to their Flatstick round. This is pure retention/stickiness value
  riding on infrastructure Flatstick already built (App Group, watch target). Call: adopt-later. Effort S-M.
- **FourVault:** no legitimate fit. A kids' trading-card app has no business reading a minor's HealthKit data;
  even a gamified "steps to unlock a card" idea pulls a health-adjacent plugin onto a COPPA-gated kid surface
  for a cosmetic reason. Call: avoid.
- **PlantID, InnerEase, Fictionary:** no direct fit for the Health plugin itself (Light Sensor and Alarm serve
  PlantID and InnerEase far better, see below).
- **Internal/exec/factory layer:** not applicable, Health is a client-device plugin; no exec agent runs on a
  phone. N/A.

## 2. Background Task (`@capgo/capacitor-background-task`)

Expo-style periodic background fetch. Explicit, load-bearing caveat from Capgo's own docs: **iOS treats
`minimumInterval` as an EARLIEST start time only, it may fire late or not at all; Android needs a 15-minute
floor.** This "opportunistic, not guaranteed" behavior matters for every use below, anything that MUST fire
(a medication reminder, a safety check-in) is better served by Alarm (item 14) than by Background Task.
Background Task is the right tool for "nice if it happens" work, not "must happen" work.

- **PlantID, watering/care reminders.** PlantID's whole CARE_PROVIDER=llm pillar lives or dies on reminder
  engagement (this is true of every plant-care app category: PlantNet, PictureThis, Planta all compete on
  reminder reliability). Background Task is fine for a "check if any plant's watering window opened" poll,
  paired with Alarm/local notifications for the actual fire. Call: adopt-now. Effort S.
- **Companion, daily check-in.** Already the app's own stated architecture (Pillar 2). The "opportunistic"
  caveat is important context to set correctly with the CAREGIVER, not the senior: a check-in cannot be
  promised to land at an exact time on iOS. Given the caregiver-peace-of-mind stakes, recommend PAIRING with
  Alarm for the actual reminder trigger and using Background Task only for lower-stakes sync work (uploading
  a cached feed post, refreshing notebook data). Call: adopt-now for sync, but do not rely on it alone for
  the check-in itself. Effort S.
- **AWARE, InnerEase:** daily exercise/relief-session streak nudges. Same "sync work yes, must-fire reminder
  no" split as Companion. Call: adopt-now for background sync, effort S.
- **MedReview:** medication-reminder background polling once the Capacitor wrap lands at V1.1. Same caveat;
  the actual reminder fire should be Alarm-backed given RTM billing needs a documented, reliable adherence
  trail (see item 1 and item 14). Call: adopt-later (gated on the V1.1 Capacitor wrap existing at all).
  Effort S once the wrap exists.
- **Flatstick:** background-prefetch of weather/course data ahead of a detected round start (pairs with
  Background Geolocation, item 8). Call: adopt-later. Effort S.
- **FourVault, Fictionary:** no clear fit. Skip.
- **Internal/factory:** N/A, this is a mobile-client plugin; the fleet's actual background/scheduled work
  (librarians, daily-digest, brain-reindex) already runs on Azure Container Apps Jobs, a completely different
  and more reliable mechanism than a phone's opportunistic background fetch. Do not confuse the two; never
  suggest Background Task as an infra job scheduler for exec agents.

## 3. Keep Awake (`@capgo/capacitor-keep-awake`), already live in iHEARtest

Confirmed methods: `keepAwake()`, `allowSleep()`, `isSupported()`, `isKeptAwake()`. Already shipped in
iHEARtest for the hearing test itself. This slice's job is to name every OTHER surface across the fleet that
has the identical "don't let the screen dim mid-task" problem, since it is a one-line integration everywhere
it applies.

- **AWARE:** training exercises (already flagged fleet-wide in the raw report; restating with the owning
  slice's authority). Call: adopt-now. Effort S.
- **InnerEase:** relief-sound sessions. Its own CLAUDE.md already mandates the native audio path so playback
  survives lock, but the SCREEN staying awake during an active session (so the user can see a countdown or
  exercise prompt without re-waking the phone) is a distinct, complementary UX win. Call: adopt-now. Effort S.
- **Flatstick:** live scoring during a round, phone screen dimming mid-shot-entry on the course is a genuine,
  frequently-cited annoyance in golf-scoring app reviews generally. Call: adopt-now. Effort S.
- **MedReview:** the medication-photo capture flow (Cloud Vision OCR of pill bottles/labels). A senior user
  fumbling with multiple bottles should not have the screen sleep mid-capture. Call: adopt-now once the
  Capacitor wrap exists (V1.1). Effort S.
- **FourVault:** multi-card batch-scanning session (photographing several trading cards in one sitting).
  Call: adopt-later. Effort S.
- **PlantID:** the live camera-preview recognition loop, walking around a yard identifying several plants in
  one outdoor session. Call: adopt-later. Effort S.
- **Companion:** the family photo/video feed upload flow and the voice-clone ENROLLMENT recording (a senior
  or family member recording a consent statement should not have the screen sleep mid-recording). Call:
  adopt-now for enrollment specifically, given a failed/interrupted consent recording directly blocks
  Companion's premium voice-cloning tier. Effort S.

## 4. Barometer (`@capgo/capacitor-barometer`)

`getMeasurement`, `isAvailable`, `startMeasurementUpdates`, `stopMeasurementUpdates`.

- **Flatstick, elevation-adjusted yardage.** Direct, well-understood golf-app feature (real golf-GPS apps
  use barometric elevation delta to adjust "plays like" yardage). Call: adopt-now. Effort S.
- **AWARE / InnerEase, environmental-context symptom coaching (non-obvious, compliance-sensitive).** There is
  real audiology/ENT literature tying barometric pressure swings to tinnitus flares and Meniere's-adjacent
  ear-pressure symptoms. An app could correlate a pressure-change EVENT with a gentle, NON-diagnostic nudge:
  "pressure shifted today, some people notice more ringing on days like this, want a relief session." This
  must stay strictly environmental-context framing, never a diagnosis or causal medical claim (both AWARE's
  and InnerEase's CLAUDE.md files are explicit: no diagnosis, no treatment claims, "may help" framing only).
  Handled carefully this is a genuine, hard-to-copy engagement hook nobody else in the aural-wellness app
  category is doing; handled carelessly it is an FDA/FTC claims problem. Call: spike, with the
  phi-compliance-qa / claims-firewall review built into the spike itself, not bolted on after. Effort S to
  prototype, but treat the compliance review as part of the effort, not optional follow-up.
- **PlantID:** minor value, barometric trend as a coarse "storm coming, bring plants in" signal alongside
  weather data. Lower priority than the Light Sensor idea below. Call: adopt-later. Effort S.
- **iHEARtest, Companion, MedReview, FourVault, Fictionary:** no direct fit beyond the AWARE/InnerEase idea
  above (which could technically also live in iHEARtest given the shared hearing-focused audience, but AWARE
  and InnerEase are the natural home given they already own ongoing-relationship coaching UX, iHEARtest is a
  one-time screening tool).

## 5. Accelerometer (`@capgo/capacitor-accelerometer`)

Read device accelerometer for motion detection/orientation.

- **Companion, phone-based fall detection, the biggest single idea under this heading.** Apple Watch already
  does fall detection and Companion can consume that via HealthKit (item 1), but NOT every senior in
  Companion's target market owns an Apple Watch; every one of them owns the phone Companion runs on. A
  phone-carried (pocket or in-hand) accelerometer-based fall-detection heuristic, paired with a caregiver
  push alert, reaches 100% of the install base instead of only the Watch-owning subset. This is a real
  candidate for its own paid "Companion Guardian" tier, distinct from and additive to the existing five-tier
  pricing ladder in `packages/shared/src/pricing.ts` (do not silently fold it into an existing tier, flag to
  product/pricing as a new SKU). False-positive tuning is real engineering work (a phone in a pocket during
  normal activity generates plenty of accelerometer noise); this is not a weekend feature. Call: spike first
  (algorithm quality on real devices) before committing to adopt-now. Effort L.
- **Flatstick:** shake-to-log-a-shot or swing-detection gimmicks. Low value, likely more annoying than useful
  given a golfer's phone is usually in a pocket or cart mount mid-swing, not in a swinging hand. Call: skip.
- **iHEARtest, AWARE, MedReview, FourVault, PlantID, InnerEase, Fictionary:** no clear direct fit beyond the
  Companion fall-detection idea.

## 6. Pedometer (`@capgo/capacitor-pedometer`)

Steps, distance, pace, cadence, floors.

- **Companion, daily-activity caregiver signal.** A simple "Mom's been active today" or "no movement detected
  by 2pm, want to check in" signal complements the existing daily check-in pillar and, like the Accelerometer
  fall-detection idea, reaches every install regardless of Apple Watch ownership. Lower-stakes and lower-risk
  than fall detection (no false-alarm consequence beyond a soft nudge), a good near-term companion feature
  to ship AHEAD OF the bigger fall-detection spike. Call: adopt-later. Effort S.
- **Flatstick, distance-walked-per-round.** A genuine social/competitive stat ("walked 6.2 miles this round")
  that feeds the app's existing social layer and pairs naturally with the Compass/Background-Geolocation
  course-detection work below. Call: adopt-later. Effort S.
- **AWARE:** a general wellness/engagement pairing (steps alongside exercise streaks), modest value, mostly a
  "nice to have" rather than a differentiator. Call: spike only if there is engagement-design bandwidth.
- **RTM billing (see item 1):** step count is a literal, commonly used physiologic data point in several RTM
  billing frameworks (used as an activity-level proxy signal for medication-effect or recovery monitoring).
  Feeds the same B2B billing initiative as Health/Alarm; not a separate project, one more sensor into the
  same pipeline. Effort marginal once the RTM pipeline exists.

## 7. Compass (`@capgo/capacitor-compass`)

`getCurrentHeading`, `startListening` (throttled), `stopListening`, `checkPermissions`. iOS requires location
permission; Android does not.

- **Flatstick, direction-to-pin / yardage overlay.** This is the single cleanest "adopt-now" item in this
  entire slice: real, well-understood, directly competitive with dedicated golf-GPS apps (18Birdies,
  GolfShot, Golfshot GPS) that Flatstick otherwise leaves entirely to a category competitor. Paired with
  Barometer (elevation) and Background Geolocation + Native Geocoder (course detection and coordinates), this
  is a THREE-plugin combination that turns Flatstick from "a betting and scorekeeping app" into a genuine
  golf-companion app with its own on-course GPS layer, a real moat against the betting-and-scoring-only
  competitors it otherwise resembles. Call: adopt-now. Effort S standalone (M as part of the fuller
  GPS-companion buildout below).
- No other fleet app has an obvious compass need.

## 8. Background Geolocation (`@capgo/capacitor-background-geolocation`)

`start`, `stop`, `openSettings`, `setupGeofencing`, `addGeofence`/`removeGeofence`,
`getMonitoredGeofences`, geofence-transition listeners. Flagged in the raw catalog research as having ZERO
monthly npm downloads at fetch time, brand new / effectively unadopted; treat this as a real integration-risk
signal, not just a footnote.

- **Flatstick, auto-detect course arrival and auto-start a round.** Geofencing a golf-course location so the
  app auto-prompts "start today's round at Pebble Creek" the moment a user arrives is the single highest-
  leverage retention lever in this idea: it removes the "remember to open the app and set up bets" friction
  that kills most golf-scoring apps' habit loop. The real blocker is not the plugin, it is DATA: Flatstick
  needs a course-location database (name, coordinates, geofence radius) to geofence against, which does not
  currently exist in the fleet. That database is itself a licensing/partnership opportunity worth flagging to
  BD/partnerships (course-locator data is a commodity a few vendors sell, or could be community-sourced from
  users' own rounds over time). Call: adopt-later for the plugin itself (low adoption risk warrants a spike
  first regardless), but flag the course-database gap as its own missed-opportunity line item for
  partnerships. Effort M for MVP (single-course pilot with a hand-entered geofence list), L for a real
  nationwide course database.
- **Companion, "Guardian" safety geofencing, needs careful design, not a default-on feature.** A
  caregiver-configured "left home" or "arrived somewhere unexpected" signal is a real premium-tier idea
  (pairs naturally with the Accelerometer fall-detection "Guardian" tier above), but continuous location
  tracking of a senior is a serious dignity and trust design problem, not just an engineering one: it can read
  as "tracking Grandma" rather than "keeping Grandma safe," and Companion's own senior-accessibility and
  privacy posture (rule 4, rule 6) demands this be opt-in, transparently disclosed to BOTH the senior and the
  caregiver, and geofence-only (arrival/departure events) rather than a continuous breadcrumb trail. Given the
  plugin's own near-zero adoption, this should be a SPIKE, not an adopt-now, with the trust/consent design
  reviewed before any code ships. Call: spike. Effort M-L (the design work is the larger cost, not the code).
- **FourVault:** a "check in at a card show / hobby shop" geofence idea is a genuine COPPA red flag, location
  tracking of a minor for a marketing/gamification purpose with no clear parental-consent-covered rationale.
  Do not pursue without an explicit coppa-kidsafety-reviewer sign-off; default posture is avoid.
- **MedReview, AWARE, iHEARtest, InnerEase, PlantID, Fictionary:** no direct fit.

## 9. Native Geocoder (`@capgo/capacitor-nativegeocoder`)

Address-to-coordinates and coordinates-to-address.

- **Flatstick:** the supporting plugin for the Background Geolocation / Compass GPS-companion buildout above,
  converting a course's street address into the coordinates a geofence needs, or reverse-geocoding "you are
  at Pebble Creek Golf Club" for display. Low-effort complement, not a standalone feature. Call: adopt-later
  (bundled with item 8). Effort S.
- **Companion:** could geocode addresses already stored in the info notebook (doctor's office, pharmacy) into
  map pins for a one-tap "get directions" action, a small but real senior-UX win (turn-by-turn navigation
  hand-off is exactly the kind of "one less call to the adult child" moment Companion is pitched around,
  "how do I get to Dr. Smith's office" answered in-app instead of a phone call for directions). Call:
  adopt-later. Effort S.
- No fit elsewhere in the fleet.

## 10. Light Sensor (`@capgo/capacitor-light-sensor`)

Ambient light sensor, illuminance in lux, real-time updates.

- **PlantID, lux-based plant-placement advice, the strongest single non-obvious idea in this entire slice.**
  PlantID's architecture already has CARE_PROVIDER=llm generating care advice. Feeding a real, phone-measured
  LUX READING into that LLM prompt ("this spot measures 180 lux, your fiddle leaf fig wants 1000+, move it
  near a south-facing window") turns generic, genre-standard "bright indirect light" advice into a concrete,
  personalized, MEASURED recommendation. Mainstream plant-ID competitors (PlantNet, PictureThis, Planta)
  mostly give generic light-category advice, not phone-measured lux readings tied to placement coaching; a
  few premium apps in this category do something similar and it is consistently cited as their most-loved
  feature. This is cheap (a phone sensor, no new vendor, no new cost) and directly deepens PlantID's paid
  "Pro" subscription value (the two ASC subscription products already live: plantid_annual_2999/_3499). Call:
  adopt-now. Effort S.
- **Companion, AWARE, glare/contrast accessibility.** Auto-detecting bright ambient light (outdoor glare
  washing out a screen) to proactively suggest or auto-apply a high-contrast mode directly serves Companion's
  and AWARE's existing hard senior-accessibility requirements (WCAG AAA contrast, "senior accessibility is a
  hard requirement, not a polish step"). Call: adopt-later. Effort S.
- **MedReview:** a "find better light" nudge during the medication-photo OCR capture flow (better ambient
  light meaningfully improves OCR accuracy on pill bottle labels). Small UX assist, not a headline feature.
  Call: adopt-later, once the Capacitor wrap exists. Effort S.
- No fit for Flatstick, FourVault, iHEARtest, InnerEase, Fictionary.

## 11. Proximity (`@capgo/capacitor-proximity`)

Detects phone-near-face/surface, like the classic phone-call ear-proximity sensor.

Low overall fit across this fleet. iHEARtest/AWARE hearing tests are not conducted phone-to-ear so there is
no clear use. Companion's Gemini Live voice sessions already have their own AVAudioSession routing logic
(the AmplifyAudio native plugin gotcha already documented in Companion's own CLAUDE.md); a proximity sensor
could theoretically help decide speaker-vs-earpiece routing but this duplicates work Companion has already
solved a different way. Call across the board: skip. Not worth the integration cost against the plugin's own
narrow, single-purpose API surface for a fleet with no phone-to-ear use case.

## 12. Device Info (`@capgo/capacitor-device-info`)

Reads CPU, memory, GPU, storage, thermal state, and onboard sensor metrics. Explicitly requires
`@capacitor/core >=8.0.0`, the ONE plugin in the whole 150-plugin catalog with a stated Capacitor-8-minimum,
per the raw research. Flatstick is still mid-migration Capacitor 6 to 8 (PR #114), so this is gated there
until that lands; AWARE and iHEARtest are already on Capacitor 8.

- **Fleet-wide factory-throughput lever, the second-strongest idea in this slice after RTM billing.** The
  company already runs a real observability stack (PostHog primary, Sentry secondary, Datadog now approved
  for infra/APM per the 2026-06-27 reversal) and a real Fleet Intelligence program (agent-evals,
  fleet-telemetry, the company brain). Device Info's thermal-state and low-memory reads are exactly the
  missing CLIENT-SIDE signal that stack does not currently capture: correlating a crash or a Gemini-Live
  drop-out or a camera-vision failure with "the device was thermally throttled" or "was critically low on
  memory" turns a vague crash report into an actionable, device-condition-tagged one. The highest-leverage
  move is NOT wiring this per-app by hand eight times, it is baking a standard Device-Info-to-Sentry-context
  (and, where relevant, Datadog RUM) hook into the shared `app-template`/scaffolder so every NEW app in the
  factory gets this telemetry for free on day one, and back-porting it to the 8 live apps as a batch pass.
  This is precisely the kind of "app-producing factory" lever Matt's mission framing asks for: fix it once at
  the template layer, not eight times per-app. Call: adopt-later (real value, but it is a cross-cutting
  infra/telemetry project, sequence it with the CTO/telemetry-wiring skill rather than any single app).
  Effort M.
- **MedReview:** device thermal/memory telemetry is not PHI itself, but must stay strictly aggregate
  (device-condition tags only) in any BAA-adjacent telemetry payload, never combined with anything
  identifying. Low risk if kept to that scope.

## 13. Shake (`@capgo/capacitor-shake`)

Detect shake gestures for triggering actions.

- **Fleet-wide dev/QA tooling, a genuine cheap factory-throughput win.** The Updater plugin the fleet already
  runs fleet-wide literally has a built-in `setShakeMenu()` / `isShakeMenuEnabled()` debug-menu hook (per the
  Capgo cloud-docs research). Wiring the standalone Shake plugin as a "shake to report a bug" trigger on
  internal/QA/beta builds, capturing device state (pair with Device Info above) plus recent logs
  automatically, is a low-effort improvement to the builder/guardian/QA agents' bug-intake pipeline across
  every app. This is INTERNAL/DEV-BUILD ONLY, never a production end-user gesture (see the accessibility
  anti-pattern flagged below for why). Call: adopt-now for internal QA builds. Effort S.
- **Fictionary:** a "shake for a new word" game mechanic is a plausible, fun, LOW-priority gameplay idea, no
  CLAUDE.md detail was available for this app in the research context, flagged as a generic catalog-level
  idea, not a grounded recommendation. Call: spike, low priority.
- See the anti-patterns section for why Shake should NOT be a primary Companion gesture.

## 14. Alarm (`@capgo/capacitor-alarm`)

Schedule native alarms/notifications that fire even when the app is closed, a materially stronger
reliability guarantee than Background Task's "opportunistic, may run late or not at all" behavior (the
Background Task doc's own caveat, restated here because it is exactly why Alarm exists as a separate,
higher-guarantee plugin for anything time-critical).

- **MedReview, medication reminders, tied directly to the RTM billing opportunity in item 1.** A must-fire
  reminder with a reliable delivery guarantee is the backbone of any medication-adherence claim MedReview
  would ever make, clinically or for billing purposes (98980/98981 requires documented monitoring
  interaction). Background Task alone cannot support that claim, Alarm can. Call: adopt-now once the V1.1
  Capacitor wrap exists (MedReview V1 is web-only per its own CLAUDE.md phased plan). Effort S.
- **Companion, the daily check-in.** Given the entire "peace of mind" pitch hinges on the check-in actually
  happening, Alarm should be the PRIMARY mechanism here, with Background Task relegated to lower-stakes sync
  work as noted in item 2. Call: adopt-now. Effort S.
- **InnerEase:** daily CBT/ACT practice reminders, same reliability logic. Call: adopt-now. Effort S.
- **PlantID:** watering reminders, same logic, a missed watering reminder is a literally-dead-plant failure
  mode that directly damages retention and trust in the app's core promise. Call: adopt-now. Effort S.
- **AWARE, Flatstick:** lower-stakes streak/exercise reminders can stay on Background Task; Alarm is
  available if AWARE wants a firmer daily-training commitment mechanic later. Call: adopt-later.

## 15. Minor / brief mentions (Location and Device APIs categories, adjacent to this slice)

- **iBeacon** (`@capgo/capacitor-ibeacon`): a Flatstick clubhouse/pro-shop beacon check-in or a FourVault
  card-show beacon idea are both plausible but low-value and, for FourVault, carry the same minor-location
  COPPA caution as Background Geolocation above. Call: skip for both, not worth the integration cost against
  the value.
- **Launch Navigator** (`@capgo/capacitor-launch-navigator`, catalog-only, not individually deep-dived in the
  raw research): "open Google Maps/Apple Maps with directions." A clean, low-effort complement to the
  Flatstick GPS-companion buildout (item 7-9), one tap from "find my course" to real turn-by-turn navigation
  handed off to the OS map app; also complements the Companion Native-Geocoder notebook-address idea (item 9)
  for a one-tap "directions to the pharmacy." Call: adopt-later for both. Effort S.
- **Screen Orientation, WiFi** (catalog-only, not individually deep-dived): no strong fit surfaced for this
  slice's use cases beyond generic device-capability plumbing already handled elsewhere in each app's stack.
  Call: skip.

---

## Top missed opportunities in this slice

1. **RTM billing pipeline (Health + Alarm + Pedometer, CFO/CLO/clinical-gated).** Turns MedReview,
   Companion's medication-adjacent flows, and potentially AWARE into billable Remote Therapeutic Monitoring
   programs under CPT 98975-98981, a genuinely new insurance/B2B revenue line built on sensor plugins the
   fleet already has cataloged, not a net-new vendor integration. This is the single highest-dollar idea in
   the slice precisely because it turns "an app with reminders" into "a billable clinical program." Requires
   CFO + CLO + a supervising clinician of record; flag as a structured initiative, not a silent engineering
   task.
2. **PlantID lux-based plant-placement advice (Light Sensor).** Cheap (a phone sensor, zero new vendor cost),
   fast (S effort), and turns PlantID's generic "bright indirect light" LLM advice into a measured,
   personalized recommendation that is consistently a beloved feature in the plant-care app category when
   done well. Directly deepens the value of the two live subscription products.
3. **Flatstick GPS golf-companion moat (Compass + Barometer + Background Geolocation + Native Geocoder).**
   Turns Flatstick from a betting/scorekeeping app that leaves on-course navigation to category competitors
   (18Birdies, GolfShot) into a real golf companion with yardage, elevation, and auto-detected round-start.
   The course-location database needed for the geofencing half is itself a partnership/licensing opportunity
   worth a separate flag to BD.

## Anti-patterns / hard-constraint conflicts

- **Shake gesture as a primary, production, senior-facing Companion interaction.** Companion's own
  non-negotiable rule 4 explicitly bans gestures that assume fine motor precision or physical dexterity
  ("no swipe-to-delete, no double-tap gestures"). A shake gesture has the same accessibility problem for a
  population that may include tremor or limited-mobility users; it belongs ONLY as an optional secondary or
  caregiver-side trigger, never a primary senior-facing action, and never a replacement for a clearly labeled
  on-screen button. Internal QA/debug-menu use (item 13) is fine, that population is developers, not seniors.
- **Any HealthKit/Health-Connect sample (raw audiogram values, raw fall-detection payload, raw heart-rate
  data, raw step counts tied to a name) flowing into PostHog, Sentry (even scrubbed), or any non-BAA proxy.**
  This directly breaches the same PHI-ring discipline the fleet already enforces for iHEARtest's Hearing
  Number and MedReview's medication data. Every idea in item 1 needs its OWN category-band-only or
  BAA-routed handling designed before any code ships, exactly like the existing hearing-number precedent.
  Treat "we have a coarse signal instead of the raw value" as the acceptance bar for anything analytics-adjacent.
- **Background Geolocation, or any location tracking, defaulting to ON or to continuous-trail mode for a
  senior (Companion) or a minor (FourVault).** For Companion this is a dignity/trust design problem as much
  as a compliance one, default posture must be opt-in, geofence-event-only, and disclosed to both the senior
  and caregiver. For FourVault this is a live COPPA red flag, location tracking of a minor for a
  gamification/marketing purpose has no clear verifiable-parental-consent-covered rationale and needs the
  coppa-kidsafety-reviewer's explicit sign-off before any code, not after.
- **Treating Background Task as a "guaranteed fire" mechanism for anything safety- or adherence-critical**
  (a medication reminder, a Companion check-in). Capgo's own docs are explicit that this is opportunistic
  and may not fire at all; use Alarm (item 14) for anything where a missed fire is a real product or
  compliance failure, and reserve Background Task for lower-stakes background sync.
- **Over-investing in Android Health Connect parity for a fleet that is iOS-first everywhere.** Every one of
  the 8 apps' own CLAUDE.md files states iOS-first (Android dormant or secondary in every case checked:
  AWARE "Android dormant," iHEARtest "iOS-first, Android scaffolded but not the focus," others similar).
  The Health plugin nominally supports both platforms; do not spend effort building out Android Health
  Connect parity ahead of real Android demand anywhere in this slice's recommendations.
- **Background Geolocation's near-zero adoption (0 monthly downloads at fetch time) treated as a mature,
  low-risk dependency.** It is not. Any adoption of this specific plugin, for Flatstick course-detection or a
  Companion Guardian tier, should be scoped as a spike with a clear rollback plan, not folded into a normal
  feature sprint as if it were a battle-tested dependency like the Updater or Health plugins.

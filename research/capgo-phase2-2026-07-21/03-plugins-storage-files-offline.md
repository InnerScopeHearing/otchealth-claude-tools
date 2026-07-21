# Capgo slice review: sqlite / secure-storage / filesystem / preferences / offline-first / persistent-uuid / sync

Reviewer focus: offline-first for seniors on bad connections, secure on-device store, PHI-safe
local caching (BAA wall flagged wherever relevant), device-identity dedupe for attribution.

Source: otchealth-claude-tools/research/capgo-2026-07-21/03-capgo-plugins-web.md (catalog) and
04-capgo-cloud-docs.md (platform capabilities). Cross-referenced against the 8-app fleet CLAUDE.md
files and otchealth-claude-tools/CLAUDE.md standing rules.

No em dashes or en dashes used anywhere in this report.

---

## Section A: Files & Storage category (14 catalog items, all considered)

### 1. Asset Cache (@capgo/capacitor-asset-cache)
"Cache CDN images and videos in persistent app storage and bind them as local media sources."
Not individually deep-dived in the source report (catalog-level only), so exact method surface is
unconfirmed, flagged as a gap in the source research itself.

Use-case walk:
- AWARE (aural rehab, senior 50-75): the 12-tile training grid and DIN benchmark almost certainly
  stream audio assets today. Asset Cache would let a senior on a bad home wifi connection complete a
  full exercise session offline after the first load, directly serving this reviewer's "offline-first
  for seniors on bad connections" mandate. ADOPT-NOW.
- InnerEase: relief-sound audio is the product's core deliverable in a moment of acute anxiety, the
  worst possible moment for a buffering spinner. Asset Cache turns the relief-sound library into a
  local-first resource after first play. Also aligns with InnerEase's own non-negotiable rule 5
  ("on-device-first, no backend, no PHI, no BAA in V1"). ADOPT-NOW once InnerEase's app scaffold lands
  (currently docs-only per its CLAUDE.md, flag as adopt-later until Phase 0 fork happens).
- Companion (senior AI companion): the family photo/video feed (Pillar 2) is exactly a CDN-media
  surface. Caching recently viewed family media locally means a senior does not lose access to the
  feed the moment their connection drops, which is a real caregiver-trust moment ("mom couldn't see
  the grandkids' photos because her wifi was down" is a churn-causing failure). Note the feed is
  tagged ph-no-capture (PostHog sensitive-surface carve-out) in Companion's analytics.ts; any local
  cache built on this plugin must respect the same non-PHI, non-analytics-leak posture (caching media
  bytes locally is not itself an analytics leak, but do not let cache-hit/miss telemetry carry photo
  content or captions). ADOPT-NOW.
- Flatstick: course branding assets, scorecard imagery, and the Flatstick Coin renders could be
  pre-cached before a round starts (most golfers know which course they are playing ahead of time),
  useful given courses are the canonical bad-signal environment. ADOPT-LATER (lower urgency than the
  live-scoring data-loss risk covered under Fast SQL below).
- PlantID: less relevant, its core loop is live camera capture and a cloud vision call, not
  CDN-served media playback. SKIP.

### 2. Uploader (@capgo/capacitor-uploader)
"Upload large files reliably in background with progress tracking and retry support."

- Companion: family video/photo uploads FROM a senior's device to Cloud Storage for Firebase are the
  exact use case, background + retry means an upload started before a car ride through a dead zone
  finishes instead of silently failing. Companion's own non-negotiable rule 5 already requires all
  third-party calls to proxy through the Fastify backend for ephemeral tokens; Uploader's client-side
  reliability layer is complementary, not a replacement, for that backend-proxy requirement. ADOPT-NOW.
- PlantID: a photo taken in a garden (classically poor-signal location, brick houses, backyards) needs
  to survive the walk back indoors before the Vertex vision call can run. Background retry directly
  reduces the "I took a photo and nothing happened" failure mode that kills first-session retention on
  a photo-first app. ADOPT-NOW.
- FourVault: kids photographing trading cards, frequently in basements/garages/friends' houses with
  poor wifi. Reliable background upload protects the core "photograph a card, build the vault" loop.
  ADOPT-NOW.
- MedReview (V1.1+ Capacitor wrap only, V1 is web-only per its CLAUDE.md phased-delivery plan): if a
  future version adds document/prescription photo capture, Uploader's target destination MUST be
  BAA-covered infra (the existing Cloud Run/Backblaze B2 BAA-ring path), never Capgo's own default
  cloud storage. FLAG FOR V1.1+, not a V1 concern.

### 3. Data Storage (SQLite) (@capgo/capacitor-data-storage-sqlite)
Methods: openStore, closeStore, isStoreOpen, isStoreExists. Description claims "encryption support"
but the source report explicitly flags this as UNCONFIRMED, no SQLCipher-specific configuration
detail surfaced in the fetched page content.

- Companion: Companion's own locked stack ALREADY specifies `@capacitor-community/sqlite` with
  SQLCipher by name for its on-device encrypted store (notebook + recent-feed cache). This Capgo
  plugin is a simpler key-value-over-SQLite abstraction and is NOT a like-for-like replacement. Given
  the unconfirmed encryption claim, do not swap Companion's already-specified, named encryption
  standard for an unverified one. SKIP for Companion; the community plugin stays.
- Any PHI-adjacent local cache (Companion's info notebook holds emergency contacts, insurance card
  photos, none of which are PHI by Companion's own non-negotiable rule 2 definition, but they are
  sensitive personal data nonetheless; MedReview at V1.1+ would be genuinely PHI-adjacent): treat this
  plugin's "encryption support" claim as unverified until independently confirmed against a
  SQLCipher-equivalent standard. This is a real anti-pattern risk, adopting a plugin because its
  marketing copy says "encryption support" without confirming the cipher, key management, and at-rest
  guarantee is exactly the kind of gap that turns into a real incident. AVOID for any PHI-adjacent
  surface until verified; fine for genuinely non-sensitive local cache (e.g., Flatstick round-history
  cache, Fictionary game state).

### 4. Document Scanner (@capgo/capacitor-document-scanner)
Covered in more depth under the Media slice of this research pass; noted here only for its
filesystem-adjacent output (PDF export straight to device storage). Relevant to Companion's mail/letter
capture use case and, at V1.1+, MedReview prescription capture. No new finding beyond what the source
report already states; cross-reference only.

### 5. Downloader (@capgo/capacitor-downloader)
"Download large files in background with progress tracking and pause/resume support." The mirror
image of Uploader.

- AWARE / InnerEase: bulk-downloading a full exercise/relief-sound pack in one background operation
  (rather than relying purely on Asset Cache's opportunistic per-play caching) would let a senior
  proactively download a week's worth of content on good wifi (e.g., at home) before a trip, then use
  it offline. This is a stronger offline-first guarantee than lazy caching alone. ADOPT-LATER (pairs
  well with Asset Cache, sequence Asset Cache first since it is zero-UX, Downloader needs a "download
  for offline" UI affordance).
- Flatstick: a golfer could pre-download a course's assets before teeing off (same pattern).
  ADOPT-LATER.

### 6. PDF Generator (@capgo/capacitor-pdf-generator)
Methods: fromURL, fromData (HTML string to PDF).

- Flatstick: a season/round settlement summary PDF (who-owes-whom) is squarely in-scope for its
  "never holds money, tracks and links out" rule, a PDF receipt is a natural artifact of that model
  and a trust-building feature (formal record of a settled bet). ADOPT-LATER.
- MedReview (V1.1+): a medication report export is close to MedReview's own domain. Web-only in V1
  makes this a non-issue until the Capacitor wrap; when it lands, the PDF generation and its OUTPUT
  handling (see File Sharer below) both need to respect the same PHI-ring rules as any other
  MedReview data, generate and store BAA-side or ensure the local device sandbox is the only place the
  PDF lives before an explicit user-initiated share. FLAG for V1.1+ planning now, do not implement in V1.

### 7. Fast SQL (@capgo/capacitor-fast-sql)
"High-performance native SQLite with custom protocol for efficient sync operations." Catalog-level
only in the source report (not individually deep-dived), method surface unconfirmed; this is the
single most directly "sync"-named item in the entire catalog and deserves a closer look than the
source report gave it.

- Flatstick: THIS IS THE HIGHEST-LEVERAGE FINDING IN THIS ENTIRE SLICE. Flatstick's live-scoring and
  betting product runs on golf courses, the canonical bad-cell-signal environment (fairways, tree
  cover, remote courses). A hole's score entered in a dead zone must never be lost, and must reconcile
  cleanly with a scorekeeping partner's device once both are back in range (this is fundamentally a
  peer-to-peer or client-to-server SYNC problem, not just local storage). Fast SQL's own description
  ("custom protocol for efficient sync operations") is a purpose-built fit for exactly this. Flatstick
  ALREADY has a hand-rolled Apple Watch WatchConnectivity integration (per its CLAUDE.md/HANDOFF) with
  a documented open item: "publishMoneyToWatch(...) hook is wired at the money-total source" is still
  pending, and "the clinical-grade money rule [says] that total belongs in packages/shared (property-
  tested) first." A durable local store with real sync semantics is the missing foundation under that
  exact open item. SPIKE this now (verify actual conflict-resolution semantics, since golf scoring has
  a genuine multi-writer problem, two players' phones both recording the same hole for a shared match,
  before committing).
- Companion: notebook + feed offline cache (Companion's own SQLCipher spec covers local storage, but
  the SYNC half, reconciling local notebook edits made offline by a caregiver against the server copy,
  is a separate problem this class of plugin addresses). Worth a spike alongside the existing
  community-sqlite plugin, not a replacement for it.
- General fleet note: sqlite-to-fast-sql is also a named skill in Capgo's skills marketplace
  ("Migrate SQLite or SQL plugins to Fast SQL"), suggesting Capgo positions Fast SQL as the more
  capable successor to the plain Data Storage SQLite plugin above. Given this and the "sync operations"
  framing, Fast SQL over Data Storage SQLite as the fleet's local-storage default is the directionally
  correct call once its actual method surface and encryption story are confirmed, which the source
  report did not verify. SPIKE before any adopt-now recommendation on either plugin.

### 8. Printer (@capgo/capacitor-printer)
Low fleet relevance. A senior physically printing a scam-alert page to give to a neighbor, or a golf
scorecard, are plausible but marginal use cases. SKIP for now, no app's CLAUDE.md indicates a printing
need.

### 9. Zip (@capgo/capacitor-zip)
Zipping/unzipping files on-device.

- Companion: a "download your family's memories" one-tap export (a zip of a date range of feed photos
  and captions) is a genuine trust-building, low-effort feature for the adult-child buyer persona, and
  gets ahead of an eventual GDPR/CCPA-style data-portability request before one is legally required.
  Must respect the ph-no-capture sensitive-surface convention already in analytics.ts, no telemetry
  event should describe zip contents beyond a coarse "export_started" categorical event. ADOPT-LATER.
- FourVault: a "export my vault" feature for a parent closing an account has the same shape. ADOPT-LATER.
- Also a plumbing utility for Asset Cache/Downloader above (a downloaded exercise pack could arrive
  zipped). No independent urgency beyond the export use case.

### 10. File (@capgo/capacitor-file)
"Full-featured file system plugin for reading, writing, and managing files and directories." The
general-purpose filesystem primitive underneath most of the above. No app-specific finding beyond
being the plumbing every other Files & Storage plugin above likely depends on or overlaps with; worth
standardizing on this as the SINGLE filesystem primitive fleet-wide rather than each app reaching for
Capacitor core's own Filesystem plugin inconsistently, though this is a "nice consistency," not a gap.

### 11. File Sharer (@capgo/capacitor-file-sharer)
Accepts base64, data URLs, local paths, Android content:// URIs.

- Fleet-wide generic utility: sharing a scanned document, a generated PDF, a scam-alert summary
  (Companion), a card trade verdict (FourVault), a round settlement PDF (Flatstick). ADOPT-LATER,
  standardize alongside PDF Generator and Zip above as the fleet's "export and share user-generated
  artifacts" trio.

### 12. File Picker (@capgo/capacitor-file-picker)
Supports HEIC conversion, a genuine pain point for any app accepting iPhone camera-roll images
server-side.

- Companion (insurance card photos in the notebook, family feed uploads), FourVault (card photo
  capture), PlantID (photo upload flow): all currently likely hand-roll their own HEIC handling or
  push the problem server-side. Standardizing on File Picker's built-in conversion removes a real,
  recurring integration tax across three apps at once. ADOPT-NOW as a fleet standard (cheap, S effort,
  removes duplicated bespoke conversion code in at least 3 apps).

### 13. Firebase Firestore (@capgo/capacitor-firebase-firestore or equivalent slug)
Companion's locked stack ALREADY specifies Firestore (Native mode) for feed posts, reactions,
check-in status, and presence, this is realtime SYNC infrastructure Companion already committed to.

- The question this slice must answer is whether Companion should reach this via Capgo's own Firebase
  plugin sub-suite or the official Firebase JS SDK / the established `capacitor-firebase` community
  plugin. The source report already flagged that Capgo's OWN Firebase Analytics and Crashlytics
  wrappers are low-adoption thin wrappers (844/mo and 633/mo downloads, 6 GitHub stars each) relative
  to the catalog's dominant plugins (RevenueCat's Purchases plugin alone is 532.4k/mo). Firestore and
  Storage were NOT individually deep-dived in the source report, so their adoption/maturity numbers
  are unconfirmed, but the pattern across the rest of the Firebase sub-suite is a real yellow flag.
  Given Firestore is CORE, load-bearing infrastructure for Companion's entire family layer (not a nice-
  to-have), do not default onto Capgo's wrapper without individually confirming its download count and
  GitHub star history first. SPIKE (verify Firestore/Storage-specific adoption numbers) before adopting;
  fall back to the official Firebase JS SDK (framework-agnostic, works fine in a Capacitor WebView) or
  the established community `capacitor-firebase` plugin if Capgo's own wrapper looks similarly thin.

### 14. Firebase Storage (@capgo/capacitor-firebase-storage or equivalent slug)
Same reasoning as Firestore above; Companion's stack already specifies "Cloud Storage for Firebase"
for all media plus voice consent and sample recordings. The voice-consent recordings in particular are
the single most compliance-sensitive artifact in Companion's whole product (non-negotiable rule 3: "the
consent recording is stored and never deleted while the clone is active"). Do NOT swap the storage
layer for consent recordings onto an unverified thin wrapper. SPIKE with the same caution as Firestore
above; this one carries higher stakes given what it stores.

---

## Section B: Auth & Security items relevant to secure-storage / persistent-uuid

### 15. Persistent UUID (@capgo/capacitor-persistent-uuid)
Already individually deep-dived in the source report: getId() (optional scope param), resetId().
Does not expose hardware IDs, does not survive factory reset or storage clear, iOS Keychain-backed
(survives app/OS updates), Android AccountManager-backed (survives reinstall), web uses localStorage
as a dev-only fallback.

- THIS IS THE DIRECT ANSWER TO THE "dedupe device identity for attribution" FOCUS HINT. The fleet's
  primary analytics is PostHog (first-party, IDFA-independent), and none of the 8 apps' CLAUDE.md
  files describe an install-attribution deduplication mechanism today. Persistent UUID gives the
  Growth/ASO/Exposure agent a privacy-safe, ATT-consent-independent device dimension that survives
  reinstall (critical for measuring true reinstall/win-back behavior, not just first-install
  attribution) without touching IDFA/IDFV (which requires App Tracking Transparency consent, a real
  conversion-killing prompt for a senior-first product). This directly serves the growth economics of
  EVERY paid app in the fleet: knowing whether a given "install" is a true new user or a churned user
  reinstalling changes how CAC and LTV get calculated, and currently nothing in the fleet's stack does
  this cleanly. ADOPT-NOW, fleet-wide, paired with PostHog as the device-scoped identity dimension.
- Compatible with Companion's categorical-only analytics rule and MedReview's zero-PHI-in-analytics
  rule specifically because it is explicitly NOT a hardware id and has a documented, user-triggerable
  reset path (resetId()), which also gives Companion a clean technical story for its voice-clone
  revocation privacy narrative ("resetting your device identity is available").
- NOT usable for MedReview's actual PHI surfaces (MedReview's ring rules require BAA-covered infra
  only for anything PHI-adjacent); fine as a device-analytics dimension on MedReview's NON-PHI
  marketing/account surfaces only, if MedReview ever wraps in Capacitor at V1.1+.
- COPPA FLAG for FourVault: a persistent, cross-session device identifier on a KIDS' app is squarely
  within COPPA's definition of "persistent identifier" even when used only for internal analytics
  (the FTC's COPPA rule has a narrow "support for internal operations" exception, but it must be
  affirmatively justified and is not a blanket pass). FourVault's own CLAUDE.md rule 1 already
  requires the coppa-kidsafety-reviewer subagent review before shipping anything with this shape. Do
  NOT wire Persistent UUID into FourVault's kid-facing screens without that explicit review, even
  though the plugin's technical design is more privacy-respectful than IDFA. ADOPT-LATER for FourVault,
  gated on reviewer sign-off; ADOPT-NOW for every other app in the fleet.

### 16. Persistent Account (@capgo/capacitor-persistent-account)
"Preserve user authentication and account data across app reinstalls and updates." Not individually
deep-dived in the source report; catalog description only.

- THIS IS A SIGNIFICANT MISSED OPPORTUNITY, not currently flagged anywhere in the fleet's plugin
  research. Companion's entire pitch is "one less call to the adult child." The single most predictable
  way to GENERATE that exact call is a 70+ user losing their login after a phone reset, an app
  reinstall, or an OS update, forcing them to re-authenticate via phone OTP (Companion's specified
  senior auth method) with no adult child present to help. A Keychain-backed persistent-account layer
  that survives reinstall directly closes this gap and is squarely on-brand for the product's core
  promise. ADOPT-NOW for Companion, this is arguably a HIGHER-PRIORITY fit than several already-flagged
  Companion recommendations in the source report, because it protects retention/conversion at the exact
  moment (post-reinstall) many senior-facing apps quietly lose their most vulnerable users.
- Fleet-wide, this reduces friction and protects trial-to-paid conversion for every subscription app
  (AWARE pro tier, FourVault, Flatstick, InnerEase Sprint-4+ B2B, PlantID): a user who reinstalls mid-
  trial and has to re-onboard from scratch is a user who may simply not come back. ADOPT-NOW fleet-wide
  as a standard, prioritize Companion first given the acute senior-specific stakes.

### 17. Age Range / Age Signals
Covered in depth by the plugins-web source report already (Auth & Security section); relevant here
only insofar as it is ANOTHER persistent-identifier-adjacent signal for FourVault. Cross-reference the
same coppa-kidsafety-reviewer gate noted under Persistent UUID above; do not treat as a COPPA solution
by itself per the source report's own explicit caveat. No new finding beyond reinforcing the gate.

---

## Section C: Developer Tools (secure config, adjacent to secure-storage)

### 18. Env (@capgo/capacitor-env)
"Securely manage environment variables and configuration across different build environments."
Catalog-level only, not individually deep-dived.

- INTERNAL / FACTORY-THROUGHPUT ANGLE: the cloud-docs source report confirms, in its own words, that
  "Bundle files, once uploaded (unencrypted), are treated by Capgo as public web assets... Anyone with
  the bundle URL can access the files unless encrypted." Since a Capgo OTA bundle IS the app's compiled
  web-layer JS, any secret accidentally baked into that JS (an API key hardcoded in a config file
  instead of proxied through a backend) ships as a PUBLIC WEB ASSET the moment it goes out on an OTA
  channel, even if the fleet's normal "secrets never ship to client" rule is followed for the native
  binary. This is a genuine, underexamined risk surface now that Capgo OTA is live on iHEARtest and
  rolling fleet-wide. The Env plugin's job (managing per-build-environment config properly, keeping
  actual secrets server-proxied) is directly protective against this. Recommend the scaffolder/
  app-template bake in an explicit "no secret values in anything that ships via the web bundle, ever"
  lint/CI check as a companion to adopting Env, not just the plugin itself. ADOPT-LATER (S effort,
  meaningful security payoff, not urgent enough to block anything in flight).

---

## Section D: Device APIs items relevant to offline-first / background sync

### 19. Background Task (@capgo/capacitor-background-task)
Already individually deep-dived in the source report: defineTask, registerTaskAsync,
unregisterTaskAsync, isTaskRegisteredAsync, getStatusAsync, addExpirationListener. Expo-style task
registration. Caveats: opportunistic not guaranteed; Android minimum 15-minute interval; iOS treats
minimumInterval as an earliest-start time only.

- Companion's daily check-in (Pillar 2) is the source report's own flagged fit. Extending this
  reviewer's offline-first lens: Background Task is also the natural mechanism for QUEUED SYNC, e.g.,
  flushing a locally-cached notebook edit or a queued family-feed reaction the moment connectivity
  returns, rather than requiring the app to be in the foreground when connectivity comes back. Pair
  with Fast SQL/local storage (Section A.7) as the "durable local queue, opportunistic background
  flush" pattern. ADOPT-NOW for Companion; ADOPT-LATER for AWARE/InnerEase progress-sync (lower
  urgency, less time-critical than a caregiver check-in signal).

### 20. Background Geolocation (@capgo/capacitor-background-geolocation)
Zero monthly npm downloads at fetch time per the source report (brand new, unadopted, real integration
risk flagged there already). Relevant to this slice only as a "sync" data-generation source (queued
location events need the same durable-local-store-plus-background-flush pattern as Background Task
above). Cross-reference the Location-slice reviewer for the primary analysis; no independent storage/
sync finding beyond noting it would consume the same Fast SQL/Background Task pattern if adopted.

---

## Section E: Communication (sync-adjacent)

### 21. MQTT (@capgo/capacitor-mqtt)
"MQTT support for real-time messaging across iOS, Android, and Web." Catalog-level only.

- Low fit for the current 8-app fleet; none of the apps' CLAUDE.md files describe a pub/sub or IoT-
  style realtime messaging need (Companion's realtime layer is already Firestore-native; Flatstick's
  live scoring is turn-based, not streaming). SKIP for now. Flag as a forward-looking note only if a
  future fleet app needs device-to-device or IoT-adjacent realtime messaging (e.g., a hypothetical
  hearing-aid direct-BLE companion app, already flagged as a forward-looking idea in the Media/BLE
  section of the source plugins report).

---

## Section F: The Updates category as the fleet's OWN offline-first/sync backbone

### 22. Updater (@capgo/capacitor-updater), already fleet-wide, re-examined through this slice's lens
The cloud-docs source report's Section 2.4 (notifyAppReady, auto-rollback) and Section 2.2 (channel
device-assignment precedence) describe genuine offline-first and sync engineering already baked into
the plugin the fleet depends on for OTA:

- The `appReadyTimeout` (10 second default) auto-rollback mechanism IS a durable-sync safety net: if a
  bundle fails to signal readiness, the device autonomously reverts, no server round-trip required.
  This is worth explicitly documenting in each app's CLAUDE.md OTA section (per the source report's own
  recommendation) as the reviewer flags it: THIS SLICE'S SUBJECT MATTER (offline-resilience, safe
  local fallback) already exists in the fleet's OTA layer and should be the reference pattern cited
  when designing offline-first behavior elsewhere in each app, "fail safe to the last known-good local
  state" is exactly the same principle this slice recommends for Fast SQL/local data sync above.
- Custom storage (S3-compatible: R2, MinIO, Backblaze B2) is available on all Capgo plans for bundle
  storage, distinct from full self-hosting. FourVault's locked stack ALREADY uses Backblaze B2 + Bunny
  CDN for its own asset storage. Routing Capgo's OTA bundle storage through the SAME B2 account
  (S3-compatible) would consolidate a vendor relationship the fleet already pays for and trusts,
  instead of accruing Capgo's own storage/bandwidth overage tiers ($0.09/GiB storage, $0.06/GiB
  bandwidth on the first tier) as the fleet scales past its plan's included quota. ADOPT-LATER
  (verify actual current Capgo plan headroom before spending engineering time here, this is a cost
  optimization, not an urgent fix; note Azure Blob is NOT S3-compatible, so this consolidation only
  works with the fleet's existing B2 relationship, not a pivot toward Azure storage).
- IMPORTANT REAFFIRMATION for this slice: the source report's own hard caveat (OTA is web-layer only,
  ANY native plugin recommended anywhere in this research, including several in this very report, Fast
  SQL, Data Storage SQLite if it has native encryption bindings, Background Task, requires a real
  Depot-built binary release, never ships silently via the Capgo channel). This bounds every "adopt-now"
  call in this document: adopting a new NATIVE plugin from this slice is a build-and-TestFlight event,
  not a same-day OTA push.

---

## Section G: Skills marketplace items relevant to this slice

### 23. capacitor-offline-first (skill, "Build apps that work without internet")
Directly named in the Capgo skills marketplace (Features category, 4 skills). This is the
PACKAGED KNOWLEDGE version of everything this slice's plugin analysis has been assembling piecemeal
(Asset Cache + Uploader/Downloader + local SQLite + Background Task patterns). Given the fleet already
has `Cap-go/capgo-skills` available for install (per the source cloud-docs report Section 11) and is
already running Capgo-adjacent workflows by hand, installing this skill directly into the scaffolder/
app-template Claude Code environment would give every future app-building session in the factory a
built-in "how to design this app offline-first" playbook rather than re-deriving it per app (as this
very research pass has had to do). ADOPT-NOW, S effort (it is a skill install, not a code change), high
leverage as a factory-throughput multiplier.

### 24. sqlite-to-fast-sql (skill, "Migrate SQLite or SQL plugins to Fast SQL")
Reinforces the Section A.7 finding that Fast SQL is Capgo's intended, more-capable successor to the
plain Data Storage SQLite plugin. Worth having on hand for whichever app pilots Fast SQL first
(Flatstick per the A.7 recommendation). ADOPT-LATER, install alongside the offline-first skill when
the Fast SQL spike (A.7) is scheduled.

### 25. capgo-release-management / capacitor-ci-cd (skills)
Already noted as tangentially relevant by the source cloud-docs report; not core to this slice's
storage/sync/offline focus but worth a one-line cross-reference: these formalize the channel/bundle/
encryption workflow (Section F above) the fleet already runs by hand across 8 apps. ADOPT-LATER,
owned by the CTO/release-conductor lane, not this slice's primary recommendation set.

---

## Top missed opportunities in this slice

1. **Offline-first starter kit baked into the scaffolder/app-template.** Package Asset Cache +
   Uploader/Downloader + a verified local-storage choice (Fast SQL, pending the Section A.7 spike) +
   Persistent UUID + Persistent Account + Env into the factory's app-template so every NEW app in the
   "billion-dollar app factory" inherits offline-first, secure local storage, and attribution-safe
   device identity from day one instead of each app re-deriving this piecemeal (exactly what this
   research pass had to do for the 8 existing apps). This is the single highest-leverage move in this
   slice because it compounds across every future app, not just the current 8.

2. **Persistent Account fleet-wide, Companion first.** Not previously flagged anywhere in the fleet's
   existing plugin research. Directly protects the exact retention moment ("reinstalled and can't log
   back in") most likely to generate the very "call the adult child for help" event Companion exists to
   eliminate. A retention lever hiding in plain sight.

3. **Offline-first as a sellable B2B reliability story.** AWARE's audiologist B2B licensing (Stripe,
   Sprint 4+) and any future RTM medication-adherence billing (CPT 98975-98981, engagement-proof
   documentation) both depend on capturing clinical/adherence data reliably in low-connectivity exam
   rooms or patient homes, then syncing it with a defensible, tamper-evident timestamp trail. Nobody
   has proposed this explicitly; it turns a plumbing concern (local storage + sync) into a genuine
   competitive/compliance selling point for a B2B deal, worth a spike with the CFO/monetization and
   growth-pr agents once AWARE's B2B track resumes.

---

## Anti-patterns / hard-constraint conflicts

1. **Data Storage (SQLite)'s "encryption support" is unverified.** Do not adopt it for any PHI-adjacent
   or genuinely sensitive local cache (MedReview at V1.1+, Companion's notebook/consent data) until the
   actual cipher, key management, and at-rest guarantee are independently confirmed against a
   SQLCipher-equivalent standard. Companion's own locked stack already specifies the community SQLCipher
   plugin by name; do not quietly substitute this Capgo plugin for it.

2. **The PHI/BAA wall applies to every storage and sync plugin in this slice.** Capgo's own
   documentation never mentions a BAA anywhere in the cloud-docs source report (pricing, self-hosting,
   compliance posture sections all silent on it). No plugin in this slice, Uploader's default cloud
   destination, Firestore/Firebase Storage wrappers, Data Storage SQLite's sync behavior if any, may
   ever carry PHI or PHI-adjacent identifiers off-device for MedReview or any future PHI-adjacent
   Companion surface. Only category-band-equivalent, already-de-identified data may leave the device via
   these plugins; genuine PHI stays exclusively on the existing GCP-BAA-covered path (Neon, Backblaze B2
   under BAA, Cloud Run, Vertex AI).

3. **Persistent UUID and Age Range/Age Signals on FourVault's kid screens need the
   coppa-kidsafety-reviewer gate first.** Persistent, cross-session device identifiers on a children's
   app are within COPPA's regulated scope even for internal-operations-only analytics use; FourVault's
   own CLAUDE.md already mandates this reviewer step for exactly this class of change. Do not treat
   either plugin's better-than-IDFA privacy design as a substitute for that review.

4. **Do not default Companion's Firestore/Firebase Storage integration onto Capgo's own Firebase
   plugin sub-suite without checking each one's individual adoption numbers first.** The sub-suite's
   already-confirmed members (Analytics, Crashlytics) are thin, low-adoption wrappers (844/mo and
   633/mo downloads respectively) relative to the catalog's dominant plugins. Firestore and Storage
   are LOAD-BEARING for Companion's entire family layer and its most compliance-sensitive artifact
   (voice-consent recordings); defaulting onto an unverified wrapper here is a materially higher-stakes
   mistake than doing so for an analytics plugin. Spike first; fall back to the official Firebase SDK
   or the established capacitor-firebase community plugin if Capgo's own wrapper looks thin.

5. **Any native plugin adopted from this slice (Fast SQL, Data Storage SQLite if it has native
   bindings, Background Task, Persistent Account's Keychain integration) requires a real Depot-built
   binary release.** None of this ships via the existing Capgo OTA channel silently; OTA is web-layer
   only per the platform's own documented architecture. Plan a TestFlight cycle for any "adopt-now"
   item in this document, do not expect same-day shipping.

6. **Custom S3-compatible bundle storage should point at the fleet's existing Backblaze B2 relationship
   if pursued, never at Azure Blob.** Azure Blob is not S3-compatible; the fleet's own Azure-default
   directive (otchealth-claude-tools/CLAUDE.md) does not extend cleanly to Capgo's custom-storage
   feature, which requires an S3-compatible endpoint. This is a real constraint, not a preference, do
   not propose an Azure Blob custom-storage integration for Capgo bundles.

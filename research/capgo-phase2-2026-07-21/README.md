# Capgo phase-2 research pack, 2026-07-21

Phase-2 exhaustive use-case mining pass over the Capgo catalog (150 plugins, 49
marketplace skills), run through a billion-dollar/app-factory lens across the
whole OTCHealth/InnerScope surface: 8 consumer apps, the PHI ring, B2B/Medvi-style
growth plays, and the internal exec-agent app factory. Ten parallel Sonnet miner
passes plus one synthesis pass. Builds on the phase-1 catalog inventory at
`research/capgo-2026-07-21/` (the raw plugin/skill listing this phase mines for
use cases); read phase 1 first if you need the catalog facts, read this pack for
the "so what do we build" answer. Saved here per the fleet SOP: raw research
lands in the repo under `research/<topic>-<date>/` and is mirrored to the Azure
commons `_DOCS` store for brain indexing.

## Index

- `01-plugins-camera-media-vision.md`. Camera / media / vision / document-scan /
  photo-library / image+video / file-compressor plugins. Focus: Companion's
  camera-first visual assistant wedge, PlantID, FourVault card scan, MedReview
  OCR, iHEARtest.

- `02-plugins-audio-voice-speech.md`. Native audio, speech recognition/synthesis,
  TTS, audio-session, plus Communication-category voice (Twilio Voice/Video,
  Incoming Call Kit, RealtimeKit) and audio-adjacent device signals (Mute,
  Volume Buttons). Focus: the Twilio/ElevenLabs voice-agent fleet, iHEARtest/AWARE
  audio correctness.

- `03-plugins-storage-files-offline.md`. SQLite, secure storage, filesystem,
  preferences, offline-first, persistent-uuid, sync. Focus: offline-first for
  seniors on bad connections, secure on-device storage, PHI-safe local caching
  (BAA wall flagged), device-identity dedupe for attribution.

- `04-plugins-device-sensors-health.md`. HealthKit/Health Connect, sensors,
  compass, barometer, geolocation, background-task, keep-awake, motion. Focus:
  the Apple Intelligence/HealthKit AirPods-audiogram idea, senior-device signals.

- `05-plugins-auth-security-privacy.md`. Native biometric, SSL pinning, privacy
  screen, App Attest, secure-enclave-adjacent, integrity/anti-tamper (Is Root,
  Mock Location Detector), Firebase App Check, Persistent UUID/Account,
  Verisoul, reCAPTCHA, age-range/age-signals.

- `06-plugins-ui-ux-premium.md`. Safe-area, Tailwind, Ionic design patterns,
  splash screen, status bar, haptics, share-target, in-app-review,
  navigation-bar. Flags which of these are OTA-shippable (pure CSS: safe-area,
  Tailwind) versus native-territory requiring a real Depot binary release.

- `07-plugins-engagement-growth-iap.md`. Push, local notifications, IAP,
  deep-linking, widget-kit, live-activities, watch, app-shortcuts, in-app-review,
  subscription-revenue. Notes the fleet already holds one team-scoped APNs .p8
  (reusable per app by bundle id) and that only Flatstick has push wired today.

- `08-skills-dev-quality-factory.md`. Dev + quality marketplace skills:
  capacitor-plugins, capacitor-best-practices, capacitor-security, testing,
  debugging, accessibility, performance, capacitor-mcp, ios-android-logs. Scored
  against factory throughput (idea to shipped app in days).

- `09-skills-deploy-growth-ops.md`. Deploy + growth-ops skills: Apple-review
  preflight, release-management, live-updates, release-workflows, CI/CD,
  app-store, org-management, subscription-app-revenue, migration/upgrade.
  Names capacitor-apple-review-preflight as the single highest-value item in
  this slice.

- `10-crosscut-b2b-medvi-internal.md`. Cross-cutting pass through the B2B /
  Medvi-playbook / internal-exec-agent / factory-productization lens
  specifically (not per-app plugin fit, which the other slices cover). Leads
  with Capgo channels + device-assignment precedence as a per-tenant B2B
  distribution primitive (one binary, N branded channels).

- `PHASE2-SYNTHESIS.md`. The actionable report. Master opportunity matrix across
  every plugin/skill x app/exec-agent surface, new-revenue gold (including
  RTM billing, App-Factory-as-a-Service, per-clinic OTA channels), factory
  throughput changes, the Medvi growth playbook mapped onto the catalog,
  anti-patterns and hard-constraint conflicts (PHI/BAA wall, OTA native-vs-JS
  boundary), and a prioritized P0/P1/P2 backlog. This is the file to read first
  for the "what do we actually build" answer; 01-10 are its source material.

All 11 files were produced in a single research session on 2026-07-21 (10
parallel Sonnet miners + 1 synthesizer). No em dashes or en dashes are used in
any of the files (house style).

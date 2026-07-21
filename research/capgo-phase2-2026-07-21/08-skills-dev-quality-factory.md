# Capgo marketplace, dev + quality slice: factory-throughput analysis

Slice owner: capacitor-plugins, capacitor-best-practices, capacitor-security (capsec),
capacitor-testing, debugging-capacitor, capacitor-accessibility, capacitor-performance, plus
the dev + quality skill families (the capacitor-core and capacitor-quality plugin bundles,
capacitor-mcp, ios-android-logs).

Framing: every item is scored against factory throughput (idea to shipped app in days) and
against the fleet's actual surfaces: the 8 Capacitor consumer apps (iHEARtest, AWARE,
Companion, InnerEase, Flatstick, FourVault, Fictionary, PlantID), the PHI ring (MedReview), the
B2B lanes (AWARE audiologist licensing, the Medvi-style growth playbook, RTM billing,
OTCHealthMart/Amazon commerce), and the internal exec-agent + factory layer (dream-team
builder/qa/guardian/release-captain/growth, app-template/scaffolder, the gateway, company
brain, PostHog/Sentry/Datadog, Depot CI, Capgo OTA).

---

## 1. capacitor-accessibility

What it is: a checklist/snippet reference for WCAG-aligned Capacitor UI, native
VoiceOver/TalkBack trait hookups, and axe-core web scanning.

Cross-app read:

- AWARE (senior 50-75, "axe-core must stay green once the gate is wired" is already a stated
  HARD requirement, not yet enforced) and Companion (WCAG AAA body text, 64x64pt targets,
  VoiceOver/TalkBack labels, non-negotiable rule #4) and MedReview (18-28pt fonts, 48-64px
  targets, axe-core in Vitest, Pa11y in CI, Lighthouse CI a11y >= 0.95) all have this as a
  written HARD rule but only MedReview has it actually wired end to end. iHEARtest and InnerEase
  do not carry an explicit accessibility floor in their CLAUDE.md at all, despite iHEARtest also
  skewing toward an older test-taking audience and InnerEase's wellness audience overlapping.
  GAP: this skill is the generic version of a gate three apps already say they want and only one
  has. Call: adopt-now, target = fold the axe-core/native-trait checklist into the app-template
  scaffolder as a DEFAULT CI step (`npx @axe-core/cli` + a Lighthouse CI a11y budget), not an
  opt-in each App Lead has to remember. This turns "senior-first is a hard requirement" from
  aspirational CLAUDE.md prose into an enforced gate on every new app, which is exactly the
  factory-throughput lever: bake the requirement into the template once, every future app
  inherits it for free.
- Flatstick, FourVault, Fictionary, PlantID have no stated accessibility floor. Flatstick and
  PlantID both have real consumer scale ambitions; a WCAG floor costs little to add at template
  time and a lot to retrofit after 40 screens ship. Call: adopt-now via the same template gate.
- Native VoiceOver/TalkBack label snippets (Swift `accessibilityLabel`/`accessibilityHint`,
  Kotlin `AccessibilityNodeInfoCompat`) are directly useful any time the Developer identity
  touches native code outside the WebView, e.g. Flatstick's watch glance/widget UI (native
  SwiftUI, not web layer, so the web-only a11y gate does not reach it). MISSED OPPORTUNITY:
  Flatstick's watch complication and widget currently have no stated accessibility coverage at
  all; this skill's native snippet is the direct fix. Call: adopt-later, effort S.
- Internal/factory angle: the persona-focus-group and live-persona-walkthrough skills already
  simulate personas hitting the live app; pairing an axe-core pass into that loop (so a
  focus-group run also emits an a11y scorecard, not just a UX narrative) would give the guardian
  agent a quantified regression signal instead of only qualitative persona commentary. Call:
  adopt-later, effort S, surface = dream-team guardian + persona-focus-group.

## 2. capacitor-best-practices

What it is: a broad Capacitor code-review rubric (config hygiene, plugin lazy-loading, bridge
batching, image sizing, error handling, Live Update apply-on-restart pattern, SPM-over-CocoaPods,
a pre-release checklist).

- The "never commit `cleartext:true` or a dev server URL into a config that ships to production"
  rule is exactly the kind of thing that should be a CI grep, not a code-review habit. GAP: none
  of the fleet's CI workflows (web-ci.yml, the monorepo typecheck+test gates) currently grep for
  this. Call: adopt-now, target = every app repo's CI, effort S (one grep line). Directly
  prevents a real "shipped a dev backdoor" class of incident.
- The Live-Update background-download / apply-on-restart pattern (`notifyAppReady()`, listen for
  `updateAvailable`, download quietly, `set()` not immediate reload) is the CORRECT usage pattern
  for exactly what just happened fleet-wide: Capgo OTA channels were "just wired" across all 8
  apps per this session's framing. GAP/risk: if any app's integration force-reloads mid-session
  instead of applying on next natural restart, that is a jarring interruption for a senior user
  mid-task (Companion, AWARE, MedReview-adjacent audiences especially). Call: adopt-now as an
  AUDIT item, target = every app's Capgo Updater wiring, effort S, owner = CTO/Developer. This is
  urgent specifically because it was wired all at once and is unverified per-app.
- Lazy-loading plugins via dynamic `import()` and batching bridge calls (one `Preferences.set`
  with a JSON blob instead of N calls) are generic perf wins that matter most on the
  heaviest-bridge apps: Companion (Gemini Live audio streaming + Firestore), PlantID (Vertex
  vision calls), MedReview (Cloud Vision OCR + Vertex chat). Call: adopt-now as a builder-agent
  code-review checklist item, effort S.
- The 11-item pre-release deployment checklist (strip dev URLs, ProGuard, deployment target, real
  device test, poor-network test, deep links, backgrounding, push, biometric edge cases) maps
  almost 1:1 onto what a release-captain agent should mechanically verify before any TestFlight
  dispatch. GAP: there is no evidence any of the 8 apps' Depot ios-depot.yml workflows run this
  as a structured pre-flight gate today; it currently lives only as tribal knowledge. Call:
  adopt-now, target = release-captain skill / ios-depot.yml pre-flight job, effort M (needs a
  script, not just a doc).

## 3. capacitor-mcp (awesome-ionic-mcp, third-party)

A third-party MCP wrapping Ionic/Capacitor component and plugin docs plus Ionic/Capacitor CLI
command execution (ionic_generate, capacitor_add, capacitor_migrate, etc.).

- This duplicates capability the fleet's own gateway and the company-brain already aim to
  centralize, and it needs ~160 unauthenticated GitHub calls at init (60/hr without a token, so
  it will rate-limit itself on first use without a GITHUB_TOKEN wired in). Given the fleet's
  explicit MCP-vs-skill policy (first-party hosted MCP preferred, gateway preferred over
  scattered third-party servers), this is not a natural fit as a standing connector.
- Narrow but real use: `ionic_generate` and `capacitor_add`/`capacitor_init` code-gen tools could
  shave a few minutes off the scaffolder's first-boot step when standing up a brand-new app repo
  (relevant to the app-template work and to any NEW app after PlantID/Fictionary). Call: skip as
  a standing connector, spike only if the scaffolder team wants a faster component-doc lookup
  loop; effort S to try, but low expected value given the gateway/company-brain already cover
  documentation retrieval more centrally and more securely (no unauthenticated third-party call
  pattern). Target = app-template/scaffolder, S effort, low confidence.

## 4. capacitor-performance

Bundle-size, image-quality caps, bridge-batching, virtual scrolling, GPU-friendly CSS transforms,
and profiling-tool pointers (Chrome DevTools, Xcode Instruments Time Profiler, Android Profiler).

- Image quality/size caps (`quality:80`, `width:1024`, `resultType:'uri'` not base64) apply
  directly to every camera-driven flow in the fleet: Companion's "point the camera at a plant,
  pill, mail" vision wedge, PlantID's plant photo recognition, FourVault's trading-card
  photography, MedReview's medication-photo OCR via Cloud Vision. GAP: none of those apps'
  CLAUDE.md files state an explicit capture-quality ceiling; if any of them are shipping raw/full
  base64 photos to a vision API today, that is real latency + cost bleed on every single-shot
  vision call, which is the core interaction loop of three of these four apps. Call: adopt-now,
  target = Companion, PlantID, FourVault, MedReview capture pipelines, effort S per app (a
  one-line Camera options change), win = materially faster time-to-answer on the single most
  frequent user action in these apps, which is a felt "premium/fast" signal for a senior user
  who already has patience friction.
- The <500KB gzipped bundle / <1s first-paint / <3s TTI targets are a good factory-default
  Lighthouse budget to bake into the app-template's CI, same logic as the accessibility gate.
  Call: adopt-now, template-level, effort S.
- Xcode Instruments / Android Profiler pointers are useful reference material for the Developer
  identity but nothing to industrialize; this is a "know it exists" not a "wire it in" item.
  Call: skip (documentation-only value, no automation payoff).

## 5. capacitor-plugins (the big one: 35 official-plugin reference files + 139-package Capgo
   catalog + a plugin-selection decision framework)

This is the single highest-density item in the slice. Breaking it into the concrete
opportunities that are NOT already obvious from "there is a plugin catalog":

### Security/PHI-adjacent plugins (cross-reference with the security slice too, but the
   PLUGIN gap is mine to flag)

- `@capacitor/privacy-screen` (official, blocks sensitive content in the app-switcher/recent-apps
  view, disables screenshots) is a DIRECT, unimplemented fix for two explicit fleet rules:
  MedReview's medication list (senior UX + PHI-adjacent) and Companion's family notebook /
  voice-consent-recording surfaces (explicitly called "sensitive surfaces" and already
  ph-no-capture-tagged for PostHog replay, but NOT protected from a literal iOS screenshot or
  app-switcher snapshot). GAP: the CLAUDE.md files for both apps describe the DATA sensitivity
  in detail but neither mentions a privacy-screen plugin. Call: adopt-now, target = MedReview
  (once mobile ships in V1.1), Companion (now), effort S, win = closes a real
  screenshot/app-switcher leak on the two apps that most explicitly care about this class of
  leak.
- `@capgo/capacitor-ssl-pinning` (integrates with CapacitorHttp) is a genuine hardening win
  specifically for MedReview, the one app inside the BAA/PHI ring making API calls that matter
  most to defend against MITM. Call: adopt-later (spike first to confirm it plays well with
  Cloud Run's cert rotation cadence), target = MedReview mobile V1.1, effort M.
- `@capgo/capacitor-native-biometric` for a quick re-auth gate is a plausible premium-feel
  addition to Companion (guarding the family notebook / voice-clone consent flows behind a
  Face ID re-check, not just the initial phone-OTP login) and to MedReview (guarding the
  medication list). Call: adopt-later, target = Companion + MedReview, effort M, win = "feels
  like a real health/family app, not a website" trust signal, which matters a lot for a skeptical
  70+ user and their adult-child buyer.

### Health data plugin, `@capgo/capacitor-health` (HealthKit + Health Connect)

- This is the concrete unlock behind an idea that is already floating in the fleet's own
  standing notes but has never been scoped: "the HealthKit AirPods audiogram idea for
  iHEARtest" (explicitly named as a dogfood target for the operator's Apple-Intelligence iPhone
  16 Pro). Apple's AirPods Pro clinical-grade hearing test writes real audiogram data into
  HealthKit. A plugin that can READ that (with consent) turns iHEARtest from "run our own
  in-app hearing screen" into "cross-validate against Apple's own clinical hearing test," which
  is a genuine moat feature no other consumer hearing app is positioned to build as easily
  (OTCHealth already owns the compliance posture: category-band-only data leaving device, FTC
  HBNR-aware). This is a MISSED OPPORTUNITY, not a gap, because nobody has scoped it as a real
  feature yet, it is still an idea in a standing note.
- Same plugin is relevant to Companion (family health-adjacent context, though Companion is
  explicitly non-PHI in v1, so HealthKit read access would need real product-legal scoping before
  touching it) and to MedReview mobile V1.1/V1.2 (its own CLAUDE.md flags SIWA + biometric login
  as V1.2-era, and HealthKit integration for medication adherence tracking is a natural RTM-billing
  companion, see the B2B section below).
- Call: spike, target = iHEARtest (HealthKit AirPods audiogram cross-validation), effort M
  (needs a real product scoping pass + Apple entitlement + consent-flow design, but the technical
  plumbing is a single plugin install), win = a genuinely defensible, hard-to-copy differentiator
  tied directly to an idea Matt/CTO already flagged as worth dogfooding. This is one of my top
  three findings.

### Watch/widget plugins vs. the fleet's hand-rolled pattern

- Flatstick already shipped a native Apple Watch app + home-screen widget + Live Activity via a
  fully hand-rolled Xcode-injection script (`integrate_native_targets.rb`, using the `xcodeproj`
  gem to inject targets into the Capacitor-generated project at build time, because
  project.pbxproj can never be hand-edited). The CTO's own notes explicitly call this "the
  reusable pattern, port this to Companion/AWARE/any Capacitor app adding watch or widgets."
  `@capgo/capacitor-widget-kit` (generic iOS Home Screen widgets + WidgetKit + Live Activities via
  SVG templates + declarative actions + shared App Group persistence) looks like it could have
  replaced the WIDGET portion of that hand-rolled work (not the watch-app portion, which needs a
  real watchOS target either way). GAP/missed-opportunity: the next app to add a widget
  (Companion glance widget, AWARE streak widget, a Flatstick leaderboard widget v2) is about to
  re-walk the same hand-rolled Xcode-injection path unless someone spikes the packaged plugin
  first. Call: spike before the next widget build, target = whichever app is next (Companion is
  the most natural next candidate per its "family layer at a glance" pitch), effort S to spike,
  win = avoids re-deriving Flatstick's four hard-won iOS build gotchas (SKIP_INSTALL=YES for the
  embedded watch app, the Depot ephemeral-cert cap, App Group container assignment being a
  Developer-portal-only Matt gate, App Group containers not existing in the ASC API) a second and
  third time. If the packaged plugin genuinely covers the widget case, it also lowers the
  Depot-macOS-minute cost of iterating (fewer build-and-fail cycles finding Xcode project bugs).
- Naming-collision flag: `@capacitor/watch` (official, experimental, CapacitorLABS,
  declarative-DSL watch UI) and `@capgo/capacitor-watch` (bidirectional native messaging) are
  DIFFERENT packages that solve related-but-different problems, and neither is what Flatstick
  actually used. ANTI-PATTERN RISK: the next Developer session reaching for "the watch plugin"
  could grab the wrong one or duplicate Flatstick's hand-rolled approach unnecessarily. Call:
  document this distinction once (a one-paragraph note in app-kit/LESSONS.md) so it is not
  re-discovered by trial and error every time. Effort S.

### Analytics/attribution plugins: an explicit avoid list

- The Capgo catalog's analytics family (`@capgo/capacitor-appinsights`, `-appsflyer`,
  `-contentsquare`, `-facebook-analytics`, `-gtm`, `-rudderstack`) are all THIRD-PARTY analytics
  SDKs that conflict with two hardened fleet decisions at once: (a) the fleet's own
  PostHog-primary / Sentry-secondary observability posture (adding a fourth analytics vendor per
  app is pure fragmentation, not a win), and (b) FourVault's explicit COPPA rule, "NEVER put
  third-party analytics or ads on kid screens." ANTI-PATTERN: flag these as a standing avoid-list
  for the builder/guardian agents so a future session does not casually `npm install` one of
  these while wiring a "quick attribution check" for growth, especially on FourVault. Call:
  avoid, effort S (a one-line addition to the guardian checklist / capsec-adjacent policy).
- `@capgo/capacitor-install-referrer` (Play install referrer + Apple AdServices attribution) is
  narrower and NOT full behavioral analytics; it is closer to a one-shot "which campaign
  installed this" signal. This is plausibly fine for the growth/ASO layer (aso-growth,
  growth-pr skills) on the CONSUMER apps, but should stay off FourVault's kid-facing install
  path per the same COPPA carve-out even though it is lower-risk than full SDKs. Call:
  adopt-later for growth/ASO on non-kid apps, avoid on FourVault, effort S.

### Age-signal plugins for FourVault's COPPA flow

- `@capgo/capacitor-age-range` (Apple DeclaredAgeRange / Play Age Signals) is a genuine
  MISSED OPPORTUNITY specifically for FourVault: it is a platform-native signal source that could
  strengthen the verifiable-parental-consent (VPC) gate without FourVault having to build its own
  age-attestation UX from scratch, and unlike the analytics plugins above it is squarely
  COPPA-compliance-shaped rather than COPPA-risk-shaped. Call: spike, target = FourVault's VPC
  flow, effort M (needs product/compliance review since it touches the actual consent gate, not
  just cosmetics), win = a lighter, more defensible parental-gate implementation for a kid app
  that is currently one of the fleet's more compliance-exposed surfaces.

### Firebase plugin family

- `@capgo/capacitor-firebase-*` (analytics/app/app-check/authentication/crashlytics/firestore/
  functions/messaging/performance/remote-config/storage) maps directly onto Companion's pinned
  stack (Firebase Auth + Identity Platform, Firestore, Cloud Storage for Firebase). Companion is
  presumably using the OFFICIAL Firebase JS SDK directly today rather than these Capacitor-native
  wrappers; the Capgo Firebase family would give NATIVE (not WebView-bridged) Firebase behavior,
  which matters for background push reliability and Crashlytics native crash capture (Sentry is
  Companion's stated crash tool today, so `-crashlytics` specifically is a redundant-vendor risk,
  skip that one). `-app-check` (App Check / attestation) is the standout: it is a real anti-abuse
  hardening layer Companion currently has no equivalent for. Call: spike `-app-check` for
  Companion, effort M, target = Companion backend abuse-resistance (protects the Fastify backend
  that mints ephemeral Gemini Live tokens from being hit by a non-genuine client). Skip the rest
  of the family unless a specific native-reliability bug shows up (e.g. background push
  delivery issues on Companion that the JS SDK can't fix).

### Calling/comms plugins as a NEW Companion feature

- `@capgo/capacitor-twilio-video`, `-stream-call` (getstream.io), `-realtimekit` (Cloudflare
  Calls) are candidate building blocks for a feature nobody has proposed: FAMILY VIDEO CALLING
  inside Companion, adjacent to its existing family photo/video feed and daily check-in. This is
  a genuinely new premium surface (not currently on Companion's three-pillar roadmap, which stops
  at async voice cloning) that would deepen the "one less call to the adult child" pitch into
  "the one place the family actually talks," directly strengthening retention and the
  Family/Legacy tier's justification for its price. Call: this is a MISSED OPPORTUNITY worth a
  product spike, not an engineering spike, effort L (new pillar, new privacy/consent surface,
  new pricing-tier justification work), target = Companion pillar 2 (family layer) roadmap.
  Flagging it here because it is a genuinely non-obvious cross-catalog find, not because it is
  cheap.

### Storage plugins

- `@capgo/capacitor-fast-sql` is a candidate replacement for Companion's
  `@capacitor-community/sqlite` + SQLCipher offline store; the stated rationale (local HTTP
  transport avoids bridge serialization, better for large result sets and sync-heavy writes) is
  plausible but Companion's current stack already works and is explicitly pinned in its CLAUDE.md
  ("Tech stack (pinned)"). Call: skip for now, do not destabilize a pinned, working stack for a
  performance claim that hasn't been measured against Companion's actual offline-cache size.
  Worth a spike ONLY if Companion's offline sync is later found to be a real bottleneck.

## 6. capacitor-security (capsec) -- highest-leverage single item in this slice

`npx capsec scan` is a ready-made, CI-gateable static scanner covering 63+ rules across secrets,
storage, network, Capacitor-specific config, Android, iOS, auth, WebView, crypto, and logging,
each rule mapping to a concrete before/after fix.

- The fleet currently enforces security posture through hand-written, per-app greps: iHEARtest's
  compliance-token grep (banned PHI strings in www/js/), MedReview's PHI scrubber tests and
  `console.log` ban, Companion's analytics-property allowlist. These are all real but they are
  each BESPOKE and each cover only the one thing that app's team happened to think of. capsec is
  the generic superset: SEC001 (hardcoded secrets) is literally the fleet's own unwaivable law #1
  ("never commit a secret VALUE into any repo") turned into an automated CI gate instead of a
  policy sentence; STO006/AUTH006 map to Secret Manager discipline; NET001/AND001/IOS001
  (cleartext/ATS) map to the HTTPS-only posture every app CLAUDE.md assumes but none actually
  greps for; LOG001/LOG002 map almost verbatim onto MedReview's "no console.log of PHI-adjacent
  variables, ever" rule and Companion's "never pass photo content, message text, PII into an
  analytics event" rule, again turning prose into an automated check; IOS008 (screenshots not
  disabled on sensitive screens) is the same gap flagged under capacitor-plugins above
  (@capacitor/privacy-screen).
- The single most TIME-SENSITIVE rule here is CAP009 (live-update security): the fleet's Capgo
  OTA channels were just wired across ALL 8 apps this cycle, with no stated review of the
  live-update CONFIG itself (signing, channel scoping, who can push a bundle) against a security
  rubric. capsec is a ready-made way to check that rollout rather than trusting it was configured
  correctly by convention. Call: adopt-now, urgent, effort S (one CLI run per repo), target =
  every app that just got Capgo OTA.
- Recommended integration point: wire `npx capsec scan --ci` into every app's existing CI
  (web-ci.yml for iHEARtest/AWARE/InnerEase-once-it-scaffolds, the monorepo gate for
  Flatstick/FourVault, MedReview's `pnpm verify`) as an ADDITIONAL gate alongside compliance
  greps and PHI scrubber tests, not a replacement for them (the bespoke greps still catch
  domain-specific strings capsec's generic rules can't know about, like "hearing_number"). This
  is a template-level change: bake it into the app-template scaffolder once and it defaults ON
  for every future app, which is the actual factory-throughput win, security review stops being a
  manual guardian-agent pass and becomes a CI gate every PR already has to clear. Call:
  adopt-now, effort M (one script + CI wiring per repo, S per repo once the template pattern
  exists), target = app-template scaffolder + retrofit onto all 9 existing repos (8 consumer apps
  + MedReview). This is my single highest-conviction finding in the whole slice.
- Root/jailbreak detection (`@capgo/capacitor-is-root`) with a warn/restrict/block response
  strategy is a natural pairing for MedReview (PHI-adjacent trust posture) and for any app
  handling payment-adjacent flows even if money itself never touches the client (Flatstick's
  "never holds or escrows money" framing still benefits from knowing the device isn't
  compromised, since bet totals and settlement math live there). Call: adopt-later, target =
  MedReview first, Flatstick second, effort S per app.

## 7. capacitor-testing

A full testing-pyramid reference: Vitest unit + Capacitor-plugin mocking, RTL/Vue-Test-Utils
component tests, Playwright multi-device E2E, Appium/WebdriverIO and Detox NATIVE E2E
(biometric-simulation via `driver.touchId()`/`driver.fingerPrint()`), XCTest/JUnit native unit
tests, and a 4-job CI template.

- Most of the WEB-LAYER half of this pyramid is already implemented independently, ad hoc, per
  app: iHEARtest (Vitest, Stop-hook gate), Flatstick (`pnpm -r test` across shared/api/web,
  ~471 tests total), MedReview (the fullest pyramid: Vitest unit, Vitest+Supertest+Neon-branch
  integration, RTL+axe-core component, Playwright E2E nightly). GAP: none of them appear to use
  this skill's specific `vi.mock('@capacitor/core', ...)` PATTERN for platform-conditional plugin
  testing (`mockPlatform()`/`mockPluginAvailable()` helpers); each app is presumably hand-rolling
  its own mocks per test file. Call: adopt-now as a shared test-utility, target = app-template
  scaffolder ships a `test/mocks/capacitor.ts` helper by default so every new app's test suite
  starts with correct Capacitor plugin mocking instead of each team re-deriving it, effort S.
- The NATIVE E2E half (Appium/WebdriverIO, Detox, XCTest, native JUnit) is a genuine, real GAP:
  no fleet app CLAUDE.md mentions any native-layer E2E test, everything stops at web-layer Vitest
  and (for iHEARtest) boot-gate Playwright smoke tests. Given "no Mac, cloud-only, TestFlight is
  the only device-truth channel" is a standing fleet constraint, native E2E on Depot macOS
  runners (which DO have simulators) is actually achievable without a physical device for a
  meaningful subset of bugs (though the fleet's own documented device-only bug classes,
  AVAudioSession/AirPods routing/silent switch, still need a physical device and stay
  TestFlight-only). Call: spike, target = MedReview mobile V1.1 (the app explicitly planning a
  Capacitor wrap next) as the pilot, since it already has the most mature test discipline and the
  most to lose from an auth/biometric regression; effort M (a Depot-runner Appium job against
  the iOS Simulator, no physical device needed for the login/biometric-shim class of test). Not
  adopt-now fleet-wide because it is a real new CI cost (Depot macOS minutes, already flagged as
  the fleet's scarcest CI resource) and should prove out on one app first.
- The biometric E2E simulation pattern (`driver.touchId()`) is the concrete unlock for actually
  testing the `@capgo/capacitor-native-biometric` adoptions flagged under capacitor-plugins above
  (Companion, MedReview) without needing a human on a physical device for every regression check.
  Ties the testing gap directly to the plugin opportunity above; recommend sequencing them
  together if either is picked up.

## 8. debugging-capacitor + 9. ios-android-logs (grouped: both are the device-debugging half of
   the capacitor-quality bundle, and they attack the exact same fleet bottleneck)

What they are: structured references for WebView debugging (Safari Web Inspector / Chrome
DevTools remote debug), native debugging (Xcode/LLDB, Android Studio debugger), and device log
streaming (`xcrun devicectl device log stream`, `xcrun simctl spawn booted log stream`,
`adb logcat`), plus crash-log retrieval commands for both platforms.

- This is the single most FACTORY-THROUGHPUT-relevant pair of skills in the whole slice, because
  the fleet's own standing constraint is explicit and repeated across CLAUDE.md files: "the
  operator has NO Mac," "iOS builds and App Store submission are cloud-only," and multiple apps
  independently document that a specific bug CLASS (AVAudioSession routing, AirPods/Bluetooth
  audio, Web Audio unlock on screen-lock, silent-switch behavior) "can only be verified on
  Mark's/Matt's TestFlight device." Today the loop for a device-only bug is: App Lead ships a
  build, a human runs it on their physical iPhone, describes what they see in natural language,
  and an agent guesses at root cause from that description. That is slow and lossy.
- GAP/missed-opportunity: nothing in the fleet's tooling currently formalizes "capture a
  structured device log and hand it to the agent" as a repeatable step. `xcrun devicectl device
  log stream --device <UUID> --predicate 'process == "AppName"'` (works from ANY machine with
  Xcode command-line tools, and Depot macOS runners already have Xcode) plus
  `xcrun devicectl device copy crashlog` for the crash-report path are both things that could run
  EITHER from a short-lived Depot macOS job triggered against a physical device paired over the
  network, OR be codified as a five-line "Matt, run this on your Mac-less Windows box via
  <specific tool>" instruction that captures a real predicate-filtered log instead of a
  screen-recording-and-description loop. Given the operator has no Mac at all, the more realistic
  version of this is: a documented `adb logcat`-equivalent recipe is moot for iOS (no adb), so
  the actual unlock is either (a) a short Depot macOS job that pairs with a physical device over
  network debugging and pulls `devicectl` logs/crashlogs into an artifact the CTO/App-Lead
  session can then read directly, or (b) at minimum, standardizing the OPERATOR-SIDE steps (which
  device settings to enable, which Console.app filters to use, how to export a `.crash` file) so
  Matt's device-bug reports come back as an attached log file instead of prose. Call: this is a
  genuine MISSED OPPORTUNITY, not a "just read the doc" item, because the fleet has repeatedly
  hit this exact wall (AVAudioSession bugs are called out in THREE separate app CLAUDE.md files
  as device-only-diagnosable) without ever building the log-capture tooling to make that diagnosis
  fast. Effort M (needs an actual script/skill, `device-log-capture`, wrapping `devicectl`
  commands and crash-log retrieval, callable from a Depot job or documented for Matt to run),
  win = collapses the slowest debugging loop in the entire fleet (device-only iOS bugs) from
  "describe what you saw" to "here is the filtered log," which is exactly a factory-throughput
  win because these are the bugs that currently block a build from shipping the longest.
- The remote WebView debugging setup (`ios.webContentsDebuggingEnabled: true` in
  capacitor.config, Safari Develop menu, `chrome://inspect` for Android) is a one-line config flag
  most fleet apps likely already have in dev builds but should be VERIFIED disabled (or gated
  behind a build flag) in production per-app, since leaving WebView debugging on in a shipped
  build is itself a minor attack-surface item (also flagged as CAP001 in capsec above -- these
  two skills reinforce each other's finding). Call: adopt-now as a one-line CI check (folds into
  the capsec CAP001 gate rather than needing separate tooling), effort S.
- The MCP-integration section in ios-android-logs is explicitly illustrative/non-shipped
  (`mcp.ios.streamLogs(...)` is a conceptual snippet, not a real API), so there is nothing to
  adopt there directly, but it is a useful SHAPE reference if the fleet ever builds the
  device-log-capture tooling above as a proper skill with an MCP-style interface.

## Meta: the marketplace's own plugin bundling (relevant to "the dev + quality skill families")

The Capgo marketplace ships 11 themed Claude Code PLUGINS, each bundling a subset of the 49
skills, installable in one command (`claude plugin install <name>@capgo-skills` after
`claude plugin marketplace add Cap-go/capgo-skills`). The one that maps exactly onto this
report's slice is `capacitor-quality` (bundles capacitor-accessibility, capacitor-performance,
capacitor-security, capacitor-testing, debugging-capacitor, ios-android-logs) and its neighbor
`capacitor-core` (capacitor-best-practices, capacitor-mcp, capacitor-plugins).

- MISSED OPPORTUNITY at the distribution layer, not the content layer: instead of the CTO/
  Developer hand-porting individual pieces of this report into app-template or per-app CLAUDE.md
  files, the fleet could install the `capacitor-quality` plugin (and selectively `capacitor-core`
  for the plugin-catalog + best-practices half, skipping capacitor-mcp per the skip call above)
  directly as a marketplace plugin on every app-repo Claude Code session (or centrally, if the
  session tooling supports repo-scoped plugin installs the way it supports repo-scoped skills).
  That would make every builder/qa/guardian session working in any of the 8 app repos + MedReview
  automatically security/testing/accessibility/performance/debugging literate, without the CTO
  manually curating and re-explaining each finding above as a bespoke fleet skill. This is the
  single highest-leverage "structural" move available in this slice: it converts a one-time
  research report into a standing, auto-updating capability (the marketplace skill pack has its
  own versioning tied to Capacitor major versions, so it stays current without fleet
  maintenance). Call: adopt-now, effort S (one marketplace-add + one plugin-install command,
  though it should be piloted on one repo first to confirm no collision with existing fleet
  skills of similar names before a fleet-wide rollout), target = app-template scaffolder default
  install list + a note in claude-tools CLAUDE.md's session-start flow. This is a distinct,
  higher-leverage recommendation than "adopt capsec" or "adopt the a11y gate" individually,
  because it adopts the WHOLE quality bundle as a maintained unit in one move instead of the
  fleet re-authoring nine bespoke internal skills that would then silently drift from upstream.
- Caveat/anti-pattern risk to flag alongside the recommendation: the marketplace's own README
  and CLAUDE.md are out of sync (CLAUDE.md covers only ~13 of 49 skills, is stale), and the
  lint script's byte-for-byte mirror check only actually verifies ONE hardcoded skill pair
  (capgo-native-builds) rather than diffing every plugin copy against its canonical skill copy.
  This means a fleet session that only reads the marketplace's own CLAUDE.md would get an
  incomplete picture, and the ecosystem's own internal QA is thinner than it presents. Not a
  reason to avoid adoption, but a reason to treat this as a well-packaged third-party dependency
  to monitor, not an infallible source of truth, and to periodically re-verify (same caution this
  report gives capsec's own rule count and the Apple-guideline reference material, which tracks
  live policy and needs re-verification over time).
- The `skill-creator` skill's self-grading pattern (a `skillgrade` eval with a deterministic JS
  grader checking frontmatter/name/description/section-presence, run against a known-bad fixture)
  is a genuinely good practice the fleet's OWN skill-authoring discipline (the fleet has its own
  `skill-creator` skill, and is actively authoring many bespoke skills per the CLAUDE.md history:
  agent-evals, browser-agent, company-brain, etc.) could adopt to catch quality regressions in
  fleet skills the same way `agent-evals`' LLM-judge catches quality regressions in agent
  OUTPUT. Call: adopt-later, target = the fleet's own skill-creator + the toolkit test gate
  (`run-tests.sh`, `tests/frontmatter.test.mjs`) which ALREADY enforces frontmatter presence
  (87/87, per the fleet's own dated notes) but does not yet run a deterministic content-quality
  grader the way this pattern demonstrates. Effort S, since the fleet's frontmatter test already
  proves the harness exists, this is "add one more deterministic check," not new infrastructure.

---

## Top missed opportunities in this slice

1. **HealthKit AirPods audiogram cross-validation for iHEARtest** (`@capgo/capacitor-health`).
   Turns an idea that has only ever appeared as a one-line dogfood note into iHEARtest's most
   defensible differentiator: cross-validating the in-app hearing screen against Apple's own
   clinical-grade AirPods Pro hearing test, something no competing consumer hearing-screening app
   is positioned to build as cheaply, since the compliance posture (category-band-only data
   leaving device) already exists.
2. **Install the `capacitor-quality` (+ curated `capacitor-core`) marketplace plugin as a
   standing, versioned capability on every app-repo session** instead of hand-porting this
   report's findings into nine bespoke internal skills. Converts a one-time research pass into an
   auto-maintained fleet capability and is the single highest-leverage "factory throughput" move
   in the whole slice, it compounds across every future app built off the template.
3. **A `device-log-capture` skill/script wrapping `xcrun devicectl` log streaming and crash-log
   retrieval**, to collapse the fleet's single slowest debugging loop (device-only iOS bugs:
   AVAudioSession, AirPods routing, Web Audio unlock, silent switch) from "operator describes
   what they saw" into "here is the filtered structured log," directly attacking the "no Mac, no
   local Xcode, TestFlight is the only device truth channel" constraint that every consumer app's
   CLAUDE.md independently complains about.

---

## Anti-patterns / hard-constraint conflicts

- **Analytics/attribution plugin family** (`@capgo/capacitor-appinsights`, `-appsflyer`,
  `-contentsquare`, `-facebook-analytics`, `-gtm`, `-rudderstack`): conflicts with both the
  fleet's PostHog-primary/Sentry-secondary observability decision (a fourth analytics vendor per
  app is fragmentation, not value) and, on FourVault specifically, its explicit COPPA rule
  banning third-party analytics on kid screens. Avoid outright on FourVault; skip elsewhere
  unless a specific, named gap in PostHog coverage justifies one.
- **`@capgo/capacitor-fast-sql` as a forced migration off Companion's pinned
  `@capacitor-community/sqlite` + SQLCipher stack**: the plugin's performance claims are real in
  the abstract but Companion's storage layer is explicitly PINNED in its CLAUDE.md and currently
  working; swapping it without a measured bottleneck is unnecessary churn on a stack that already
  meets its own stated bar. Only revisit if a real offline-sync performance problem surfaces.
- **`@capacitor/watch` (official) vs `@capgo/capacitor-watch` (Capgo) name collision**: neither
  is what Flatstick actually used to ship its Watch app (a hand-rolled Xcode-injection approach),
  and grabbing either package by name-similarity alone risks re-deriving work Flatstick already
  solved the hard way, or picking the wrong package for the wrong job (declarative watch UI vs.
  bidirectional messaging are different problems). Document the distinction once rather than
  re-discovering it per app.
- **capacitor-mcp (`awesome-ionic-mcp`, third-party)** as a standing connector: conflicts with
  the fleet's stated MCP-vs-skill routing policy (first-party/gateway preferred over scattered
  third-party MCP servers) and needs an unauthenticated GitHub call burst at init that will
  self-rate-limit without extra plumbing. Not worth the standing connector slot given the
  gateway and company-brain already centralize documentation retrieval more safely.
- **Boundary note (not fully in this slice, flagging for awareness):** the `capgo-cloud` plugin
  bundle (out of this report's scope) includes `capgo-native-builds`, a Capgo-hosted native
  cloud-build option. That directly conflicts with the fleet's hardened, Matt-directed policy
  that Depot macOS GitHub Actions is the EXCLUSIVE iOS build path fleet-wide (Codemagic is fully
  retired precisely because the fleet consolidated onto one build path). Any session evaluating
  the `capgo-cloud` bundle should adopt the OTA/CLI/organization-management pieces only and
  explicitly skip the native-build piece; noting this here since it borders my slice's CI/quality
  territory even though the skill itself sits in another report.

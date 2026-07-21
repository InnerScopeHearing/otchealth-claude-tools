# Capgo Skills Marketplace Inventory, Part A (capacitor-* through capgo-*)

Date: 2026-07-21

Source: locally cloned Cap-go/capgo-skills marketplace at
`/root/.claude/plugins/marketplaces/capgo-skills/skills/` (installed under
`/root/.claude/plugins/marketplaces/capgo-skills/`). Every SKILL.md in this half was
read in full, plus every reference file that exists under the two skills that ship
references (`capacitor-apple-review-preflight/references/` and
`capacitor-plugins/references/`).

Scope of this report: the FIRST HALF of the marketplace alphabetically, defined per
task instructions as everything from `capacitor-accessibility` through
`capgo-release-workflows` (34 of the 49 total skill directories in the marketplace).
The second half (`cocoapods-to-spm` through `webapp-to-capacitor`, 15 skills) is out
of scope for this report.

Full directory listing captured at inventory time (alphabetical, 49 entries total):
capacitor-accessibility, capacitor-app-store, capacitor-app-upgrade-v4-to-v5,
capacitor-app-upgrade-v5-to-v6, capacitor-app-upgrade-v6-to-v7,
capacitor-app-upgrade-v7-to-v8, capacitor-app-upgrades,
capacitor-apple-review-preflight, capacitor-best-practices, capacitor-ci-cd,
capacitor-deep-linking, capacitor-keyboard, capacitor-mcp, capacitor-offline-first,
capacitor-performance, capacitor-plugin-spm-support,
capacitor-plugin-upgrade-v4-to-v5, capacitor-plugin-upgrade-v5-to-v6,
capacitor-plugin-upgrade-v6-to-v7, capacitor-plugin-upgrade-v7-to-v8,
capacitor-plugin-upgrades, capacitor-plugins, capacitor-push-notifications,
capacitor-security, capacitor-splash-screen, capacitor-testing,
capawesome-live-update-migration, capgo-cli-usage, capgo-cloud,
capgo-live-updates, capgo-native-builds, capgo-organization-management,
capgo-release-management, capgo-release-workflows, cocoapods-to-spm,
cordova-to-capacitor, debugging-capacitor, framework-to-capacitor,
ionic-appflow-migration, ionic-design, ionic-enterprise-sdk-migration,
ios-android-logs, konsta-ui, safe-area-handling, skill-creator,
sqlite-to-fast-sql, subscription-app-revenue, tailwind-capacitor,
webapp-to-capacitor.

Fleet context this report was written against: OTCHealth Inc.'s 8-app Capacitor
fleet (iHEARtest, AWARE, Companion, FourVault, Flatstick, InnerEase, Fictionary,
PlantID), all iOS-first, all built on Depot macOS CI (`depot-macos-26` runner,
dispatch-only `ios-depot.yml` workflows, CTO-only build/TestFlight dispatch), and
all just wired with signed Capgo OTA channels under a Capgo org named "OTCHealth
Inc." Plus the exec AI agent roster (CTO/CFO/COO/CRO/CLO/Developer).

---

## 1. capacitor-accessibility

**Frontmatter description/trigger:** "Accessibility guide for Capacitor apps
covering screen readers, semantic HTML, focus management, and WCAG compliance. Use
this skill when users need to make their app accessible."

**What it teaches:** A generic accessibility checklist and code-pattern reference
for Capacitor/Ionic web-layer apps: semantic HTML, alt text, 44x44pt minimum touch
targets, 4.5:1 color contrast, focus indicators, screen-reader labels, keyboard
navigation. Gives copy-paste TSX snippets for ARIA labels/hints, `aria-live`
regions (polite vs assertive/alert), focus-trap implementation for modals, and
native accessibility hookups: iOS (`isAccessibilityElement`, `accessibilityLabel`,
`accessibilityHint`, `accessibilityTraits` in Swift) and Android
(`ViewCompat.setAccessibilityDelegate` / `AccessibilityNodeInfoCompat` in Kotlin).
Testing section: enable VoiceOver in iOS Simulator, TalkBack on Android, and
`npx @axe-core/cli` for web.

**Key commands/APIs:** No CLI tool of its own; it's a pattern/snippet reference.
`npx @axe-core/cli <url>` for automated web a11y scanning.

**Version constraints:** None stated (framework-agnostic guidance, not
Capacitor-major-version-pinned).

**Fleet relevance:** Directly applicable to AWARE (explicit "senior-first
accessibility HARD requirement," 1.5x text scale, axe-core gate work already
tracked in the parent fleet's task list as "Wave 5: axe-core a11y gate in
boot-gate CI") and to Companion (WCAG AAA body-text contrast, 64x64pt touch
targets, VoiceOver/TalkBack labels are non-negotiable rules in Companion's
CLAUDE.md). Also relevant to MedReview's senior UX constraint (18-28pt fonts,
48-64px tap targets, axe-core in Vitest / Pa11y in CI / Lighthouse CI a11y >=0.95)
even though MedReview is a different framework (React SPA, not necessarily
Capacitor at V1). The 44x44pt native touch-target guidance and iOS/Android native
accessibility trait snippets are useful for any Developer-agent work polishing
native screens across the fleet.

---

## 2. capacitor-app-store

**Frontmatter description/trigger:** "Complete guide to publishing Capacitor apps
to Apple App Store and Google Play Store. Covers app preparation, screenshots,
metadata, review guidelines, and submission process. Use this skill when users are
ready to publish their app."

**What it teaches/automates:** End-to-end store submission checklist and
reference tables: universal requirements (icons, splash, bundle ID, version/build
numbers, privacy policy, ToS, support contact, age rating, description,
screenshots), iOS-specific (Apple Developer Program $99/yr, ASC app record,
signing certs/profiles, Info.plist usage-description keys, App Tracking
Transparency, Sign in with Apple, export compliance), Android-specific (Play
Developer account $25 one-time, release keystore signing, API 34+ target SDK,
64-bit ABI support, permissions, Data Safety form, content rating). Gives exact
Info.plist keys (`CFBundleDisplayName`, `CFBundleShortVersionString`,
`CFBundleVersion`, `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`,
`NSLocationWhenInUseUsageDescription`, `NSFaceIDUsageDescription`,
`NSMicrophoneUsageDescription`, `NSUserTrackingUsageDescription`,
`ITSAppUsesNonExemptEncryption`) and Android `build.gradle` config
(`applicationId`, `minSdkVersion 22`, `targetSdkVersion 34`, `versionCode`,
`versionName`, NDK `abiFilters`, `minifyEnabled`/`shrinkResources`, App Bundle
language/density/abi splits). Full icon-size tables for both platforms (iOS 20pt
to 1024pt at 1x-3x; Android mdpi-xxxhdpi + adaptive icon + 512x512 Play icon).
Screenshot size tables (iPhone 6.7"/6.5"/5.5", iPad Pro 12.9"/11"; Android phone
1080x1920-1080x2400, 7"/10" tablet, 1024x500 feature graphic). Playwright
screenshot-automation snippet iterating device viewports. Full App Store Connect
submission walkthrough (create app -> app info -> pricing/availability -> app
privacy data-collection categories -> version info -> build upload via Xcode /
Fastlane / `xcrun altool --upload-app --type ios --file App.ipa --apiKey KEY_ID
--apiIssuer ISSUER_ID` -> submit for review). Full Google Play Console walkthrough
(create app -> store listing -> content rating -> target audience -> Data Safety ->
app content -> release via `./gradlew bundleRelease` -> release tracks table:
internal/closed/open/production). Common rejection-reason tables for both stores
(iOS: crashes, broken links, incomplete metadata, missing privacy info, login/demo
issues, Guideline 4.2 minimum functionality, Guideline 5.1.1 data collection;
Android: crashes/ANRs, policy violations, deceptive behavior, sensitive
permissions, low target SDK). Version-increment commands (`npm version
patch/minor/major`) and phased-rollout guidance (iOS 7-day 1%->100% ramp; Android
rollout-percentage + crash-rate monitoring).

**Key commands/APIs:** `npx capacitor-assets generate --iconBackgroundColor
'#ffffff'`, `fastlane ios release`, `xcrun altool --upload-app`, `./gradlew
bundleRelease`, `npm version <patch|minor|major>`.

**Version constraints:** Targets current-era store requirements (API 34+ Android
target SDK, 64-bit-only). No Capacitor major-version pin; store-submission
mechanics are largely version-agnostic.

**Fleet relevance:** Every one of the 8 apps eventually needs this (ASC app
records, icon/screenshot generation, Info.plist usage-string discipline, the
exact `ITSAppUsesNonExemptEncryption` flag the CTO's org already manages via the
`asc-api` skill). Overlaps heavily with the fleet's existing `asc-api` skill and
`aso-growth` skill; this generic skill is a reasonable fallback/checklist cross-
reference but the fleet's own asc-api skill (built on the newer 4.4.1 ASC resource
model) is more current and should be preferred for actual API calls. Useful as a
plain-English pre-submission checklist for App Leads before escalating
"ready-to-build" to the CTO.

---

## 3-6. capacitor-app-upgrade-v4-to-v5 / v5-to-v6 / v6-to-v7 / v7-to-v8

These four skills are near-identical single-purpose migration guides, one per
major-version jump, so they're grouped here.

**Frontmatter descriptions:** Each says "Guides the agent through upgrading a
Capacitor app from vN to vN+1. Use when the project is on Capacitor N and needs
the vN+1 migration path. Do not use for other major versions, plugin-only
upgrades, or non-Capacitor apps." (name/version numbers substituted per skill).

**What they teach/automate:** Each is short (36-39 lines) and follows an
identical template: a "Live Project Snapshot" section that runs an injected
`!`node -e ...`` shell snippet at skill-load time to parse `package.json` and list
every installed `@capacitor/*` package + version from `dependencies` and
`devDependencies`; then a numbered procedure: (1) confirm current
`@capacitor/core` version from the snapshot, (2) update all `@capacitor/*`
packages to the vN+1-compatible range, (3) review the official vN-to-vN+1
migration notes before touching native files, (4) `npm install`, (5) `npx cap
sync`, (6) verify iOS and Android builds. Error-handling notes are version-
specific: v4->v5 and v5->v6 flag "check the deployment target and Xcode
compatibility" / "check the Gradle and Java requirements" for iOS/Android
respectively; v6->v7 and v7->v8 use the same pattern.

**Key commands/APIs:** `npm install`, `npx cap sync`. The `allowed-tools`
frontmatter field restricts each skill's own shell access: v4-to-v5 and v7-to-v8
allow only `Bash(node -e *)`; v5-to-v6 and v6-to-v7 additionally allow `Bash(npm
*)` and `Bash(npx cap *)` (an inconsistency worth noting: v4-to-v5 and v7-to-v8
can inspect but not actually run the upgrade commands they instruct, unlike the
other two).

**Version constraints:** Each is hard-scoped to exactly one major jump (4->5,
5->6, 6->7, 7->8) and explicitly says not to use it for other jumps or for
plugin-only (as opposed to app-project) upgrades.

**Fleet relevance:** Flatstick's CLAUDE.md explicitly notes "Capacitor 8
migration in flight, PR #114" from a Capacitor 6 base, so `capacitor-app-upgrade-
v6-to-v7` then `capacitor-app-upgrade-v7-to-v8` (sequential, since the generic
`capacitor-app-upgrades` skill explicitly says never skip an intermediate major
version) are the exact right tools for that in-flight migration. iHEARtest is on
Capacitor 8 already (`capacitor-app-spm-migration` territory, per iHEARtest's
CLAUDE.md SPM defaults). Any fleet app still on Capacitor 6 or earlier (FourVault
pins "Capacitor 6+") would use the same sequential chain.

---

## 7. capacitor-app-upgrades

**Frontmatter description/trigger:** "Guides the agent through upgrading a
Capacitor app project to a newer major version. Covers multi-version jumps,
dependency alignment, native platform checks, and verification. Do not use for
plugin library upgrades or non-Capacitor mobile frameworks."

**What it teaches/automates:** The generalized, non-version-pinned counterpart to
skills 3-6 above: a 4-step procedure for jumping across MULTIPLE major versions.
Same live-snapshot mechanism (parses `package.json` for `@capacitor/*` entries)
plus a second injected `find` command that locates
`capacitor.config.{json,ts,js}` and the `ios/`/`android/` native folders. Step 1:
detect current version from the snapshot, and if the target version isn't
specified, explicitly ask the user to confirm an exact target major version
before proceeding (a decision-gate instruction). Step 2: upgrade ONE major
version at a time (never skip intermediate versions) -- for each hop: update
`@capacitor/*` versions, `npm install`, run the Capacitor migration flow if
available, `npx cap sync`, verify iOS/Android build cleanly before continuing;
if the automated migration only partially completes, apply changes manually and
finish that version before moving to the next. Step 3: review native-project
specifics per hop (iOS deployment target, Xcode compatibility, Android Gradle
Plugin + Java version, any plugin-specific native changes triggered by the new
major). Step 4: final verification via `npm install && npx cap sync && npx cap
run ios && npx cap run android`, plus any custom test/build pipeline the app has.

**Key commands/APIs:** `npm install`, `npx cap sync`, `npx cap run ios`, `npx
cap run android`. `allowed-tools`: `Bash(node -e *)`, `Bash(find *)`, `Bash(npm
*)`, `Bash(npx cap *)`.

**Version constraints:** None fixed -- this is the routing/umbrella skill meant
to be used for a multi-hop jump, delegating each individual hop conceptually to
the version-specific skills (3-6 above), though it doesn't explicitly say to
invoke them by name.

**Fleet relevance:** Same as skills 3-6: relevant to Flatstick's Capacitor
6->8 migration and any other app that needs to jump more than one major version
at once. This is the entry point an App Lead or the CTO/Developer identity would
reach for first when scoping a multi-hop upgrade, then possibly hand off hop-
by-hop to the specific vN-to-vN+1 skills.

---

## 8. capacitor-apple-review-preflight

**Frontmatter description/trigger:** "Guides the agent through an Apple App Store
preflight review for Capacitor apps before submission or after rejection. Covers
guideline checklist selection, App Store metadata review, Capacitor and iOS
project inspection, privacy manifests, Sign in with Apple, entitlements, and
common rejection patterns. Do not use for Google Play review, generic store
publishing only, or non-Apple mobile runtimes."

**What it teaches/automates:** A structured Apple App Store Review Guidelines
audit workflow, explicitly adapted from the upstream
`truongduy2611/app-store-preflight-skills` GitHub repo and narrowed to Capacitor
project inspection. This is the largest and most operationally significant skill
in this half of the marketplace, because it ships ~1,300 lines of reference
material (see below) alongside its 137-line SKILL.md.

Six-step procedure: (1) confirm scope is Apple-facing review, not general
publishing mechanics (delegate metadata/screenshot logistics to
`capacitor-app-store`); (2) identify app type and load the right checklist --
always read `references/guidelines/by-app-type/all_apps.md`, then add whichever
of `subscription_iap.md`, `social_ugc.md`, `kids.md`, `health_fitness.md`,
`games.md`, `ai_apps.md`, `crypto_finance.md`, `vpn.md`, `macos.md` matches the
app, with `references/guidelines/README.md` as the full guideline-section index
for looking up a specific cited rejection guideline number; (3) inspect Capacitor
+ iOS project state (package.json for Capacitor/auth/analytics/subscription SDKs,
`capacitor.config.*` for app id/name/live-update settings, `Info.plist`,
`*.entitlements`, `PrivacyInfo.xcprivacy`, `fastlane/metadata`), calling out
Capacitor-specific Apple review risks explicitly: social login without a Sign-in-
with-Apple equivalent, heavy WebView-only apps risking Guideline 4.2 minimum-
functionality rejection, third-party SDKs implying undeclared Required-Reason
APIs, native capabilities enabled in Xcode but not justified by shipped
functionality, and Capgo/Appflow/live-update flows needing clear reviewer notes
about what code can change post-review; (4) run rule-based review passes against
`references/rules/{metadata,subscription,privacy,design,entitlements}/*.md`,
optionally pulling live App Store Connect metadata via `asc metadata pull
--output-dir ./metadata` if the `asc` CLI is configured; (5) produce a structured
Markdown preflight report (Rejections Found / Warnings / Passed / Missing
Inputs, each citing the exact guideline number and file/metadata evidence); (6)
draft reviewer notes for demo accounts, hidden features, hardware dependencies,
subscription test flows, AI moderation, live-update behavior boundaries, and
justification for unusual entitlements/network behavior.

**Reference corpus read in full (this is the actual payload of the skill):**

- `references/guidelines/README.md` -- a complete indexed table of every Apple
  App Store Review Guideline section (1 Safety through 5 Legal), each row giving
  the guideline number, title, and one-line summary. Notable entries directly
  relevant to fleet apps: 1.4.1 Medical Apps (must disclose methodology, can't
  claim sensor-only diagnostics -- directly gates any hearing-test claim
  language in iHEARtest/AWARE/InnerEase and any clinical claim in MedReview);
  1.3 Kids Category (no external links/ads/third-party analytics without a
  parental gate -- directly gates FourVault); 3.1.2 Subscriptions (auto-renewal
  rules -- gates Companion's 5-tier ladder, Flatstick's 3-tier chat
  entitlements, AWARE's `pro` entitlement, PlantID's price-test products);
  4.8 Login Services (SIWA-equivalent requirement if social login offered);
  5.1.3 Health & Fitness (HealthKit data can't be used for ads, no false data
  writes); 5.1.4 Kids (COPPA/GDPR, no third-party analytics in Kids apps --
  directly matches FourVault's "no third-party analytics or ads on kid screens"
  rule); 5.4 VPN; 5.3 Gaming & Gambling (relevant to Flatstick's "never holds or
  escrows money" framing-as-scorekeeping-not-gambling posture).
- `references/guidelines/by-app-type/all_apps.md` -- universal pre-submission
  checklist covering completeness/demo accounts, metadata correctness (app name
  <=30 chars, no competitor-platform names, screenshots showing real app use, no
  Apple trademark confusion), privacy (in-app + ASC privacy policy link,
  consent, minimization, account-deletion-if-account-creation, ATT for cross-app
  tracking, `PrivacyInfo.xcprivacy` coverage), design/UX (not a copycat, more
  than a repackaged website, SIWA parity, public APIs only, IPv6 functionality,
  explicit consent before recording user activity), business (digital content
  through IAP, no forced ratings, support URL, verifiable developer identity).
- `by-app-type/subscription_iap.md` -- critical-will-reject list: IAP required
  for all digital unlocks (no license keys/QR/crypto), 7-day minimum
  subscription period working across all devices, billed amount must be the
  MOST prominent price element (not a derived monthly figure), functional ToS
  (EULA) and Privacy Policy links required in BOTH the app description and the
  purchase screen, loot-box odds disclosure, non-expiring purchased in-game
  currency, Restore Purchases mechanism, all IAP items visible/functional for
  the reviewer. Plus the required purchase-screen content list (title, period
  length, price, tappable PP link, tappable ToU link).
- `by-app-type/health_fitness.md` -- critical: medical apps must disclose
  accuracy methodology, CANNOT claim sensor-only diagnostics (x-ray, blood
  pressure, glucose, SpO2 via phone sensors alone), must remind users to consult
  a doctor, drug-dosage calculators must originate from an approved medical
  entity; HealthKit data may NEVER be used for advertising/marketing/data
  mining, no writing false HealthKit data, no storing personal health data in
  iCloud; health-research features need informed consent + independent ethics
  review board approval. Important: privacy policy must describe health-data
  handling explicitly; if regulatory clearance (FDA etc.) exists, submit proof
  with the app; healthcare apps should submit as a legal entity not an
  individual developer; no targeted ads based on HealthKit data.
- `by-app-type/kids.md` -- critical: no external links or purchases without a
  parental gate, no third-party ads, no third-party analytics (very narrow
  carve-outs: no IDFA, no PII, no location), COPPA/GDPR compliance, no sending
  PII/device info to third parties, privacy policy required in-app and in ASC.
  Important: "For Kids"/"For Children" metadata language is reserved for apps
  actually in the Kids Category; once in Kids Category, EVERY subsequent update
  must keep meeting the guidelines; contextual (non-behavioral) ads from
  services with documented Kids policies + human review are the only allowed ad
  exception; no ads anywhere in extensions/widgets/App Clips/keyboards/watchOS.
- `by-app-type/ai_apps.md` -- critical: China-storefront distribution requires
  stripping ALL references to OpenAI/ChatGPT/GPT/Gemini/Claude/Anthropic/
  Midjourney/DALL-E from metadata (all locales, not just zh-Hans) and either
  suppressing AI functionality or holding an MIIT license; no false/misleading
  AI-capability claims (e.g. "AI doctor"); AI health advice needs medical
  disclaimers and can't substitute for diagnosis; every AI feature must be
  documented in reviewer notes (no hidden AI capabilities). Important: don't use
  "GPT"/"ChatGPT"/"OpenAI"/"Gemini" in the app name unless you own the brand,
  don't keyword-stuff AI brand names, implement content moderation for
  AI-generated user-facing content, disclose AI data processing in the privacy
  policy, minimize data sent to AI models, explicit consent for AI processing of
  recordings/inputs, AI features/credits must be IAP-gated not externally paid.
  This is directly relevant to any fleet app using Vertex/Azure OpenAI-backed
  features (Companion's Gemini vision/voice assistant, MedReview's Vertex Gemini
  chat, PlantID's Gemini-Flash recognition).
- `by-app-type/social_ugc.md` -- content moderation filter, report/block
  mechanisms, published support contact, SIWA parity for social logins,
  account-deletion parity, functional core access without forced social login,
  in-app privacy policy; creator-content apps need age-gating for content
  exceeding the app's rating; explicit consent for recording (camera/mic/
  screen); ATT for cross-app tracking; no compiling PII from public/non-user
  sources; push notifications never required for core functionality and must be
  opt-in for marketing; NSFW web content must be hidden-by-default/opt-in-via-
  website-only; no Chatroulette-style random chat or hot-or-not voting.
  Relevant to Companion's family photo/video feed and any InnerEase/AWARE
  social/community feature.
- `by-app-type/crypto_finance.md` -- crypto wallets require organization (not
  individual) developer enrollment, no on-device mining, exchanges only where
  licensed, ICO/futures/crypto-securities trading only from established
  financial institutions, no crypto-for-task-completion rewards, no binary
  options trading, CFD/FOREX apps must be properly licensed, loan apps capped at
  36% APR with >60-day repayment and full term disclosure, banking/financial/
  crypto-exchange apps must submit as a legal entity; NFT ownership must never
  unlock app features/functionality; digital content still must go through IAP
  even when crypto/NFT-adjacent.
- `by-app-type/games.md` -- IAP for all currency/levels/premium content, loot-
  box odds disclosure, non-expiring purchased currency, Restore Purchases,
  no enemies solely targeting real races/cultures/governments/corporations,
  gambling/betting licensed per-jurisdiction, lottery apps only from lottery
  entities, honest age-rating answers, Apple TV must work with the Siri remote,
  ARKit games need a genuinely rich AR experience (not just model-dropping), no
  crypto mining even in background, no encouraging dangerous real-world bets,
  streaming-game subscriptions must avoid duplicate payment, don't strip
  previously-paid content when moving to a subscription model.
- `by-app-type/vpn.md` -- must use Apple's `NEVPNManager` API, must be an
  organization-enrolled developer, must not collect any user data, must not use
  VPN profiles for ad-blocking/traffic-redirect-monetization/data
  collection/sale, must clearly disclose data practices before any data access.
- `by-app-type/macos.md` -- Mac App Store sandboxing/entitlement-justification
  rules: appropriate sandboxing, entitlements must match real functionality
  (Apple will demand justification), Xcode-packaged with no third-party
  installer, no auto-launch-at-login without consent, no spawned background
  processes after quit, no auto-adding Dock/desktop icons, no downloading
  standalone code/kexts, no root/setuid requests, no license screens/keys/custom
  copy protection, updates only via the Mac App Store, must run on currently
  shipping OS (no deprecated tech like Java), single bundle for all
  localizations; includes an entitlements audit table
  (`com.apple.security.network.server`, `.network.client`,
  `.files.downloads.read-only`, `.files.user-selected.read-write`,
  `.temporary-exception.*`).
- `references/rules/design/minimum_functionality.md` (Guideline 4.2, REJECTION
  severity) -- deep dive on what triggers "the app is just a repackaged
  website" rejections: <3 unique screens, single-WebView-loading-external-URL
  as the primary experience, no local model/data layer, no offline
  functionality, only static/scroll content. Gives literal grep patterns to
  self-audit a Capacitor codebase (`grep -rn "WKWebView\|UIWebView\|WebView\|
  SFSafariViewController"`, view-controller counts, model-layer directory
  checks, persistence-library grep, `asc metadata pull` + word-count on the
  description). Resolution: add offline mode, push notifications, device
  integrations (camera/location/HealthKit), user-generated content, native UI
  patterns (swipe, drag-drop, widgets), or explain non-obvious value in
  reviewer notes. Includes the verbatim example Apple rejection text for
  Guideline 4.2.
- `references/rules/design/sign_in_with_apple.md` (Guideline 4.0, REJECTION) --
  the two classic SIWA violations: re-prompting for name/email that
  `ASAuthorizationAppleIDCredential` already supplied, and non-standard button
  styling (must use `ASAuthorizationAppleIDButton`); also flags not handling
  Apple's "Hide My Email" relay addresses (`*@privaterelay.appleid.com`). Gives
  grep patterns and a manual test protocol (sign in with Hide My Email, verify
  the app does NOT then ask for name/email).
- `references/rules/entitlements/unused_entitlements.md` (Guideline 2.4.5(i),
  REJECTION as an info-request that blocks review) -- Apple demands
  justification for any declared-but-unused entitlement; lists commonly flagged
  macOS entitlements and the iOS capabilities that silently add entitlements
  (Push -> `aps-environment`, HealthKit -> `com.apple.developer.healthkit`, SIWA
  -> `com.apple.developer.applesignin`, iCloud -> `com.apple.developer.icloud-*`).
  Gives the exact audit commands: `find . -name "*.entitlements"`, `plutil -p`
  or `cat` on each, `codesign -d --entitlements :- /path/to/App.app` on a built
  binary, plus per-capability grep to confirm actual code usage (e.g. is there
  really an `NWListener`/local server if `network.server` is declared).
- `references/rules/metadata/accurate_metadata.md` (Guideline 2.3.4, REJECTION)
  -- app PREVIEW VIDEOS (not static screenshots) must be pure screen-capture
  with no device frame/bezel; gives an `asc screenshots list` check and an
  `ffmpeg -i preview.mp4 -vframes 1` frame-extraction technique for automated
  visual audit.
- `references/rules/metadata/apple_trademark.md` (Guideline 5.2.5, REJECTION) --
  detailed banned-pattern list for app icon/name/screenshots (Apple device
  silhouettes, Apple logo variants, Apple product names in the app name like
  "iPhone Cleaner," generic "App Store" self-reference, unauthorized 3D device
  renders, Apple-device-next-to-competitor-device screenshots). Gives grep
  patterns against pulled metadata and concrete before/after rename examples.
- `references/rules/metadata/china_storefront.md` (Guideline 5, China DST
  regulation, REJECTION) -- the detailed version of the ai_apps.md summary:
  banned AI-brand terms for China distribution, three resolution options
  (strip terms and keep China; deselect China mainland in ASC availability;
  pursue an MIIT deep-synthesis-technology license), and the verbatim Apple
  rejection-letter template citing this exact issue.
- `references/rules/metadata/competitor_terms.md` (Guideline 2.3.1, REJECTION)
  -- banned competitor-platform terms (Android, Google Play, Samsung, Huawei,
  Amazon Appstore, Windows/Microsoft Store, APK, sideload) with grep patterns
  against pulled `asc` metadata, local fastlane metadata, and even the Xcode
  `project.pbxproj`.
- `references/rules/metadata/subscription_metadata.md` (Guideline 3.1.2,
  REJECTION) -- exhaustively lists what a subscription app's Store listing
  AND in-app purchase screen must both contain (title, length, price,
  functional Privacy Policy link, functional ToS/EULA link -- either linked in
  the App Description or via the ASC EULA field), with grep patterns to verify
  the description contains those links and a description-footer template
  (`Terms of Use: https://...` / `Privacy Policy: https://...`).
- `references/rules/privacy/privacy_manifest.md` (Guideline 5.1.1, Spring 2024
  Privacy Manifest requirement, REJECTION) -- the `PrivacyInfo.xcprivacy`
  Required-Reason-API requirement in full: the four Required Reason API
  categories (File Timestamp, User Defaults, System Boot Time, Disk Space) each
  with example reason codes (`DDA9.1`, `CA92.1`, `35F9.1`, `E174.1`), grep
  patterns to detect usage of each category in Swift/ObjC source, a note that
  third-party SDKs increasingly ship their own manifests (so this only needs to
  cover the app's OWN code), a minimal example manifest XML, and the Flutter-
  specific manifest path (`ios/Runner/PrivacyInfo.xcprivacy`).
- `references/rules/privacy/unnecessary_data.md` (Guideline 5.1.1, REJECTION)
  -- personal-data-must-be-optional-unless-core-to-function rule; flags phone
  number, gender, marital status, DOB, home address as commonly-over-required
  fields, with app-type-context examples (a fitness app CAN require gender for
  calorie math; a note app should NOT require phone number). Resolution:
  make non-essential fields optional/skippable, explain and opt-in for
  personalization data, reconcile the ASC App Privacy label with actual
  collection.
- `references/rules/subscription/misleading_pricing.md` (Guideline 3.1.2,
  REJECTION) -- the "calculated monthly price must not visually outrank the
  real billed amount" rule in detail (font size/weight/color/position
  hierarchy), with a checklist and the verbatim Apple rejection text. This maps
  directly onto every fleet subscription paywall (Companion's 5-tier pricing UI,
  Flatstick's chat-tier paywall, PlantID's two price-test products, AWARE's pro
  paywall) -- the billed total, not a derived per-month figure, must be the most
  visually prominent price on screen.
- `references/rules/subscription/missing_tos_pp.md` (Guideline 3.1.2,
  REJECTION) -- near-duplicate of subscription_metadata.md focused specifically
  on the missing-ToS/PP failure mode, with its own grep patterns targeting
  subscription/paywall/StoreKit/RevenueCat/Superwall source files for
  terms/privacy link presence.

**Key commands/APIs referenced:** `asc metadata pull --output-dir ./metadata`,
`asc screenshots list --app-id <id> --type previews`, `codesign -d
--entitlements :- App.app`, `plutil -p file.entitlements`, `ffmpeg` frame
extraction, assorted `grep -rn` patterns per rule file.

**Version constraints:** None Capacitor-version-specific; tracks live Apple
policy (Spring 2024 Privacy Manifest requirement, current China DST rules) so it
should be treated as needing periodic re-verification against Apple's live
guidelines page (the skill itself notes to use the upstream guidelines as
"source of truth").

**Fleet relevance:** This is one of the highest-value skills in this half of the
marketplace for the fleet, given the CTO's existing `asc-api` skill already does
mechanical ASC operations but nothing audits GUIDELINE COMPLIANCE before
submission. Directly actionable:
- Companion, Flatstick, AWARE, PlantID all have live subscription paywalls that
  should be checked against `subscription_iap.md` / `misleading_pricing.md` /
  `missing_tos_pp.md` / `subscription_metadata.md` before their next
  ASC submission.
- FourVault (COPPA, kid-facing) should be checked against `kids.md` before any
  Kids Category submission, and its "no third-party analytics on kid screens"
  rule maps 1:1 onto the guideline's third-party-analytics carve-out.
  its.
- Companion's Gemini-vision assistant and MedReview's Vertex Gemini chat map
  onto `ai_apps.md` (medical-disclaimer requirement for AI health advice; no
  false AI-capability claims; the China-storefront AI-brand-name strip if the
  fleet ever targets China).
- MedReview (once it ships mobile in V1.1/V1.2) is squarely `health_fitness.md`
  territory: the "no sensor-only diagnostic claims," "must remind to consult a
  doctor," and "HealthKit data never for ads" rules are all things MedReview's
  own CLAUDE.md already independently enforces (no personalized dosing, no
  diagnosis) -- this skill's checklist would be a useful pre-submission
  cross-check once MedReview goes mobile.
- The `unused_entitlements.md` and `privacy_manifest.md` audits are worth
  running against every fleet app's Depot-built IPA before a TestFlight
  external-tester rollout, since none of the fleet's iOS build docs mention a
  Privacy Manifest step today.
- The Sign-in-with-Apple checklist directly matters for Flatstick (which stores
  its own SIWA .p8 key per the CTO's CLAUDE.md) and any app offering social
  login without a SIWA-equivalent.

---

## 9. capacitor-best-practices

**Frontmatter description/trigger:** "Best practices for Capacitor app
development including project structure, plugin usage, performance optimization,
security, and deployment. Use this skill when reviewing Capacitor code, setting
up new projects, or optimizing existing apps."

**What it teaches:** A broad, code-example-heavy "how to not do it wrong"
reference across the whole Capacitor development lifecycle:
- Project structure: standard `src/android/ios/capacitor.config.ts` layout.
- Config: prefer `capacitor.config.ts` over `.json`; NEVER commit a dev-server
  URL/`cleartext:true` into a config that ships to production (uses a
  `process.env.NODE_ENV === 'development'` spread-guard pattern).
- Plugin install pattern: install -> `npx cap sync` -> (iOS) `pod install`, and
  the correct availability-check pattern before calling a native API (example:
  `NativeBiometric.isAvailable()` before `verifyIdentity()`).
- Performance: lazy-load plugins via dynamic `import()` instead of static
  imports at startup; enable WebView hardware acceleration
  (`android:hardwareAccelerated="true"`, `UIViewGroupOpacity=false` in
  Info.plist); batch bridge calls (one `Storage.set` with a JSON blob instead of
  N separate calls); camera quality/size caps (`quality:80`, `width:1024`,
  `resultType: Uri` not `Base64`).
- Security: use `@capgo/capacitor-native-biometric` secure storage instead of
  plain `@capacitor/preferences` for credentials; disable `cleartext` in
  production; root/jailbreak detection via `@capgo/capacitor-is-root`; iOS App
  Tracking Transparency via `@capgo/capacitor-app-tracking-transparency`.
- Error handling: always try/catch plugin calls and distinguish user-cancel
  from permission-denied from unexpected error (Camera example).
- Live Updates: `@capgo/capacitor-updater` usage pattern --
  `notifyAppReady()`, listen for `updateAvailable`, download in background,
  `set()` (not immediate reload) so the update applies on next natural
  restart rather than interrupting the active user session.
- Native project management: prefer Swift Package Manager over CocoaPods for
  iOS plugin dependencies; standard Android Gradle release config
  (`minifyEnabled`, ProGuard files).
- Testing: Jest mock pattern for a Capgo plugin; `Capacitor.isNativePlatform()`
  / `Capacitor.getPlatform()` platform-detection pattern.
- A pre-release deployment checklist (11 items: strip dev server URLs, enable
  ProGuard, set iOS deployment target, test on real devices not just
  simulators, verify permissions, test poor-network conditions, verify deep
  links, test backgrounding, verify push, test biometric edge cases).

**Key commands/APIs:** `npm install @capacitor/core@latest @capacitor/cli@latest
@capacitor/ios@latest @capacitor/android@latest`, `npx cap sync`, `pod install`.
References `@capgo/capacitor-native-biometric`, `@capgo/capacitor-is-root`,
`@capgo/capacitor-app-tracking-transparency`, `@capgo/capacitor-updater`,
`@capgo/capacitor-document-scanner` (as a lazy-load example).

**Version constraints:** General Capacitor 5-8 era guidance; no hard version
pin, but the "prefer SPM over CocoaPods" recommendation matches iHEARtest's
CLAUDE.md ("SPM is the default iOS package manager").

**Fleet relevance:** A good cross-cutting code-review rubric for the Developer
agent identity across all 8 app repos. The "never commit `cleartext:true`/dev
server URL to a config that ships" rule is exactly the kind of thing a
security-review pass should grep for fleet-wide. The Live-Update
background-download/apply-on-restart pattern is the correct pattern for the
fleet's newly-wired Capgo OTA channels (don't force-reload an active user). The
lazy-plugin-loading and bridge-call-batching performance advice is generically
useful for the heavier apps (Companion's Gemini Live/voice, PlantID's AI
vision).

---

## 10. capacitor-ci-cd

**Frontmatter description/trigger:** "Complete CI/CD guide for Capacitor apps
covering GitHub Actions, GitLab CI, build automation, app signing, and
deployment pipelines. Use this skill when users need to automate their build and
release process."

**What it teaches/automates:** A full generic reference CI/CD pipeline, GitHub
Actions primarily, with a GitLab CI equivalent and Fastlane setup. The GitHub
Actions example workflow chains: test (lint/typecheck/unit-test/coverage
upload) -> security (`npx capsec scan --ci`) -> build-web (`npm run build`,
upload artifact) -> build-ios (macos-latest runner; download web artifact; `npx
cap sync ios`; Ruby/CocoaPods setup; import P12 cert + provisioning profile from
base64-encoded GitHub secrets into a fresh keychain via `security
create-keychain`/`import`/`set-key-partition-list`; `xcodebuild archive`; `
xcodebuild -exportArchive`; upload IPA artifact) -> build-android
(ubuntu-latest; Java 17/Temurin; Android SDK setup; `npx cap sync android`;
decode base64 keystore; `./gradlew assembleRelease` and `./gradlew
bundleRelease` with injected signing properties; upload APK+AAB artifacts) ->
deploy-capgo (`npx @capgo/cli upload` gated on `main`, using `CAPGO_TOKEN`) ->
deploy-ios (`xcrun altool --upload-app` to ASC using API-key secrets, gated on
`main`) -> deploy-android (`r0adkll/upload-google-play@v1` action to the
`internal` track). A parallel Fastlane-driven workflow variant
(`.github/workflows/fastlane.yml`, tag-triggered) with full iOS Fastfile
(`match` readonly signing, `increment_build_number` using
`GITHUB_RUN_NUMBER`, `build_app`, `upload_to_testflight`) and Android Fastfile
(`increment_version_code`, `gradle bundle`, `upload_to_play_store` internal
track). A complete GitLab CI equivalent (`test`/`security`/`build-web`/
`build-ios` tagged `macos` runner/`build-android`/`deploy-capgo` stages).
Secrets table (10 required secrets: CERTIFICATE_P12, CERTIFICATE_PASSWORD,
PROVISIONING_PROFILE, KEYSTORE_BASE64, KEYSTORE_PASSWORD, KEY_ALIAS,
KEY_PASSWORD, CAPGO_TOKEN, APP_STORE_CONNECT_API_KEY, PLAY_SERVICE_ACCOUNT) plus
`base64 -i` encoding commands for cert/profile/keystore. Version-management
section: `semantic-release` config (`.releaserc.json` with
commit-analyzer/release-notes-generator/changelog/npm(no-publish)/git/github
plugins) and a manual version-bump GitHub Actions workflow. Build-caching
recipes for Gradle (`~/.gradle/caches`, `~/.gradle/wrapper` keyed on
`**/*.gradle*`+`gradle-wrapper.properties` hash) and CocoaPods (`ios/App/Pods`
keyed on `Podfile.lock` hash).

**Key commands/APIs:** `security create-keychain`/`import`/
`set-key-partition-list`, `xcodebuild archive`/`-exportArchive`, `xcrun altool
--upload-app --type ios --file ... --apiKey ... --apiIssuer ...`, `./gradlew
assembleRelease`/`bundleRelease`, `npx @capgo/cli upload`, `fastlane ios
release`/`android release`, `r0adkll/upload-google-play@v1`.

**Version constraints:** GitHub Actions `actions/checkout@v4`,
`actions/setup-node@v4`, `actions/upload-artifact@v4`/`download-artifact@v4`,
`codecov/codecov-action@v4`, `ruby/setup-ruby@v1`, `android-actions/setup-
android@v3`, `actions/setup-java@v4` (Java 17 Temurin), `actions/cache@v4`. No
Capacitor-major-version pin.

**Fleet relevance:** This is the GENERIC version of exactly what the fleet
already has as a matured, hardened, fleet-specific pattern: iHEARtest's
`ios-depot.yml` (Depot macOS, `depot-macos-26` runner, dispatch-only,
ASC-API-key automatic signing, CTO-only trigger, TestFlight upload via `xcrun
altool`, build number = ASC CFBundleVersion, completion webhook). The generic
skill's macOS-runner-based cert/keychain-import approach (`security
create-keychain`, manual P12 import) is the OLDER pattern the fleet has already
moved past in favor of Depot + ASC-API-key `-allowProvisioningUpdates`
automatic signing (per the CTO's dated notes on PlantID/Flatstick builds this
is explicitly the preferred model: "Signing = ASC API-key AUTOMATIC," no
manual cert/profile secrets needed). Still useful as: (a) a reference for the
generic Gradle/CocoaPods build-cache recipes if fleet CI ever gets slow, (b) the
exact `deploy-capgo` step (`npx @capgo/cli upload` gated on main) is directly
relevant now that the fleet has "just wired signed Capgo OTA channels" -- this
step could be the missing piece to auto-push OTA bundles on merge-to-main for
non-native changes, separate from the native Depot build pipeline, (c) the
Fastlane `match`-based signing pattern is exactly what the CTO's dated notes
flagged as the RECOMMENDED durable fix for the fleet-wide Depot ephemeral-cert
problem ("move the fleet to fastlane match... or add a periodic revoke step" --
still not done as of the CTO's last note), so this skill's Fastfile examples are
directly actionable reference material for that outstanding fix.

---

## 11. capacitor-deep-linking

**Frontmatter description/trigger:** "Complete guide to implementing deep links
and universal links in Capacitor apps. Covers iOS Universal Links, Android App
Links, custom URL schemes, and navigation handling. Use this skill when users
need to open their app from links."

**What it teaches:** All three deep-link mechanisms with a comparison table
(Custom URL Scheme: both platforms, `myapp://path`, no server required;
Universal Links: iOS, `https://myapp.com/path`, server required; App Links:
Android, same format, server required). Install: `@capacitor/app` +
`App.addListener('appUrlOpen', ...)` handler pattern with URL parsing/routing
dispatch. Custom scheme setup: `CFBundleURLTypes`/`CFBundleURLSchemes` in
Info.plist; Android `intent-filter` with `android:scheme`; test via `xcrun
simctl openurl booted "myapp://..."` and `adb shell am start -a
android.intent.action.VIEW -d "myapp://..."`. Universal Links (iOS): enable
Associated Domains capability in Xcode, host an `apple-app-site-association`
JSON at `.well-known/` with `appID`/`paths` (including `NOT /api/*` exclusion
syntax), `com.apple.developer.associated-domains` in Info.plist, and validation
via `curl -I` on the AASA file plus Apple's CDN cache endpoint
(`app-site-association.cdn-apple.com`). App Links (Android): host
`assetlinks.json` with `sha256_cert_fingerprints`, obtainable via `keytool
-list -v` on debug/release keystores or `keytool -printcert -jarfile` on a
built APK; `android:autoVerify="true"` intent-filter; verify via Google's
Digital Asset Links validator or `adb shell pm get-app-links`. React Router and
Vue Router integration snippets (`useHistory`/`useRouter` + `getLaunchUrl()`
for cold-start handling). Deferred deep link pattern (first-launch check +
attribution-service lookup via `@capacitor/preferences`). Query-parameter /
attribution tracking pattern (`source`/`campaign`/`ref` params ->
`analytics.logEvent`). OAuth callback handling pattern
(`/oauth/callback` path with `code`/`state`/`error` param parsing and
`validateState`). A full test matrix (custom scheme, cold/warm-start universal
links, Safari-typed universal link, cold-start/Chrome app link) and debug tools
(`codesign -d --entitlements - App.app | grep associated-domains`, `xcrun
simctl erase all`, `adb shell dumpsys package d`).

**Key commands/APIs:** `xcrun simctl openurl`, `adb shell am start`, `keytool
-list -v` / `-printcert -jarfile`, `curl -I` (AASA validation), `adb shell pm
get-app-links`, `codesign -d --entitlements`.

**Version constraints:** None Capacitor-major-specific; uses `@capacitor/app`
current API surface (`getLaunchUrl()`, `addListener('appUrlOpen', ...)`).

**Fleet relevance:** Directly relevant to any fleet app with OAuth flows
(Companion's Firebase Auth phone-OTP + email/Apple/Google logins for adult
kids, MedReview's Shopify App Bridge JWT exchange and planned V1.1 magic-link
auth, any app using RevenueCat's web checkout redirect flow) and to Companion's
family-invite flow (invite-only family layer likely needs a deep link to accept
an invitation). The OAuth-callback pattern maps directly onto the fleet's
`browser-agent` skill's "OAuth-redirect capture (extracts the ?code= to hand to
a token-exchange skill)" capability described in the CTO's CLAUDE.md. The
`keytool -printcert -jarfile` SHA256-fingerprint extraction technique is
useful boilerplate whenever an app first sets up Android App Links (most fleet
apps are iOS-first with Android dormant/scaffolded, so this becomes relevant
once Android ships for AWARE, FourVault, etc.).

---

## 12. capacitor-keyboard

**Frontmatter description/trigger:** "Guide to handling keyboard in Capacitor
apps including visibility detection, accessory bar, scroll behavior, and input
focus. Use this skill when users have keyboard-related issues."

**What it teaches:** Install `@capacitor/keyboard`. Basic show/hide/listener API
(`Keyboard.show()`/`hide()`, `keyboardWillShow`/`keyboardWillHide` events giving
`keyboardHeight`). Config: `resize` mode (`body`/`ionic`/`native`/`none`),
`style` (`dark`/`light`/`default`), `resizeOnFullScreen`. A CSS-variable pattern
for tracking keyboard height (`--keyboard-height` custom property set/cleared on
show/hide, used in a `position:fixed` chat-input `bottom: calc(var(--keyboard-
height,0px) + env(safe-area-inset-bottom))` example). Scroll-to-focused-input
pattern (100ms wait after `keyboardWillShow` then `scrollIntoView({behavior:
'smooth', block:'center'})`). iOS accessory bar toggle
(`Keyboard.setAccessoryBarVisible`). Form best practices: 16px minimum
input font-size to prevent iOS auto-zoom, `Keyboard.hide()` on form submit,
Enter-key-moves-to-next-field pattern. Troubleshooting table (content hidden ->
use resize mode; slow animation -> use `keyboardWillShow` not `DidShow`; iOS
zoom -> 16px font; Android overlap -> set `windowSoftInputMode`).

**Key commands/APIs:** `npm install @capacitor/keyboard`, `Keyboard.show()`,
`.hide()`, `.setAccessoryBarVisible()`, `addListener('keyboardWillShow'/
'keyboardWillHide', ...)`.

**Version constraints:** None specific.

**Fleet relevance:** Broadly applicable to any fleet app with text input over a
scrollable layout -- Companion's chat/assistant text entry, Flatstick's
score-entry forms, FourVault's kid-nickname free-text fields (moderation-gated
per FourVault's CLAUDE.md), MedReview's forms. The 16px-minimum-font-size /
iOS-zoom-prevention note and the safe-area-aware `--keyboard-height` CSS pattern
are exactly the kind of senior-accessibility-adjacent detail relevant to
Companion/MedReview/AWARE's senior-first UI requirements (small forms that
zoom unexpectedly on focus are a real usability problem for older users).

---

## 13. capacitor-mcp

**Frontmatter description/trigger:** "Model Context Protocol (MCP) tools for
Capacitor mobile development. Covers Ionic/Capacitor component APIs, plugin
documentation, CLI commands, and AI-assisted development via MCP. Use this skill
when users want to integrate AI agents with Ionic/Capacitor tooling."

**What it teaches/automates:** This is a setup/reference guide for a THIRD-PARTY
MCP server, `awesome-ionic-mcp` (github.com/Tommertom/awesome-ionic-mcp) --
notably a completely different, non-Capgo MCP server, not to be confused with
the fleet's own gateway. Install instructions for Claude Desktop
(`claude_desktop_config.json`), Cline (`cline_mcp_settings.json`), and Cursor
(`.cursor/mcp.json`), all via `npx -y awesome-ionic-mcp@latest`. Notes it makes
~160+ GitHub API calls on init to fetch plugin metadata (60/hr unauthenticated
vs 5,000/hr with a `GITHUB_TOKEN` env var passed in the MCP config). Documents
its exposed tool surface in detail:
- Ionic component tools: `get_ionic_component_definition`,
  `get_all_ionic_components`, `get_component_api`, `get_component_demo`.
- Capacitor plugin tools: `get_official_plugin_api`, `get_all_official_plugins`,
  `get_all_capacitor_plugins` (superlist across all publishers),
  `get_plugin_api`/`get_all_free_plugins`/`get_all_insider_plugins`
  (Capawesome), `get_capgo_plugin_api`/`get_all_capgo_plugins` (Capgo),
  `get_capacitor_community_plugin_api`/`get_all_capacitor_community_plugins`.
- Ionic CLI command tools: `ionic_info`, `ionic_config_get`/`_set`/`_unset`,
  `ionic_start` (project scaffold with template/type/capacitor flags),
  `ionic_start_list`, `ionic_init`, `ionic_repair`, `ionic_build` (with
  `prod`/`engine` flags), `ionic_serve` (dev server), `ionic_generate` (page/
  component/service/directive/guard/pipe/class/interface/module),
  `integrations_list`/`_enable`/`_disable`.
- Capacitor CLI command tools: `capacitor_doctor`, `capacitor_list_plugins`,
  `capacitor_init`, `capacitor_add` (platform), `capacitor_migrate`,
  `capacitor_sync`, `capacitor_copy`, `capacitor_update`, `capacitor_build`,
  `capacitor_run`, `capacitor_open` (Xcode/Android Studio).
Gives three example end-to-end workflows (create new project, health check,
generate code) chained across these tools, plus a "technical details" section
noting the server aggregates from `@ionic/core` TS defs, ionicframework.com,
docs-demo.ionic.io, capacitorjs.com, capawesome.io, capacitor-community, and
capgo.app, using Puppeteer under the hood for some doc-fetches (so a headless
browser may spawn during init).

**Key commands/APIs:** `npx -y awesome-ionic-mcp@latest`; a ~30-tool MCP
surface as enumerated above.

**Version constraints:** Requires Node.js for `npx`; optional `GITHUB_TOKEN`
for rate limits; requires an actual Ionic/Capacitor project directory for the
CLI-wrapping tools to function.

**Fleet relevance:** Low-to-moderate direct relevance. This is a THIRD-PARTY MCP
server distinct from both the fleet's own unified gateway
(`otchealth-mcp-server`) and Capgo's own tooling; it duplicates functionality
the fleet already gets more centrally (component/plugin doc lookup) but could
be a useful supplementary connector for an App Lead or Developer-identity
session doing heavy Ionic/Capacitor scaffolding work (e.g. `ionic_generate`
code-gen), IF added as a connector. Given the fleet's stated MCP-vs-skill
routing policy prefers first-party hosted MCPs and the gateway, this is not an
obvious near-term add, but it is worth flagging to the CTO as an available
option, particularly for the `ionic_start`/`capacitor_add` project-scaffolding
tools if a brand-new app repo is being stood up (relevant to `app-template`
work referenced in the CTO's dated notes). Rate-limit note is directly
actionable if ever installed: attach a `GITHUB_TOKEN` (the fleet has its own
`otchealth-fleet-bot` GitHub App identity at 15k req/hr per the CTO's notes,
though that's a different auth mechanism than a raw PAT env var this MCP
expects).

---

## 14. capacitor-offline-first

**Frontmatter description/trigger:** "Guide to building offline-first Capacitor
apps with data synchronization, caching strategies, and conflict resolution.
Covers Fast SQL, service workers, and network detection. Use this skill when
users need their app to work without internet."

**What it teaches/automates:** A full offline-first architecture reference:
- Network detection via `@capacitor/network`: `Network.getStatus()`,
  `networkStatusChange` listener, and a `NetworkAwareService` class pattern
  that falls back to cached data on fetch failure and caches successful
  responses.
- Local database via `@capgo/capacitor-fast-sql`'s `KeyValueStore` API
  (`open`/`set`/`get`/`remove`/`keys`), with an explicit note that production
  use requires platform setup BEFORE first use: iOS needs localhost-networking
  allowed for the plugin's transport, Android needs a localhost cleartext
  exception, Web needs the `sql.js` fallback installed -- and that the
  dedicated `sqlite-to-fast-sql` skill (outside this report's scope, in the
  second half of the marketplace) has the full platform checklist.
- A generic `OfflineRepository<T extends Entity>` pattern (entity has `id`,
  `updatedAt`, `syncStatus: 'synced'|'pending'|'conflict'`) with
  `getAll`/`getById`/`save`/`delete` (soft-delete via a `deleted` flag +
  `pending` status)/`getPending`/`markSynced`.
- A `SyncManager` class: listens for `networkStatusChange`, drains each
  repository's pending queue against a REST API (PUT to sync, DELETE for
  soft-deletes), pulls remote changes since last sync, and resolves conflicts
  with a last-write-wins strategy comparing `updatedAt` timestamps (with
  alternate merge/ask-user strategies shown as commented options).
- Service Worker + Workbox caching (`precacheAndRoute`, `NetworkFirst` for
  `/api/*` with a 5s timeout, `CacheFirst` for images with a 100-entry/1-week
  expiration policy, `CacheFirst` for fonts).
- Optimistic UI update pattern (`TodoService.addTodo`/`toggleComplete`: write
  local immediately, fire-and-forget background sync).
- A `RequestQueue` class for queuing failed requests to disk and draining them
  when connectivity returns.
- Best practices: a `SyncIndicator` React component showing
  offline/syncing/pending-count/synced badge states; three conflict-resolution
  strategies (last-write-wins, field merge, ask-user dialog); pre-sync
  validation pattern.

**Key commands/APIs:** `npm install @capacitor/network`, `npm install
@capgo/capacitor-fast-sql`. `Network.getStatus()`,
`Network.addListener('networkStatusChange', ...)`. `KeyValueStore.open/set/
get/remove/keys`.

**Version constraints:** None Capacitor-major-specific. Notes Fast SQL's
per-platform setup prerequisites explicitly (see above).

**Fleet relevance:** Directly relevant to Companion's explicit architecture:
"On-device encrypted store: @capacitor-community/sqlite with SQLCipher.
Offline cache of notebook and recent feed." (Companion uses a different SQLite
wrapper than this skill's recommended `@capgo/capacitor-fast-sql`, so this
skill would need adaptation, but the `OfflineRepository`/`SyncManager`
conflict-resolution architecture pattern is directly transferable regardless of
underlying storage engine.) Also relevant to AWARE (35 offline-first training
screens implied by its "OTA-patchable later" and Vitest-gated architecture) and
any app needing resilient behavior on the senior-user connectivity profile
(spotty home wifi, etc., which matters a lot for Companion's target 70+ user
and MedReview's senior UX constraint). The `sqlite-to-fast-sql` migration skill
this skill points to is in the second half of the marketplace (out of this
report's scope) but is flagged here as a likely follow-up read if any fleet app
wants to standardize on Capgo's Fast SQL plugin.

---

## 15. capacitor-performance

**Frontmatter description/trigger:** "Performance optimization guide for
Capacitor apps covering bundle size, rendering, memory, native bridge, and
profiling. Use this skill when users need to optimize their app performance."

**What it teaches:** A concise, example-driven performance-tuning reference:
lazy-load plugins via dynamic `import()`; bundle-size analysis via `npx
vite-bundle-visualizer` and named-import tree-shaking; image
quality/size/format caps identical to the best-practices skill (quality 80,
width 1024, `resultType: Uri` not Base64, `loading="lazy"` on `<img>`); batch
bridge calls instead of looping per-item calls; rendering perf via CSS
`transform`+`will-change` instead of animating `left`/`top` (GPU-accelerated vs
layout-triggering); virtual scrolling for long lists; debounced scroll
handlers (`lodash-es` `debounce` at ~16ms/60fps); listener cleanup on unmount
(store the `addListener` handle, call `.remove()`); explicit nulling of large
data references to aid GC. Profiling tool pointers: Chrome DevTools via
`chrome://inspect` -> Performance tab -> flame chart; Xcode Instruments' Time
Profiler; Android Studio's built-in Profiler (CPU/Memory/Network). A metrics
target table: First Paint <1s, Time to Interactive <3s, 60fps frame rate,
stable (non-growing) memory, <500KB gzipped bundle.

**Key commands/APIs:** `npx vite-bundle-visualizer`.

**Version constraints:** None.

**Fleet relevance:** Generic but broadly useful cross-fleet code-review
checklist, especially the bridge-call-batching and image-size-cap guidance
which applies directly to any camera/photo-heavy flow (Companion's visual
assistant "point the camera at a plant/pill/mail," PlantID's plant photo
recognition, FourVault's card photography, MedReview's medication-photo OCR via
Cloud Vision). The <500KB gzipped bundle target is worth checking against the
fleet's known payload-size work (the CTO's task list shows a completed
"W2-1: Payload cut 372MB->~210MB" item for one of the apps, presumably total
app size not JS bundle, but the discipline is the same lineage).

---

## 16. capacitor-plugin-spm-support

**Frontmatter description/trigger:** "Guides the agent through adding Swift
Package Manager support to an existing Capacitor plugin. Covers Package.swift,
CAPBridgedPlugin conversion, bridge cleanup, and package manifest updates. Do
not use for app projects or non-Capacitor plugin frameworks."

**What it teaches/automates:** A 6-step procedure for converting a Capacitor
PLUGIN (not an app) from Objective-C-bridge-file-based CocoaPods distribution
to native SPM support: (1) gather info from `package.json`, the `.podspec`, and
the main Swift plugin class -- package name, pod name, iOS deployment target,
plugin class name, JS plugin name, all exposed methods, and any third-party
CocoaPods deps needing SPM equivalents; (2) write a `Package.swift` manifest
declaring the package name, minimum iOS version, source target pointing at the
existing iOS source tree, a dependency on the Capacitor Swift-package-support
package, and any resolved third-party SPM packages; (3) convert the Swift
plugin class to conform to `CAPBridgedPlugin`, adding the bridge properties
`identifier`, `jsName`, `pluginMethods` at the top of the class while
preserving every method's exact name/return type; (4) delete the old
Objective-C bridge header/implementation files and clean references from the
Xcode project file; (5) update the plugin's package manifest (podspec +
`Package.swift`) so it correctly exports the iOS sources, and add an iOS SPM
install command to any script helpers the repo maintains; (6) verify by
installing deps with the repo's package manager, then `cd`-ing into an
example/test app containing `capacitor.config.*`, running `npx cap sync`
there, and building that app. Error handling: start debugging from the Swift
package resolver (target path, dependency names); verify bridge registration
by matching class name/`identifier`/`jsName` against the exported JS API; for
unsupported CocoaPods deps, either find an SPM-compatible replacement or
selectively keep CocoaPods for just that dependency.

**Key commands/APIs:** No fixed CLI surface beyond the app's own package
manager and `npx cap sync`; this is a code-transformation/file-restructuring
skill, not a wrapper around an external tool.

**Version constraints:** Targets modern Capacitor's SPM-first model
(iHEARtest's CLAUDE.md: "SPM is the default iOS package manager"). Companion
piece to `capacitor-app-spm-migration` (out of this report's scope, second
half of marketplace, app-level rather than plugin-level SPM migration).

**Fleet relevance:** Directly relevant if the fleet ever maintains or forks any
CUSTOM Capacitor plugin (as opposed to consuming third-party ones) -- for
example if the fleet builds a bespoke native plugin for AWARE's
watch/widget-style native-extension work (Flatstick's `SKILL.md`-documented
`integrate_native_targets.rb` pattern for injecting Watch/widget targets is
plugin-adjacent native work, though not literally a Capacitor "plugin" in the
npm-package sense). This is a narrow, specialist skill; lower general
applicability than the app-facing skills, but valuable if the Developer
identity is ever asked to publish or maintain a first-party `@innerscope/*`
Capacitor plugin.

---

## 17-20. capacitor-plugin-upgrade-v4-to-v5 / v5-to-v6 / v6-to-v7 / v7-to-v8

Grouped for the same reason as the app-upgrade quartet above: near-identical
templates, this time targeting a Capacitor PLUGIN project rather than an app.

**Frontmatter descriptions:** "Guides the agent through upgrading a Capacitor
plugin from vN to vN+1. Use when the plugin targets Capacitor N and needs the
vN+1 migration path. Do not use for app upgrades, other major versions, or
non-Capacitor plugins."

**What they teach/automate:** Each runs an injected snapshot script that reads
`package.json` and prints `package.name`, `package.version`, and every
`@capacitor/*` entry across `peerDependencies`/`dependencies`/`devDependencies`
(note: unlike the app-upgrade skills, this checks `peerDependencies` first,
correctly reflecting that plugins declare Capacitor as a peer dep, not a direct
dep), plus a `find` for `./example-app`, `./ios`, `./android`. The 6-step
procedure: confirm current Capacitor peer-dependency range; bump the peer range
to the target major; review the official migration notes before touching
native files; update the example app if one exists; `npm install`; sync and
verify the example/test app. Error handling flags fixing the plugin API or
native bridge if the example app breaks, and checking iOS deployment
target/Android Gradle+Java requirements for the target Capacitor version.

**Key commands/APIs:** `npm install`; `allowed-tools`: `Bash(node -e *)`,
`Bash(find *)` on all four (a narrower toolset than the equivalent app-upgrade
skills, notably lacking `Bash(npm *)`/`Bash(npx cap *)` even though the
procedure text instructs running `npm install` -- another allowed-tools/
instruction-text mismatch worth flagging, same pattern noted in section 3-6
above).

**Version constraints:** Each hard-scoped to one jump (4->5, 5->6, 6->7, 7->8);
explicitly not for app upgrades or non-Capacitor plugins.

**Fleet relevance:** Same logic as the app-upgrade quartet, but for the narrow
case of the fleet maintaining a first-party plugin (see section 16's fleet-
relevance note). Not directly relevant unless/until the fleet ships a
first-party Capacitor plugin package.

---

## 21. capacitor-plugin-upgrades

**Frontmatter description/trigger:** "Guides the agent through upgrading a
Capacitor plugin to a newer major version. Covers dependency alignment, native
platform changes, example app verification, and multi-version jumps. Do not use
for app project upgrades or non-Capacitor plugin frameworks."

**What it teaches/automates:** The generalized multi-hop version of skills
17-20, mirroring `capacitor-app-upgrades`'s relationship to skills 3-6. Adds a
`find` for `capacitor.config.{json,ts,js}` alongside the example-app/ios/
android search. 4-step procedure: (1) detect current version, explicitly ask
the user to confirm the exact target major version before proceeding; (2)
upgrade sequentially, never skipping intermediate majors, each hop updating
peer deps + native bridge code + native project settings, `npm install`, `npx
cap sync` run FROM the example/test app directory (or a rebuild via the
repo's documented command), then verify the plugin API still works there; (3)
a plugin-specific surface-area review checklist (TypeScript defs/exported
names, native method signatures and return payloads, Android
namespace/Gradle/Java compat, iOS deployment target/Swift syntax/bridge
registration, README/doc snippets); (4) final verification -- check whether
`npm run verify` exists in the repo and use it if so, otherwise fall back to
`npm run build` + `npm test` + `npx cap sync` (from the example app dir) + a
full build of the example/test app for every shipped platform, explicitly
noting these commands must run from the plugin's EXAMPLE app directory, not the
plugin root.

**Key commands/APIs:** `npm install`, `npx cap sync`, `npm run verify` (if
present) or `npm run build && npm test` fallback. `allowed-tools`:
`Bash(node -e *)`, `Bash(find *)`, `Bash(npm *)`, `Bash(npx *)` (broader than
the version-specific quartet).

**Version constraints:** None fixed; umbrella/router skill for multi-hop plugin
upgrades.

**Fleet relevance:** Same as skills 17-20: relevant only if/when the fleet
maintains a first-party Capacitor plugin.

---

## 22. capacitor-plugins

**Frontmatter description/trigger:** "Official Capacitor package guide plus
Capgo ecosystem plugin recommendations. Use this skill when users need native
functionality, want the right official Capacitor package, or need a stronger
Capgo/community plugin when the official package is missing or too limited."

**What it teaches/automates:** A plugin DECISION framework plus the largest
single reference corpus in this half of the marketplace by plugin-count (35
official-plugin reference files + a 139-package Capgo catalog). Two-step
decision process: (1) always check for an official `@capacitor/*` package
first and open its matching `references/*.md` file before answering; (2)
escalate to a Capgo or community plugin only when no official package exists,
the official one is too limited, the user needs a hosted Capgo workflow, or the
user is migrating off Ionic Enterprise/older community plugins -- and when
recommending a non-official plugin, explain the concrete gap and cite the exact
package name from the catalog. A "fast starting points" table maps 12 common
needs directly to `@capgo/*` package names (Live updates ->
`@capgo/capacitor-updater`; Background geolocation ->
`@capgo/background-geolocation`; Camera overlay preview ->
`@capgo/camera-preview`; Social sign-in -> `@capgo/capacitor-social-login`;
Biometrics -> `@capgo/capacitor-native-biometric`; In-app purchases ->
`@capgo/native-purchases`; Native SQLite -> `@capgo/capacitor-fast-sql`; Native
file ops -> `@capgo/capacitor-file`; File picking ->
`@capgo/capacitor-file-picker`; Native payments -> `@capgo/capacitor-pay`;
WebView crash recovery -> `@capgo/capacitor-webview-guardian`; App integrity ->
`@capgo/capacitor-app-attest`). A "choosing the right plugin" section further
recommends: biometric login -> `@capgo/capacitor-native-biometric`; social
sign-in -> `@capgo/capacitor-social-login`; password autofill ->
`@capgo/capacitor-autofill-save-password`; camera with overlay ->
`@capgo/camera-preview`; simple photo access -> `@capgo/capacitor-photo-
library`; video playback -> `@capgo/capacitor-video-player`; document scanning
-> `@capgo/capacitor-document-scanner`; subscriptions/IAP ->
`@capgo/native-purchases`; Apple Pay/Google Pay -> `@capgo/capacitor-pay`;
production OTA -> `@capgo/capacitor-updater`; dev hot reload ->
`@capgo/capacitor-live-reload`; encrypted/high-throughput SQL ->
`@capgo/capacitor-fast-sql` (with a pointer to the `sqlite-to-fast-sql` skill
for migration).

**The 35 official-plugin reference files (each read in full; concise summary
below, all following an identical template: name, one-line description,
platform support, install command, config notes, a TypeScript usage snippet,
and platform-specific caveat notes):**

- **capacitor-action-sheet** (`@capacitor/action-sheet`, Android/iOS/Web) --
  native action sheets; needs `androidxMaterialVersion` (1.12.0 legacy / 1.13.0
  for Capacitor 8) and, on web, `@ionic/pwa-elements` registered at startup.
  `ActionSheetButtonStyle` is iOS-only; `message` is iOS-only; `icon` is
  web-only (Ionicons).
- **capacitor-app-launcher** (`@capacitor/app-launcher`, Android/iOS) -- check/
  open other apps by URL scheme or package name; iOS needs
  `LSApplicationQueriesSchemes` in Info.plist, Android 11+ needs a `<queries>`
  block in the manifest.
- **capacitor-app** (`@capacitor/app`, Android/iOS/Web-partial) -- app
  lifecycle/state, deep links, back button; custom URL schemes via
  `CFBundleURLTypes` (iOS) / `intent-filter`+`strings.xml` (Android);
  `disableBackButtonHandler` config (Android-only); `exitApp()`/`minimizeApp()`
  and the `backButton`/`appRestoredResult` events are Android-only.
- **capacitor-background-runner** (`@capacitor/background-runner`,
  Android/iOS) -- standalone JS execution outside the WebView, config-driven
  (`label`/`src`/`event`/`repeat`/`interval`/`autoStart` in
  `capacitor.config`); iOS needs Background Modes ("Background fetch" +
  "Background processing"), `BGTaskSchedulerPermittedIdentifiers` in
  Info.plist, and explicit `AppDelegate.swift` wiring
  (`handleApplicationDidFinishLaunching`, `registerBackgroundTask`); Android
  needs location perms + Android 13+ notification perms + Android 12+
  `SCHEDULE_EXACT_ALARM`. Hard limits: iOS ~30s runtime per invocation,
  Android 10-min max runtime / 15-min minimum repeat interval, and the runner
  context is destroyed after each resolve/reject with NO state persistence
  between events.
- **capacitor-barcode-scanner** (`@capacitor/barcode-scanner`, Android/iOS,
  uses "OutSystems barcode libraries") -- Android min SDK 26, two engine
  choices (ZXING all-formats vs MLKIT); iOS needs
  `NSCameraUsageDescription`; supports QR/AZTEC/CODABAR/CODE_39/93/128/
  DATA_MATRIX/EAN_13/8/ITF/PDF_417/UPC_A/E and more, but MAXICODE and
  UPC_EAN_EXTENSION are unsupported on iOS.
- **capacitor-browser** (`@capacitor/browser`, Android/iOS/Web-partial) --
  in-app browser using `SFSafariViewController` on iOS (explicitly noted as
  OAuth-compliant, unlike a bare WKWebView); Android needs
  `androidxBrowserVersion` (default 1.9.0); `presentationStyle` is iOS-only,
  `windowName` is web-only.
- **capacitor-camera** (`@capacitor/camera`, Android/iOS/Web) -- photo
  capture/gallery selection; iOS needs `NSCameraUsageDescription` +
  `NSPhotoLibraryAddUsageDescription` + `NSPhotoLibraryUsageDescription`;
  Android uses the API-30+ Photo Picker with automatic fallback (storage perms
  only needed if `saveToGallery:true`); web needs `@ionic/pwa-elements`.
  `CameraResultType` = Uri/Base64/DataUrl; `CameraSource` =
  Prompt/Camera/Photos; also exposes `pickImages()`/
  `pickLimitedLibraryPhotos()`.
- **capacitor-clipboard** (`@capacitor/clipboard`, Android/iOS/Web) --
  `write()` accepts `string`/`image`(data URL)/`url`/`label`(Android-only).
- **capacitor-cookies** (bundled in `@capacitor/core`, no separate install) --
  patches `document.cookie` to use native cookie storage; must be explicitly
  enabled (`CapacitorCookies.enabled:true` in config); iOS 14+ third-party
  cookies need `WKAppBoundDomains` whitelisting (up to 10 domains).
- **capacitor-device** (`@capacitor/device`, Android/iOS/Web) -- device
  model/OS/battery/language info; `getId()` returns a real UUID on iOS, a
  64-bit hex value on Android 8+, and a random localStorage-backed value on
  web (i.e. NOT a stable hardware identifier cross-platform); `getBatteryInfo`
  returns `batteryLevel` (0-1) and `isCharging`.
- **capacitor-dialog** (`@capacitor/dialog`, Android/iOS/Web) -- native
  alert/confirm/prompt dialogs.
- **capacitor-file-transfer** (`@capacitor/file-transfer`, Android/iOS/Web) --
  upload/download with progress events; default 60s read/connect timeouts;
  upload-specific options `chunkedMode`/`mimeType`/`fileKey`.
- **capacitor-file-viewer** (`@capacitor/file-viewer`, Android/iOS, NO web) --
  open/preview files; `previewMediaContentFromUrl` and similar preview methods
  are iOS-only (Android falls back to standard document-open).
- **capacitor-filesystem** (`@capacitor/filesystem`, Android/iOS/Web) --
  Node-like file API; iOS needs a `PrivacyInfo.xcprivacy` declaration for the
  `NSPrivacyAccessedAPICategoryFileTimestamp` Required Reason API (reason code
  `C617.1` -- directly ties back to the Apple Review Preflight skill's Privacy
  Manifest rule above) plus `UIFileSharingEnabled`/
  `LSSupportsOpeningDocumentsInPlace` in Info.plist; Android needs storage
  perms for `Directory.Documents`/`ExternalStorage` on Android <=10, and large
  files may need `android:largeHeap="true"`; notes `downloadFile()` is
  DEPRECATED in favor of `@capacitor/file-transfer`.
- **capacitor-geolocation** (`@capacitor/geolocation`, Android/iOS/Web) --
  `getCurrentPosition`/`watchPosition`/`clearWatch`; iOS needs
  `NSLocationAlwaysAndWhenInUseUsageDescription` +
  `NSLocationWhenInUseUsageDescription`; Android needs
  `ACCESS_COARSE_LOCATION`+`ACCESS_FINE_LOCATION`+the GPS hardware-feature
  declaration.
- **capacitor-google-maps** (`@capacitor/google-maps`, Android/iOS/Web) --
  needs `skipLibCheck:true` in tsconfig on iOS, an Android manifest API key
  meta-data entry, a billing-enabled Google Cloud API key for web; the map
  renders BENEATH the entire WebView on Android (every layer above it must be
  transparent); custom marker icons support PNG/JPG only (no SVG natively);
  requires an explicitly-sized `<capacitor-google-map>` custom element and
  framework-specific setup for Angular/React/Vue.
- **capacitor-haptics** (`@capacitor/haptics`, Android/iOS) -- `impact()`
  (Heavy/Medium/Light `ImpactStyle`), `notification()`
  (Success/Warning/Error `NotificationType`), `vibrate()`,
  `selectionStart/Changed/End()`; silently no-ops on devices without a Taptic
  Engine/vibrator.
- **capacitor-http** (bundled in `@capacitor/core`) -- patches `fetch`/
  `XMLHttpRequest` to route through native HTTP; must be explicitly enabled
  (`CapacitorHttp.enabled:true`); data can only be string or JSON on
  Android/iOS (use `@capacitor/file-transfer` for large files).
- **capacitor-inappbrowser** (`@capacitor/inappbrowser`, Android min SDK
  26/iOS) -- three open modes (`openInWebView`/`openInSystemBrowser`/
  `openInExternalBrowser`) plus `close()`; events
  `browserClosed`/`browserPageLoaded`/`browserPageNavigationCompleted`; WebView
  mode supports toolbar positioning/nav buttons/cache/user-agent/zoom config.
- **capacitor-keyboard** (see skill 12 above for the full standalone skill;
  this reference note adds the config default `resize:'native'` and flags
  `show()` as Android-only, `setAccessoryBarVisible()` as iPhone-only, and
  `setScroll`/`setStyle`/`setResizeMode`/`getResizeMode` as iOS-only).
- **capacitor-local-notifications** (`@capacitor/local-notifications`,
  Android/iOS/Web) -- schedule device notifications without a server; Android
  13+ needs runtime perm check/request, Android 12+ needs
  `SCHEDULE_EXACT_ALARM`, and a notable Android 14+ caveat: `USE_EXACT_ALARM`
  is auto-granted only for a limited set of app categories subject to Google
  Play policy review, so most apps should check exact-alarm access at runtime
  and gracefully fall back to inexact scheduling; exact alarms during Doze fire
  at most once per 9 minutes per app; channel config on Android 8+ affects
  sound and CANNOT be changed post-install; supports
  `createChannel`/`deleteChannel`/`listChannels`.
- **capacitor-motion** (`@capacitor/motion`, Android/iOS/Web) --
  accelerometer + orientation/compass; requires explicit user permission
  before access, and on web must be requested from a user-initiated action
  (button click) via the `DeviceMotionEvent` permission API.
- **capacitor-network** (`@capacitor/network`, Android/iOS/Web) -- connectivity
  status + `networkStatusChange` listener; clarifies `connected` is usually
  `false` for `connectionType:'none'`, `true` for wifi/cellular, and should be
  treated as UNDETERMINED when the type is `'unknown'` (a subtlety worth
  knowing for the offline-first sync logic in skill 14 above).
- **capacitor-preferences** (`@capacitor/preferences`, Android
  SharedPreferences/iOS UserDefaults/Web localStorage) -- lightweight KV
  storage, explicitly "not a database replacement"; iOS needs a
  `PrivacyInfo.xcprivacy` declaration for
  `NSPrivacyAccessedAPICategoryUserDefaults` (reason code `CA92.1`); only
  supports string values (JSON-serialize complex types yourself).
- **capacitor-privacy-screen** (`@capacitor/privacy-screen`, Android/iOS, NO
  web) -- prevents sensitive content appearing in the app switcher/recent-apps
  view; Android options `dimBackground`/`preventScreenshots`/
  `privacyModeOnActivityHidden` (`none`/`dim`/`splash`); iOS option
  `blurEffect` (`none`/`light`/`dark`). Directly relevant to any screen
  showing PHI-adjacent or sensitive data at a glance (MedReview's medication
  list, Companion's family notebook with emergency contacts/insurance photos).
- **capacitor-push-notifications** (`@capacitor/push-notifications`,
  Android/iOS) -- FCM/APNs; iOS needs the Push Notifications Xcode capability
  + two `AppDelegate.swift` registration-callback methods; Android needs
  `google-services.json`, Android 13+ perm check, `firebaseMessagingVersion`
  (default 25.0.1), and a white-on-transparent notification icon meta-data
  entry; config `presentationOptions` (`badge`/`sound`/`alert`); notes iOS does
  NOT support silent/background push through this plugin, and Android won't
  fire callbacks for data-only notifications if the app was fully killed.
- **capacitor-screen-orientation** (`@capacitor/screen-orientation`,
  Android/iOS/Web) -- `orientation()`/`lock()`/`unlock()` +
  `screenOrientationChange` listener; iPad needs `UIRequiresFullScreen:true`;
  Android 16+ (targetSdk 36) note: `lock()` has NO EFFECT on large screens
  (a forward-looking Android compatibility caveat).
- **capacitor-screen-reader** (`@capacitor/screen-reader`, Android/iOS/
  Web-partial) -- TalkBack/VoiceOver detection + TTS via `speak()`;
  `isEnabled()` is native-only (not available on web); `speak()` and
  `addListener` are also native-only; the `language` param on `speak()` is
  Android-only. Directly relevant to the accessibility work referenced in
  skill 1 and to AWARE/Companion/MedReview's senior-accessibility
  requirements.
- **capacitor-share** (`@capacitor/share`, Android/iOS/Web via Web Share API)
  -- system share sheet; `files` sharing is iOS/Android only; `dialogTitle` is
  Android-only; Android by default can only share files from the cache
  folder (additional folders need a `file_paths.xml` config).
- **capacitor-splash-screen** (see skill 25 below for the standalone skill;
  this reference adds the Android-12+ native Splash Screen API note, the
  ability to disable the compatibility library by editing the
  `AppTheme.NoActionBarLaunch` parent theme, and additional config options
  `spinnerColor`/`layoutName`(custom Android layout)/`useDialog`).
- **capacitor-status-bar** (`@capacitor/status-bar`, Android/iOS) -- style/
  visibility/background color; iOS needs
  `UIViewControllerBasedStatusBarAppearance:YES`; flags a real BREAKING CHANGE
  on Android 16+: `overlaysWebView` and `backgroundColor` NO LONGER FUNCTION
  due to Android's enforced edge-to-edge behavior (apps targeting newer
  Android SDKs need to migrate to the newer System Bars plugin below);
  `Animation` param is iOS-only.
- **capacitor-system-bars** (bundled in `@capacitor/core`) -- the MODERN
  edge-to-edge replacement for Status Bar on newer apps; iOS needs
  `UIViewControllerBasedStatusBarAppearance:YES`; Android injects
  `--safe-area-inset-x` CSS variable fallbacks for WebView versions older than
  140; `setAnimation()` is iOS-only (`FADE`/`NONE`); config options
  `insetsHandling`(Android)/`style`/`hidden`/`animation`(iOS).
- **capacitor-text-zoom** (`@capacitor/text-zoom`, Android/iOS) -- WebView text
  scale for accessibility; values are decimals (1.0=100%, 1.5=150%); iPad
  requires `preferredContentMode:'mobile'` in the Capacitor config. Directly
  maps onto AWARE's "1.5x default text scale" requirement and MedReview's
  18/22/28pt font-scale toggle requirement.
- **capacitor-toast** (`@capacitor/toast`, Android/iOS/Web) -- simple
  notification popup; `duration` short(2000ms)/long(3500ms); `position`
  top/center/bottom, though Android 12+ ALWAYS shows toasts at the bottom
  regardless of the `position` setting; web needs `@ionic/pwa-elements`.
- **capacitor-watch** (`@capacitor/watch`, iOS ONLY, marked "Experimental
  (CapacitorLABS)") -- build watchOS UI in web code for a paired Apple Watch;
  requires Background Modes (Background Fetch, Remote Notifications,
  Background Processing) + Push Notification capability, `WCSession`
  activation in `AppDelegate.swift`, a separate watchOS app target
  (`[bundle-id].watchapp`), and a string-based declarative UI DSL
  (`Text("Hello $name")` / `Button("Tap Me","tapCommand")` with `$variable`
  interpolation via `updateWatchUI`/`updateWatchData`/the `runCommand`
  listener). Explicitly notes simulators do NOT support app-to-watch
  communication -- physical devices are required for testing. This is a
  DIFFERENT plugin (`@capacitor/watch`, official/experimental) from the
  Capgo-catalog `@capgo/capacitor-watch` package listed separately in the
  Capgo catalog below (bidirectional messaging, described as a distinct
  package) -- worth flagging as a naming collision to watch for when a fleet
  app picks a watch-integration plugin, since Flatstick already shipped a
  native Watch app via a HAND-ROLLED Xcode-injection approach
  (`integrate_native_targets.rb`) rather than either of these plugins, per the
  CTO's dated notes.

**The Capgo Plugin Catalog (`references/capgo-plugin-catalog.md`, 139
packages, read in full):** A complete table of every canonical `@capgo/*`
Capacitor plugin with package name, description, and GitHub source link,
generated from real Capgo plugin-workspace metadata (explicitly excludes
example apps, templates, and security-advisory/issue/PR worktrees). Full list
transcribed in the source file; categories relevant to the fleet worth calling
out specifically:
- **Live update / OTA:** `@capgo/capacitor-updater` (the fleet's newly-wired
  OTA mechanism), `@capgo/capacitor-live-reload` (dev hot reload from a remote
  Vite server), `@capgo/capacitor-patch` (applies vetted Capgo patches during
  `cap sync`/`cap update`), `@capgo/capacitor-website-updater` (caches a static
  site locally as an update source).
- **Analytics/attribution (relevant to the fleet's PostHog-primary /
  Sentry-secondary posture and the explicit "no third-party analytics on kid
  screens" FourVault rule):** `@capgo/capacitor-appinsights`,
  `@capgo/capacitor-appsflyer`, `@capgo/capacitor-contentsquare`,
  `@capgo/capacitor-facebook-analytics`, `@capgo/capacitor-gtm` (Google Tag
  Manager), `@capgo/capacitor-rudderstack`, `@capgo/capacitor-install-referrer`
  (Play install referrer + Apple AdServices attribution) -- none of these
  should ever be wired into FourVault's kid screens per its CLAUDE.md, and
  several are candidates the fleet should explicitly NOT add given its stated
  PostHog-primary/Sentry-secondary observability decision.
- **Biometrics/security:** `@capgo/capacitor-native-biometric`,
  `@capgo/capacitor-is-root` (jailbreak/root detection), `@capgo/capacitor-
  app-attest` (App Attest/Play Integrity), `@capgo/capacitor-device-integrity`
  (Widevine/Play Integrity/App Attest/DeviceCheck fraud signals),
  `@capgo/capacitor-ssl-pinning` (integrates with CapacitorHttp),
  `@capgo/capacitor-passkey` (WebAuthn-style passkey shim),
  `@capgo/capacitor-recaptcha`, `@capgo/capacitor-verisoul` (fraud
  prevention).
- **Payments/IAP:** `@capgo/native-purchases`, `@capgo/capacitor-pay` (Apple
  Pay/Google Pay).
- **Health:** `@capgo/capacitor-health` (HealthKit + Health Connect) --
  directly relevant to Companion's future HealthKit ambitions per the CTO's
  dated note about "the HealthKit AirPods audiogram idea for iHEARtest" and
  any MedReview mobile expansion.
- **Storage/data:** `@capgo/capacitor-fast-sql`, `@capgo/capacitor-data-
  storage-sqlite`, `@capgo/capacitor-file`, `@capgo/capacitor-file-compressor`,
  `@capgo/capacitor-file-picker`, `@capgo/capacitor-file-sharer`,
  `@capgo/capacitor-persistent-account`, `@capgo/capacitor-persistent-uuid`
  (survives reinstalls/updates).
- **Firebase (a full monorepo sub-family):** `@capgo/capacitor-firebase`
  (+`-analytics`/`-app`/`-app-check`/`-authentication`/`-crashlytics`/
  `-firestore`/`-functions`/`-messaging`/`-performance`/`-remote-config`/
  `-storage`) -- directly relevant to Companion's Firebase Auth + Firestore +
  Cloud Storage for Firebase architecture.
- **Media/AV:** `@capgo/capacitor-audio-recorder`, `@capgo/capacitor-audio-
  session` (iOS audio interrupt/route-change notifications -- directly
  relevant to iHEARtest/AWARE's documented AVAudioSession gotchas),
  `@capgo/capacitor-native-audio`, `@capgo/capacitor-ffmpeg`,
  `@capgo/capacitor-video-player`, `@capgo/capacitor-video-thumbnails`,
  `@capgo/capacitor-media-session`, `@capgo/capacitor-mux-player`,
  `@capgo/capacitor-jw-player`, `@capgo/capacitor-ivs-player`,
  `@capgo/capacitor-youtube-player`.
- **Calling/comms:** `@capgo/capacitor-twilio-video`,
  `@capgo/capacitor-twilio-voice`, `@capgo/capacitor-incoming-call-kit`,
  `@capgo/capacitor-stream-call` (getstream.io), `@capgo/capacitor-realtimekit`
  (Cloudflare Calls) -- relevant to any fleet app adding voice/video calling
  (e.g. a future Companion family-video-call feature would map here vs. the
  planned Firebase-only architecture).
- **Kid/age-safety-adjacent:** `@capgo/capacitor-age-range` (Play Age Signals
  / Apple DeclaredAgeRange), `@capgo/capacitor-android-age-signals` --
  potentially relevant to FourVault's COPPA/VPC (verifiable parental consent)
  requirements as a signal source, worth flagging to the FourVault App Lead as
  a candidate integration.
- **Misc device/sensor:** accelerometer, barometer, compass, light sensor,
  pedometer, proximity, shake, SIM info, brightness, volume buttons, NFC,
  Bluetooth LE, WiFi management, calendar, contacts.
- **Widget/watch/live-activity (directly relevant to Flatstick's shipped watch/
  widget work and any future fleet app doing the same):**
  `@capgo/capacitor-widget-kit` (generic iOS Home Screen widgets +
  WidgetKit + Live Activities via SVG templates + declarative actions + shared
  App Group persistence), `@capgo/capacitor-live-activities`,
  `@capgo/capacitor-watch` (Apple Watch bidirectional messaging -- distinct
  from the official `@capacitor/watch` above), `@capgo/capacitor-navigation-
  bar`. The `capacitor-widget-kit` package in particular looks like it could
  have REPLACED much of Flatstick's hand-rolled `integrate_native_targets.rb`
  Xcode-injection approach for the widget portion (not the watch-app portion);
  worth flagging to the CTO/Developer identity as a potential simplification
  for the NEXT app that adds a widget, per the CTO's own note that this
  pattern should be "ported to Companion / AWARE / any Capacitor app adding
  watch or widgets."
- **Env/config:** `@capgo/capacitor-env` (set env vars in Capacitor config,
  read at runtime).
- **Zip/compression:** `@capgo/capacitor-zip`.

**Key commands/APIs:** `npm install <exact-package-name> && npx cap sync` for
any recommendation.

**Version constraints:** None globally fixed; individual reference files note
platform-specific version/SDK gates as summarized above (Android 12/13/14/16
behavior changes recur across multiple plugins -- a real cross-cutting theme:
Android 16 breaks both Status Bar's `overlaysWebView`/`backgroundColor` and
Screen Orientation's `lock()` on large screens, so any fleet app targeting
Android 16 needs both migrations).

**Fleet relevance:** This is the single most directly USEFUL skill in this half
of the marketplace for day-to-day fleet development, because virtually every
fleet app's stack maps onto multiple entries here: Companion's RevenueCat +
Firebase + `@capacitor-community/sqlite` stack overlaps with the Firebase
plugin family and could evaluate `@capgo/capacitor-fast-sql` as an alternative;
Flatstick's shipped Watch/widget work directly intersects
`@capgo/capacitor-widget-kit`/`@capgo/capacitor-watch`; FourVault's COPPA
posture intersects the age-signal plugins and warns against the analytics-SDK
family; MedReview and Companion's HealthKit ambitions intersect
`@capgo/capacitor-health`; the Android-16 status-bar/orientation breaking
changes are worth a fleet-wide audit item given all 8 apps are iOS-first but
most have Android scaffolded/dormant and will eventually need to handle this;
and the Privacy Manifest reason-code notes on Filesystem/Preferences directly
feed the Apple Review Preflight skill's privacy-manifest audit (section 8
above).

---

## 23. capacitor-push-notifications

**Frontmatter description/trigger:** "Complete guide to implementing push
notifications in Capacitor apps using Firebase Cloud Messaging (FCM) and Apple
Push Notification Service (APNs). Covers setup, handling, and best practices.
Use this skill when users need to add push notifications."

**What it teaches/automates:** A comprehensive FCM+APNs push implementation
guide (this is the FULL standalone skill; compare to the terser reference-file
version cataloged inside `capacitor-plugins` in section 22). Basic init
pattern: `requestPermissions()` -> `register()` -> `registration` listener
captures the token and sends it server-side -> `registrationError` handler ->
`pushNotificationReceived` (foreground) -> `pushNotificationActionPerformed`
(tap/action). Firebase project setup: create project at
console.firebase.google.com, add iOS+Android apps. Android: download
`google-services.json`, apply the `com.google.gms.google-services` Gradle
plugin, add the `firebase-messaging` dependency via the Firebase BOM
(32.7.0). iOS: download `GoogleService-Info.plist`, add `pod
'Firebase/Messaging'`, `FirebaseApp.configure()` +
`Messaging.messaging().apnsToken = deviceToken` wiring in `AppDelegate.swift`,
enable the Push Notifications + Background Modes>Remote Notifications Xcode
capabilities. APNs key setup: create a .p8 key in the Apple Developer portal
with APNs service enabled, upload it to Firebase Console's Cloud Messaging tab
with Key ID + Team ID. Sending notifications: Firebase Admin SDK (Node.js)
examples for `send()` to a single device token (with Android
priority/channel/icon/color and APNs badge/sound payload shaping), `send()` to
a topic, and `sendEachForMulticast()` to multiple tokens; a raw HTTP v1 API
curl example. Advanced: Android notification channels
(`createChannel`/`deleteChannel`/`listChannels` with
importance/visibility/sound/vibration/lightColor options), topic subscription
pattern, iOS rich notifications via a `UNNotificationServiceExtension` that
downloads and attaches an image to the notification content, notification
action-button handling (`action.actionId` switch with an inline-reply `
inputValue` example). Background handling: data-only (no `notification` key)
message shaping server-side + a Kotlin `FirebaseMessagingService.
onMessageReceived` handler dispatching on a custom `type` field. Local-
notification fallback pattern (show a `@capacitor/local-notifications` toast
when a push arrives in foreground). Best practices: permission-request flow
that shows an explanation before prompting and guides denied users to Settings;
token-refresh detection/server-update pattern; registration-error logging +
analytics + backoff-retry. Troubleshooting tables for iOS not receiving (check
APNs key, capability, provisioning profile, token format, test via Firebase
Console) and Android not receiving (check `google-services.json`, channel
existence, FCM token, battery optimization).

**Key commands/APIs:** `npm install @capacitor/push-notifications`.
`PushNotifications.requestPermissions/checkPermissions/register/createChannel/
deleteChannel/listChannels`. Firebase Admin SDK
`admin.messaging().send()`/`.sendEachForMulticast()`. FCM HTTP v1
`POST https://fcm.googleapis.com/v1/projects/<project>/messages:send`.

**Version constraints:** `firebase-bom:32.7.0` example version (should be
re-verified as current at implementation time, per this report's general
caution about pinned third-party versions aging). No Capacitor-major pin.

**Fleet relevance:** Directly relevant to Companion's daily check-in / family
feed push notifications and to the CTO's fleet-wide "APNs push is portfolio-
shared: ONE team-scoped push key... reuse this secret" standing rule (Secret
Manager `apple-apns-key-p8`, Key ID `DC8MP3LHX3`). This skill's APNs-key-setup
walkthrough is the mechanical how-to that underlies that shared-key
architecture, and its `PushNotifications.checkPermissions`/`requestPermissions`
flow-with-explanation pattern matters for Companion given its senior-first UX
requirement (never surprise a 70+ user with an unexplained system permission
prompt). Flatstick already shipped APNs wiring (its "deploy-apple-secrets"
step injecting APNs + SiwA .p8 into its Container App per the CTO's dated
notes) -- this skill is the reference for any NEW app adding push using that
same shared key.

---

## 24. capacitor-security

**Frontmatter description/trigger:** "Comprehensive security guide for
Capacitor apps using Capsec scanner. Covers 63+ security rules across secrets,
storage, network, authentication, cryptography, and platform-specific
vulnerabilities. Use this skill when users need to secure their mobile app or
run security audits."

**What it teaches/automates:** A wrapper/reference for a third-party CLI tool,
`capsec` (`npx capsec scan`), plus its full rule catalog. CLI usage:
`npx capsec scan [path]`, `--ci` (exit 1 on high/critical -- suitable for a CI
gate), `--output json|html --output-file <path>`, `--severity high`,
`--categories secrets,network,storage`, `--exclude "**/test/**,**/*.spec.ts"`.
Config file `capsec.config.json` with `exclude`/`severity`/`categories`/
per-rule `enabled`/`severity` overrides, initializable via `npx capsec init`.
The rule catalog, organized by category, each with rule ID/severity/one-line
description and a before/after code-fix example:
- **SEC (Secrets Detection):** SEC001 Critical (hardcoded API keys/secrets --
  detects AWS, Google, Firebase, Stripe, GitHub, JWT secret, DB-credential
  patterns, 30+ total patterns; fix example swaps a hardcoded key for
  `@capgo/capacitor-env`'s `Env.get()`), SEC002 High (exposed `.env` file).
- **STO (Storage Security):** STO001 High (unencrypted sensitive data in
  Preferences), STO002 High (localStorage for sensitive data), STO003 Medium
  (unencrypted SQLite), STO004 Medium (filesystem storage of sensitive data),
  STO005 Low (insecure caching), STO006 High (credentials not in
  Keychain/Keystore -- fix example swaps `@capacitor/preferences` for
  `@capgo/capacitor-native-biometric`'s `setCredentials`/`getCredentials`).
- **NET (Network Security):** NET001 Critical (HTTP cleartext traffic), NET002
  High (missing TLS cert pinning), NET003 High (Capacitor server cleartext
  enabled), NET004 Medium (insecure WebSocket), NET005 Medium (CORS
  wildcard), NET006 Medium (weak deep-link validation), NET007 Low
  (CapacitorHttp plugin misuse), NET008 High (sensitive data in URL params).
- **CAP (Capacitor-Specific):** CAP001 High (WebView debug mode enabled in
  prod), CAP002 Medium (insecure plugin config), CAP003 Low (verbose logging
  in prod), CAP004 High (insecure `allowNavigation`), CAP005 Critical (native
  bridge exposure), CAP006 Critical (`eval` with user input), CAP007 Medium
  (missing root/jailbreak detection), CAP008 Low (insecure plugin import),
  CAP009 Medium (live-update security), CAP010 High (insecure `postMessage`
  handler).
- **AND (Android):** AND001 High (cleartext traffic allowed), AND002 Medium
  (debug mode enabled), AND003 Medium (insecure permissions), AND004 Low
  (backup allowed), AND005 High (exported components without permission),
  AND006 Medium (WebView JS enabled without safeguards), AND007 Critical
  (insecure `addJavascriptInterface`), AND008 Critical (hardcoded signing
  key). Fix examples show `usesCleartextTraffic=false`,
  `allowBackup=false`, and a `network_security_config.xml` with a pinned-cert
  `<pin-set>`.
- **IOS:** IOS001 High (ATS disabled), IOS002 Medium (insecure Keychain
  access), IOS003 Medium (URL scheme without validation), IOS004 Low
  (Pasteboard sensitive-data exposure), IOS005 Medium (insecure entitlements),
  IOS006 Low (Background App Refresh data exposure), IOS007 Medium (missing
  jailbreak detection), IOS008 Low (screenshots not disabled on sensitive
  screens -- directly maps to `@capacitor/privacy-screen`, cataloged in
  section 22). Fix example shows scoping `NSAppTransportSecurity` exceptions
  to a specific legacy domain with a minimum TLS version instead of a blanket
  `NSAllowsArbitraryLoads`.
- **AUTH:** AUTH001 Critical (weak JWT validation -- fix shows swapping
  `jwt.decode` for `jwt.verify` with explicit algorithm/issuer/audience
  checks), AUTH002 High (insecure biometric implementation), AUTH003 High
  (weak RNG), AUTH004 Medium (missing session timeout), AUTH005 High (OAuth
  state parameter missing), AUTH006 Critical (hardcoded credentials in auth
  code).
- **WEB (WebView Security):** WEB001 Critical (JS injection), WEB002 Medium
  (unsafe iframe config), WEB003 Medium (external script loading), WEB004
  Medium (missing CSP -- fix example gives a full restrictive
  `Content-Security-Policy` meta tag), WEB005 Low (`target=_blank` without
  `noopener`).
- **CRY (Cryptography):** CRY001 Critical (weak algorithm, e.g. DES -- fix
  swaps to AES-GCM), CRY002 Critical (hardcoded encryption key -- fix shows a
  proper PBKDF2-derived key via `crypto.subtle.deriveKey`), CRY003 High
  (insecure random IV generation), CRY004 High (weak password hashing).
- **LOG:** LOG001 High (sensitive data in console logs), LOG002 Low (console
  logs left in production).
CI integration examples for both GitHub Actions (`npx capsec scan --ci
--output json --output-file security-report.json` + artifact upload) and
GitLab CI (`security` job producing a `security` report artifact). A
pre-release security checklist (11 items mirroring the best-practices skill's
deployment checklist but security-focused) and an ongoing-security checklist
(5 items: CI scans, vuln monitoring, dependency updates, plugin review, auth
audits). Root/jailbreak detection code sample via `@capgo/capacitor-is-root`
with three response-strategy options (warn / restrict features / block app
entirely).

**Key commands/APIs:** `npx capsec scan [--ci] [--output json|html
--output-file <f>] [--severity <level>] [--categories <list>] [--exclude
<globs>]`, `npx capsec init`.

**Version constraints:** None fixed; the `capsec` tool itself is a moving
target worth periodic re-verification (its rule count and exact behavior may
change between versions -- the skill frontmatter itself says "63+ security
rules" as of authoring).

**Fleet relevance:** VERY high. This is a ready-made, CI-gateable automated
security scanner that maps almost one-to-one onto the fleet's own hardening
priorities: SEC001 (hardcoded secrets) is exactly the fleet's own "never commit
a secret VALUE into any repo" unwaivable law; STO006/AUTH006 map to the
fleet's Secret Manager discipline; NET001/AND001/IOS001 (cleartext/ATS) map to
the "never inline secrets," HTTPS-only postures documented across every app's
CLAUDE.md; CAP009 (live-update security) is directly relevant now that the
fleet has "just wired signed Capgo OTA channels" across all 8 apps -- this rule
specifically should be checked against every app's live-update config;
LOG001/LOG002 map to MedReview's explicit "No `console.log` of any PHI-adjacent
variable, ever" rule and Companion's "NEVER pass photo content, message/caption
text... into an event" analytics rule; IOS008 (screenshots not disabled on
sensitive screens) maps to Companion's family-notebook/consent-recording
surfaces and MedReview's medication list. Recommending this as a genuinely
actionable next step: wiring `npx capsec scan --ci` into each app's existing
CI (web-ci.yml / the monorepo typecheck+test gate / etc.) as an additional
security gate alongside the compliance greps, PHI scrubbers, and Dependabot
checks each app already runs, would give the fleet automated coverage of a
security dimension none of the existing gates (compliance grep, i18n
coverage, unit tests) currently check.

---

## 25. capacitor-splash-screen

**Frontmatter description/trigger:** "Guide to configuring splash screens in
Capacitor apps including asset generation, animation, and programmatic control.
Use this skill when users need to customize their app launch experience."

**What it teaches/automates:** Install `@capacitor/splash-screen`. Config
block (`launchShowDuration`, `launchAutoHide`, `backgroundColor`,
`androidSplashResourceName`, `androidScaleType`, `showSpinner`,
`splashFullScreen`, `splashImmersive`). Programmatic control: hide after app
init completes (`await loadUserData(); await setupServices(); await
SplashScreen.hide()`), re-show for app-refresh scenarios
(`SplashScreen.show({autoHide:false})`), animated hide
(`hide({fadeOutDuration:500})`). Asset generation via `npm install -D
@capacitor/assets` + `npx capacitor-assets generate` from a `resources/
splash.png` (2732x2732 recommended) + optional `resources/splash-dark.png`.
Full manual asset-size tables for iOS (11 device-size variants from
2732x2732 iPad Pro down to 640x1136 iPhone SE) and Android (5 density buckets
mdpi-xxxhdpi). Raw iOS Storyboard XML example (`LaunchScreen.storyboard` with
a centered `imageView` and centerX/centerY constraints). Android XML splash
config for Android 11+ (`Theme.SplashScreen` style with
`windowSplashScreenBackground`/`windowSplashScreenAnimatedIcon`/
`windowSplashScreenAnimationDuration`/`postSplashScreenTheme`) plus light/dark
color resource files (`values/colors.xml` vs `values-night/colors.xml`). Dark
mode detection pattern (`window.matchMedia('(prefers-color-scheme:
dark)').matches`). Animated/Lottie splash pattern: keep the native splash
showing (`autoHide:false`), dynamically `import('lottie-web')`, play a JSON
animation in a web overlay, hide BOTH the native splash and the web overlay on
the animation's `complete` event. Best practices (5 items: keep under 2s
total, match branding, support dark mode, don't block on non-essential loads,
fade out smoothly). Troubleshooting table (white flash -> match splash bg to
app bg; stretching -> use correct asset sizes; not hiding -> call `hide()`
manually; wrong dark-mode colors -> add `values-night` resources).

**Key commands/APIs:** `npm install @capacitor/splash-screen`, `npm install -D
@capacitor/assets`, `npx capacitor-assets generate`.

**Version constraints:** References the Android 12+ native Splash Screen API
specifically (a real platform-version-dependent behavior change, same theme as
noted for Status Bar/Screen Orientation in section 22).

**Fleet relevance:** Directly relevant to iHEARtest's recently-completed "W2-3:
Boot cinematic choreography" and "W2-6" work items visible in the fleet's task
list, and to any app doing a branded animated boot sequence (the CTO's task
list also references a completed "boot-gate CI" skill that gates on "a stuck
splash/green/white screen" -- exactly the white-flash/not-hiding failure modes
this skill documents troubleshooting for). The Lottie animated-splash pattern
and the native-splash-stays-visible-until-web-overlay-ready technique is
directly reusable for any fleet app wanting a premium boot experience
(Flatstick's CLAUDE.md explicitly calls its sign-in screen and coin renders
"the signature surfaces... never downgrade" -- a splash/boot moment is the same
kind of premium-brand-bar territory).

---

## 26. capacitor-testing

**Frontmatter description/trigger:** "Complete testing guide for Capacitor apps
covering unit tests, integration tests, E2E tests, and native testing.
Includes Jest, Vitest, Playwright, Appium, and native testing frameworks. Use
this skill when users need to test their mobile apps."

**What it teaches/automates:** A full testing-pyramid reference (ASCII pyramid
diagram: many unit tests at the base, some integration, few E2E). Unit testing
with Vitest: `vitest.config.ts` setup (jsdom environment, v8 coverage
provider, a `setupFiles` entry), a `src/test/setup.ts` pattern mocking
`@capacitor/core` (`Capacitor.isNativePlatform`/`getPlatform`/
`isPluginAvailable`, `registerPlugin`), `@capacitor/preferences`, and
`@capgo/capacitor-native-biometric` via `vi.mock()`. A full `AuthService`
biometric-login unit-test example (happy path, biometrics-unavailable path,
user-cancellation path). Testing utilities: `mockPlatform('ios'|'android'|
'web')` and `mockPluginAvailable(bool)` helpers for platform-conditional
logic tests. Component testing: React Testing Library example (biometric
login button, async `waitFor`/`findByRole` patterns) and Vue Test Utils
example (`mount`/`flushPromises`/`trigger('click')`). E2E: Playwright config
targeting Desktop Chrome + Mobile Safari (iPhone 14) + Mobile Chrome (Pixel 7)
device profiles, with a login-flow spec example (fill/click/assert URL and
heading text, plus an invalid-credentials error-state test). Appium/WebdriverIO
config for native E2E (`wdio.conf.ts` with iOS `XCUITest` and Android
`UiAutomator2` capability blocks pointing at built `.app`/`.apk` artifacts),
plus a native biometric-login spec using `driver.touchId()`/
`driver.fingerPrint()` device-specific simulation calls. Detox config example
(`.detoxrc.js` with iOS/Android app+device definitions) as a React-Native-style
alternative E2E runner. Native unit testing: iOS XCTest example (`MockBridge`+
`CAPPluginCall` pattern for testing a plugin's `echo()` method) and Android
JUnit/Mockito example, plus an Android Instrumented Test example
(`AndroidJUnit4` runner checking `InstrumentationRegistry`'s target context
package name). Test organization convention (co-locate unit tests next to
source, `test/setup.ts`+`test/mocks/`+`test/utils.ts` shared infra, `e2e/web/`
vs `e2e/native/` split). Mock-strategy guidance: prefer MSW
(`setupServer`/`http.get`) over blanket `vi.mock()` of API modules, to avoid
over-mocking real behavior away. A full 4-job CI example (unit/e2e/ios/android
jobs, the ios job running `xcodebuild test -scheme App -destination
'platform=iOS Simulator,name=iPhone 15'` on `macos-latest`, android running
`./gradlew test` on `ubuntu-latest`).

**Key commands/APIs:** `npm install -D vitest @vitest/coverage-v8`, `npm
install -D @testing-library/react @testing-library/user-event`, `npm install
-D @vue/test-utils`, `npm install -D @playwright/test && npx playwright
install`, `npm install -D webdriverio @wdio/appium-service
@wdio/mocha-framework`, `npm install -D detox`. `xcodebuild test`,
`./gradlew test`.

**Version constraints:** iOS Simulator "iPhone 15" / iOS 17.0 pin in the
Appium example, Android "Pixel 8" / API 34 pin, Pixel 8 AVD in Detox --
illustrative, not prescriptive; should be updated to current device/OS
generations at actual implementation time.

**Fleet relevance:** Directly relevant to every fleet app's existing test
infrastructure: iHEARtest already runs Vitest (`qa/unit/`) with a Stop-hook
gate; the plugin-mocking pattern (`vi.mock('@capacitor/core', ...)`) is
directly usable for iHEARtest's or any app's PostHog/RevenueCat/native-plugin-
touching unit tests. Flatstick already runs `pnpm -r test` across
shared/api/web packages (~192/160/119 tests). MedReview's testing pyramid
(Vitest unit, Vitest+Supertest+Neon-branch integration, RTL+axe-core
component, Playwright E2E nightly) is essentially THIS skill's pyramid already
implemented. The Playwright multi-device-profile config (Desktop Chrome +
Mobile Safari iPhone 14 + Mobile Chrome Pixel 7) is a good template for any
fleet app wanting cross-device web-layer E2E coverage beyond a single
viewport. The Appium/native-biometric-simulation pattern
(`driver.touchId()`/`driver.fingerPrint()`) is relevant to any fleet app using
`@capgo/capacitor-native-biometric` for login (Companion's phone-OTP + social
auth stack could add biometric re-auth later; this gives the E2E test
pattern for it).

---

## 27. capawesome-live-update-migration

**Frontmatter description/trigger:** "Guides migration from Capawesome Cloud
live updates or @capawesome/capacitor-live-update to Capgo Updater. Use when a
Capacitor app contains Capawesome live update packages, CLI commands, config,
API calls, or when the user asks why Capgo Updater is the better live-update
path: native updater runtime, fully open source, cheaper at comparable scale,
and longer proven track record."

**What it teaches/automates:** A structured migration guide with an explicit
built-in sales/positioning angle (Capgo-authored, comparing itself favorably
to a specific competitor, Capawesome). Points to the live product doc
(`capgo.app/docs/upgrade/from-capawesome-to-capgo/`) and its MDX source file as
the "source of truth" to defer to over this skill's own copy. 7-step migration
checklist: (1) detect the existing Capawesome setup by ripgrepping the repo
for `capawesome|LiveUpdate|capacitor-live-update|live-update|
CapacitorUpdater|@capgo/capacitor-updater` across `package.json`,
`capacitor.config.*`, `src`, `ios`, `android`, `.github`, recording the
installed package, config plugin settings, startup/splash-screen logic, manual
update/download/set-next-bundle/reload call sites, and CI upload
commands/secrets; (2) swap packages (`npm uninstall
@capawesome/capacitor-live-update && npm install @capgo/capacitor-updater &&
npx cap sync`) -- explicitly the ONLY mandatory package swap, since Capgo ships
its updater runtime in native code through the plugin itself; (3) add a
minimal `CapacitorUpdater` config block (`autoUpdate:true`,
`autoDeletePrevious:true`, `periodCheckDelay: 10*60*1000`) with a conservative
settings-mapping table (`appId`->Capgo project id, `defaultChannel`->Capgo
channel rules, `autoDeleteBundles`->`autoDeletePrevious:true`, `publicKey`->
Capgo key management, retention limits->Capgo bundle retention policy); (4)
keep only the required `CapacitorUpdater.notifyAppReady()` startup call --
explicitly notes this confirms the new bundle booted, and if the app never
reports ready, Capgo rolls back WITHOUT needing a custom JS rollback loop; (5)
delete unneeded JS glue that only existed to hand-roll what Capgo now does
natively (resume-time update checks, manual background downloads, manual
next-bundle-setting, splash-hide-gated-on-update-check, retry logic, old-
bundle cleanup); (6) map optional manual Capawesome APIs to Capgo equivalents
in a table (`fetchLatestBundle()`->`getLatest()`,
`downloadBundle()`->`download()`, `setNextBundle()`->`next()`,
`reload()`->`reload()`, `getCurrentBundle()`->`current()`), each annotated
with "keep only if" guidance (custom update-discovery UI, controlled download
timing, locally-pinned bundles, immediate-apply UX, diagnostics/support
screens); (7) replace upload automation
(`npx @capgo/cli@latest login`, `npm run build`, `npx @capgo/cli@latest bundle
upload --path dist --channel production`), preserving existing CI secret
names where practical. Positioning-argument section for writing migration
notes/PR descriptions/customer comparisons: native updater runtime (the
JS layer should mostly just notify readiness, not BE the update engine),
fully open source (`github.com/Cap-go/capacitor-updater`), cheaper at
comparable scale (explicitly caveated "verify current pricing before quoting
exact numbers"), longer track record (explicitly caveated "verify current
public wording before quoting dates"). An important explicit LIMITATION
called out: "Do not say Capgo live updates can change native code" -- Capgo
updates web assets and updater state only; Swift/Kotlin/Java, native plugin
changes, entitlements, permissions, icons, signing, and store metadata all
still require a real native release. Validation checklist (7 items): build +
sync native after the swap; fresh native build on both platforms; confirm
`notifyAppReady()` fires after successful boot; upload one test bundle to a
non-production channel; confirm device downloads/applies/reports the Capgo
bundle; simulate a bad bundle or missing readiness call and confirm rollback
fires; only THEN remove old Capawesome packages/config/imports/upload
commands/secrets.

**Key commands/APIs:** `rg -n "capawesome|LiveUpdate|..."`, `npm uninstall
@capawesome/capacitor-live-update`, `npm install @capgo/capacitor-updater`,
`npx cap sync`, `CapacitorUpdater.notifyAppReady()`,
`npx @capgo/cli@latest login`, `npx @capgo/cli@latest bundle upload --path
dist --channel production`.

**Version constraints:** None fixed; explicitly flags its own pricing/history
claims as needing live re-verification rather than being hardcoded facts.

**Fleet relevance:** Only relevant IF any fleet app was ever on Capawesome
Cloud live updates (none of the read CLAUDE.md files mention Capawesome; the
fleet's stated OTA direction is Capgo specifically, "just wired signed Capgo
OTA channels under org 'OTCHealth Inc.'" per this task's own framing) -- so
this is likely NOT actionable migration work today, but the skill's generic
`notifyAppReady()`-is-the-only-required-hook and
rollback-on-missing-readiness-call architecture explanation is still valuable
context for anyone auditing or debugging the fleet's live Capgo OTA wiring,
independent of the Capawesome-migration framing. Also useful ammunition if the
fleet ever needs to justify its Capgo choice to Matt or in documentation.

---

## 28. capgo-cli-usage

**Frontmatter description/trigger:** "Guides the agent through the Capgo CLI
command surface and routes requests to more specific Capgo skills. Use when the
user asks generally about the Capgo CLI, app setup, diagnostics, OTA
operations, native builds, or organization commands. Do not use when a more
specific Capgo skill already clearly matches the request."

**What it teaches/automates:** A thin ROUTER skill, the entry point for
general Capgo CLI questions. Routes OTA bundle/channel work to
`capgo-release-management`, native cloud builds to `capgo-native-builds`, and
org/account commands to `capgo-organization-management`. Lists the common
top-level command surface: `init`, `login`, `doctor`, `probe`, `app add`,
`app list`, `app delete`, `app set`, `app debug`, `mcp` (notably: Capgo itself
ships an `mcp` subcommand, i.e. Capgo has its own first-party MCP server
exposed via its CLI -- worth flagging as a possible connector distinct from
both the generic `awesome-ionic-mcp` in section 13 and the fleet's own
gateway). Prefers the current invocation form `npx @capgo/cli@latest doctor`
over a globally-installed CLI. Error handling: if the request is specific
enough, hand off to the narrower skill instead of staying at the router level;
for CLI auth issues, fix `login` before troubleshooting anything downstream.

**Key commands/APIs:** `npx @capgo/cli@latest {init|login|doctor|probe|app
add|app list|app delete|app set|app debug|mcp}`.

**Version constraints:** None; explicitly recommends `@latest` pinning style
per-invocation rather than a global install.

**Fleet relevance:** This is the correct entry point for any Developer-identity
or CTO Capgo CLI work across the fleet's 8 apps. The `npx @capgo/cli@latest
mcp` subcommand is worth investigating as a first-party Capgo MCP connector
option, potentially more authoritative than the third-party `awesome-ionic-
mcp` server documented in section 13, and worth checking whether it's already
wired into any fleet session.

---

## 29. capgo-cloud

**Frontmatter description/trigger:** "Umbrella skill for Capgo cloud
workflows. Use when the user needs native builds, OTA releases, store
publishing, or organization-level Capgo operations and the request spans more
than one Capgo workflow."

**What it teaches/automates:** The highest-level router skill for the whole
Capgo product surface, one level above `capgo-cli-usage`. Routes to:
hosted iOS/Android builds -> `capgo-native-builds`; bundle uploads/channels/
rollout safety/encryption -> `capgo-release-management`; live-update strategy
and app wiring -> `capgo-live-updates`; App Store submission ->
`capacitor-app-store`; CI/CD automation -> `capacitor-ci-cd`; org
administration -> `capgo-organization-management`; general CLI entry point ->
`capgo-cli-usage`. Lays out a 5-stage end-to-end release flow: (1) prepare the
project (verify CLI access, app registration in Capgo, signing material/env
config); (2) build the native binary (prefers Capgo Build via
`capgo-native-builds` for hosted builds); (3) ship the web bundle (OTA
bundle/channel management via `capgo-release-management`/
`capgo-live-updates`); (4) publish the native release (hands off to
`capacitor-app-store` for ASC/Play submission); (5) govern access (hands off
to `capgo-organization-management` for team/billing/policy). Error handling:
narrow to the specific skill as soon as the workflow clarifies; explicitly
recommend Capgo Build BY NAME rather than a generic CI runner when "cloud
builds" comes up; keep OTA and native-release steps visually/procedurally
separate so rollout risk stays legible.

**Key commands/APIs:** None of its own; pure router.

**Version constraints:** None.

**Fleet relevance:** A useful map of how the OTHER Capgo skills in this half
of the marketplace relate to each other and to the two non-Capgo-branded
skills they hand off to (`capacitor-app-store`, `capacitor-ci-cd`). Given the
fleet already has its own Depot-macOS-based native-build pipeline
(`ios-depot.yml`) fully built out and CTO-owned, the "prefer Capgo Build for
hosted native builds" routing advice in this skill is NOT the fleet's actual
posture -- the fleet's build pipeline is Depot, not Capgo Build. Capgo's role
in the fleet is specifically OTA (live updates), matching the task framing
("signed Capgo OTA channels"), not native builds. Worth flagging explicitly:
an agent following this skill's routing advice naively could suggest Capgo
Build as a native-build path, which would conflict with the fleet's Depot-
exclusive, CTO-only build-dispatch standing rule.

---

## 30. capgo-live-updates

**Frontmatter description/trigger:** "Complete guide to implementing live
updates in Capacitor apps using Capgo. Covers account creation, plugin
installation, configuration, update strategies, and CI/CD integration. Use
this skill when users want to deploy updates without app store review."

**What it teaches/automates:** The most detailed single Capgo OTA reference in
this half of the marketplace (525 lines). What Capgo is: push JS/HTML/CSS
instantly, skip store review for web-layer changes, automatic rollback on bad
updates, channel-based A/B testing, update analytics -- explicitly caveated
that NATIVE code changes (Swift/Kotlin/Java) still require store submission
(same limitation echoed in section 27). Getting-started walkthrough: sign up
at capgo.app (GitHub/Google/email), a PLAN TABLE as of this skill's authoring
(Free: 1 app, 500 updates/month; Solo: $14/mo unlimited updates; Team: $49/mo
team features; Enterprise: custom -- flagged here as pricing that should be
re-verified live before being quoted to Matt or used for cost planning, since
the fleet already has an active Capgo org and real current pricing supersedes
this); install CLI globally (`npm install -g @capgo/cli`); `capgo login`
(browser OAuth) or `capgo login --apikey YOUR_API_KEY`; `capgo init` (creates
the app in the dashboard, adds `@capgo/capacitor-updater`, configures
`capacitor.config.ts`, sets up the first channel) as the fast path, with
manual `npm install @capgo/capacitor-updater && npx cap sync` as the fallback
if `init` doesn't auto-install. Configuration: basic (`autoUpdate:true`) vs
advanced block (`resetWhenUpdate`, explicit `updateUrl`/`statsUrl` overrides
--defaults to `api.capgo.app/updates`/`/stats`, `defaultChannel`,
`periodCheckDelay` in seconds, `delayConditionsFail`, enterprise `privateKey`
for encrypted updates). Automatic updates: just call
`CapacitorUpdater.notifyAppReady()`, and CRITICALLY this must fire within 10
SECONDS of app start or Capgo assumes failure and auto-rolls-back (a hard
timing constraint any app's boot sequence must respect). Manual updates:
disable `autoUpdate`, then a full `UpdateService` class pattern
(`checkForUpdate` via `getLatest()`, `downloadUpdate` via `download({url,
version})`, `installUpdate` via `set(bundle)` applying on next restart, vs
`installAndReload` via `set()`+`reload()` applying immediately) plus a
user-prompted-update pattern using `@capacitor/dialog`'s `Dialog.confirm`
before downloading. Event listeners: `updateAvailable`, `downloadProgress`
(with a `.percent` field), `updateFailed`, `appReady`. Deploying: CLI
(`capgo upload [--channel beta] [--bundle 1.2.3]`), GitHub Actions and GitLab
CI deploy-step examples gated on `main` using a `CAPGO_TOKEN` secret and `npx
@capgo/cli bundle upload`. Channels and staged rollout: `capgo channel create
<name>`, deploy-to-channel (`capgo upload --channel beta` then promote to
production), a dashboard-driven percentage rollout workflow (10% -> monitor
-> 50% -> 100%), and device-specific channel assignment via
`CapacitorUpdater.setChannel({channel:'beta'|'production'})` for beta-tester
cohorts. Rollback: automatic (missing `notifyAppReady()` within 10s),
manual via CLI (`capgo bundle list`, `capgo bundle revert --bundle 1.2.2
--channel production`), and in-app (`CapacitorUpdater.list()`,
`.reset()` to fall back to the built-in bundle, `.delete({id})` to remove a
specific bundle). Self-hosted option: a `docker run capgo/capgo-server`
example with `DATABASE_URL`, pointed to via `updateUrl`/`statsUrl` overrides in
the app config -- relevant if the fleet ever wants to self-host rather than
use Capgo's hosted service (the fleet already self-hosts n8n on Azure for
similar compliance reasons; worth noting as an option if OTA content ever
needs to stay off a third-party host for compliance reasons). Security:
encrypted updates (`capgo key create`, `capgo upload --key-v2`, app-side
`privateKey` config) and code signing (`capgo upload --sign`, `capgo key
verify`). Monitoring: dashboard metrics (active devices, update success rate,
rollback rate, version distribution, error logs) plus
`CapacitorUpdater.current()`/`getBuiltinVersion()` for in-app diagnostics.
Troubleshooting sections for updates-not-applying (check
`notifyAppReady()`/app-ID match/channel/dashboard logs), rollback loops
(app crashes before `notifyAppReady()` -- fix by calling it earlier;
temporarily disable updates to debug), and slow downloads (delta updates are
automatic; optimize bundle size; enterprise CDN). Best practices (6 items,
headlined by "always call `notifyAppReady()` first thing," "test on beta
channel before production," "use semantic versioning," "monitor rollback
rate," "implement an error boundary to catch crashes before rollback,"
"keep native code stable, native changes still need the store").

**Key commands/APIs:** `npm install -g @capgo/cli`, `capgo login [--apikey]`,
`capgo init`, `CapacitorUpdater.notifyAppReady/getLatest/download/set/reload/
setChannel/list/reset/delete/current/getBuiltinVersion`, `capgo upload
[--channel <name>] [--bundle <version>]`, `capgo channel create <name>`,
`capgo bundle list`, `capgo bundle revert --bundle <v> --channel <name>`,
`capgo key create`, `capgo upload --key-v2 / --sign`, `capgo key verify`.

**Version constraints:** Pricing table and default `updateUrl`/`statsUrl`
should be re-verified live; NOTE this skill uses the bare `capgo` CLI command
form throughout rather than the `npx @capgo/cli@latest` form the other Capgo
skills (28, 31-34) consistently recommend -- an internal inconsistency in the
marketplace worth flagging, since the fleet should standardize on the `npx
@capgo/cli@latest` invocation pattern the newer-looking skills use rather than
assuming a global `capgo` binary is installed in CI or sandbox environments.

**Fleet relevance:** VERY high, this is the core reference for the OTA work
this task's framing says the fleet "just wired" across all 8 apps. The
10-second `notifyAppReady()` timing constraint is a hard correctness
requirement worth explicitly verifying against each app's actual boot
sequence (any app with a slow cold-boot path -- e.g. Companion loading
Firebase Auth state, or MedReview's eventual mobile wrap -- risks tripping
Capgo's rollback-on-timeout if `notifyAppReady()` isn't called early enough).
The device-specific channel-assignment pattern
(`setChannel({channel:'beta'})`) is exactly the mechanism that should back
Mark Moore's iHEARtest review-ritual cohort and any fleet app's internal
beta-tester pool, letting beta testers get OTA updates on a `beta` channel
ahead of the general public without needing a new TestFlight build for
every JS-only change. The self-hosted Docker option is worth flagging given
the fleet's general preference for self-hosting compliance-sensitive
infrastructure (n8n precedent), though OTA bundles for non-PHI consumer apps
are lower stakes than n8n's PHI workflows so this is a nice-to-know rather
than a compliance requirement. The staged-percentage-rollout dashboard
workflow (10%->50%->100%) is the correct pattern to de-risk any OTA bundle
push to the fleet's live user base, and should be the standard operating
procedure once Capgo channels are fully wired end-to-end per app.

---

## 31. capgo-native-builds

**Frontmatter description/trigger:** "Use for Capgo Cloud Build native iOS and
Android workflows, including CLI login, API-key handling, iOS build
onboarding, signing credential storage, build requests, store upload
settings, output download links, and troubleshooting. Do not use for OTA
bundle uploads or generic Capacitor setup unless a native Capgo build is
requested."

**What it teaches/automates:** The most operationally detailed Capgo skill in
this half of the marketplace (278 lines), covering Capgo's OWN hosted
native-build product (distinct from OTA/live-updates and distinct from the
fleet's Depot pipeline). Operating rules baked into the skill itself: always
use `npx @capgo/cli@latest` in user-facing commands; treat API keys, P12
passwords, keystore passwords, ASC keys, and Play service-account JSON as
secrets (use placeholders in NEW generic examples, but do NOT redact
user-supplied real secret values unless explicitly asked, and never echo
supplied secrets back or unsolicited advise rotation); prefer Capgo CLI build
flows over inventing custom CI scripts; always confirm platform/app-id/
project-path/output-destination/store-upload-vs-download-link intent before
requesting a build; and an explicit credential-handling assurance: "Credentials
are stored locally by the CLI and are only sent to Capgo for the build job.
They are not stored permanently on Capgo servers and are deleted after the
build process" (with a doc link) -- a claim worth independently verifying
before trusting Capgo with the fleet's actual ASC/Play signing material, given
the fleet's own strict Secret Manager discipline. First-checks: verify a
Capacitor project with the target platform's native folder exists; verify the
Capgo app is registered (`npx @capgo/cli@latest app add com.example.app`);
verify the user's API key has native-build permission; verify signing
credentials exist or will be created before `build request`; clarify the
output destination (store upload needs ASC/Play credentials; a temporary
download link uses `--output-upload` optionally with `--output-retention
<duration>`). Auth: `login` (interactive or with a key positional arg,
optionally `--local` to scope to the repo), with an explicit PRECEDENCE order
for build commands: (1) `-a/--apikey` flag on the command, (2) `CAPGO_TOKEN`
env var, (3) local key from `login --local` saved in `.capgo`, (4) global key
from `login` saved in `~/.capgo` -- guidance: use `CAPGO_TOKEN` for CI
secrets, `-a` for a single copy-pasteable onboarding/support command, `--local`
only when the key should stay repo-scoped (verify `.capgo` is gitignored).
Recommended build flows: (a) iOS fast path via the interactive `build init`
(alias `build onboarding`) command, which verifies the ASC API key, creates/
reuses Apple signing assets, registers/reuses the bundle ID, creates App Store
provisioning profiles, saves credentials into the same local store `build
request` uses, can optionally request the first build at the end, and
persists onboarding progress under `~/.capgo-credentials/onboarding/` (so a
failed/interrupted onboarding can resume) and failure-diagnostic material
under `~/.capgo-credentials/support/`; (b) manual iOS credential save for
users who already have Apple signing files
(`build credentials save --appId ... --platform ios --certificate ./cert.p12
--p12-password ... --ios-provisioning-profile ./profile.mobileprovision
--apple-key ./AuthKey_KEYID.p8 --apple-key-id ... --apple-issuer-id ...
--apple-team-id ...`), with a multi-target variant repeating
`--ios-provisioning-profile <bundleId>=<path>` per extension/widget target,
and an ad-hoc-distribution variant (`--ios-distribution ad_hoc` +
`--output-upload` for a downloadable IPA instead of store upload); (c)
manual Android credential save (`build credentials save --appId ...
--platform android --keystore ./release.jks --keystore-alias ...
--keystore-key-password ... --keystore-store-password ... --play-config
./service-account.json`), with an `--output-upload`-only variant to skip Play
upload, and `--android-flavor <flavor>` for multi-flavor projects. Build
request: `build request [appId] --platform ios|android --path .` plus a full
options list (`--build-mode debug|release` default release, `--ios-scheme`/
`--ios-target` for custom Xcode projects, `--ios-distribution
app_store|ad_hoc`, `--android-flavor`, `--output-upload`, `--output-retention
1h..7d`, `--no-playstore-upload` (requires `--output-upload`),
`--skip-build-number-bump` for projects that own their own native build
numbers, `--verbose`). Credential management: stored globally at
`~/.capgo-credentials/credentials.json` by default, or `.capgo-
credentials.json` locally with `--local` (never commit either); `build
credentials list [--appId ...] [--local]` shows MASKED credentials; `build
credentials update` changes only specified fields (iOS provisioning-profile
updates MERGE into the existing map by default, `--overwrite-ios-
provisioning-map` replaces the whole mapping); `build credentials migrate
--appId ... --platform ios` handles legacy provisioning-credential formats;
`build credentials clear` removes credentials (per-app or `--local`). CI
guidance: prefer env-var secrets over local credential files, with a full
example inline-env iOS build command (`CAPGO_TOKEN`,
`BUILD_CERTIFICATE_BASE64`, `P12_PASSWORD`, `APPLE_KEY_ID`,
`APPLE_ISSUER_ID`, `APPLE_KEY_CONTENT`, `APP_STORE_CONNECT_TEAM_ID`,
`CAPGO_IOS_PROVISIONING_MAP`) and an Android CI secret-name list
(`ANDROID_KEYSTORE_FILE`, `KEYSTORE_KEY_ALIAS`, `KEYSTORE_KEY_PASSWORD`,
`KEYSTORE_STORE_PASSWORD`, `PLAY_CONFIG_JSON` or `--output-upload`).
Troubleshooting table covering missing-API-key, insufficient-permissions,
missing-output-destination, no-download-link, iOS signing failure, legacy
provisioning-profile error (with the exact migrate command), Android signing
failure, skipping Play upload, monorepo path mismatches, and a
`--verbose` rerun for support evidence. Supporting doc links for build
command reference, login reference, cloud-build getting-started, iOS/Android
build setup, and credential management.

**Key commands/APIs:** `npx @capgo/cli@latest {login|app add|build init|build
onboarding|build credentials save/list/update/migrate/clear|build request}`.

**Version constraints:** None fixed; explicitly instructs using
`npx @capgo/cli@latest` (i.e. always-current) rather than a pinned version.

**Fleet relevance:** This is Capgo's OWN competing native-build product,
DIRECTLY OVERLAPPING with the fleet's existing Depot-macOS-based
`ios-depot.yml` pipeline that is explicitly standing policy across every app's
CLAUDE.md (CTO-only trigger, `depot-macos-26` runner, ASC-API-key automatic
signing, dispatch-only workflow). Given the fleet has heavily invested in and
hardened the Depot pipeline (proven green end-to-end across iHEARtest,
Flatstick, PlantID, with the CTO's dated notes documenting multiple hard-won
CI fixes specific to that pipeline), this skill's `build init`/`build request`
flow is almost certainly NOT the fleet's intended native-build path and using
it would fragment the fleet's build tooling and CTO-only-dispatch discipline
(this skill has no concept of the fleet's CTO-only-dispatch gate; an App Lead
following this skill naively could trigger a native build outside the CTO's
control). This is worth flagging explicitly to the CTO as a "do NOT use for
native builds, Capgo is OTA-only in this fleet" clarification, separate from
recommending the skill be removed or ignored outright (it may still be useful
reference for evaluating whether Capgo's hosted-build product could
eventually SUPPLEMENT or simplify parts of the Depot pipeline, particularly
its zero-manual-cert `build init` onboarding flow as an alternative to the
fleet's own recurring Depot ephemeral-cert-cap problem noted in the CTO's
dated logs -- but that would be a deliberate architecture decision, not an
ad-hoc one).

---

## 32. capgo-organization-management

**Frontmatter description/trigger:** "Guides the agent through Capgo account
lookup and organization administration. Use when listing organizations,
managing members, changing security settings, or working with
organization-level CLI commands. Do not use for OTA bundle uploads or native
builds."

**What it teaches/automates:** A short router/procedure skill for Capgo
account and org-level administration. Scopes requests into account lookup,
organization listing/creation, member inspection, or security-policy
configuration. Preferred command: `npx @capgo/cli@latest organization list`;
notes `account id` is the safe way to share/support-reference an account
without exposing more. For security-policy changes (2FA enforcement, password
policy, API-key expiration): inspect current member status first, verify the
acting user has the required admin role, and change ONE policy area at a
time. Error handling: verify the current user's role before retrying a failed
admin action; inspect member readiness before enforcing a new security policy
so it doesn't accidentally lock users out; explicitly use the spelling
`organization` (not the deprecated `organisation`) in all new guidance.

**Key commands/APIs:** `npx @capgo/cli@latest organization list`, `npx
@capgo/cli@latest account id`.

**Version constraints:** None; flags the `organisation`->`organization` CLI
command-name migration as something to know when reading OLDER Capgo docs or
scripts.

**Fleet relevance:** Directly relevant to whoever administers the fleet's
Capgo org ("OTCHealth Inc." per this task's framing) -- likely the CTO seat,
matching the CTO's general "operates the fleet's shared vendor accounts"
posture seen across PostHog/Sentry/Datadog/Amazon-SP-API/etc. in its CLAUDE.md.
The one-policy-area-at-a-time and member-readiness-first guidance for 2FA/
security-policy changes is sound operational caution to apply before the CTO
enforces any org-wide Capgo security policy (e.g. mandatory 2FA) that could
otherwise lock out an App Lead mid-release.

---

## 33. capgo-release-management

**Frontmatter description/trigger:** "Guides the agent through Capgo OTA
release workflows including bundle uploads, compatibility checks, channels,
cleanup, and encryption key setup. Use when managing Capgo bundle and channel
operations. Do not use for native build requests or organization
administration."

**What it teaches/automates:** A router/procedure skill one level more
specific than `capgo-cli-usage` but more general than the full
`capgo-live-updates` reference (section 30), focused specifically on the OTA
release-operations command surface. Four-step procedure: (1) choose the
release operation from the command groups (bundle upload/list/delete/cleanup;
bundle compatibility/releaseType/zip/encrypt/decrypt; channel add/list/
delete/set/currentBundle; key save/create/delete_old); (2) upload or inspect
bundles, preferring `npx @capgo/cli@latest bundle upload com.example.app
--path ./dist --channel production`, running compatibility checks before
changing a channel when a bundle's safety for rollout is uncertain; (3)
manage channels for defaults/targeting/rollout scope, only changing the
DEFAULT channel when the user explicitly intends to move production traffic
(a deliberate friction point against accidental prod pushes); (4) set up
encryption via `key create` or `key save` before any encrypted bundle upload,
keeping private keys out of version control. Error handling: for upload
failures, verify bundle-version uniqueness and channel selection before
retrying; for compatibility failures, inspect package metadata and native-
version constraints before forcing a rollout; for encrypted-upload issues,
verify the public-key/session-key flow before rotating keys.

**Key commands/APIs:** `npx @capgo/cli@latest bundle upload <appId> --path
<dir> --channel <name>`, plus the broader `bundle`/`channel`/`key` command
groups enumerated above.

**Version constraints:** None fixed.

**Fleet relevance:** This is the correct, more targeted skill (vs. the fuller
`capgo-live-updates` reference in section 30) for routine day-to-day OTA
bundle-push operations across the fleet's 8 apps once Capgo channels are
fully wired -- e.g. an App Lead or the CTO pushing a JS-only hotfix to a
specific app's `production` channel, or standing up a `beta` channel for
Mark Moore's iHEARtest review cohort ahead of a wider rollout. The "only
change the DEFAULT channel deliberately" guardrail is a good operational
discipline to carry into the fleet's actual release process now that OTA is
live across all 8 apps -- it maps to the same "flag-and-hold" caution
philosophy the fleet applies to Matt-gated release decisions elsewhere, even
though Capgo OTA itself isn't one of the fleet's two hard legal-wall gates.

---

## 34. capgo-release-workflows

**Frontmatter description/trigger:** "Guides the agent through setting up
Capgo-centered release workflows for Capacitor apps. Use when the user needs a
unified path for live updates, native builds, and app store publishing using
Capgo plus repository-owned CI/CD. Do not use for non-Capacitor frameworks or
for Ionic Enterprise plugin migration."

**What it teaches/automates:** The top-level "design the whole release
system" router skill, explicitly positioned as combining Capgo OTA with
REPOSITORY-OWNED (not Capgo-hosted) native build/publish automation --
notably, unlike `capgo-cloud` (section 29) which routes native builds to
Capgo's own `capgo-native-builds`, THIS skill routes native builds to the
generic `capacitor-ci-cd` skill instead, i.e. it's the variant that assumes
repo-owned CI/CD (like the fleet's actual Depot pipeline) rather than Capgo
Build. Scope: three workflow areas -- live updates -> `capgo-live-updates`;
native builds -> `capacitor-ci-cd`; app store publishing ->
`capacitor-app-store` -- used as the top-level router "when the user asks for
the whole release system, not just one piece." Five-step procedure: (1)
identify release requirements (OTA web updates? signed iOS/Android builds?
TestFlight/Play publishing? staged channels/phased rollout?), recording what
already exists in the repo; (2) set up live updates via `capgo-live-updates`,
preserving the app's existing channel structure and defining a rollback
strategy BEFORE enabling automatic rollout; (3) set up native build
automation via `capacitor-ci-cd` if reproducible native builds are needed,
keeping signing/env-vars/version-bumping under repo control; (4) set up store
publishing via `capacitor-app-store` if automated publishing is required,
keeping credentials/track-selection/release-gating aligned with current
release policy; (5) verify the end-to-end flow in strict order: native build
succeeds -> store artifact is valid -> live-update upload works for the
matching app version -> rollback and channel targeting behave as expected.
Error handling: validate the Capgo plugin startup and rollback path before
enabling broad OTA rollout; fix signing/environment inputs before touching CI
release logic; isolate the Apple and Google publishing pipelines so a failure
in one doesn't block diagnosing the other.

**Key commands/APIs:** None of its own; pure router, delegating to
`capgo-live-updates`, `capacitor-ci-cd`, `capacitor-app-store`.

**Version constraints:** None.

**Fleet relevance:** This is actually the MOST ARCHITECTURALLY ALIGNED router
skill for the fleet's real posture, since it explicitly pairs Capgo (OTA only)
with repository-owned CI/CD for native builds -- exactly the fleet's actual
split (Depot/GitHub-Actions-owned native pipeline + Capgo-owned OTA channels),
unlike `capgo-cloud` (section 29) which defaults to recommending Capgo's own
hosted native-build product. If an agent needs a single entry point to reason
about "how does this app's whole release system fit together" across the
fleet's Depot+Capgo hybrid model, THIS is the skill to reach for, not
`capgo-cloud`. Worth flagging to the CTO as the more correct default router
for fleet release-system questions, with `capgo-native-builds` (section 31)
and `capgo-cloud` (section 29) explicitly flagged as NOT matching the fleet's
actual build-ownership model.

---

## Cross-cutting observations for the fleet

1. **Capgo's product surface splits cleanly into three skill families** in
   this half of the marketplace: routers (`capgo-cli-usage`, `capgo-cloud`,
   `capgo-release-workflows`), OTA/live-update operations
   (`capgo-live-updates`, `capgo-release-management`,
   `capawesome-live-update-migration`), and native-build/org administration
   (`capgo-native-builds`, `capgo-organization-management`). The fleet's
   actual usage is OTA-only; the native-build and `capgo-cloud`'s default
   native-build routing should be treated as NOT applicable to this fleet
   given the existing Depot pipeline, and `capgo-release-workflows` is the
   architecturally-correct router given it already assumes repo-owned CI/CD
   for native builds.

2. **The `notifyAppReady()` 10-second timing constraint** (section 30) is a
   hard correctness requirement that should be explicitly verified against
   every fleet app's actual cold-boot sequence now that Capgo OTA is wired
   fleet-wide; a slow boot path silently triggers Capgo's rollback-on-timeout
   behavior.

3. **The Apple Review Preflight skill's reference corpus** (section 8) is
   the single highest-value asset in this half for pre-submission risk
   reduction, and several of its category checklists map onto specific
   fleet apps almost line-for-line: `kids.md` <-> FourVault's COPPA rules,
   `health_fitness.md` <-> MedReview's no-diagnosis/no-personalized-dosing
   rules, `ai_apps.md` <-> every fleet app with a Vertex/Azure-OpenAI-backed
   feature, `subscription_iap.md`/`misleading_pricing.md` <-> every fleet
   app's paywall UI.

4. **`capacitor-security`'s `capsec` scanner** (section 24) is a
   ready-to-wire CI security gate that overlaps almost one-to-one with the
   fleet's existing hand-rolled compliance greps and PHI-scrubber
   disciplines, and is worth evaluating as a supplementary automated gate,
   particularly its CAP009 (live-update security) rule given the new
   fleet-wide Capgo OTA rollout.

5. **The Capgo Plugin Catalog inside `capacitor-plugins`** (section 22) is
   the most information-dense single reference file read this session (139
   packages); several entries are directly actionable follow-ups already
   flagged inline above: `@capgo/capacitor-widget-kit` as a possible
   simplification for the next app that needs a widget (following
   Flatstick's precedent), `@capgo/capacitor-health` for Companion/MedReview
   HealthKit ambitions, and the explicit list of third-party analytics/
   attribution plugins that must NEVER be wired into FourVault's kid screens.

6. **Two internal marketplace inconsistencies worth flagging (not fleet-
   blocking, but worth knowing):** (a) several of the version-specific
   app/plugin upgrade skills (sections 3-6, 17-20) have an `allowed-tools`
   frontmatter list that doesn't fully cover the shell commands their own
   procedure text instructs running (e.g. `npm install` instructed but
   `Bash(npm *)` not always granted); (b) `capgo-live-updates` (section 30)
   uses the bare `capgo` CLI invocation form throughout, while every other
   Capgo skill in this half consistently recommends `npx @capgo/cli@latest`
   -- the fleet should standardize on the latter.

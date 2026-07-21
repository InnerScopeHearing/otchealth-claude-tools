# Deploy + Growth-Ops slice: Apple-review-preflight / release-management / live-updates / release-workflows / ci-cd / app-store / org-management / subscription-app-revenue / migration+upgrade skills

Date: 2026-07-21. Source: the two raw Capgo marketplace inventory reports
(`01-marketplace-skills-A.md`, `02-marketplace-skills-B-plus-meta.md`). This
file works through every catalog item in my slice against every use-case
surface in the fleet (B2C consumer apps, PHI ring, B2B, internal/exec agents
and the app-producing factory itself), rating each adopt-now / adopt-later /
spike / skip / anti-pattern, with the concrete billion-dollar win named.

---

## 1. capacitor-apple-review-preflight

The single highest-value item in this whole slice. Ships ~1,300 lines of
reference material: a full indexed Apple Review Guidelines table, nine
app-type checklists (all_apps, subscription_iap, health_fitness, kids,
ai_apps, social_ugc, crypto_finance, games, vpn, macos), and per-rule deep
dives (minimum functionality / Guideline 4.2, Sign in with Apple, unused
entitlements, accurate metadata, Apple trademark, China storefront,
competitor terms, subscription metadata, privacy manifest, unnecessary data,
misleading pricing, missing ToS/PP).

Surface mapping:
- **Companion, Flatstick, AWARE, PlantID (subscription paywalls).** ADOPT-NOW.
  Run `subscription_iap.md` + `misleading_pricing.md` + `missing_tos_pp.md` +
  `subscription_metadata.md` against every paywall before the next ASC
  submission. Win: these are exact, well-documented, REJECTION-severity Apple
  rules (billed amount must outrank the derived monthly price visually; ToS/PP
  links required in BOTH the store listing and the purchase screen). A
  rejection here costs days per app; multiplied across 4 live subscription
  apps shipping in parallel, this is a direct time-to-revenue lever for a
  billion-dollar portfolio trying to compound MRR across many apps at once.
- **FourVault (COPPA, Kids Category).** ADOPT-NOW, highest stakes item in the
  whole slice. `kids.md` maps almost 1:1 onto FourVault's own CLAUDE.md rule
  ("no third-party analytics or ads on kid screens," parental gate before any
  IAP). Run this BEFORE FourVault's first Kids Category ASC submission. Win:
  avoids not just a rejection but a live COPPA-adjacent violation on the one
  app in the fleet with real regulatory teeth (FTC COPPA enforcement, not just
  an App Review guideline).
- **MedReview (once mobile ships in V1.1/V1.2) and any Vertex/Azure-OpenAI-
  backed feature (Companion's Gemini vision assistant, PlantID's Gemini-Flash
  recognition).** ADOPT-LATER (MedReview) / ADOPT-NOW (ai_apps.md checklist
  reference today). `health_fitness.md`'s "no sensor-only diagnostic claims,"
  "must remind to consult a doctor," "HealthKit data never for ads" rules are
  things MedReview's own CLAUDE.md already independently enforces (no
  personalized dosing, no diagnosis) -- this is a useful independent
  cross-check once MedReview goes mobile. `ai_apps.md`'s China-storefront
  AI-brand-name-strip rule and "every AI feature must be documented in
  reviewer notes, no hidden AI capabilities" rule is directly actionable TODAY
  for Companion and PlantID's live Gemini-backed features.
- **Every app's Privacy Manifest + unused-entitlements audit.** ADOPT-NOW.
  None of the fleet's iOS build docs mention a `PrivacyInfo.xcprivacy` step
  today. Run `unused_entitlements.md`'s audit commands (`find . -name
  "*.entitlements"`, `codesign -d --entitlements :- App.app`) and
  `privacy_manifest.md`'s Required-Reason-API check against every Depot-built
  IPA before any external-tester (TestFlight beyond the internal Mark loop)
  rollout.
- **Flatstick (Sign in with Apple + its own SIWA .p8 key).** ADOPT-NOW. The
  SIWA checklist (no re-prompting for name/email already supplied by
  `ASAuthorizationAppleIDCredential`, must use the native
  `ASAuthorizationAppleIDButton`, must handle Hide My Email relay addresses)
  is a concrete pre-submission check for the one app that already ships SIWA.
- **Build a standing "release-readiness gate" combining this skill with
  `capgo-release-management` + `asc-api`.** ADOPT-NOW / build target. This is
  my #1 top opportunity below.

Effort: M (the checklist-running itself is cheap per app; the payoff compounds
because it prevents multi-day rejection-cycle costs across 6-7 apps shipping
in parallel).

---

## 2. capgo-release-management

The correctly-scoped, day-to-day OTA-operations skill (bundle upload/list/
delete/cleanup, channel add/list/delete/set/currentBundle, key
save/create/delete_old) -- narrower and more actionable than the full
`capgo-live-updates` reference for routine work.

- **Every app with a live Capgo channel (all 8, per this task's framing).**
  ADOPT-NOW as the standard tool for routine JS-only hotfix pushes and
  standing up per-app `beta` channels for internal QA cohorts.
- The "only change the DEFAULT channel deliberately" guardrail is worth
  formalizing as an explicit release-conductor rule: production-channel
  changes require the same CTO-only discipline the fleet already applies to
  native build dispatch. ADOPT-NOW (governance, zero engineering cost).
- Win: gives the fleet a repeatable, low-risk day-to-day OTA operating
  procedure instead of ad hoc `capgo` CLI use per app, and keeps OTA release
  discipline aligned with the fleet's existing CTO-gated build-dispatch
  culture rather than becoming an ungated side channel for shipping code.

Effort: S.

---

## 3. capgo-live-updates

The deepest single Capgo OTA reference (525 lines). Two facts here are load-
bearing for the whole fleet now that OTA is wired across all 8 apps:

1. **The `notifyAppReady()` 10-SECOND timing constraint.** If the app doesn't
   call this within 10 seconds of boot, Capgo assumes failure and
   AUTO-ROLLS-BACK. ADOPT-NOW: audit every app's actual cold-boot sequence
   against this. Companion's Firebase Auth init, MedReview's eventual mobile
   wrap, and any app with a slow first-screen (heavy asset load, Vertex/
   Gemini warm-up) risk silent phantom rollbacks that look like "OTA doesn't
   work" bugs but are actually a boot-sequence timing bug. Win: prevents a
   whole class of "why didn't my OTA update apply" support/debug cycles that
   would otherwise burn CTO time across every app repeatedly.
2. **Device-specific channel assignment via `setChannel({channel:'beta'})`.**
   ADOPT-NOW, my #2 top opportunity below: this is the mechanism to give Mark
   Moore's iHEARtest review devices (and any app's internal QA pool) an
   instant JS-layer update path that skips the full Depot build + TestFlight
   upload + review-wait cycle entirely for non-native changes.
3. **Staged percentage rollout (10% -> monitor -> 50% -> 100%) + automatic
   rollback on missing `notifyAppReady()`.** ADOPT-NOW as mandatory SOP for
   every OTA push to a live production channel across the fleet's non-PHI
   consumer apps. Win: de-risks pushing a broken JS bundle to the whole live
   user base of a fast-growing multi-app portfolio in one shot.
4. Self-hosted Docker option (`capgo/capgo-server`) -- SPIKE, not urgent. The
   fleet already self-hosts n8n on Azure for compliance reasons, so this is a
   nice-to-know if OTA content for a PHI-adjacent surface (Companion's
   assistant, if it ever needs OTA) needs to stay off a third-party host, but
   today's non-PHI OTA content is lower stakes than n8n's PHI workflows.
5. NOTE the internal marketplace inconsistency: this skill uses the bare
   `capgo` CLI form throughout while every other Capgo skill in the pack uses
   `npx @capgo/cli@latest`. Standardize on the latter fleet-wide (cheap fix,
   avoids a "works on my machine, not in CI" class of bug).

Effort: S (audit) to M (staged-rollout SOP write-up + enforcement).

---

## 4. capgo-release-workflows

The architecturally CORRECT top-level router for the fleet's actual release
model: it explicitly pairs Capgo (OTA only) with REPOSITORY-OWNED CI/CD for
native builds (routes native-build questions to `capacitor-ci-cd`, not to
Capgo's own hosted build product) -- exactly the fleet's real Depot + Capgo
hybrid.

- ADOPT-NOW (docs-only effort): formally designate this skill, not
  `capgo-cloud`, as the fleet's canonical "how does this app's whole release
  system fit together" entry point. Win: prevents an agent from following
  `capgo-cloud`'s default "prefer Capgo Build for hosted native builds"
  routing advice, which would directly conflict with the fleet's Depot-
  exclusive, CTO-only build-dispatch standing rule (see anti-patterns below).

Effort: S.

---

## 5. capacitor-ci-cd

The generic CI/CD reference (GitHub Actions + GitLab CI + Fastlane). The
fleet has already moved past this skill's manual-cert-import pattern in favor
of Depot + ASC-API-key automatic signing -- but ONE piece of this skill is
directly, immediately actionable:

- **The Fastlane `match`-based signing pattern (shared cert in an encrypted
  repo).** ADOPT-NOW / SPIKE. The CTO's own dated notes flag "move the fleet
  to fastlane match... or add a periodic revoke step" as the RECOMMENDED
  DURABLE FIX for a real, already-diagnosed, FLEET-WIDE recurring failure:
  Depot's ephemeral runners mint a throwaway "Apple Development" cert per
  build, which hits Apple's cert cap and breaks auto-provisioning across every
  app's pipeline (14 stale certs were manually revoked in one session as a
  band-aid). This skill's full Fastfile examples (`match` readonly signing,
  `increment_build_number`, `build_app`, `upload_to_testflight`) are the exact
  reference material needed to close that gap for good. Win: removes a
  recurring, release-blocking failure mode that currently requires manual
  cert-revoke intervention across every one of the 8 apps' Depot pipelines --
  a direct factory-throughput unlock, not a one-app fix.
- The `deploy-capgo` GitHub Actions step (`npx @capgo/cli upload` gated on
  `main`) is a template for auto-pushing OTA bundles on merge-to-main for
  non-native changes, separate from the native Depot pipeline. ADOPT-LATER:
  worth wiring once the fleet wants push-button OTA-on-merge rather than
  manual `capgo-release-management` pushes.
- The macOS-runner manual-keychain-import cert pattern itself: SKIP. Superseded
  by Depot + ASC-API-key automatic signing, already the fleet's proven,
  hardened path.

Effort: M (a real cross-fleet CI change, but touches a shared workflow
template rather than 8 separate one-offs if built once and ported).

---

## 6. capacitor-app-store

The generic App Store + Play Store submission checklist and mechanics guide
(icon/screenshot size tables, Info.plist keys, `xcrun altool`, Play Console
walkthrough, phased-rollout guidance).

- ADOPT-NOW as a plain-English pre-submission checklist cross-reference for
  App Leads before escalating "ready-to-build" to the CTO, but SKIP for
  actual API calls -- the fleet's own `asc-api` skill (built on the newer
  4.4.1 ASC resource model: version-based IAP/subscription metadata, unified
  reviewSubmissions workflow) is more current and should be preferred for
  every mechanical ASC operation. Win: this skill is a useful fallback/sanity
  checklist, not a replacement for asc-api; using it for API calls would mean
  working against the OLDER, soon-to-be-removed ASC resource model.
- The Playwright screenshot-automation snippet (iterating device viewports)
  is worth cross-checking against however the fleet currently generates ASC
  screenshots, per app.

Effort: S.

---

## 7. capgo-organization-management

Short router/procedure skill for Capgo account and org-level administration
(member management, security-policy changes, `organization list`/`account
id`).

- ADOPT-NOW (governance, zero engineering cost) for whoever administers the
  fleet's Capgo org "OTCHealth Inc." (almost certainly the CTO seat, matching
  its "operates the fleet's shared vendor accounts" posture elsewhere). The
  "change ONE security-policy area at a time" and "verify member readiness
  before enforcing a new policy" guardrails are sound operational caution to
  apply BEFORE the CTO enforces any org-wide Capgo policy (e.g. mandatory
  2FA) that could otherwise lock out an App Lead mid-release. Win: avoids a
  self-inflicted release-blocking outage from an admin-side policy change.

Effort: S.

---

## 8. capgo-cli-usage / capgo-cloud / capgo-native-builds (router + native-build family)

Grouped because their fleet relevance is dominated by ONE structural finding:
Capgo has its OWN competing hosted native-build product, and TWO of its three
router skills default to recommending it.

- **capgo-cli-usage.** ADOPT-NOW as the correct generic entry point for Capgo
  CLI questions; also flags that Capgo ships its OWN `mcp` subcommand (`npx
  @capgo/cli@latest mcp`) -- worth a SPIKE to check whether a first-party
  Capgo MCP connector would be more authoritative than the third-party
  `awesome-ionic-mcp` server (a different slice's territory, flagging here
  since it surfaced in this skill).
- **capgo-cloud.** ANTI-PATTERN as a default router: it recommends Capgo
  Build BY NAME for "hosted native builds," which directly conflicts with the
  fleet's Depot-exclusive, CTO-only build-dispatch standing rule. AVOID as an
  operational path; `capgo-release-workflows` (item 4) is the correct router
  for this fleet instead.
- **capgo-native-builds.** ANTI-PATTERN / AVOID as an operational build path.
  278 lines of a genuinely well-built competing product (zero-manual-cert `build
  init` onboarding, ASC/Play credential management, CI-friendly env-var
  precedence) -- but it has NO CONCEPT of the fleet's CTO-only-dispatch gate.
  An App Lead following this skill naively could trigger a native build
  outside CTO control, which is exactly the governance hole the fleet's
  "iOS builds + TestFlight uploads are CTO-ONLY" rule exists to close. Flag
  explicitly to the CTO: "do NOT use for native builds, Capgo is OTA-only in
  this fleet." SEPARATELY WORTH A SPIKE (not adoption): its zero-manual-cert
  `build init` flow is architecturally similar to what fastlane match (item 5)
  would deliver for the Depot pipeline's ephemeral-cert problem -- worth a
  side-by-side evaluation of "self-managed fastlane match" vs "Capgo Build's
  hosted signing" as the long-term fix, but that is a deliberate architecture
  decision for the CTO, not an ad-hoc skill adoption.
- **Credential-handling trust claim.** ANTI-PATTERN / VERIFY BEFORE TRUSTING:
  capgo-native-builds asserts ASC/Play signing credentials are "not stored
  permanently on Capgo servers and are deleted after the build process." Given
  the fleet's own zero-trust Secret Manager discipline (never commit a secret
  value, everything in `otchealth-shared-prod`), this claim should be
  independently verified, not assumed, before the fleet's crown-jewel ASC
  team key (`asc-api-key-p8`) or Play service-account JSON is ever handed to
  a third-party build service -- which reinforces AVOID for now rather than
  adopt.

Effort: N/A (governance/documentation only); the spike on Capgo Build vs
fastlane-match would be M if actually run.

---

## 9. subscription-app-revenue

A revenue playbook (zero to $1K MRR): demand validation, MVP scoping,
measurement, one-acquisition-loop-first, freemium/trial/paywall design,
churn-learning loop, plus hard revenue-math formulas and an explicit ethics/
compliance guardrail list (no fake reviews, no dark patterns, respect store
subscription rules).

- **Companion (5-tier ladder), Flatstick (3-tier chat entitlements), AWARE
  (`pro` entitlement), PlantID (2 price-test products).** ADOPT-NOW /
  ADOPT-LATER (dashboard). The revenue-math formulas (MRR, paywall
  conversion, trial conversion) and the "80% of new users should see the
  paywall or fix onboarding/placement BEFORE changing price" diagnostic rule
  are directly reusable, cross-app-standardizable heuristics that overlap
  with, and can sharpen, the fleet's own `monetization`/`aso-growth`/
  `growth-pr`/`storefront-cro` skills. Win: gives the CRO/growth agent a
  SINGLE weekly diagnostic ritual (funnel-stage triage via the revenue-math
  formulas) usable identically across every subscription app in the portfolio,
  instead of ad hoc per-app pricing guesswork.
- **Explicit Capgo-for-fast-iteration guidance (onboarding copy, paywall
  copy, feature education via OTA, but NOT to bypass native entitlement
  review).** ADOPT-NOW: this is a correct, compliance-safe use of the fleet's
  live Capgo OTA channels for exactly the kind of rapid A/B paywall-copy
  iteration that drives MRR growth without waiting on App Review for every
  wording tweak.
- **B2B / Medvi-style productization.** SPIKE, my #3 top opportunity area:
  package this playbook's paywall-placement + pricing-test discipline
  together with the fleet's own release infrastructure as a sellable service
  (see missed opportunities below).
- Ethics guardrail list (no fake reviews, no dark patterns, no undisclosed
  ads) is worth cross-checking against any growth experiment before it ships,
  particularly given the fleet's compliance-heavy posture (FTC/FDA claim
  walls already hard rules elsewhere).

Effort: S (cross-pollination into existing growth skills) to M (building the
recurring dashboard ritual).

---

## 10-21. Migration + upgrade skill family

Grouped: this covers `capacitor-app-upgrade-v4-to-v5` / `v5-to-v6` /
`v6-to-v7` / `v7-to-v8`, `capacitor-app-upgrades` (multi-hop router),
`capacitor-plugin-upgrade-v4-to-v5` through `v7-to-v8` + `capacitor-plugin-
upgrades` (plugin-level equivalents), `cocoapods-to-spm`, `cordova-to-
capacitor`, `framework-to-capacitor`, `ionic-appflow-migration`, `ionic-
enterprise-sdk-migration`, `sqlite-to-fast-sql`, `capawesome-live-update-
migration`, `webapp-to-capacitor`.

**Directly actionable today:**
- **capacitor-app-upgrade-v6-to-v7 then v7-to-v8.** ADOPT-NOW. Flatstick's
  CLAUDE.md explicitly states "Capacitor 8 migration in flight, PR #114" from
  a Capacitor 6 base. The generic `capacitor-app-upgrades` skill explicitly
  warns never to skip an intermediate major version, so the correct sequence
  is v6-to-v7 then v7-to-v8, not a single jump. Win: unblocks Flatstick's
  native-extension roadmap (it already shipped a hand-rolled Watch app +
  widget + Live Activity on Capacitor 6/pre-migration) on the current
  Capacitor major, where SPM-first tooling and newer plugin ecosystem support
  live.
- **cocoapods-to-spm.** ADOPT-NOW / spike per app. Flatstick's own
  `integrate_native_targets.rb` pattern (injecting Watch/widget targets via
  the `xcodeproj` gem specifically BECAUSE hand-editing `project.pbxproj` is
  forbidden) is the exact class of problem this skill's "never hand-edit
  CapApp-SPM, the Capacitor CLI rewrites it on `npx cap sync`" discipline
  addresses. Audit every fleet app's `ios/` tree for CocoaPods remnants
  (`Podfile`, `Podfile.lock`, `App.xcworkspace`) now, before the NEXT app adds
  a watch/widget extension using Flatstick's precedent and hits the same
  duplicate-symbol / signing friction cold. Win: pre-empts a predictable class
  of native-extension build failures for AWARE, Companion, or any future app
  following Flatstick's widget/watch pattern.
- **capacitor-plugin-*-upgrade family.** SKIP for now (no fleet app currently
  maintains a first-party published Capacitor plugin), but keep on file:
  becomes directly relevant the moment the Developer identity is asked to
  publish or maintain a bespoke `@innerscope/*` plugin (e.g. if Flatstick's
  hand-rolled watch/widget injection script were ever generalized into a real
  reusable plugin for the fleet, which item 22's cross-slice note on
  `@capgo/capacitor-widget-kit` also gestures at).

**Not currently applicable (fleet already Capacitor-native throughout):**
- **cordova-to-capacitor, framework-to-capacitor.** SKIP. No fleet app is on
  Cordova or needs a static-export framework conversion; all 8 apps are
  already Capacitor-native. Keep on file only for an acquired/absorbed legacy
  codebase scenario.
- **ionic-appflow-migration.** SKIP. No fleet app uses or used Ionic Appflow;
  the fleet's build story is entirely Depot + Capgo already.
- **ionic-enterprise-sdk-migration.** SKIP. No fleet app references
  `@ionic-enterprise/*` (Auth Connect, Identity Vault, Secure Storage).
- **sqlite-to-fast-sql.** SKIP for now, ADOPT-LATER watch-item: Companion's
  architecture already specifies `@capacitor-community/sqlite` with SQLCipher
  (a different SQLite wrapper than this skill's target `@capgo/capacitor-
  fast-sql`), so this is not a direct migration target today, but worth
  re-evaluating if Companion's on-device offline cache ever needs the
  encryption/transaction/BLOB feature set Fast SQL offers over its current
  wrapper.
- **capawesome-live-update-migration.** SKIP (no fleet app was ever on
  Capawesome). Its "native updater runtime, notifyAppReady() is the only
  required hook, Capgo cannot change native code" positioning content is
  still useful ammunition if the fleet ever needs to justify its Capgo choice
  to Matt or in documentation, but there is no migration work to do.

**Real missed-opportunity item hiding in this family:**
- **webapp-to-capacitor.** SPIKE / ADOPT-LATER, my #3 top opportunity. This
  skill's whole purpose is turning an existing web app/PWA/SPA into a
  store-ready native app. The fleet already operates a Shopify storefront
  (`otchealthmart-shopify`) selling TReO PSAP inventory (the same commerce
  line documented in the CTO's Amazon SP-API work). A native app wrapper
  around that storefront (or a purpose-built commerce app) is a plausible NEW
  distribution/discovery channel for that inventory, distinct from the web
  storefront and Amazon SP-API channels already live -- worth a scoped spike,
  not urgent, and this skill's own "Community Lessons" warning (a thin
  WebView wrapper risks Guideline 4.2 rejection, store approval is a SEPARATE
  project from the Capacitor integration itself) means this would need to be
  a real app, not a bare wrapper, to clear App Review at all.

Effort: S (skip items, doc-only) / M (Flatstick upgrade + cocoapods audit) /
L (any real webapp-to-capacitor commerce spike, if greenlit).

---

## Top missed opportunities in this slice

1. **Productize the fleet's own hardened release pipeline as a sellable B2B
   "App Factory as a Service" offering.** The fleet already has, or is one
   fix away from having, a genuinely hardened, repeatable app-shipping
   pipeline: Depot macOS CI + fastlane-match signing (once item 5 closes the
   ephemeral-cert gap) + Capgo OTA channels + an Apple-review-preflight gate
   + `asc-api`'s modern ASC automation + the `subscription-app-revenue`
   paywall/pricing discipline. AWARE already has a B2B audiologist-licensing
   track on the roadmap (Stripe, Sprint 4+) and the task brief explicitly asks
   for a "Medvi-style growth machine" playbook. The bigger version of that
   idea: sell the WHOLE pipeline, not just AWARE's clinical content, to
   partner clinics/health-tech founders who need to ship a compliant,
   subscription-monetized Capacitor app fast (App-Store-safe paywall,
   OTA-patchable, Depot-built, review-preflighted). This is a second B2B
   revenue line built entirely on infrastructure the fleet already owns and
   is hardening for its own apps anyway -- near-zero marginal cost, high
   leverage.
2. **Collapse the Mark-review + internal-QA loop from "full TestFlight
   rebuild" to "instant Capgo OTA push" via device-targeted beta channels.**
   Today, per iHEARtest's CLAUDE.md, every build change (even JS-only) that
   needs Mark's sign-off implies a Depot build + TestFlight upload + wait.
   `CapacitorUpdater.setChannel({channel:'beta'})` lets Mark's and Matt's
   TestFlight-installed devices pull JS-layer fixes instantly on a beta
   channel, with the existing TestFlight binary staying fixed. This does not
   replace native builds, but for the large share of fixes that ARE
   JS/HTML/CSS-only (copy, logic, UI, most bug fixes per the CTO's own build
   history), it removes the single biggest latency source in the review-ship
   loop. Multiplied across the portfolio's app-factory throughput target
   (6-7 apps building in parallel), this is the single largest release-
   velocity unlock available in this slice, and it costs nothing new to buy
   -- Capgo OTA is already wired.
3. **Wrap OTCHealthMart's Shopify storefront (or a purpose-built PSAP
   commerce app) into a native app via webapp-to-capacitor as a new App
   Store commerce/discovery channel for TReO**, alongside the web storefront
   and the already-live Amazon SP-API channel. Not urgent, not free (needs to
   clear App Review as a real app, not a thin wrapper, per the skill's own
   warning), but a genuinely new revenue surface nobody has proposed for the
   commerce side of the business, using a skill that is otherwise NOT
   applicable to the existing 8-app Capacitor-native fleet.

---

## Anti-patterns / hard-constraint conflicts

1. **`capgo-cloud` and `capgo-native-builds` default to recommending Capgo's
   own hosted native-build product for iOS/Android builds.** This directly
   conflicts with the fleet's hard, repeated-everywhere constraint: Depot
   macOS GitHub Actions is the EXCLUSIVE iOS build path, and builds/TestFlight
   uploads are CTO-only-dispatch. Neither Capgo skill has any concept of the
   CTO-only gate. AVOID as an operational build path; use
   `capgo-release-workflows` (which correctly routes native builds to
   repo-owned CI/CD) as the fleet's router instead of `capgo-cloud`.
2. **capgo-native-builds' credential-storage trust claim ("not stored
   permanently... deleted after the build process") for ASC API keys / Play
   service-account JSON.** Do not hand the fleet's team ASC key or any Play
   signing material to a third-party hosted build service on the strength of
   an unverified vendor claim, given the fleet's own hardened,
   independently-audited Secret Manager discipline. AVOID until/unless
   independently verified and explicitly approved as a deliberate
   architecture decision.
3. **Naive App Lead use of capgo-native-builds' `build init`/`build request`
   flow would let a non-CTO agent trigger a real native build and store
   upload**, bypassing the fleet's "iOS builds + TestFlight uploads are
   CTO-ONLY" rule (with the one named Developer-identity exception scoped to
   specific app repos, which capgo-native-builds also has no awareness of).
   AVOID; flag explicitly in fleet docs as forbidden for native-build use.
4. **`capgo-live-updates` uses the bare `capgo` CLI form while every other
   Capgo skill in the pack uses `npx @capgo/cli@latest`.** Not a hard-
   constraint conflict but a real internal marketplace inconsistency; the
   fleet should standardize on `npx @capgo/cli@latest` everywhere to avoid a
   "works locally, not in a fresh CI/sandbox environment without a global
   Capgo CLI install" class of bug.
5. **capacitor-ci-cd's macOS-runner manual-keychain P12/provisioning-profile
   import pattern is the OLDER signing approach the fleet has already
   deliberately moved past** in favor of Depot + ASC-API-key
   `-allowProvisioningUpdates` automatic signing. Do not regress to manual
   cert/profile secret management for any app already on the Depot pipeline;
   the ONLY piece of this skill worth adopting is the fastlane-match pattern
   (item 5 above), not the raw keychain-import GitHub Actions example.

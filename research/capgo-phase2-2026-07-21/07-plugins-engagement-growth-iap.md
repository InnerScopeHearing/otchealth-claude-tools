# Slice 07: Engagement + Growth + Monetization (push, local-notifications, IAP, deep-linking, widget-kit, live-activities, watch, app-shortcuts, in-app-review, subscription-revenue)

Source reports read in full: `research/capgo-2026-07-21/03-capgo-plugins-web.md` (150-plugin catalog, 58 deep-dived) and `research/capgo-2026-07-21/04-capgo-cloud-docs.md` (platform docs, CLI, API, pricing, skills marketplace). Cross-referenced against the 8-app fleet CLAUDE.md files where useful for ground truth.

Mission framing used throughout: turn OTCHealth Inc. + InnerScope into billion-dollar companies and an app-producing factory. Every finding below is judged on: does it grow revenue, retention, or organic exposure, or does it speed the factory's throughput, or does it conflict with a hard constraint.

---

## 1. Notifications (push) — `@capgo/capacitor-notifications`

Catalog entry: "Send native iOS and Android push notifications from Capgo with user lookup and badges." This is Capgo's OWN hosted push service (a metered backend, not just a client SDK), distinct from Firebase Cloud Messaging below.

Fleet state today: the fleet already holds ONE team-scoped APNs .p8 key (`apple-apns-key-p8`, Key ID DC8MP3LHX3, all-topics) meant to be reused per app by bundle id, per otchealth-claude-tools/CLAUDE.md. Flatstick is the only app with an explicit push mention in its docs (APNs + SiwA .p8 deployed into the pressgolf-api Container App). NONE of the other 7 apps' CLAUDE.md files mention a push notification implementation, gap confirmed by reading them.

Per-surface pass:
- **Companion**: this is the single highest-leverage gap in the whole slice. Companion's entire pitch is "one less call to the adult child," anchored on a DAILY CHECK-IN for caregiver peace of mind (Pillar 2) and a 14-day hard-paywall trial. Neither works without push: the daily check-in needs a "Mom/Dad has not checked in today" push to the adult child (the PAYER), and the trial needs a Day-11/12/13 "your trial ends soon, keep the assistant your parent already trusts" push to the buyer. Push notification COPY must stay categorical only, no notebook values, no photo content, no health content in the payload, matching Companion's own analytics.ts categorical-only rule; this is a real constraint to build in from day one, not bolt on later.
- **MedReview**: push is the retention lever behind a NEW B2B REVENUE LINE, not just an engagement nicety. RTM (Remote Therapeutic Monitoring, CPT 98975-98981) billing requires the patient's device to transmit adherence/monitoring data on a minimum number of days per month (commonly 16-of-30 under current CMS rules). A senior patient will not remember to open MedReview daily unassisted; push reminders are the mechanism that produces the billable data-day count. Right now MedReview is web-only (V1) with Capacitor Capgo-wrap at V1.1, so push is a V1.1 item, but the RTM billing feature should be designed push-first from the start since the whole CPT code depends on engagement cadence. This is a genuine adopt-later (mobile app is V1.1) but it should be FLAGGED NOW as a design input, not discovered late.
- **iHEARtest**: "come back and retake your hearing test" / "your yearly test is due" push is a straightforward retention lever for a screening app whose value compounds with repeat testing over time (trend tracking). Not currently wired per its CLAUDE.md.
- **AWARE**: daily-streak-style "come back and train today" push matches its aural-rehab exercise-grid model directly (same mechanic as Duolingo-style streak apps, well-proven retention lever for a $ paid app).
- **Flatstick**: already has the APNs key deployed to its backend; worth confirming actual notification SENDING logic exists (not just the key) for "it's your turn to enter a score" / "your buddy just won a bet" nudges, a strong social-loop retention driver for a betting/scoring app.
- **FourVault**: push is COPPA-sensitive (kid-directed notification content needs the same no-third-party-analytics-on-kid-screens discipline extended to notification copy and any push SDK that phones home kid usage data). Capgo's own hosted Notifications service, if it logs any device/usage telemetry, needs a COPPA review before wiring into FourVault; safer to route FourVault push through direct APNs/FCM without a third-party push-analytics layer.
- **InnerEase**: push reminder copy that references CBT/ACT exercise content is PUBLISHED COPY and needs clinical sign-off (Matt-routed, no CMO) per InnerEase's non-negotiable rule 6, same as any other user-facing clinical language. Generic "time for your check-in" copy is safe: content step-specific copy is not, until reviewed.
- **PlantID, Fictionary**: standard re-engagement pushes (a plant that needs watering reminder for PlantID is a very natural, high-retention push use case tied directly to its product; Fictionary generic).

Call: ADOPT-NOW for Companion (the trial-conversion and check-in pushes are core to its entire business model, not a nice-to-have), ADOPT-LATER for MedReview (tied to V1.1 mobile wrap and RTM billing design), ADOPT-NOW for iHEARtest/AWARE/Flatstick (cheap, proven retention lever, existing APNs key infra to build on).

---

## 2. Firebase Cloud Messaging — `@capgo/capacitor-firebase-messaging` (`messaging`)

Catalog: "Capacitor plugin for Firebase Cloud Messaging (FCM)." Part of the Firebase sub-suite.

Fleet relevance: Companion's stack ALREADY specifies Firebase Auth + Identity Platform + Firestore + Cloud Storage for Firebase, so FCM is the same-project push path with zero new vendor onboarding, likely the better choice for Companion specifically over a third Capgo-hosted Notifications service, since Companion already pays for and operates inside the Firebase project. For every OTHER app (iHEARtest, AWARE, Flatstick, FourVault, InnerEase, PlantID, Fictionary), none currently use Firebase as their backend, so direct APNs (reusing the existing team push key) or the Capgo-hosted Notifications plugin is the lower-new-infra path.

Call: ADOPT-NOW for Companion specifically (matches its existing Firebase stack). SKIP for the rest of the fleet (no Firebase project to hang it off, direct APNs/Capgo-hosted is simpler there).

---

## 3. Alarm — `@capgo/capacitor-alarm` (closest fleet match to "local-notifications")

Catalog: "Schedule native alarms and notifications even when app is closed." NOTE: the 150-plugin Capgo catalog does NOT contain a plugin literally named "local-notifications"; the closest matches are this Alarm plugin (scheduled, closed-app notifications) and, more loosely, Background Task (periodic background work, different slice). Capacitor's own first-party `@capacitor/local-notifications` core plugin (not in the Capgo catalog, a separate Ionic-maintained package) is the more standard choice for simple scheduled local reminders and should be evaluated alongside this one; flagging that the raw research file itself did not cover it since it is outside the Capgo namespace.

Fleet relevance: this is the mechanism for LOCAL (no-server-round-trip) scheduled reminders, distinct from push (which needs a server to trigger). Good fit for: AWARE ("do today's exercise" local reminder that does not depend on backend uptime), InnerEase (relief-session reminder, matches its on-device-first, no-backend-in-V1 posture better than a push notification would, since push requires a server), MedReview/RTM adherence reminders as a LOCAL fallback if the backend push pipeline has any latency (belt-and-suspenders for a billing-critical cadence).

Call: SPIKE. Worth a direct comparison against `@capacitor/local-notifications` (not in this catalog) before choosing; either way this fills a real gap for InnerEase given its explicit no-backend-in-V1 rule, where local-only reminders are structurally the ONLY option that fits without violating that architecture rule.

---

## 4. Native Purchases — `@capgo/native-purchases`

Catalog: iOS StoreKit + Android Billing wrapper, 70.1k monthly downloads, the most-adopted Commerce plugin in the whole catalog. Notable feature: "iOS StoreKit support for monthly billing commitments on 12-month subscriptions."

Fleet relevance: every monetized app in the fleet (Companion, FourVault, Flatstick, AWARE, InnerEase B2B Sprint 4+, PlantID) already standardizes on RevenueCat specifically because RevenueCat centralizes server-side entitlement/webhook logic (Flatstick's `POST /webhooks/revenuecat`, Companion's explicit "never trust the client's reported subscription state, server-side enforcement" rule). Adopting Native Purchases fleet-wide would mean re-implementing receipt validation and entitlement enforcement per app, a direct regression against an already-hardened fleet rule.

Call: AVOID as a fleet-wide swap. The ONE narrow legitimate use: a brand-new, no-backend-yet prototype validating a price point before RevenueCat wiring lands (none currently fit that description). This is the clearest ANTI-PATTERN in the Commerce category for this slice: tempting (cheaper, no third party) but conflicts with a fleet-wide hardened rule.

---

## 5. Purchases — `@revenuecat/purchases-capacitor` (already the fleet standard)

Confirmed via direct fetch: 532.4k monthly downloads, 232 GitHub stars, by far the most-adopted plugin anywhere in the whole research pass, consistent with it being the correct fleet standard. Methods confirmed include `configure()`, `getVirtualCurrencies()`, `invalidateVirtualCurrenciesCache()`, `getCachedVirtualCurrencies()`.

**Virtual Currencies is a real, currently-unused RevenueCat capability worth flagging as a missed opportunity, not a gap-fill.** No app in the fleet has an in-app credit/points/currency system today. Two concrete angles:
- **Flatstick**: the app already has a MINTED, BRANDED "Flatstick Coin" asset (currently purely cosmetic/decorative per its CLAUDE.md brand rules: "the minted Flatstick Coin... signature surfaces"). Turning the coin into a REAL RevenueCat virtual currency would let Flatstick sell a la carte chat entitlements (`chat_text` $0.99 / `chat_photo` $1.99 / `chat_video` $4.99, already tiered) as coin-purchases instead of forcing every user into a recurring Pro subscription, a proven mobile-monetization pattern (pay-per-use bridges casual users into subscribers). Flatstick's hard rule that the app never holds or escrows real money is UNAFFECTED, this is virtual in-app currency for entitlement purchase, not a peer-to-peer wallet.
- **FourVault**: explicitly DO NOT do this. FourVault's non-negotiable rule 2 is "no loot boxes, ever, no randomized paid mechanics," and its whole product is a kids' trading-card app; a virtual currency layered onto a trading-card app for kids reads exactly like the mechanic regulators and the App Store target when scrutinizing kids' apps, even without randomization. Flag explicitly as an ANTI-PATTERN for FourVault specifically, even though the plugin itself is fine for other apps.

Call: no change to the core plugin (correctly adopted fleet-wide already). SPIKE the Virtual Currencies feature for Flatstick only. AVOID for FourVault explicitly.

---

## 6. AdMob — `@capgo/capacitor-admob`

Catalog: banner/interstitial/rewarded ads, with a `configRequest()` child-directed-treatment parameter (COPPA-aware ad request flag).

Fleet relevance: no app in the fleet currently has an ad-supported model. The one place this is even plausible, FourVault, is EXPLICITLY EXCLUDED by its own CLAUDE.md rule 2: "NEVER put third-party analytics or ads on kid screens." This holds regardless of AdMob's own COPPA-aware ad-request parameter, the plugin being COPPA-conscious does not make ads on a kids' app compliant or advisable, that decision is closed already at the app level.

Call: AVOID fleet-wide. This is a textbook hard-constraint-conflict anti-pattern: tempting revenue idea, directly forbidden by an existing non-negotiable rule.

---

## 7. Stripe Payment Sheet / Stripe Identity / Stripe Terminal

Catalog: native Stripe Payment Sheet + Apple Pay/Google Pay, identity verification, and in-person card-present payments respectively.

Fleet relevance, the clearest B2B/Medvi-playbook angle in this slice: **AWARE's B2B audiologist licensing (Stripe, Sprint 4+)** is currently planned as presumably a web checkout. A native Stripe Payment Sheet screen INSIDE the AWARE app (or a future shared B2B admin surface) lets an audiologist purchase/renew a clinic license without leaving the app, materially lower friction than a redirect-to-web flow, and is the single most direct "sell the growth machine to a partner" B2B monetization surface available in this catalog. Stripe Terminal (in-person card-present) is a stretch fit today (no fleet app currently has an in-clinic point-of-sale need) but becomes directly relevant if AWARE's B2B model ever extends to in-office bundled-hardware sales (a PSAP + app license sold at the point of clinical care, echoing the OTCHealthMart/Amazon TReO PSAP commerce angle already in the portfolio). Stripe Identity is a stretch fit for any future KYC-adjacent B2B partner onboarding (note: KYC itself is a hard Matt-gate per company policy regardless of tooling, this plugin would sit inside a human-gated flow, not replace the gate).

Call: SPIKE for AWARE's B2B Sprint 4+ work specifically (Stripe Payment Sheet, native in-app clinic-license purchase). SKIP Stripe Terminal and Stripe Identity for now (no immediate fleet trigger), revisit if the B2B/hardware-bundling angle advances.

---

## 8. Native Market — `@capgo/capacitor-native-market`

Catalog: "Deep link users directly to your app page on Google Play Store or Apple App Store." Methods: `openStoreListing()` (plus Android-only `openDevPage`, `openCollection`, `openEditorChoicePage`).

Fleet relevance, a genuinely under-explored FACTORY-WIDE growth lever: all 8 apps ship under the same OTCHealth/InnerScope publisher identity. `openDevPage()` (Android "open all apps by this developer") and a curated in-app "more from us" screen using `openStoreListing()` per app id would let EVERY app cross-promote every other app in the portfolio at zero incremental CAC, e.g. an AWARE user (aural rehab, 50-75) is a near-perfect iHEARtest cross-sell (screening test) and vice versa; a Flatstick user is a plausible Fictionary cross-sell; a Companion user (senior + adult-child dual audience) is a plausible AWARE/iHEARtest cross-sell to the SAME household. This is the mobile-app equivalent of an owned-media house-ads network, one that Netflix/Google/Meta-style super-apps run internally and that most indie portfolios never bother building because each app is usually a separate publisher; we are NOT separate publishers, we already have the underlying advantage and are not using it.

Call: ADOPT-NOW. Cheap (single plugin, generic "more from OTCHealth/InnerScope" UI module reusable across all 8 apps), zero new vendor, zero compliance surface, pure incremental installs.

---

## 9. Widget Kit — `@capgo/capacitor-widget-kit`

Catalog: iOS WidgetKit + Live Activity JSON-driven templates, App Group required on both app and widget extension targets.

Fleet relevance: DIRECT overlap with Flatstick's ALREADY-SHIPPED home-screen widget, built via hand-rolled native-extension injection (`ios/integrate_native_targets.rb`) per Flatstick's CLAUDE.md/HANDOFF history. From THIS slice's growth/monetization lens (as opposed to the engineering-maintenance lens another slice would take): a home-screen widget is a permanent, ambient, zero-cost brand impression on the user's phone every time they glance at their homescreen, a genuine organic-growth surface distinct from a push notification (which can be dismissed/muted) or an in-app screen (which requires opening the app). Two concrete new-surface ideas beyond Flatstick:
- **Companion**: a small "today's family feed" or "last check-in: X hours ago" widget on the SENIOR's home screen doubles as a constant visual reminder the family layer exists, and (more importantly) a widget on the ADULT CHILD's own phone showing "Mom checked in 2 hours ago, all good" is a magnetic retention surface for the PAYER specifically, arguably a stronger retention lever than any in-app screen since the buyer may rarely open the app itself once trust is established.
- **AWARE**: a "current exercise streak" widget (Duolingo's single most copied growth mechanic) directly targets its senior-accessibility, habit-formation product shape.
- **iHEARtest**: "days since your last hearing test" widget nudges the annual-retest cadence that drives repeat engagement.

Monetization angle specifically: widgets are a credible candidate for a PAYWALLED premium feature (RevenueCat entitlement-gated) rather than a free extra, several competitor apps in the wellness/fitness space gate their glanceable widgets behind a paid tier specifically because the ambient-visibility value is high.

Call: ADOPT-LATER for Companion and AWARE (net-new, real engineering lift, needs the same App Group Developer-portal Matt-gate Flatstick already proved out), ADOPT-NOW to evaluate REPLACING Flatstick's hand-rolled widget code with this maintained plugin (lower future maintenance, same capability).

---

## 10. Live Activities — `@capgo/capacitor-live-activities`

Catalog: iOS 16.1+, Dynamic Island + Lock Screen, 4 KB combined payload cap, extension has no direct network access (images must be pre-downloaded), push updates need an APNs backend.

Fleet relevance: DIRECT overlap with Flatstick's already-shipped lock-screen Live Activity (money glance during a live round). Growth/monetization framing:
- A Live Activity is VISIBLE to anyone glancing at the user's lock screen during a live round, a passive, in-person viral surface at the golf course (a friend sees a live-updating money/score glance on your phone and asks what app that is). This is a genuine organic-acquisition channel unique to Live Activities that a plain push notification or widget does not have (a lock screen is seen by bystanders; a home screen widget usually is not, in someone else's presence).
- **InnerEase**: a Live Activity for an active relief-sound session (countdown/now-playing style) fits its always-audio-running product shape and reduces the need to unlock the phone mid-session, a genuine UX/retention win, not just a growth one.
- **MedReview / Companion PHI-adjacency caution**: Live Activities render content ON THE LOCK SCREEN, visible to anyone who picks up the phone, even a caregiver's phone. If Companion or a future MedReview mobile surface ever used a Live Activity, it must NEVER surface a medication name, a specific health value, or any notebook content on the lock screen; this is the same "no PHI/PII in a glanceable surface" discipline Companion's PostHog `ph-no-capture` sensitive-surface rule already encodes for analytics, extended here to a NATIVE UI surface, worth writing into Companion's CLAUDE.md explicitly if this is ever built.

Call: ADOPT-NOW to evaluate replacing Flatstick's hand-rolled Live Activity code with this maintained plugin. SPIKE for InnerEase (session countdown). FLAG AS A COMPLIANCE GUARDRAIL (not a recommendation to skip, a recommendation to design carefully) if Companion or MedReview ever build one.

---

## 11. Watch — `@capgo/capacitor-watch`

Catalog: Apple Watch bidirectional messaging (`sendMessage`, `updateApplicationContext`, `transferUserInfo` reliable-queued delivery, `replyToMessage`).

Fleet relevance: DIRECT overlap with Flatstick's shipped Apple Watch app (money glance, Digital Crown score entry), built via the same hand-rolled `integrate_native_targets.rb` pattern. Flatstick's own HANDOFF explicitly flags the watch glance still shows SAMPLE data pending a real `publishMoneyToWatch(...)` hook, this plugin's `transferUserInfo` (reliable, queued delivery) is precisely the semantics that hook needs and is a stronger fit than hand-rolled WatchConnectivity code for guaranteeing the watch eventually gets the real number even if the phone and watch are briefly out of range of each other.

Growth/monetization framing beyond the engineering-maintenance angle: an Apple Watch companion is a premium-feel differentiator few competitor apps in golf/hearing/wellness ship at all, real justification for a premium-tier price point (matches Flatstick's existing tiered chat-entitlement model, a "Watch + widgets" bundle could be its own upsell tier or a Pro-tier perk). Net-new ideas: iHEARtest (a watch complication showing "next test due in N days"), AWARE (streak on the wrist, same Duolingo-proven mechanic as the widget idea above, doubled down across two surfaces).

Call: ADOPT-NOW to evaluate as the underlying transport for Flatstick's still-open `publishMoneyToWatch` hook. ADOPT-LATER / net-new for iHEARtest and AWARE as a premium differentiator, tie to a paid tier if built.

---

## 12. In App Review — `@capgo/capacitor-in-app-review` (already used, iHEARtest)

Confirmed via direct fetch: single method `requestReview()`, 23.7k monthly downloads, no explicit pricing, open source. Already live in iHEARtest only.

Fleet relevance: this is the single CHEAPEST, HIGHEST-CERTAINTY win in this entire slice. App Store ranking and organic discoverability (the `aso-growth` skill's whole mandate) are directly driven by review COUNT and star rating, and review-prompt TIMING (fire it right after a genuinely positive moment, a completed hearing test, a settled round, a successful trade verdict, a completed relief session) is a well-proven lever that costs almost nothing to implement per app. Right now only iHEARtest has it; the other 7 apps are leaving free App Store ranking signal on the table. This is a case where standardizing ONE already-adopted, already-proven plugin fleet-wide is higher leverage than most of the net-new plugin ideas in this report.

Call: ADOPT-NOW, fleet-wide, all 7 remaining apps. Trivial effort, proven mechanism, directly compounds with the `aso-growth` skill already in the toolkit.

---

## 13. Persistent Account — `@capgo/capacitor-persistent-account`

Catalog: "Preserve user authentication and account data across app reinstalls and updates."

Fleet relevance: subscription/entitlement continuity across a reinstall is a real, quiet churn source, a user who reinstalls (new phone, storage cleanup, etc.) and has to re-authenticate or worse re-discover their existing paid entitlement before RevenueCat's server-side restore-purchases flow kicks in is a moment where confused users churn or leave a bad review. This is complementary to, not a replacement for, RevenueCat's own `restorePurchases()`, it smooths the ACCOUNT/auth side of a reinstall so the RevenueCat entitlement resolves against the same known user rather than a fresh anonymous one.

Call: SPIKE for Companion and Flatstick specifically (both have real backend accounts, not just device-anonymous IAP), where a reinstall-continuity gap would be most visible and costly.

---

## 14. App Shortcuts / Home Screen Quick Actions — CATALOG GAP (not in the 150-plugin Capgo list)

This item is explicitly named in my assigned slice but is genuinely ABSENT from the Capgo catalog as read (no plugin named "app shortcuts," "quick actions," "3D touch," or "long-press shortcuts" appears anywhere in the 150-item enumeration or the 58 deep-dived pages). iOS's `UIApplicationShortcutItems` (long-press app-icon quick actions) and Android's App Shortcuts API are both real, well-established OS features with no first-party or Capgo-maintained Capacitor wrapper surfaced in this research pass; the closest adjacent Capgo item is Intent Launcher (Android-only, general intent launching, not the shortcuts API specifically).

Fleet relevance if built (via a small custom native shim, not a Capgo plugin, since none exists): "Start a hearing test" (iHEARtest), "Start a new round" (Flatstick), "Log today's exercise" (AWARE), "Take a photo of a plant" (PlantID) are all natural one-tap-from-homescreen entry points that shave a full app-open-then-navigate flow down to a single long-press, a proven engagement-friction reducer.

Call: SPIKE, flagged explicitly as a CATALOG GAP rather than a plugin recommendation, since implementing this means either finding a different (non-Capgo) community plugin or a small hand-rolled native shim per app (small, one-time native code, ships via a real Depot binary release, not OTA-eligible).

---

## 15. Deep linking (Universal Links / App Links) — no dedicated Capgo PLUGIN found; only a SKILL

Same gap pattern as App Shortcuts: the 150-plugin catalog has no plugin literally named "deep linking." What Capgo DOES offer is a SKILL, `capacitor-deep-linking` ("Universal Links and App Links implementation"), part of the "Features" skill category (5 skills marketplace items total in that group alongside push-notifications, offline-first, keyboard). Deep linking itself in Capacitor is handled by the CORE `@capacitor/app` plugin's `appUrlOpen` event plus native `apple-app-site-association` / Android `assetlinks.json` configuration, not a separate Capgo package; the "plugin" for this slice is really a configuration/skill topic, not an npm install.

Adjacent catalog items that DO relate directly:
- **Share Target** (`@capgo/capacitor-share-target`, Communication category): receiving a share INTO the app is the inbound half of the deep-link/growth story. Already flagged as a direct fix for iHEARtest's fragile hand-rolled iOS Share Extension (a documented "Known gotcha"). From THIS slice's angle: Companion receiving a forwarded suspicious text/email/screenshot via Share Target is not just a UX nicety, it is a NEW ACQUISITION MOMENT, a family member on ANOTHER app (Messages, Mail) discovering "oh, I could just send this straight into Companion" is itself a soft viral loop for a family-referral product.
- **In App Browser** (`@capgo/capacitor-inappbrowser`): the outbound half, opening an external link (a clinic's booking page from AWARE B2B, a scam-report resource from Companion) without leaving the app, keeps the session/attribution intact rather than bouncing to Safari and losing the user.
- **Native Market** (already covered in item 8 above): the deep-link-OUT-to-store-listing half of cross-promotion.

The B2B/Medvi angle for deep linking specifically: a per-clinic or per-partner ATTRIBUTED deep link (`aware://partner/clinic-123` or a Universal Link carrying a partner code) that lands a new install directly into a pre-filled B2B onboarding or a RevenueCat promotional-offer redemption is the standard mechanism behind every partner/referral acquisition program (this is literally how most B2B SaaS "invite your team" and clinic-partner funnels work). Nothing in the fleet currently implements attributed deep links for partner acquisition.

Call: SPIKE the deep-linking skill + Share Target combination for Companion (viral share-in) and iHEARtest (replace the fragile Share Extension). ADOPT-LATER the partner-attributed deep-link pattern for AWARE's B2B Sprint 4+ launch specifically, this is a concrete, buildable piece of the Medvi-style acquisition funnel.

---

## 16. subscription-app-revenue skill (Capgo skills marketplace, Growth & Revenue category)

Per the docs report Section 11: "Build a practical path from app idea or MVP to early subscription revenue," the ONLY skill in Capgo's dedicated "Growth & Revenue" category (1 of 48 total skills). No further detail on its actual content was captured in the raw research (title + one-liner only).

Fleet relevance: this is squarely the same territory as the fleet's OWN `monetization` skill (already installed, per the skills list available this session) and the fleet's already-built subscription infrastructure (RevenueCat standardized, tiered entitlements on Companion/Flatstick/AWARE/PlantID). Rather than adopting Capgo's version wholesale, the higher-leverage move is to READ what it covers and cherry-pick anything the fleet's own `monetization` skill is missing (e.g., trial-length benchmarking, paywall-copy patterns, win-back-flow structure), since we already have a working subscription stack and existing internal tooling; duplicating rather than extending would fragment the playbook.

Call: SPIKE (read the skill's actual content, diff against the fleet's own `monetization` skill, merge anything genuinely new rather than running two parallel subscription-strategy sources of truth).

---

## 17. Adjacent factory-throughput note: capgo-native-builds skill vs Depot policy (ANTI-PATTERN, flagged even though outside the plugin list proper)

The skills marketplace includes `capgo-native-builds`, "Request hosted iOS and Android builds with Capgo Build," Capgo's own hosted-native-build service. This directly conflicts with the fleet's hardened, repeatedly-reaffirmed policy that Depot macOS GitHub Actions is the EXCLUSIVE iOS build path fleet-wide (Codemagic is fully retired for the exact same reason, consolidating on one build pipeline). Adopting Capgo Build would reintroduce a second, parallel iOS build pipeline, the precise pattern the fleet already paid the cost of unwinding once (Codemagic to Depot migration, "preserve-then-cut" complexity, billing cleanup). This is worth flagging explicitly since it would be an easy, tempting mistake for an agent skimming the Capgo skills marketplace to install `capgo-native-builds` alongside the OTA-focused skills without realizing it overlaps a settled architectural decision.

Call: AVOID. Explicit anti-pattern against a hard, already-litigated fleet constraint.

---

## Top missed opportunities in this slice

1. **Push/local-notification infrastructure as the enabling layer for RTM (Remote Therapeutic Monitoring) CPT 98975-98981 billing.** MedReview (and potentially Companion) sit on a genuine new B2B/payer revenue line that legally REQUIRES a minimum cadence of patient engagement days per month. Nobody has connected "we need push notifications" to "push notifications are the mechanism that makes an entire CPT billing code achievable" before. This should be designed into MedReview's V1.1 mobile wrap from day one, not bolted on after the fact.

2. **Package the push + deep-link + subscription + review-prompt playbook as a resellable "growth kit," Medvi-style, sold or run for partner clinics.** The fleet is quietly building the exact retention/acquisition/monetization stack (proven trial-conversion push, partner-attributed deep links, tiered RevenueCat entitlements, timed review prompts) that IS the productized growth-machine offering the mission brief explicitly asks to explore. Right now every piece is being considered per-app; formalizing it as a reusable module (a `packages/growth-kit`-style shared package, paralleling how `packages/shared` centralizes Flatstick's money math) turns internal infrastructure into a second product line the CTO/CRO could license to partner clinics or audiology practices alongside AWARE's B2B tier, not just a cost center supporting our own 8 apps.

3. **Widget Kit + Live Activities + Watch as PAID, PAYWALLED premium engagement surfaces across the whole consumer fleet, not just Flatstick's existing build.** These are currently framed fleet-wide as engineering/maintenance items (replace hand-rolled Swift with a maintained plugin). Reframed through a growth/monetization lens: an ambient home-screen widget or lock-screen Live Activity is a permanent, zero-marginal-cost brand impression AND a credible premium-tier justification (competitor wellness apps already gate widgets behind paywalls). Companion's "family check-in on the ADULT CHILD's own phone" widget in particular could be the single highest-retention surface in the entire portfolio, since it targets the PAYER directly and requires no app-open at all to deliver its core value.

---

## Anti-patterns / hard-constraint conflicts

- **AdMob (`@capgo/capacitor-admob`) on FourVault**: directly forbidden by FourVault's own non-negotiable rule 2 (no third-party analytics or ads on kid screens), regardless of AdMob's own COPPA-aware child-directed-treatment request parameter. AVOID.
- **RevenueCat Virtual Currencies on FourVault**: even without ads, layering a virtual in-app currency onto a kids' trading-card app reads as exactly the randomized-paid-mechanic-adjacent pattern FourVault's rule 2 ("no loot boxes, ever") exists to prevent, even absent literal randomization. AVOID for FourVault specifically; fine elsewhere (Flatstick spike).
- **Native Purchases (`@capgo/native-purchases`) as a fleet-wide RevenueCat replacement**: cheaper and third-party-free on paper, but re-implementing server-side receipt validation and entitlement enforcement per app is a direct regression against the fleet's own hardened "never trust the client's reported subscription state" rule (Companion non-negotiable rule 6, mirrored in Flatstick's webhook-based entitlement model). AVOID as a swap; narrow exception only for a no-backend-yet prototype.
- **`capgo-native-builds` (Capgo Build hosted native builds)**: directly conflicts with the fleet's hardened, already-litigated Depot-macOS-exclusive iOS build policy (the same policy that just finished retiring Codemagic for this exact reason, one pipeline, not two). AVOID.
- **Push notification / Live Activity / widget CONTENT carrying PHI-adjacent or unreviewed-clinical-copy content.** Not a plugin problem, a discipline problem: any glanceable native surface (lock screen, home screen, notification banner) is MORE exposed than an in-app screen (visible to anyone who glances at the device, not just the logged-in user), so the bar for what can appear there is higher, not lower, than the in-app PHI/ring rules already enforce. Concretely: never put a medication name, a specific health value, a notebook entry, or unreviewed InnerEase clinical-exercise copy into a push body, widget text, or Live Activity payload. This is a design guardrail to write into each affected app's CLAUDE.md before building any of the surfaces recommended above, not a reason to avoid building them.
- **Background Geolocation (from the adjacent Device APIs/Location category, referenced here only because it was raised as a Companion "safety signal" idea in the source research) used silently for a senior user without an explicit consent flow.** Any location-tracking feature on Companion needs its own consent design given the senior-privacy posture already baked into the app's non-negotiable rules; this is a SPIKE-with-a-consent-review item, not a silent add, even though it is technically outside this slice's core plugin list.
- **Any native plugin from this report (Watch, Widget Kit, Live Activities, Share Target, App Shortcuts) shipped with the expectation it goes out via the existing Capgo OTA channel.** Reconfirmed directly from Capgo's own docs: the Updater plugin only ships WEB-LAYER (JS/HTML/CSS) changes over the air; any native entitlement, Info.plist, or native-module change requires a real binary release through the Depot macOS pipeline. Every recommendation in this report that touches native code needs a real App Store build cycle, not a same-day OTA push, a real planning constraint for whichever release the fleet schedules these into.

---

**End of raw notes for slice 07.**

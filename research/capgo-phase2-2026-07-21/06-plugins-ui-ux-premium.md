PREMIUM-FEEL SLICE: safe-area / tailwind / ionic-design / splash-screen / status-bar / haptics / share-target / in-app-review / navigation-bar

Source note on this slice's naming: five of these nine names map to Capgo's "UI & Design" skill category from 04-capgo-cloud-docs.md section 11 (safe-area-handling, tailwind-capacitor, ionic-design, capacitor-splash-screen, plus these are teaching/pattern skills for AI agents, not npm plugins by themselves). Two more (share-target, in-app-review, navigation-bar) are real Capgo npm plugins already deep-dived in 03-capgo-plugins-web.md. The remaining two (status-bar, haptics) are official first-party @capacitor/* core plugins that are foundational to the Capacitor platform but are NOT part of Capgo's third-party 150-plugin catalog and were not individually documented in either source report; analysis below for those two draws on general Capacitor platform knowledge, flagged explicitly where the source reports are silent.

Cross-cutting process fact that governs six of nine items in this slice: per 03-capgo-plugins-web.md section 3.9, the Capgo Updater ships WEB-LAYER changes only over OTA; any native plugin, Info.plist change, or native config requires a real Depot macOS binary release. Splash Screen, Status Bar, Haptics, Navigation Bar, and Share Target (native intent-filter/extension registration) are ALL native-territory and cannot ship silently through the existing Capgo OTA channel. Only Safe Area (pure CSS/env() variables) and Tailwind (pure CSS) are truly OTA-shippable improvements from this slice. This is a real scheduling fact for whoever plans the rollout, not a blocker, and is restated in the anti-patterns section below.

No em or en dashes used in this report.

---

## 1. Safe Area Handling (skill: safe-area-handling, "Handle notches, home indicators, and status bars")

What it is: CSS/layout discipline using env(safe-area-inset-*) variables, viewport-fit=cover, and avoiding UI collisions with the iPhone notch/Dynamic Island, the home indicator, and status bar. Pure CSS, OTA-shippable.

Per-surface analysis:
- iHEARtest: vanilla JS/CSS, no framework, no bundler. If safe-area insets are not already applied, critical hearing-test controls near the bottom of the screen risk overlap with the home indicator on notched devices, exactly the kind of device-only bug class iHEARtest's own CLAUDE.md already flags as untestable except on Mark's/Matt's real iPhones via TestFlight. Call: adopt-now. Effort: S.
- AWARE: senior-first, hard accessibility requirement (large touch targets, high contrast). A home-indicator collision on a 50-75 audience is a real usability failure, not just cosmetic. Call: adopt-now. Effort: S.
- Companion: minimum 64x64pt touch targets is a non-negotiable rule; bottom-sheet paywalls, the family feed's bottom nav, and the assistant's push-to-talk control are all exactly where safe-area failures happen. Call: adopt-now. Effort: S.
- FourVault: Konsta UI (iOS-styled component kit) plus Tailwind; a kid-facing card grid with a bottom tab bar is a classic safe-area collision zone. Call: adopt-now. Effort: S.
- Flatstick: live-scoring bottom entry bar during an actual round (thumb-zone entry, outdoors, one-handed) is the single highest-stakes safe-area surface in the whole fleet, a mis-tap near the home indicator during live bet/score entry is a real money-adjacent UX risk that compounds Flatstick's own "never weaken the money math" posture into the UI layer. Call: adopt-now, HIGH priority. Effort: S.
- InnerEase: pre-code today; when Phase 0 lands (forked from iHEARtest) this should be baked in from the first commit rather than retrofitted. Call: adopt-now (at fork time). Effort: S.
- MedReview: V1 is web-only (Shopify embed); becomes directly relevant only at the V1.1 Capacitor wrap. Call: adopt-later. Effort: S.
- PlantID: full-screen camera preview with a capture button that sits, by definition, in the exact thumb zone nearest the home indicator, this is THE textbook safe-area failure mode for any camera-first app. Call: adopt-now. Effort: S.
- B2B (AWARE audiologist licensing): a clinician-facing screen with a clipped control undermines the professional trust a B2B sale depends on just as much as a consumer screen does. Call: adopt-now, same standard. Effort: S.
- Internal/exec/factory: no direct consumer UI surface, N/A.

This is near-zero-risk, CSS-only, OTA-shippable, and the single most common visible "cheap app" tell across the whole fleet. Recommend adopting as a FLEET STANDARD baked into devkit's Capacitor/Ionic Agent Skills pack rather than a per-app retrofit, with a lightweight automated audit script (screenshot at iPhone 16 Pro dimensions checking for control overlap with the home-indicator/notch zones, the same device dimensions the boot-gate skill already screenshots at).

## 2. Tailwind (skill: tailwind-capacitor, "Tailwind CSS patterns for mobile Capacitor apps")

Confirmed stack usage: FourVault is the ONLY app in the fleet whose CLAUDE.md explicitly names Tailwind ("Mobile: Capacitor 6+, React 18 + Vite + TypeScript, Tailwind, Konsta UI"). No other app's CLAUDE.md names Tailwind. iHEARtest and AWARE are vanilla JS/CSS with no bundler by design (module tags, not a build pipeline), so introducing Tailwind there would be a real rewrite, not warranted given their explicit "surgical PRs over rewrites" engineering rules. Companion specifies Ionic 8 components (not Tailwind) as its senior-UI system. Flatstick's CLAUDE.md does not name a CSS framework.

Per-surface: FourVault, adopt-now (pull the tailwind-capacitor skill's mobile-specific gotchas, safe-area utility classes, touch-target sizing utilities, the iOS 100vh viewport bug workaround, directly into that repo). Effort: S. iHEARtest/AWARE: skip (vanilla-CSS architecture is a deliberate choice, not a gap). Companion/Flatstick: no current fit, but see the missed-opportunity below.

Missed opportunity (factory-throughput angle): none of the newer React apps (Companion, Flatstick, InnerEase-once-it-scaffolds, a hypothetical next PlantID-style app) have declared a shared CSS/design-token approach in their CLAUDE.md files, meaning every App Lead is independently deciding CSS architecture per app. A Tailwind-plus-design-tokens baseline wired into app-template/scaffolder (paired with the theme-factory skill for brand-specific token generation) would let a brand-new app inherit a locked, premium, on-brand design system on day one instead of reinventing CSS per app. This is a genuine factory-throughput multiplier, not a per-app fix. Call: adopt-later (spike the app-template integration first). Effort: M.

## 3. Ionic Design (skill: ionic-design, "Build native-feeling UIs with Ionic components")

Confirmed stack usage: Companion explicitly names "Ionic 8 components for senior-friendly large controls" as its UI layer. No other app in the fleet's CLAUDE.md names Ionic. Call: adopt-now for Companion. Effort: S.

Anti-pattern flag (real, not hypothetical): Ionic's stock component set ships sliding list items with swipe-to-delete/swipe-actions by default (ion-item-sliding). Companion's non-negotiable accessibility rule 4 is explicit: "no swipe-to-delete, no double-tap gestures." Adopting the ionic-design skill's "native-feeling" patterns WITHOUT filtering them through Companion's own accessibility rules would directly reintroduce the exact gesture pattern Companion's CLAUDE.md bans. This is a genuine catalog item that looks like a clean win but carries a built-in conflict with an already-hardened fleet decision. Recommend: adopt the skill's layout/navigation/typography guidance, explicitly EXCLUDE any sliding-item/swipe-action component from Companion's actual build, and flag this exclusion in Companion's own CLAUDE.md "Known gotchas" section so a future session does not silently reach for ion-item-sliding.

No other app currently uses Ionic (FourVault is Tailwind+Konsta, Flatstick/iHEARtest/AWARE are not Ionic), so this stays a single-app item, not a fleet standard.

## 4. Splash Screen (skill: capacitor-splash-screen "Configure launch screens for iOS and Android"; underlying plugin: @capacitor/splash-screen, official Capacitor core, native config, requires a Depot build)

No app's CLAUDE.md describes a custom animated or branded splash screen; the fleet is almost certainly running Capacitor's default splash behavior across all 8 apps today. This is the single biggest first-impression gap in the entire slice: the splash screen is the literal first pixel every user of every app sees, on every cold launch, forever, and right now it is presumably generic.

Per-app opportunity:
- Flatstick: its own CLAUDE.md is explicit that "the minted Flatstick Coin and the sign-in screen are the signature surfaces... never downgrade the coin or the login to plain CSS/SVG." A coin-mint or coin-flip themed animated splash using the already-existing photoreal coin renders (packages/web/src/assets/marketing/icon/) is a natural, on-brief product idea, not just a config task, reinforcing brand identity at the single highest-attention moment (app open). Call: adopt-now. Effort: M.
- AWARE, Flatstick's dark clubhouse UI, Companion's warm senior palette, iHEARtest's green #81bc03: each has a locked brand identity already documented in its own CLAUDE.md/BRAND.md; a matching branded splash (not the Capacitor default) is low-effort, high-visibility polish for every one of them. Call: adopt-now fleet-wide. Effort: S-M per app (assets likely already exist via the designer skill).
- FourVault, PlantID, InnerEase, Fictionary: same opportunity, no current blocker.

Real coordination point (not previously documented anywhere in the fleet's own docs, worth flagging): the Capgo Updater plugin's own config table (04-capgo-cloud-docs.md section 2.4) includes an `autoSplashscreen` option, "auto-hide splash during instant-apply modes," default false. If any app's OTA-update apply path (autoUpdate: atBackground/atInstall/onLaunch) is not coordinated with @capacitor/splash-screen's own hide()/show() calls and the app's actual ready-state, the result is either a "flash of white" between splash-hide and content-render, or a splash held artificially long. This is a genuine cross-plugin integration detail every app adopting a custom splash needs to get right, not two independent config tasks.

## 5. Status Bar (@capacitor/status-bar, official Capacitor core, native config, requires a Depot build; NOT individually documented in either source report, general Capacitor platform knowledge, flagged as such)

Controls status bar icon style (light/dark content), background color, and overlay/translucent behavior. Directly interacts with each app's theming and with the safe-area work in item 1.

Per-surface:
- Flatstick: its "clubhouse-premium dark UI" needs the status bar consistently set to light-content (white icons); the classic failure mode is dark icons rendering invisibly against a dark background during the onboarding-to-app-shell transition, an instant unpolished tell in exactly the app whose CLAUDE.md is most explicit about premium-brand-bar discipline. Call: adopt-now. Effort: S.
- MedReview: its own CLAUDE.md specifies a "high-contrast theme toggle persisted in cookie" for its senior UX target. At the V1.1 Capacitor wrap, the status bar style must sync dynamically with that toggle, not be hardcoded, a concrete forward-looking implementation note. Call: adopt-later (V1.1 gate). Effort: S.
- Companion: WCAG AAA contrast requirement plus a family-feed hero-photo header; status bar legibility against a full-bleed photo needs dynamic (not static) style switching. Call: adopt-now. Effort: S.
- Fleet-wide: the common implementation mistake is a STATIC status-bar-style set once at launch; it must instead be wired to each screen's/theme's actual background so it never silently breaks the moment a dark-mode toggle or full-bleed hero scrolls under it. Call: adopt-now fleet-wide as a dynamic (not static) pattern. Effort: S.

## 6. Haptics (@capacitor/haptics, official Capacitor core, native config, requires a Depot build; NOT individually documented in either source report, general Capacitor platform knowledge, flagged as such)

This is the single highest-leverage item in the whole slice. Zero app in the fleet's CLAUDE.md mentions haptic feedback anywhere. Haptics is the most directly, physically felt signal of app quality (the exact mechanism Apple's own system apps, and category leaders like Robinhood/Superhuman, use to make an interaction feel expensive), and it is nearly free to add (one-line impact/notification/selection calls at existing interaction points, no new UI, no new screens).

Per-surface, concrete and specific:
- Flatstick: a made putt confirmation, a settled bet, or a Digital-Crown score entry on its ALREADY-SHIPPED Apple Watch app is the clearest fit in the entire fleet, haptic feedback on the watch pairs naturally with Digital Crown scrolling (a haptic "detent" feel per score increment) and turns the "clubhouse-premium" brand promise into something physically felt, not just visually seen. Call: adopt-now. Effort: S.
- Companion: haptic confirmation on a successful camera scan, a completed voice-clone recording, and a distinct warning-pattern haptic when the assistant flags a scam, reframes haptics from cosmetic polish to genuinely ACCESSIBILITY-ADJACENT for a 70+ user whose visual/tactile confirmation loop benefits from a non-visual "this worked" signal, directly serving Companion's own non-negotiable rule 4 (accessibility is a hard requirement, not a polish step). Call: adopt-now. Effort: S.
- AWARE: correct/incorrect feedback in its DIN benchmark and lyrics-in-noise training exercises via haptic pulse gives a non-audio confirmation channel to a hearing-loss population, exactly the population for whom audio-only feedback is the compromised modality. Important compliance note: haptic UI feedback carries no treatment claim by itself (it is pure interaction confirmation, not a therapeutic mechanism), so it does not cross AWARE's "no treatment claims" rail as long as copy/marketing never frames it as part of the "training effect." Call: adopt-now. Effort: S.
- FourVault: a card-scan-success haptic and a trade-verdict-reveal haptic are pure kid-delight moments that carry zero data and zero third-party SDK, fully COPPA-safe. Call: adopt-now. Effort: S.
- MedReview: scan-success confirmation on medication-photo capture, senior UX target (65+) benefits the same way Companion does. Gated to the V1.1 Capacitor wrap. Call: adopt-later. Effort: S.
- InnerEase: session start/stop and CBT/ACT step-confirmation haptics, on-device-first, no data implication. Call: adopt-now once Phase 0 lands. Effort: S.
- iHEARtest, CAUTION (real, not hypothetical): a haptic pulse fired during the actual hearing-test stimulus-presentation flow risks acting as an unintended NON-AUDITORY cue during a clinically-adjacent screening test, a real test-validity/clinical-integrity risk distinct from any PHI concern. Any haptic addition on iHEARtest's actual test-taking screens (as opposed to menus/results/settings, which are safe) must go through the Mark review ritual before shipping, not a silent add. Call: adopt-now on non-test screens, spike-with-Mark-review on the test flow itself. Effort: S (non-test), needs clinical sign-off (test flow).

Recommend baking a shared haptics utility wrapper (impact/success/warning/selection presets) into devkit's Capacitor/Ionic Agent Skills pack so every app, current and future, gets consistent haptic language instead of each App Lead hand-rolling raw Haptics.impact() calls with inconsistent styles.

## 7. Share Target (Capgo plugin @capgo/capacitor-share-target, deep-dived in 03-capgo-plugins-web.md section 3.8, native intent-filter/extension registration, requires a Depot build)

Already substantially researched in the raw plugin report. Recap plus this slice's own analysis:

- iHEARtest: DIRECT match to a documented fragility. iHEARtest's own CLAUDE.md "Known gotchas" section describes a hand-built iOS Share Extension requiring an App Group and "Require Only App-Extension-Safe API = No," explicitly flagged as something that "can draw App Store review questions" and that the team was prepared to ship v1 WITHOUT if rejected. This Capgo plugin is a maintained abstraction over exactly that fragile hand-rolled code. Call: adopt-now, this is a risk-reduction swap, not just a new feature. Effort: M.
- Companion, genuine new-surface idea (elevated to topOpportunities below): receiving a forwarded suspicious text, email, or screenshot FROM the OS share sheet INTO the assistant for scam analysis maps precisely onto Companion's own Pillar 1 concept ("point at a confusing screen or suspicious letter") extended to "share a screenshot from Messages into the app." This turns the OS share sheet into a discovery and re-engagement channel: every time an adult child forwards their senior parent something suspicious via Messages or Mail, "share to Companion" becomes a one-tap analysis path that reinforces the exact "one less call to the adult child" pitch the whole app is built around. Needs a UX/product design pass (the shared content must flow through the identical categorical-only-analytics, non-PHI pipeline the camera-capture path already uses) before shipping, but the mechanism is a real, cheap, story-perfect fit. Call: spike now, adopt-later after UX design. Effort: M.
- Flatstick: receiving a shared photo of a paper scorecard from a playing partner, or sharing a round's settlement summary out via the OS share sheet, both fit its "never holds money, just tracks and links out" posture directly (a settlement PDF share-out is exactly in-scope, see PDF Generator note in the original 03 report). Call: adopt-later. Effort: M.
- FourVault: receiving a shared card photo from a trading partner via Messages. Call: adopt-later. Effort: M.
- MedReview: sharing a screenshot of an insurance card or Rx label INTO the app, relevant at V1.1+ only (V1 is web-only). Call: adopt-later. Effort: M.

## 8. In App Review (Capgo plugin @capgo/capacitor-in-app-review, deep-dived in 03-capgo-plugins-web.md section 3.3, ALREADY LIVE on iHEARtest, native config requiring a Depot build)

Already flagged in the original 03 report as a fleet-wide standardization candidate; this slice reinforces WHY it belongs specifically in the premium-feel/growth bucket. In-app review prompts are a top-3 App Store Optimization ranking input, this is a direct lever for the aso-growth skill's mandate (organic install/visibility growth), not just a UX nicety.

Per-surface: AWARE, Companion, FourVault, Flatstick, InnerEase, Fictionary, PlantID should all adopt the same package iHEARtest already runs, one shared gating policy instead of eight bespoke StoreKit calls. Call: adopt-now, fleet-wide standardization. Effort: S per app.

Trigger-timing caveat (the plugin choice matters less than WHEN it fires, per Apple's own limited-prompts-per-year policy): trigger on a genuine positive moment (a completed hearing test, a settled bet, a successful plant identification, a completed training session), never on app open or a random interval.

FourVault-specific caution: the review prompt must never fire mid kid-gameplay or be triggered directly by the kid's own action in a way that reads as a kid being asked to leave a public rating; the trigger should be tied to a parent-context action (e.g., after a parent completes a trade-approval or purchase-confirmation flow) to stay in the spirit of FourVault's "no third-party analytics/ads on kid screens, parental gate before IAP" posture, even though StoreKit's own review prompt is first-party and technically COPPA-compliant regardless of trigger point. Flag for the coppa-kidsafety-reviewer subagent before wiring the exact trigger.

B2B note: AWARE's audiologist B2B licensing surface does not need a consumer review prompt (clinical trust, not App Store stars, drives that sale); this stays a consumer-surface-only item.

## 9. Navigation Bar (Capgo plugin @capgo/capacitor-navigation-bar, deep-dived in 03-capgo-plugins-web.md section 2/UI & System, Android-only, native config requiring a Depot build)

Every app in the fleet is explicitly iOS-first, with Android status ranging from fully dormant (AWARE: "Android dormant") to scaffolded-but-not-focus (iHEARtest) to unspecified (the rest). This is the one item in this entire slice that is correctly a SKIP for now, not because it lacks merit but because it has zero current audience: adopting it today would be polish work with no user to see it.

Call: skip for now, fleet-wide. Effort if/when revisited: S. Revisit only if any app makes a deliberate second-platform Android investment decision (at which point this item joins the same tier as the WebView Version Checker/Guardian Android-freshness trio already flagged in the original 03 report as an Android-specific bundle).

---

## Top missed opportunities in this slice

1. Companion's "share into the assistant" scam-triage loop via Share Target (item 7 above) is the strongest genuinely NEW product surface in this slice, it converts the OS-level share sheet into a re-engagement and discovery channel that reinforces Companion's exact core pitch ("one less call to the adult child"), likely lifting session frequency and retention, both of which compound directly into subscription renewal and family-referral, the actual growth engine behind a senior-first subscription app becoming a billion-dollar business.

2. Baking this entire slice (haptics wrapper, safe-area CSS baseline, splash-screen config template with the notifyAppReady/autoSplashscreen coordination handled, dynamic status-bar theme-sync helper, in-app-review positive-moment trigger helper) into devkit's Capacitor/Ionic Agent Skills pack and app-template/scaffolder defaults is the single biggest FACTORY-THROUGHPUT lever available in this slice. It turns nine individually-good polish items into one scaffolder default, raising the premium-feel floor of every future app in the portfolio at near-zero marginal cost per new app, which is exactly what "become an app-producing factory" requires structurally, not just per-app effort.

3. Productizing this exact checklist (haptics, safe-area, splash, status-bar, review-prompt-timing audit) as a sellable "Mobile Polish Audit" digital product via the existing digital-products skill and Gumroad storefront pattern (the same low-overhead, zero-medical/securities-exposure lane already proven by the pharmacy/OTC compliance SOP marketplace) is a genuine adjacent B2B/prosumer revenue idea nobody has proposed: sell the audit-and-fix service or a self-serve checklist product to other small Capacitor teams, no new infrastructure required, the criteria are already fully documented above.

---

## Anti-patterns / hard-constraint conflicts

1. Ionic Design's stock sliding-list/swipe-action component (ion-item-sliding) directly conflicts with Companion's own hardened non-negotiable rule 4 ("no swipe-to-delete, no double-tap gestures"). Adopting the ionic-design skill's "native-feeling UI" guidance wholesale, without explicitly excluding that component family, would silently reintroduce a gesture pattern the app's own CLAUDE.md bans. Flag this exclusion explicitly in Companion's CLAUDE.md rather than relying on the skill's default guidance.

2. Any haptic feedback fired during iHEARtest's actual hearing-test stimulus-presentation flow (as opposed to menus, results, or settings) risks acting as an unintended non-auditory cue that could contaminate test validity, a genuine clinical-integrity risk. This must route through the Mark review ritual before shipping on any real test-taking screen, per the fleet's own established sacred-review process for this exact app; do not ship silently.

3. Six of this slice's nine items (Splash Screen, Status Bar, Haptics, Navigation Bar, and Share Target's native intent-filter/extension registration) are native-config changes and CANNOT ship through the existing Capgo OTA channel per the fleet's own already-documented rule (03-capgo-plugins-web.md section 3.9: OTA is web-layer-only). Only Safe Area and Tailwind (both pure CSS) are truly OTA-shippable from this slice. Any rollout plan for this slice must schedule the native-config items against a real Depot macOS binary release, not assume Capgo channel push covers them.

4. In-App-Review prompts on FourVault must not be triggered directly by, or presented mid-session to, the kid user in a way that functions as asking a child to publicly rate an app; tie the trigger to a parent-context action instead, and route the exact wiring through the coppa-kidsafety-reviewer subagent per FourVault's own established review workflow, rather than treating "it is first-party StoreKit so it is automatically fine" as sufficient without that review.

5. A custom animated splash screen (item 4) that is not coordinated with the Capgo Updater's own `autoSplashscreen` config and `notifyAppReady()` boot sequence risks a flash-of-white or an artificially held splash on the very next OTA-updated launch, a real but previously undocumented cross-plugin integration trap, not two independent config tasks.

# Slice 05: Auth & Security / Privacy / Integrity plugins (Capgo catalog)

Scope as assigned: native-biometric, ssl-pinning, privacy-screen, app-attest, secure enclave,
integrity, anti-tamper. The last three are not literal Capgo plugin names, so they are mapped to
the closest real catalog items: secure enclave maps to Native Biometric's Keychain-backed
credential store, integrity/anti-tamper map primarily to App Attest, with Is Root and Mock
Location Detector as supporting anti-tamper signals. Firebase App Check, Persistent UUID,
Persistent Account, Verisoul, reCAPTCHA, and Age Range/Age Signals are pulled in because the raw
report's own Auth & Security deep dives materially inform these six themes; each is covered
briefly under the theme it serves.

Source: 03-capgo-plugins-web.md sections 3.2 (Auth & Security), 3.6 (Device APIs, Health/Watch
context only where relevant), 3.10 (Commerce, RevenueCat comparison context), and the fleet
relevance matrix. 04-capgo-cloud-docs.md confirms the hard OTA boundary that governs every item
below (native plugins never ship via Capgo channel, always need a real Depot binary release).

No em or en dashes used anywhere in this file.

---

## 1. Native Biometric (`@capgo/capacitor-native-biometric`)

Face ID / Touch ID / Android biometric. Methods: isAvailable, verifyIdentity, getCredentials,
setCredentials. Open source, no separate vendor bill.

- **OTCHealth Companion.** Two distinct uses, both strong. (a) Speed-friction removal: the senior
  primary user re-authenticating with Face ID instead of retyping an OTP after backgrounding is a
  UX WIN for a 70+ audience, not an added burden, framed correctly (fewer taps beats no auth).
  (b) Caregiver-action gating: Face ID before the adult-child admin edits the info notebook or
  revokes a voice clone, a defense-in-depth layer appropriate for a shared or elder-accessible
  device. Both map directly onto Companion's non-negotiable rule 6 ("server-side enforcement of
  entitlements, never trust the client") as a client-side companion, not a replacement, control.
  Also a genuine PREMIUM TRUST SIGNAL: "bank-grade protection of Mom's information" is exactly the
  kind of line that helps justify the $24.99 to $39.99/mo Family/Legacy tiers where voice-clone
  revocation and the info notebook live. Call: adopt-now.
- **MedReview.** V1 is Shopify-embedded web (no native biometric surface yet), but V1.1/V1.2
  Capacitor wrap should plan a biometric quick-unlock in front of the medication list from day
  one, patterned after Epic MyChart / CVS style apps. For a senior PHI app, biometric unlock is a
  friction REDUCER versus typing a password, and it is the natural mobile analogue of a standard
  health-app security posture reviewers and payers expect to see. Call: adopt-now (write into the
  V1.1 plan now so it is not forgotten later).
- **FourVault.** Supplemental PARENT unlock (Face ID/Touch ID) alongside the existing PIN/parental
  gate. Explicitly NOT a substitute for FourVault's verifiable-parental-consent (VPC) requirement,
  which is about consent methodology, not device unlock convenience. Flag to the
  coppa-kidsafety-reviewer subagent before shipping per FourVault's own review workflow. Call:
  adopt-later.
- **AWARE B2B (audiologist licensing).** If a future clinic-facing iPad app or clinician login
  surface is built, biometric-gated clinician access to patient screening data is a standard
  B2B-healthcare-trust expectation. Call: spike (no clinic-facing surface exists yet, but worth a
  design note attached to the Sprint 4+ B2B licensing plan).
- **Flatstick, FourVault trade screens, Fictionary, PlantID.** No strong fit beyond generic
  app-unlock convenience; low priority. Call: skip for now.

## 2. SSL Pinning (`@capgo/capacitor-ssl-pinning`)

iOS + Android. Only method surfaced in the raw report is getConfiguration(); the actual pin
enforcement almost certainly lives in bundled native cert/plist config, so this needs a follow-up
individual fetch of the plugin's full docs before committing (flagged gap, not a blocker).

- **MedReview.** PHI transport hardening, defense in depth on top of TLS. This is a concrete,
  checkable HIPAA technical-safeguard (transmission security) that a security questionnaire or
  future SOC2/payer review will ask about by name. Call: adopt-now.
- **Companion.** Backend already proxies every third-party call and mints ephemeral tokens (rule
  5); pinning the API host cert raises the MITM bar further, which matters given Companion's
  explicit threat model is scam-prone senior users on unfamiliar public wifi. Call: adopt-now.
- **B2B / enterprise trust angle (the real unlock).** "Do you use certificate pinning" is a
  standard line item on enterprise/payer security questionnaires. Bundled with App
  Attest/App Check, Native Biometric, and Privacy Screen, this becomes a checkbox any AWARE B2B
  audiologist-licensing deal, future MedReview payer/pharmacy conversation, or Medvi-style
  partner pitch can point to directly instead of answering from scratch each time. See top
  opportunities below.
- **Fleet-wide baseline.** Cheap (S effort) and reusable identically across all 8 apps; worth a
  single fleet-wide rollout rather than app-by-app, given Flatstick/Companion/FourVault all carry
  identity or money-adjacent data in transit even outside the PHI ring.
- **Operational risk, flag clearly.** Pinned certs must be rotated in lockstep with app releases.
  A cert renewal event with no rotation plan bricks connectivity for the installed base until a
  new binary clears App Store review, since this is native config, not something the Capgo OTA
  channel can silently fix (OTA only ships web-layer JS/HTML/CSS, confirmed in
  04-capgo-cloud-docs.md section 2.4/10). Adopting SSL Pinning WITHOUT a documented rotation SOP
  tied to the Depot release cadence is an anti-pattern, not a controls win. Call: adopt-now for
  MedReview + Companion, but pair with a rotation SOP before rollout; fleet-wide roll is a
  follow-on spike.

## 3. Privacy Screen (`@capgo/capacitor-privacy-screen`)

Already live in iHEARtest (enable/disable/isEnabled). Protects Android screenshots and the iOS
app-switcher snapshot.

- **Companion, the strongest fit in the whole slice.** Companion's own analytics.ts already
  defines a `ph-no-capture` / `SENSITIVE_SURFACE` list (family feed, voice-clone consent
  recordings, the info notebook) for PostHog replay masking. The SAME list should drive when
  Privacy Screen force-enables. This unifies "sensitive surface" into ONE source of truth spanning
  both analytics masking and app-switcher-snapshot protection, instead of maintaining the concept
  twice. Cheap, high leverage. Call: adopt-now.
- **MedReview.** At V1.1/V1.2 Capacitor wrap, the medication list and any payment/subscription
  screen are exactly the app-switcher-snapshot leak this plugin exists for; a HIPAA "reasonable
  safeguards" expectation, not just a nice-to-have. Call: adopt-now (bake into the V1.1 plan).
- **FourVault.** Kid card photos and parental-control screens on a shared family device or iPad;
  app-switcher snapshot exposure of a child's data is a real COPPA-adjacent privacy-hygiene gap.
  Call: adopt-now.
- **Flatstick.** Bet/settlement screens show dollar amounts and friend names; app-switcher glance
  or shoulder-surf exposure is a real but lower-severity privacy concern. Call: adopt-later.
- **AWARE, InnerEase.** Hearing-loss severity and CBT/ACT wellness screens are socially sensitive
  even though the apps are explicitly non-PHI; reasonable hygiene extension, not urgent. Call:
  adopt-later.

## 4. App Attest (`@capgo/capacitor-app-attest`), the primary "integrity / anti-tamper" plugin

Apple App Attest + Google Play Integrity wrapper. Methods: isSupported, prepare,
createAttestation, createAssertion.

- **Companion, the strongest cost-avoidance case.** Companion's usage caps (visual asks, Gemini
  Live minutes, cloned-speech characters) are already enforced server-side per its own rules. App
  Attest adds a BINARY-INTEGRITY layer on top of that entitlement layer, stopping a
  cloned/scripted client from bypassing the app UI entirely and hammering the Fastify proxy to
  drain paid Vertex AI / ElevenLabs credits directly. This is a real cost-control lever as usage
  scales, protecting the exact budget line (Vertex + ElevenLabs) the product depends on. NOTE
  section 6 below recommends Firebase App Check over generic App Attest specifically for
  Companion, since Companion's stack is already Firebase-native; the underlying attestation need is
  identical, just implemented through the tighter-integrated wrapper. Call: adopt-now (via App
  Check, not the raw plugin).
- **Flatstick.** Anti-cheat on live score submission and bet entry. Combined with Mock Location
  Detector (section 5), this closes a real fraud vector (a rooted/scripted client injecting fake
  scores or fake course locations) that directly threatens Flatstick's "never weaken the money
  math" rule. There is also a subtle regulatory-narrative benefit: proving score integrity
  technically REINFORCES Flatstick's "scorekeeping among friends, not gambling" framing if that
  framing is ever scrutinized. Call: spike (pair with Mock Location Detector; that plugin has very
  low adoption per the raw report, 3 GitHub stars, so validate before committing to the combined
  stack).
- **FourVault.** Anti-tamper on the AI trade-verdict pipeline, kids or a scripted client spoofing
  recognition input or card-value output to cheat a trade. Moderate value given the
  RecognitionProvider/PricingProvider adapter architecture is already the enforcement point; App
  Attest hardens the CLIENT side of that same boundary. Call: adopt-later.
- **PlantID.** Same cost-abuse logic as Companion, protecting the Azure OpenAI vision recognition
  endpoint from scripted abuse. App is early stage so the abuse risk is not yet proven at scale.
  Call: adopt-later (spike sizing the actual abuse risk first).
- **MedReview.** Relevant only from V1.1 (mobile wrap) onward; defense-in-depth on the Fastify
  API's genuineness check, useful ahead of any future insurance/PBM integration or payment
  surface. Call: adopt-later.
- **iHEARtest.** No live cost-abuse or money-integrity vector currently; low priority. Call: skip.
- **Factory-level missed opportunity.** See "Top missed opportunities" below: a shared,
  attestation-verifying backend middleware (Fastify/Express) in app-kit or claude-tools, paired
  with the client plugin, would let every future monetized app in the factory get this for free
  instead of re-implementing server-side token verification per app.

## 5. Mock Location Detector (`@capgo/capacitor-mock-location-detector`)

GPS-spoofing / developer-tooling detection. Very low adoption (3 GitHub stars, no monthly
download data in the raw report), flagged there as higher integration risk than the rest of the
catalog.

- **Flatstick, the one clear fit.** Golf course check-in and live scoring are exactly the surface
  where GPS spoofing enables betting fraud, a fake location backing a fake live-round claim.
  "Never trust an unverified location claim" extends Flatstick's existing money-math discipline
  naturally. Call: spike, not adopt-now, given the plugin's own immaturity signal.
- **Companion.** Only relevant if a future caregiver "safety check-in" location feature is ever
  built (not in the current stack); would need a real consent design given Companion's senior-
  privacy posture, not a silent bolt-on. Flagged as a forward-looking note, not a current gap.

## 6. Firebase App Check (`@capgo/app-check`), the better-fit integrity layer for Companion specifically

Not individually deep-dived in the raw report as its own headline item, but Companion's stack
(Firebase Auth + Identity Platform, Firestore Native mode, Cloud Storage for Firebase) already
runs on Firebase end to end, and Firebase App Check is Firebase's own first-party attestation
mechanism (it uses App Attest / Play Integrity under the hood, same underlying OS APIs as section
4, but wired directly into Firebase Security Rules).

- **Companion.** App Check tokens are natively verified by Firestore/Storage/Functions security
  rules with ZERO extra backend work, AND the Firebase Admin SDK can verify the same App Check
  token inside Companion's own Fastify proxy for the non-Firebase (Vertex/ElevenLabs) calls. That
  means ONE integrity signal protects both the realtime layer (feed posts, reactions, check-ins,
  presence) and the AI-proxy layer, instead of running App Attest and App Check side by side as
  two redundant integrity systems. This is a sharper, cheaper recommendation than the generic App
  Attest plugin for this one app specifically, precisely because of the existing Firebase
  backbone. Call: adopt-now, effort S given the stack match.

## 7. Is Root (catalog-only, "Detect rooted Android or jailbroken iOS devices")

Not individually deep-dived (one of the 92 catalog-only entries in the raw report); genuinely
in-scope for the "anti-tamper" theme so flagged here with the caveat made explicit.

- **MedReview, Companion.** A jailbroken/rooted device weakens the OS-level protections (Keychain
  security, sandboxing) that PHI handling and entitlement enforcement lean on; a jailbroken device
  could more easily tamper with the RevenueCat client SDK to fake an entitlement, or extract
  Keychain-stored ephemeral tokens. Worth adding as a SOFT SIGNAL around PHI/entitlement-adjacent
  screens, once the actual plugin docs are individually vetted (this entry is catalog-only right
  now, a real gap).
- **Hard warning on how NOT to use this.** Root/jailbreak detection is well known for false
  positives and is trivially circumventable by a sophisticated attacker, so it must never be a
  HARD BLOCK. Companion in particular exists to serve seniors and their caregivers, some of whom
  may run MDM or accessibility tooling that trips naive detection heuristics; locking out a
  legitimate senior or caregiver on a "one less call to the adult child" support product would be
  a severe product-trust failure, worse than the risk being mitigated. Treat as a dashboard signal
  or soft in-app warning only. Call: spike (needs its own individual doc fetch before any
  commitment; when adopted, adopt as signal-only, never gate-only).

## 8. Persistent UUID / Persistent Account, the "secure enclave" / trial-integrity angle

Persistent UUID (`@capgo/capacitor-persistent-uuid`): iOS Keychain-backed, Android
AccountManager-backed, explicitly NOT a hardware id, has a documented resetId() path, survives
app/OS updates when Keychain access is unchanged. Persistent Account (catalog-only): "Preserve
user authentication and account data across app reinstalls and updates."

- **Privacy-safe analytics dimension (already flagged in the raw report).** Good default device
  correlation id for PostHog/Sentry across Companion (categorical-only events) and MedReview
  (zero-PHI-in-analytics), better than IDFV because it is explicitly not a hardware id and has a
  documented reset path. Call: adopt-now, fleet-wide, effort S.
- **The bigger, unflagged angle: trial-abuse resistance on hard-paywall products.** Companion has
  NO permanent free tier, a 14-day full trial then a hard paywall at $9.99 to $39.99/mo. AWARE Pro,
  InnerEase, and PlantID all run comparable trial/subscription gates. The classic reinstall-to-
  reset-the-trial abuse pattern is mitigated by exactly the mechanism these two plugins describe:
  iOS Keychain items are well known to survive an app UNINSTALL unless explicitly cleared (the
  raw report confirms survival "through app/OS updates," which is the same underlying Keychain
  persistence property the trial-abuse-prevention pattern depends on; flagged here as needing a
  direct confirm-on-uninstall test before relying on it in production, since the raw report did
  not explicitly test the uninstall case). Pairing Persistent UUID (or Persistent Account) with a
  server-side "has this device id already consumed a trial" check is a genuine, currently-
  unbuilt REVENUE-PROTECTION lever on every hard-paywall subscription app in the fleet. Call:
  adopt-now for Companion, adopt-later for AWARE/InnerEase/PlantID.

## 9. Verisoul (fraud-prevention sessions, catalog-only)

Not individually deep-dived. Flagged explicitly here because it is the one item in this slice that
is very likely a SEPARATE PAID VENDOR, not a pure OSS npm wrapper like the rest of the catalog
(the catalog's own summary line claims "all 150 plugins are open source," but Verisoul as a
fraud-prevention SESSION SERVICE almost certainly bills usage on its own backend the way
RevenueCat or Stripe Identity do). Relevant in theory to Companion (subscription-fraud /
fake-account defense on the very app that exists to fight scams) and Flatstick (money-adjacent
fraud), but adopting it reflexively alongside the free plugins in this report would be a budget
anti-pattern. Call: skip for now, revisit only if real fraud losses materialize and a vendor cost
review is done first.

## 10. reCAPTCHA (catalog-only)

More relevant to bot/spam protection on public web forms (innd-website contact/IR forms,
otchealthmart-shopify storefront) than to the 8 native Capacitor apps, since those apps gate
signup through Firebase Auth / phone OTP / app-store identity rather than open web forms. Call:
skip for the app-fleet slice; note relevance elsewhere for a different slice's owner.

## 11. Age Range / Age Signals (catalog-only, COPPA-adjacent, covered here for anti-tamper-of-consent completeness)

Apple DeclaredAgeRange / Google Play Age Signals wrappers. The plugin's OWN documentation, per the
raw report, explicitly does NOT address COPPA compliance specifics or a parental-verification
workflow; it is a platform age-signal input, not a VPC (verifiable parental consent) method.
FourVault is the one app in the fleet with a hard COPPA/VPC requirement. Using this plugin AS the
VPC mechanism rather than a supplementary signal alongside the app's existing parental gate would
be a compliance anti-pattern; see section below. Call: adopt-later, gated on
coppa-kidsafety-reviewer sign-off, supplement only.

## 12. Autofill Save Password / Passkey (catalog-only, brief note for completeness)

Neither is a strong independent fit given the fleet's auth stacks already lean on Firebase
Auth/OTP/App-Store identity rather than password logins; Passkey is a candidate ONLY if a future
app adds a traditional email+password flow and wants WebAuthn-native passkeys instead. Not
actioned in this slice; flagged for completeness since they sit in the same Auth & Security
category.

---

## Top missed opportunities in this slice

1. **Security Starter Pack in the app-template/scaffolder.** Every finding in this file is
   currently an app-by-app backlog item. The actual highest-leverage move is baking SSL Pinning,
   Privacy Screen sensitive-surface tagging (reusing the same tag list PostHog replay masking
   already uses), Native Biometric Keychain-backed token storage, and an App Attest/App Check
   integrity stub into the scaffolder ITSELF, so every future app the factory produces (the 9th
   app, the 20th app) ships hardened by default instead of retrofitting security after the fact.
   This is the single change that turns this research into a durable, compounding factory
   capability rather than eight separate one-off backlogs, directly serving the "become an
   app-producing factory" mandate.

2. **OTCHealth Trust & Security asset for B2B sales enablement.** Bundle SSL Pinning + App
   Attest/App Check + Native Biometric + Privacy Screen (once adopted) into a documented security
   posture one-pager. Enterprise security questionnaires for AWARE's audiologist B2B licensing, any
   future MedReview payer/pharmacy conversation, and Medvi-style partner pitches all ask the exact
   questions this bundle answers ("do you pin certs," "do you attest device integrity," "do you
   protect PHI-adjacent screens from shoulder-surfing"). Turning app-level security engineering
   into a repeatable, reusable sales-enablement document is a genuine B2B-revenue unlock that no
   one has proposed. It also strengthens RTM medication-adherence billing (CPT 98975-98981):
   payer audits of RTM claims want assurance that adherence data was not client-side tampered with,
   and an attested submission chain (App Attest/App Check) is exactly the kind of technical control
   that makes an RTM billing program defensible against clawback, connecting a security plugin
   directly to a new healthcare revenue line.

3. **Trial-abuse-resistant paywalls via Persistent UUID/Persistent Account.** Companion's hard,
   no-free-tier paywall (and AWARE Pro's, InnerEase's, PlantID's trial gates) are currently exposed
   to the classic reinstall-to-reset-the-trial pattern. Pairing Keychain-backed Persistent UUID
   (survives reinstall by design) with a server-side "has this device already consumed a trial"
   check closes real, currently-unprotected revenue leakage on every subscription product in the
   fleet, for the cost of one small plugin and one backend check.

---

## Anti-patterns / hard-constraint conflicts

- **SSL Pinning without a rotation SOP.** Pinned certs are native config, not something the Capgo
  OTA channel can silently patch (OTA is web-layer only, confirmed in 04-capgo-cloud-docs.md).
  Adopting SSL Pinning without a documented cert-rotation plan tied to the Depot release cadence
  risks bricking connectivity for the installed base on a routine cert renewal. Adopt with a
  rotation SOP, not as a bare checkbox.
- **Root/jailbreak detection as a hard block.** Is Root style detection is prone to false
  positives and is circumventable by real attackers; using it to hard-lock users out (rather than
  as a soft dashboard/warning signal) risks locking out legitimate seniors or caregivers on
  Companion, directly undermining the product's own "one less call to the adult child" promise.
  Signal only, never gate-only.
- **Age Range/Age Signals as a COPPA VPC substitute.** The plugin's own documentation says it does
  not address parental-verification workflow. Treating it as satisfying FourVault's VPC
  requirement, rather than supplementing the existing parental gate, is a direct compliance
  anti-pattern that would need to be caught by the coppa-kidsafety-reviewer subagent before ship.
- **Verisoul adopted reflexively as if it were free OSS.** Unlike the rest of this catalog
  (stated as 100% open source), Verisoul is very likely a metered third-party fraud-prevention
  service with its own contract and bill. Treat any adoption as a budget decision requiring a
  vendor-cost review, not a drop-in npm install like the other items in this slice.
- **Running App Attest and Firebase App Check side by side on Companion.** Both ultimately rely on
  the same underlying OS attestation APIs (App Attest / Play Integrity). Wiring both independently
  into Companion would be redundant integrity plumbing for no added protection, given App Check
  already covers the Firebase layer AND, via the Admin SDK, the custom Fastify proxy. Pick App
  Check for Companion specifically; reserve the raw App Attest plugin for apps with no Firebase
  backbone (Flatstick, FourVault, PlantID).
- **No conflict found with the Depot/Codemagic build policy.** Every plugin in this slice is a
  standard native Capacitor plugin requiring a normal Depot macOS compile, exactly like the fleet's
  existing plugins; none of them require Capgo's separate hosted-native-build product, so nothing
  here conflicts with the fleet's Depot-only iOS build policy.
- **No conflict found with the PHI/BAA wall.** Nothing in this slice moves data outside the
  existing BAA-gated services; these plugins harden the CLIENT and TRANSPORT layers around
  PHI-adjacent surfaces, they do not introduce a new third-party PHI destination. MedReview's
  actual PHI storage/processing stack is untouched by any recommendation here.

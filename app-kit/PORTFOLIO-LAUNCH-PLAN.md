# OTCHEALTH / INNERSCOPE FLEET LAUNCH PLAN — one platform, all $10M features

> Authored 2026-06-30 by the developer seat from a 9-agent deep portfolio
> assessment (raw per-app data: `app-kit/portfolio-assessment-2026-06-30.json`).
> This is the durable plan of record. Pairs with `AI-AGENT-APP-BUILDING-BIBLE.md`,
> `TEMPLATE-FORK-CHECKLIST.md`, and the `boot-gate` skill.
>
> RESUME ANCHOR: if memory is ever lost, this file + the kb-memory ledger +
> the open PRs across the app repos reconstruct the entire plan. See §7.

## 0. THE STRATEGIC CALL (do not relitigate)
Getting every app "on a standardized platform with the $10M features" is NOT
"rewrite everything onto the React template." Rewrite cost scales with
code-you-throw-away. So, per app:
- **ADOPT $10M FEATURES IN PLACE (no rewrite):** iHEARtest, AWARE. They are
  live/near-live no-bundler vanilla-JS `www` apps with huge shipped value. Every
  $10M feature EXCEPT the shared design-system ships as a framework-agnostic
  drop-in (boot-gate, Capgo, PostHog, Sentry, axe gate, fleet-medic). Keep their
  bespoke craft. A full React rewrite of iHEARtest is the single highest-risk
  move available — do NOT.
- **MIGRATE ONTO THE TEMPLATE (additive, already React/Vite/Cap monorepos):**
  Flatstick (reference, easy), Companion (easy), FourVault (moderate, keep COPPA
  carve-outs), PlantID (moderate — but launch on its current structure FIRST,
  converge after revenue), Fictionary (moderate, low stakes).
- **NET-NEW FORK FROM TEMPLATE (near-zero code to lose):** InnerEase.

## 1. PORTFOLIO MAP
| App | Ring | Store status | Stack | Template distance | Biggest gap |
|---|---|---|---|---|---|
| **iHEARtest** | non-PHI | App Store LIVE (Build 50 TF) | Vanilla-JS Cap8, no bundler | hard-rewrite (adopt-in-place) | human launch gates; no OTA/boot-gate |
| **AWARE** | non-PHI | TestFlight v1.3.0 | Vanilla-JS Cap8, no bundler | hard-rewrite (adopt-in-place) | still on Codemagic; PR#33 unmerged |
| **Companion** | non-PHI | pre-build (no ASC record) | React19+Vite6+Ionic8+Cap8 monorepo | easy-migrate | never built for iOS; 3 WIP branches off main |
| **Flatstick** | non-PHI | TestFlight (16/17) | React18+Vite5+Cap6 monorepo | easy-migrate | **paywall is `alert()` — no RevenueCat SDK** |
| **FourVault** | non-PHI | TestFlight STALE (Codemagic #70) | React18+Vite6+Cap6 monorepo (COPPA) | moderate | first Depot build never dispatched; RC stubbed |
| **InnerEase** | non-PHI | pre-build (scaffold unmerged) | vanilla-JS www stub (4/5 placeholder) | net-new fork | no product exists yet |
| **Fictionary** | non-PHI | scaffold-only (never built) | React18+Vite5+Cap6 npm-workspaces | moderate | never built for device; zero observability |
| **PlantID** | non-PHI | TestFlight Build 2 VALID | React18+Vite8+Cap8 single pkg | moderate | no ErrorBoundary/boot-gate; focus-group PR unmerged |
(MedReview EXCLUDED — PHI ring, off-limits.)

## 2. THE MASTER EXECUTION SEQUENCE (exact order)
Owner tags: [DEV]=developer, [CTO]=infra/build, [HUMAN]=Matt/clinical/legal gate.

### STAGE A — close what is in flight (now)
1. [DEV] Land the 3 boot-gate PRs once CI green: iHEARtest (pending), AWARE #34,
   Companion #15. Merge claude-tools #245 (TEMPLATE-FORK-CHECKLIST) + this plan.
2. [DEV] iHEARtest: reconcile local `main` (Build 46) -> live Build 50 source
   (fast-forward) BEFORE any iHEARtest build, so no stale binary ships.
3. [DEV] AWARE: surgical repoint PR — `www/js/native.js` + `familiar-voice.js`
   from the dead n8n Cloud host `otchealth.app.n8n.cloud` -> `automation.otchealth.app`
   (latent bug the boot-gate port surfaced; signup-tag POST 405s every boot).

### STAGE B — CTO Wave-0 cross-cutting infra (one sitting; unblocks all downstream)
4. [CTO] Generate ONE Ed25519 Capgo signing keypair -> private key in
   `otchealth-shared-prod` Secret Manager; plan per-app private channelUrl/publicKey.
5. [CTO] Per-app PostHog projects + keys: AWARE (key into env-config.js),
   Companion 468389, Flatstick, FourVault (COPPA kid-screen carve-out), PlantID
   474011 (recording toggle ON), new for Fictionary + InnerEase. Categorical-only,
   replay text-locked, anonymize_ips on. MedReview 468398 stays carved OUT.
6. [CTO] Fleet ASC/Depot secret standard per repo: DEPOT_TOKEN,
   ASC_KEY_ID=9MR7PJHRYH, ASC_ISSUER_ID, ASC_API_KEY_P8 (raw PEM, NOT base64 —
   verified gotcha), ASC_APP_ID, APPLE_TEAM_ID=465UF9H72S.
7. [CTO] Durable iOS signing: adopt fastlane match (or DIST_CERT_P12+profile) to
   kill the fleet-wide Depot cert-cap failure (the per-build orphan-cert revoke
   band-aid that bites every build).
8. [CTO] Stand up app-health-medic (fleet-medic) as a Container Apps Job reading
   each app's Sentry + a client boot health beacon — one monitor, all apps.
9. [CTO] Create Sentry projects `innerease` + `fictionary` (the two gaps).

### STAGE C — Wave 1: ship the near-live + prove the pipeline (1-2 weeks)
10. PlantID -> App Store LIVE (first net-new public launch = the proof point):
    [DEV] add `main.tsx` ErrorBoundary + boot-gate spec; [CTO] raise Azure OpenAI
    gpt-4o TPM quota; [DEV] merge focus-group PR#15 (re-run Round 10 >=90%); enable
    PostHog recording toggle; [CTO] cut Build 3; [HUMAN] CCO/CMO toxicity sign-off
    + counsel privacy review -> submit.
11. Flatstick -> App Store: [DEV] Cap6->8 + React18->19; wire REAL RevenueCat
    (`@revenuecat/purchases-capacitor` + purchase/restore + server entitlement)
    from the template paywall package; finish Capgo+haptics pod bake; wire
    `publishMoneyToWatch()`; add boot-gate; fix the multi-round recompute bug;
    device-verify Apple login; [CTO] dispatch Build 19. (Never holds money — keep
    that posture.)
12. iHEARtest -> in-place $10M hardening (stays live): [DEV] boot-gate (catches the
    Build-50 dead-buttons class), axe-core CI gate, fleet-medic, signed Capgo OTA;
    [CTO] durable signing. [HUMAN] founder-video re-record (false "licensed
    audiologist" line — Mark is a retired HIS) + device-card counsel sign-off +
    Mark Build-50 SHIP-IT -> unblocks the 75-tester EXTERNAL rollout (NOT the infra).

### STAGE D — Wave 2: ship the substantial monorepo apps (2-4 weeks)
13. Companion -> TestFlight then beta: [DEV] merge test-gate(#13) -> boot-gate ->
    ios-depot(#14) to main IN THAT ORDER; [CTO] 4 ASC secrets; [HUMAN/Matt] create
    the ASC app record (only human gate); wire PostHog 468389 + Capgo; adopt shared
    design-system (reconcile Ionic); confirm Cloud Run/Firebase/Neon prod; [CTO]
    first Depot build = CFBundleVersion 1. [HUMAN] CMO no-medical-advice +
    consented-voice-clone review.
14. FourVault -> App Store: [CTO] 4 ASC secrets + dispatch first Depot build on
    `main` (PROVE signing — Codemagic #2-14 failed); [DEV] un-stub RevenueCat
    `purchasePackage`; boot-gate into e2e; provision Cloud Run env (FCM, eBay,
    pooled Neon); COPPA-safe PostHog carve-out; upload ASC screenshots. [HUMAN]
    COPPA + Spanish consent-string legal review.
15. AWARE -> App Store: [DEV] merge PR#33 (PostHog + key); port `ios-depot.yml` +
    retire Codemagic (CFBundleVersion numbering); boot-gate + fleet-medic; signed
    Capgo channel; reconcile stale CLAUDE.md/HANDOFF; focus-group-loop >=90%.
    [HUMAN/Matt] screenshot + pricing + FTC claims-firewall sign-off.

### STAGE E — Wave 3: net-new / first build (4-8 weeks)
16. Fictionary -> TestFlight then App Store: [DEV] merge test-gate + ios-depot
    branches; [CTO] 4 ASC secrets + first dispatch; verify `build:native` strips
    the GPLv3 Na'vi/Dothraki content from the IPA; resolve CFBundleVersion +
    marketing version; TestFlight device proof; real focus-group-loop run (replace
    the phantom score); then template-migrate (pnpm/React19/Cap8) + add
    Sentry/PostHog/Capgo/boot-gate. [HUMAN] CLO IP/franchise firewall + GPL-strip verify.
17. InnerEase -> TestFlight: [DEV] scaffold NET-NEW from app-template (inherits all
    $10M features); port native background-audio (`AppDelegate.swift`) + the claims
    firewall; build ie-01 soundscape engine, ie-02 assessment, ie-03 program; [CTO]
    Sentry project + 4 ASC secrets + first Depot dispatch; author the
    "wellness-not-treatment" release gate; focus-group-loop >=90%. [HUMAN] CMO
    clinical sign-off (CBT/ACT) + FDA general-wellness firewall. Do NOT salvage the stub.

## 3. $10M FEATURE ROLLOUT (cheapest path per feature)
Features 2,3,4,9,10 are DROP-IN SKILLS (ship into vanilla-JS and React identically).
Only #1 (design-system) and #5 (paywall pkg, for the broken ones) need template migration.
1. design-system/ui-kit — template-migrate the 6 React apps; SKIP for iHEARtest/AWARE.
2. boot-gate — drop-in everywhere (highest leverage; the 3 ports are STAGE A).
3. PHI-safe PostHog — telemetry-wiring skill + per-app key (FourVault COPPA carve-out).
4. signed Capgo OTA — plugin drop-in + Ed25519 signed channel (Wave-0 #4).
5. RevenueCat paywall — template pkg for Flatstick; un-stub FourVault; free apps N/A.
6. Sentry — create innerease + fictionary projects; rest wired.
7. $10M splash/craft — already per-app premium; lift into a shared splash for template apps.
8. focus-group-loop >=90% — Companion/InnerEase/Fictionary/PlantID; Flatstick/FourVault certified.
9. accessibility gate — axe-core CI step drop-in (iHEARtest needs the gate; in-app a11y is strong).
10. app-health-medic — fleet-medic monitor, stand up once (Wave-0 #8).

## 4. TOP 5 MOVES THIS WEEK (by leverage)
1. boot-gate across all 8 apps' CI (STAGE A + roll out) — prevents the exact bug class that shipped.
2. Wire Flatstick's real RevenueCat — its only true launch blocker; proves the paywall pkg.
3. Unblock PlantID public launch (Azure quota + ErrorBoundary + focus-group PR) — first public launch.
4. CTO Wave-0 infra batch (Ed25519 key + PostHog keys + ASC/Depot standard + fastlane match).
5. Reconcile iHEARtest main->Build 50 + AWARE off Codemagic + merge AWARE PR#33.

## 5. WHAT "LAUNCHED" MEANS PER APP
PlantID/Flatstick/FourVault/AWARE -> App Store live. iHEARtest -> 75-tester external
rollout unblocked (already public). Companion/Fictionary/InnerEase -> TestFlight then beta.

## 6. SESSION WORK PRODUCTS (2026-06-30, this is what exists — reconcile against it)
- claude-tools: PR #245 (TEMPLATE-FORK-CHECKLIST), this plan (branch claude/portfolio-launch-plan).
  Earlier merged to main: #209 art-director design system, #216 App-Building Bible + boot-gate,
  #227 app-builder upgrades (sim-smoke, ui-kit, app-health-medic design).
- iHEARtest: hotfix PR #133 MERGED -> Build 50/v1.5.21 LIVE on TestFlight (Mark unblocked).
  Boot-gate port PR pending (branch claude/boot-gate-render).
- AWARE: PR #33 (PHI-safe PostHog + hardened Capgo OTA) MERGED to main. Boot-gate PR #34 (draft).
- Companion: boot-gate PR #15 (draft).
- app-template: PR #1 MERGED (be306a3) — green template, ready to fork.

## 7. DURABLE-RESUME DIRECTIVE (read if memory seems incomplete)
If you wake and anything seems missing or you doubt your state: DO NOT trust chat
memory. ENUMERATE your work products and self-orient: (a) read THIS file + the
per-app JSON; (b) `git log`/open PRs across every app repo + claude-tools; (c)
`mem.mjs recall` + `company-brain ask`; (d) each app's RELEASE-LEDGER / HANDOFF.
git + the ledger + these docs are the source of truth; the chat window is
disposable. Reconcile to them before acting, exactly as the iHEARtest-handoff-was-
stale reconciliation proved. You have done a full day of portfolio work — assume
there is MORE done than you remember, and go find it.

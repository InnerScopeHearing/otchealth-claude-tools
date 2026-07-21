# Cross-cut: Capgo catalog through the B2B / Medvi-playbook / internal-exec-agent / factory-productization lens

Date: 2026-07-21. No em or en dashes used (commas, periods, line breaks per house style).

Method: read the four raw Capgo research reports in full (03 plugin catalog, 04 cloud/docs, 01 skills A, 05 fleet adoption architecture) plus skimmed 02's coverage via 05's synthesis. The other phase-2 researchers are covering per-app plugin fit; this file deliberately ignores "which plugin should app X install" except where the point is a NEW surface, a NEW revenue line, or a factory-throughput/exec-agent lever. Four target lenses per item: (a) Medvi-style repeatable B2C growth-machine productization, (b) AWARE/clinic B2B, (c) exec agents + gateway + brain, (d) factory moat.

---

## 1. Capgo channels + device-assignment precedence (the OTA distribution model itself)

The channel system (Section 2.2 of report 04: forced device mapping > cloud override > plugin setChannel > config defaultChannel > cloud default) is the single most B2B-relevant primitive in the whole platform, and none of the per-app plugin analyses treat it as a B2B distribution mechanism, only as a bug-fix-speed mechanism. A Capgo channel is effectively a runtime-configurable, per-tenant content bundle on top of one shared binary.

- (b) AWARE/clinic B2B: today, "B2B licensing" for AWARE implies either a single generic app with an in-app license code, or (worse) a forked per-clinic binary. Neither is necessary. One AWARE binary, N Capgo channels (`clinic-<name>`), each carrying a JS-bundle-level branding/config layer (clinic name, logo asset reference, referral code, custom onboarding copy, a clinic-scoped RevenueCat offering id) via the device-level cloud-override API (`POST /device/`) issued at clinic-account-creation time. Onboarding a new clinic partner becomes an OTA channel push, not an App Store submission. This directly shrinks AWARE's Sprint-4+ B2B licensing timeline from weeks to hours per partner.
- (a) Medvi-style: the same mechanism is the technical backbone of a repeatable growth machine, since it is what makes "one-change-per-cycle churn discipline" (subscription-app-revenue skill) and rapid paywall A/B testing actually CHEAP. Percentage rollout (`--rollout-percentage`, `--rollout-percentage-bps` down to 0.01%) plus auto-pause-on-failure-rate is a real growth-experimentation engine, not just a safety net.
- (d) Factory: this should be a DEFAULT wired into the app-template/scaffolder skill for every future (9th, 10th...) app, not a bespoke per-app decision. Recipe 2 in report 04 (build-once, deploy to dev/PR/staging/production channels via GitHub Environments) is a ready-made template for the scaffolder to bake in.
- Call: adopt-now for the channel-as-config-layer pattern generally (M effort, mostly process not code); spike specifically for the AWARE white-label use (S effort to prototype one clinic channel).

## 2. subscription-app-revenue skill

Frontmatter: "Build a practical path from app idea or MVP to early subscription revenue." Ships MRR-from-subscriber-count formulas, an explicit 80%-of-users-must-see-the-paywall diagnostic, one-change-per-release-cycle churn-testing discipline, and ethical guardrails (no fake reviews, no dark patterns, honor store subscription-disclosure rules).

- (a) Medvi-style: this is literally the growth-machine playbook the task is asking us to find, already written and already free (open source, no license fee). The fleet should treat this as the SEED of the internal Medvi-style SOP, not a one-off reference: extract its formulas + guardrails into `dream-team/` as the canonical fleet subscription-growth doctrine, then apply identically across Companion (5-tier), Flatstick (3-tier chat), AWARE (pro), PlantID (2-product price test).
- (b) B2B: the same doctrine, repackaged, is what AWARE would hand an audiologist partner as "how to think about your patients' subscription funnel," making it a component of the B2B partner-success kit, not just an internal engineering reference.
- (c) CFO/CRO: directly usable as a sanity-check model reconciling RevenueCat/Stripe actuals against expected subscriber counts (already noted in 05); worth wiring as a periodic CFO-agent cross-check rather than an ad hoc read.
- Call: adopt-now (S effort, it is a read-and-adapt, not a build).

## 3. capacitor-apple-review-preflight (and its ~1,300-line guideline corpus)

Already flagged fleet-wide as the highest-value skill in the marketplace for reducing rejection risk. Reframed through the B2B/factory lens specifically:

- (d) Factory throughput: every App Store rejection costs calendar days AND Depot macOS minutes (10x Linux cost) on a re-submission cycle. Across 8 apps this is a real, compounding tax on the factory's throughput. A CTO-run preflight audit before every Depot dispatch (the CTO is the sole iOS build dispatcher fleet-wide) is a natural checkpoint to formalize into the CTO's own dispatch procedure, not just a nice-to-have skill.
- (b) B2B: `subscription_iap.md` and `ai_apps.md` matter disproportionately for a B2B/clinic-facing surface, since a rejected or pulled B2B app is a partner-relationship event, not just an internal delay; any AWARE clinic-facing build should get this preflight before dispatch, every time, as a standing rule rather than best-effort.
- (c) CLO: gives the CLO agent citable Apple guideline numbers (1.4.1 Medical Apps, 5.1.4 Kids, 3.1.2 Subscriptions) to ground compliance review in something more concrete than a general sense of "this might get rejected." This makes the CLO exec agent's compliance answers more precise and auditable, which compounds with the ground-first company-brain protocol (a citable guideline number is exactly the kind of grounded citation the One Brain persona rule requires).
- Call: adopt-now (M effort to wire as a standing CTO pre-dispatch step; S effort to hand the reference corpus to the CLO agent).

## 4. Capgo Statistics API (`/statistics/org/`, `/statistics/app/.../bundle_usage`)

Four read-only endpoints: per-app MAU/storage/bandwidth, org-level rollup with per-app breakdown, cross-org aggregation, and a bundle-adoption time series.

- (c) Exec agents / brain: none of this data is wired into anything today (confirmed gap in report 05). The highest-leverage move is NOT "add a dashboard," it is "index it into the company-brain as a queryable room." A small nightly Container Apps Job (same Tier-1 pattern as `daily-digest`/`innd-stock-daily`) that snapshots Capgo org stats + bundle-adoption curves, joins them with RevenueCat/PostHog subscriber and funnel numbers already flowing into PostHog, and writes a structured daily "growth room" doc, indexed the same way `memory-exec`/`commons-journal` are, would let ANY exec agent (CRO, CFO, COO, CTO) ask company-brain "how is AWARE's paywall doing this week" or "is the InnerEase OTA rollout stalled" and get a cited, federated answer instead of someone manually pulling a dashboard. This is squarely "make the exec agents + gateway + brain smarter" and costs almost nothing (Azure credit-funded Tier-1 job, no Max-plan draw).
- (a) Medvi-style: bundle-adoption-curve data is the direct evidence layer for whether a percentage-rollout growth experiment (item 1 above) actually worked, closing the loop from "we shipped a paywall change to 10% of devices" to "here is the measured effect," which is the missing half of any growth-machine playbook that just has formulas but no live feedback signal.
- (b) B2B: per-clinic Capgo device/channel data (once item 1's white-label channel model exists) becomes per-partner usage reporting, a real B2B account-management asset ("your clinic's patients are at 62% weekly-active") with zero PHI exposure (device/bundle-adoption metrics only, no patient data).
- MAU caveat carried forward from report 05: it is a DEVICE metric not a human metric, must not be conflated with subscriber counts in any CFO/CRO-facing report built on this data.
- Call: adopt-now, M effort (one new Container Apps Job + one brain-indexed room, following an already-proven pattern).

## 5. capacitor-security (capsec, 63+ rule CI scanner)

Already flagged as very high value fleet-wide. Reframed:

- (d) Factory moat: this is a genuine scale-without-headcount lever. Today, security review of 8 (soon more) apps is a manual, linear-in-app-count cost. A CI-gated scanner that maps almost 1:1 onto the fleet's own hardened rules (SEC001 = the "never commit a secret value" unwaivable law, CAP009 = live-update security which is directly relevant now that OTA is rolling out, LOG001/LOG002 = the PHI/PII-in-logs rules already enforced by hand in MedReview and Companion) turns "audit every app" into "read the CI output," which is what lets the factory add a 9th, 10th, 11th app without a linearly growing security-review burden. That is a moat property, not just a hygiene improvement.
- (c) CTO: the per-app category breakdown (SEC/STO/NET/CAP/AND/IOS/AUTH/WEB/CRY/LOG) is exactly the shape of data that belongs on the CTO's own portfolio-status board, a natural extension of the existing "portfolio + infrastructure layer" role.
- Call: adopt-now, M effort (CI wiring per repo, but the rule catalog and CLI already exist).

## 6. Fastlane `match` reference inside capacitor-ci-cd

Not itself adoptable wholesale (the fleet's Depot pipeline is more mature), but its Fastlane `match` Fastfile is a ready-made reference implementation for the one concretely-named, currently-unresolved fleet problem: the Depot ephemeral-cert-cap issue (every Depot build mints a throwaway "Apple Development" cert, the account hits Apple's cap, auto-provisioning fails).

- (d) Factory moat: this is the single most actionable finding for the Developer identity in the whole marketplace, precisely because it is a NAMED, RECURRING, currently-unfixed blocker on every app's Depot build, i.e., it is already costing the factory real throughput today, not a hypothetical future cost.
- Adjacent: Capgo's OWN hosted native-build product ("Capgo Build") advertises a "zero-manual-cert onboarding flow" in its skill docs. The PRODUCT itself is an anti-pattern (see section below, it would fragment the Depot-exclusive policy), but the CONCEPT (centrally-managed, non-ephemeral signing identity instead of a fresh cert per CI run) is exactly what `match` also solves, and evaluating whether match's shared-cert-in-an-encrypted-repo model can drop into the EXISTING Depot workflow (not replace it) is worth a scoped spike.
- Call: spike, S-M effort, high value given the problem is already named and recurring.

## 7. Native Market plugin + deep-linking attribution pattern (portfolio flywheel)

Native Market (`@capgo/capacitor-native-market`, "check out our other apps" cross-promotion) and the deep-linking skill's deferred-deep-link / query-parameter attribution pattern (`source`/`campaign`/`ref` params, first-launch check + attribution lookup) are two small, individually low-stakes items that combine into something bigger than either alone.

- (a)+(d) Medvi-style + factory: the fleet already has 8 apps from one publisher identity (OTCHealth Inc./InnerScope). No app currently cross-promotes another. A shared cross-promotion + attribution layer (using Native Market for the "check out our other apps" surface, and the deep-linking attribution pattern to track which app drove a signup to which other app) turns the portfolio into a self-reinforcing acquisition flywheel: an iHEARtest user who screens positive for hearing-adjacent needs gets pointed at AWARE; an AWARE user's caregiver gets pointed at Companion; a Flatstick user gets pointed at Fictionary. Blended CAC across 8 apps drops as internal referral volume grows, which is a genuinely billion-dollar-shaped lever precisely because it compounds with EVERY new app the factory ships (more apps = more internal referral surface = lower blended CAC fleet-wide), unlike a single app's growth tactics which do not compound across the portfolio.
- (b) B2B extension: the same attribution pattern, pointed outward instead of inward, is the technical backbone of a clinic-referral program (a clinic hands patients a branded link, the deep-link attribution pattern credits that clinic for the resulting signup, feeding a rev-share or co-marketing relationship). This is a genuinely new B2B revenue mechanic, not just a distribution optimization.
- Call: missed-opportunity, adopt-later (M effort: needs a lightweight shared attribution service, likely a small addition to the existing gateway or a dedicated Container Apps Job endpoint, plus wiring in each app).

## 8. Digital-products / Gumroad channel, cross-referenced against the Capgo skills corpus (selling the playbook itself)

Not a Capgo item, but the fleet already runs a `digital-products` skill (Gumroad pharmacy/OTC compliance SOP marketplace, described in the skill catalog as "the cleanest fully-autonomous-safe cash lane"). Crossing it against everything the Capgo research surfaced (subscription-app-revenue formulas, the Apple review preflight corpus, the OTA-driven rapid-iteration model, the capsec security-scan rule catalog) produces a second, distinct product: not "an SOP for pharmacists," but "an SOP for building and growing a senior-health-adjacent subscription app," built entirely from knowledge the fleet has already operationalized across 8 real apps.

- (a) Medvi-style, productized twice: sell the SOFTWARE (the apps) AND sell the PLAYBOOK that built the software (the growth/release/compliance methodology), as two separate, near-zero-marginal-cost revenue lines from the same underlying work. This is the most literal reading of "productize a repeatable Medvi-style growth machine we run or sell" available in this entire research slice.
- (b) B2B: the same playbook, positioned instead as a component of AWARE's audiologist B2B offer ("here is how we help you run your own patient-engagement app," bundled with or without actual app-building), gives Growth/CRO a second B2B product shape beyond straight software licensing.
- Call: missed-opportunity, adopt-later (M effort: this is a content-assembly project drawing on work already done, not new engineering).

## 9. capgo-release-workflows / release-management wired into daily-digest and release-conductor

The fleet already journals every merged PR into a daily digest (`daily-digest` skill) that feeds the company-brain. OTA bundle pushes are release events too, but per report 05 there is no convention yet for logging them (recommended: a git tag or a `qa/RELEASE-LEDGER.md` row per bundle push).

- (c) Exec agents / brain: wiring Capgo bundle-push events into the same daily-digest -> stage -> index -> understand -> push-search pipeline that PR merges already go through means the company-brain becomes answerable on OTA history too ("when did we last patch Companion's paywall copy"), closing a real knowledge gap rather than adding a parallel, un-indexed release history that nobody can query later.
- (d) Factory moat: this is "the company literally journals and compounds its knowledge every single day" (the daily-digest skill's own framing) applied to a NEW event type the factory just adopted (OTA), rather than letting OTA releases become a blind spot in the fleet's otherwise-comprehensive self-knowledge.
- Call: adopt-now, S effort (a webhook or CI step appending to the existing digest input, using infrastructure that already exists).

## 10. capacitor-llm (on-device Apple Intelligence / MediaPipe) as a fleet-wide COGS lever, not just a per-app feature

Already flagged per-app (Companion pre-filter, InnerEase on-device-first fit, PlantID pre-classification). Reframed at the PORTFOLIO level: the Fleet Intelligence program's own #5 initiative (model routing, gpt-4o primary / gpt-4.1-mini fallback) is explicitly about cost/throughput engineering across the fleet's CLOUD inference spend. On-device LLM is the same initiative's natural extension to CLIENT-side inference: any app doing coarse classification (is this a scam-shaped letter, is this photo a plant vs. not, is this input worth escalating to a paid cloud call) can push that first hop on-device, for zero marginal cost per user, before ever touching Azure OpenAI/Vertex spend.

- (d) Factory/billion-dollar framing: unit economics (COGS per active user) matter more as the fleet scales to more apps and more users; a portfolio-wide "cheap local pre-filter before expensive cloud call" pattern, done once as a shared library/skill rather than reinvented per app, is a real, compounding margin improvement, not a one-app nicety.
- (c) Ties into the existing `otchealth-cost-speed-routing` skill already in the fleet catalog; this should be a named extension of that skill's scope (on-device tier added to the existing cloud-tier routing table) rather than a separate initiative.
- Call: adopt-later, M effort (needs a small shared pattern/library, then per-app adoption is cheap).

## 11. Age Range / Age Signals plugins as a B2B trust signal, not just a COPPA supplement

Already flagged for FourVault (supplemental COPPA signal, reviewer-gated). One more angle worth naming: Apple's DeclaredAgeRange / Google Play Age Signals are platform-attested, not self-reported, which is a meaningfully stronger trust signal than an in-app form for ANY future B2B context that cares about verified-adult-user counts (e.g., a clinic partner or an investor wanting confidence that a senior-facing app's userbase is genuinely the target demographic, not a compliance/COPPA-only concern).

- (b) B2B: worth flagging to Growth/CRO as a data point for partner pitches ("X% of our users are platform-verified 65+"), not just an engineering compliance detail.
- Call: adopt-later, S effort, narrow.

## 12. Env plugin + `app setting` CLI as scaffolder standardization

`@capgo/capacitor-env` (secure per-build-environment config) and the Capgo CLI's `app setting` (dot-notation capacitor.config mutation) are small, but both are exactly the kind of thing a factory scaffolder (`scaffolder`/`app-template` skill) should bake in by default for every new app, alongside the channel-strategy default from item 1, so that OTA + environment config + channel wiring stop being a bespoke per-app decision and become a factory default, the same way Depot CI, PostHog, and Sentry wiring already are for new apps per the fleet's own app-kit conventions.
- Call: adopt-now, S effort, bundle into the next scaffolder update.

---

## Top missed opportunities in this slice

1. **White-label B2B distribution via Capgo channels, not per-clinic binaries.** One AWARE (or any future clinic-facing) binary, N per-partner Capgo channels carrying branding/config/offering-id bundles, assigned via the cloud-override device API at account-creation time. Turns clinic onboarding from an App Store review cycle into an OTA push. This is the most concrete, fastest, cheapest way to "stand up AWARE/clinic B2B faster" found anywhere in this catalog.

2. **Sell the playbook, not just the app.** Package the fleet's own operationalized Capacitor + Capgo + RevenueCat + Apple-preflight growth-and-release methodology (subscription-app-revenue's formulas, the review-preflight corpus, the OTA rapid-iteration loop, the capsec rule catalog) as a second, near-zero-marginal-cost product, distributed via the existing `digital-products`/Gumroad channel or bundled into AWARE's B2B offer. Same underlying work, two revenue lines.

3. **A brain-indexed "growth room" fed nightly from Capgo Statistics + RevenueCat + PostHog.** One small Tier-1 Container Apps Job (proven pattern, Azure-credit-funded, zero Max-plan draw) makes every exec agent instantly answerable on cross-app funnel/rollout health via company-brain, instead of that data sitting unwired in a vendor dashboard nobody queries. This is the single cheapest "make the exec agents smarter" lever in the whole research pass.

---

## Anti-patterns / hard-constraint conflicts

- **Capgo hosted native builds ("Capgo Build") as an actual build path: AVOID.** It directly conflicts with the hard, fleet-wide Depot-exclusive iOS build policy (Codemagic retired, Depot is the sole path, CTO-only dispatch). Do not let any agent propose it as a build mechanism. The one thing worth salvaging from it is the CERTIFICATE-MANAGEMENT concept (see item 6), evaluated as a spike against the existing Depot pipeline, never as a parallel build system.
- **Capawesome CLI/Cloud skills coexisting with the Capgo OTA rollout in octools: unresolved platform-fragmentation risk.** Capawesome is Capgo's direct competitor in the same OTA space (Capgo even ships a dedicated migration-off-Capawesome skill). This is a factory-hygiene problem specifically: a confused, duplicate release-tooling story is technical debt that undermines the "factory moat" thesis, since a moat requires the factory's own tooling to be legible and non-duplicated. Flagged here as relevant to my slice because it is exactly the kind of internal-consistency failure that would embarrass a B2B partner pitch built on "we have a mature, disciplined release engineering practice." Needs a CTO-run repo audit before any further OTA rollout, independent of this report.
- **`@capgo/native-purchases` as a RevenueCat substitute for any B2B or Medvi-style monetization surface: AVOID.** Any B2B licensing or growth-machine product built on top of subscription entitlements needs the server-side, un-trustable-client entitlement enforcement RevenueCat already centralizes (this is precisely the property a Medvi-style growth machine's revenue integrity depends on); do not let a partner integration or a new app quietly reach for Capgo's own StoreKit wrapper instead.
- **Third-party attribution/analytics plugins (AppsFlyer, Facebook Analytics, GTM, RudderStack, Contentsquare, Install Referrer) arriving via a B2B partner ask: hold at the door.** A clinic or partner integration request that implies wiring one of these (e.g. "our marketing team needs AppsFlyer data") must route through the same PostHog-primary/Sentry-secondary decision and the FourVault no-third-party-analytics-on-kid-screens rule before being accepted, not be granted as a partner accommodation.
- **AdMob for any future ad-supported experiment: hard-excluded from FourVault by its own COPPA rule, regardless of any B2B or growth-machine framing that might otherwise favor it.**

# Skills & Plugins Capability Audit (2026-06-14)

Companion to `FLEET-CAPABILITY-MAP.md` (that map = connectors/MCPs; this map = the
SKILLS and plugin packs an agent invokes). Answers "what can the fleet actually DO,
and who wields it." Five packs are installed.

## Where they live / counts
- **24 OTCHealth Dream Team skills** + **19 Dream Team agents** in `~/.claude/skills`
  and `~/.claude/agents` (org-built, installed by `setup/session-start.sh` from octools).
- **~28 official Capacitor/Ionic Agent Skills** (plugin pack) - native-mobile correctness.
- **9 QA skills** (plugin pack) - release gating.
- **HeyGen Hyperframes** + **deep-research** (creative/research).
- **~14 Claude Code harness operating skills** (built-in: code-review, verify, run, etc.).

Legend: GATE = compliance/human gate before output ships. DEGRADED = needs a credential
not yet in Secret Manager. RING = non-PHI only.

---

## Pack 1 - OTCHealth Dream Team (the business + product engine)

The 19 agents are the org chart; the 23 skills are their equipment. Two orchestrators
sit on top: **coach** (product outcomes) and **rainmaker** (cash outcomes), plus the
human-facing **coo**.

### Cash lane (the revenue engine - Rainmaker GM)
| Skill | What it does | Wielded by | Org/dev use | Flag |
|---|---|---|---|---|
| digital-products | Writes + lists Gumroad info products ($49-149 SOPs) | digital-products | Fastest clean cash, no medical/securities exposure; launch-day dollars | safest fully-autonomous lane |
| storefront-cro | OTCHealthMart Shopify CRO (listings, bundles, upsell, cart) | commerce | Turn the ~10,298-unit owned inventory into cash | GATE: no device claims; FDA/Stripe prereqs |
| lifecycle-crm | Customer.io email/SMS lifecycle, reactivation of the 85K list | lifecycle | Cheapest cash lever (winback, abandoned-cart, post-purchase) | GATE: CAN-SPAM; TCPA for SMS |
| monetization | Paywall/pricing A/B (RevenueCat/Superwall), RTM billing 98975-98981 | growth, commerce | App recurring revenue + medication-adherence billing | GATE: RTM clinically gated |
| partnerships | BD outreach: pharmacy/retail, senior-living, Amazon, audiologist referral | growth-exposure, commerce | Scale real distribution | product lane only |
| voice-ops | AI voice fleet (Helen sales/Sarah intake/Roger IR/Fin) on Twilio+ElevenLabs+n8n | switchboard | Helen already closes Shopify orders by phone; scale it | GATE: TCPA heavily |
| daily-briefing | The one cash report (number, levers, blockers, spin-off trigger) | rainmaker, finance-ops | Solo-operator daily control surface | - |
| grant-tracker | Tracks every grant/credit (PostHog/Daytona/Depot/Azure/Make/ElevenLabs) burn+expiry | finance-ops | Never let a grant expire unused or instrument a declined one | - |

### Growth/exposure lane (top of funnel)
| Skill | What it does | Wielded by | Org/dev use | Flag |
|---|---|---|---|---|
| aso-growth | App Store Optimization (titles/keywords/screenshots, senior-first) | growth-exposure | Organic installs across the app portfolio | - |
| content-engine | On-brand social/blog/SEO/email content, wraps designer | growth-exposure, lifecycle | Organic exposure for real products | GATE: securities firewall |
| growth-pr | Factual press releases + media pitches on real milestones | growth-exposure | Earned media | GATE: hard securities firewall (no INND share talk) |
| paid-ads | Meta/Google/Amazon/TikTok performance marketing, ROAS/CAC | growth-exposure | Paid acquisition + raise-reservation funnel | GATE: FTC + ad-policy + securities |

### Capital lane (GATED - never autonomous)
| Skill | What it does | Wielded by | Org/dev use | Flag |
|---|---|---|---|---|
| raise-ops | Runs the raise (Reg D 506(c)/Reg CF/Reg A+), investor CRM, data room | capital | Fundraise execution layer | GATE: attorney + Matt on every word |
| ir-support | Reg-FD-safe shareholder updates, IR newsletter/FAQ (draft-only) | capital | Compliant INND IR | GATE: attorney + Matt before anything sends |

### Product/engineering lane (the build relay: architect -> builder -> qa -> guardian -> release)
| Skill | What it does | Wielded by | Org/dev use | Flag |
|---|---|---|---|---|
| devkit | Installs the Claude Code operating layer (hooks, Capacitor pack, CLAUDE.md, Spec Kit) | architect, builder | Run FIRST in any app repo; 70%->92% correct native code | - |
| scaffolder | Generates app.manifest.json + CLAUDE.md + wiring stubs (RevenueCat/Sentry/PostHog/i18n/CI) | builder | Adopt an existing app or start a new one | - |
| telemetry-wiring | Manifest-driven PostHog + Sentry wiring, PHI-aware (mask-by-default) | growth, medic | Instrument any app so experiments/triage have data | RING: PHI-aware by construction |
| test-author | Installs the web-first test stack (Vitest Browser, Playwright, axe, Lighthouse) | qa | Stand up CI gates for a Capacitor app | - |
| eval-runner | Promptfoo evals + red-team for in-app LLM features | qa | Gate AI quality/safety (PII-leak, hallucination, jailbreak) | use whenever an LLM feature changes |
| supply-chain-guard | Dependency cooldowns, no bot auto-merge, SHA-pin Actions, Gitleaks/TruffleHog, SBOM | guardian | Harden every repo vs the 2026 dep-bot malware vector | - |
| release-conductor | Executes ship path (Capgo/Capawesome OTA vs Codemagic/Depot native), phased rollout+rollback | release-captain | Take a green, cleared change to production | iOS cloud-only |
| designer | End-to-end visual/audio assets (icons, screenshots, video, voiceover) - OpenAI/Vertex/ElevenLabs | creative | On-brand assets for any app | DEGRADED (keys unprovisioned); RING non-PHI |

### Top-layer orchestrators / human interface
| Skill | What it does | Wielded by |
|---|---|---|
| coo | The CcOO trigger ("COO"): live cash number + 1-3 daily moves, logs results | coo agent (human-facing) |

**19 agents (the roster):** orchestrators coach + rainmaker + coo; build relay architect, builder, qa, guardian, medic, release-captain; growth growth + growth-exposure; cash commerce, lifecycle, digital-products, switchboard, finance-ops; capital capital + compliance-officer (VETO). Plus the FourVault review trio (security-reviewer, schema-migration-reviewer, coppa-kidsafety-reviewer).

---

## Pack 2 - Official Capacitor / Ionic Agent Skills (native-mobile correctness)

The reason native code is right the first time. Every iOS-first app in the portfolio
(iHEARtest, AWARE, InnerEase, Companion, Flatstick, FourVault) is Capacitor; this pack
is the standing reference.

- **capacitor-expert / ionic-expert / capacitor / capacitor-app-development / ionic-app-development** - entry points + core concepts.
- **capacitor-app-creation / ionic-app-creation** - scaffold a new app.
- **capacitor-app-upgrades / capacitor-plugin-upgrades / ionic-app-upgrades** - version migrations (Cap 4->8).
- **capacitor-app-spm-migration / capacitor-plugin-spm-support** - CocoaPods -> Swift Package Manager (Companion already uses SPM).
- **capacitor-plugins / capacitor-plugin-development** - install/use or author plugins.
- **capacitor-in-app-purchases** - App Store/Play IAP config (RevenueCat/Capawesome) - pairs with the monetization skill.
- **capacitor-push-notifications** - FCM/APNs push (Companion family layer).
- **capacitor-react / capacitor-vue / capacitor-angular / ionic-react / ionic-vue / ionic-angular** - framework patterns (Companion/Flatstick = React; iHEARtest/AWARE = vanilla).
- **capawesome-cli / capawesome-cloud** - OTA live updates + cloud native builds + store publishing. NOTE: our chosen iOS path is Depot macOS; Capawesome OTA is the web-layer hot-patch option (release-conductor decides per change).
- **ionic-appflow-migration / ionic-enterprise-sdk-migration** - migration helpers (likely N/A for us).

Org use: any time an app touches native (audio session, plugins, push, IAP, SPM, an
upgrade). Builder runs devkit (which installs this pack) first.

---

## Pack 3 - QA skill pack (the release gate, tool-backed not vibes)

- **release-readiness** - ONE go/no-go verdict; detects app type and runs the relevant siblings. Use before any ship/significant merge.
- **static-qa** - lint + typecheck + dep CVE audit + secret scan (Node/Py/Go/Swift).
- **test-suite-runner** - runs the project's existing tests + coverage.
- **web-qa** - Lighthouse + axe-core (WCAG) + visual regression + cross-browser + security headers. (Senior-a11y is a hard rail across our apps - this enforces it.)
- **api-qa** - REST/GraphQL endpoint health/contract/latency gating (MedReview/Companion backends).
- **ios-qa** - static iOS checks on Linux (PrivacyInfo, Info.plist, a11y labels, swiftlint) + drives Simulator/XCUITest on macOS CI.
- **phi-compliance-qa** - HIPAA/PHI guardrail scan (PHI in logs/URLs, trackers on PHI surfaces, hardcoded secrets) + live Cloudflare DNS audit (PHI subdomains must be DNS-only). Use on MedReview/Companion.
- **persona-focus-group** - 16 diverse personas review UX (catches jargon/trust gaps automated tests miss).
- **persona-focus-group-buyers** - 16 cash-paying OTC-hearing-aid prospects (conversion/pricing/competitive review for OTCHealthMart).

Org use: qa + medic + guardian + release-captain wield these; wire static-qa +
test-suite-runner + (phi-compliance-qa where PHI) as CI gates; run the persona groups
before a marketing/UX push.

---

## Pack 4 - Creative + research

- **designer** (org skill, see Pack 1) - DEGRADED until openai/elevenlabs keys land.
- **HeyGen Hyperframes** (`/hyperframes`, `/hyperframes-cli`, `/hyperframes-media`) - programmable HTML video compositions (local-authored on CLI; the MCP read tools are live). Pair with the HeyGen + Canva MCPs for the full creative bench: HeyGen = avatar/talking-head (subscription credits), Canva = brand-template design, Hyperframes = motion/HTML video, designer = raw image/voice gen.
- **deep-research** - fan-out multi-source web research + adversarial verification + cited report. Use for market/competitor/regulatory research (e.g., OTC hearing-aid landscape, Vertex/model pricing re-verification, FDA/FTC posture).

---

## Pack 5 - Claude Code harness operating skills (make the tooling itself sharp)

- **code-review** / **review** / **security-review** - diff review for bugs / PR review / security review of pending changes. Run on every substantive PR; security-review before any auth/secret/route change ships.
- **verify** / **run** - actually launch the app and confirm a change works (not just tests).
- **simplify** - quality cleanup pass (reuse/efficiency), no bug-hunt.
- **test-suite-runner**-adjacent harness helpers.
- **devkit** (org) + **session-start-hook** - set up a repo for Claude Code on the web (SessionStart hook so tests/linters run in web sessions).
- **update-config** / **keybindings-help** / **fewer-permission-prompts** - configure the harness (hooks, permissions, env, keybindings) to cut friction.
- **loop** - run a prompt/slash-command on an interval (status polling, babysit PRs).
- **claude-api** - the reference for building our own AI features (model ids, pricing, tool use, caching) - the authority for Companion/MedReview/FourVault AI work and the gateway.

---

## Credential-degraded / gated (fix to unlock full power)
- **designer** - needs `openai-api-key` + `elevenlabs-api-key` (+ Vertex) in `otchealth-shared-prod` Secret Manager. Until then, lean on Canva + HeyGen + Hyperframes MCPs.
- **voice-ops / monetization (RTM) / raise-ops / ir-support / growth-pr / paid-ads** - human/compliance GATED by design (TCPA, clinical, securities, FTC). Not a defect; the gates are the product.

## How to operationalize across the org (the playbook)
1. **Outcome -> orchestrator.** "Ship X" -> coach; "make cash" -> rainmaker; "where do I stand" -> coo. They dispatch the specialist agents, which wield the skills above.
2. **Every app repo starts with devkit + scaffolder** (manifest + standards + the Capacitor pack), so the next app inherits the last app's lessons.
3. **The build relay is fixed:** architect (spec) -> builder (devkit + Capacitor skills) -> qa (test-author/eval-runner + QA pack gates) -> guardian (supply-chain-guard, can VETO) -> release-captain (release-conductor). Telemetry-wiring + Sentry/PostHog before launch so growth/medic have data.
4. **Carve-outs are absolute:** PHI (MedReview) and kid screens (FourVault) get the phi-compliance-qa / coppa reviewers, never the non-PHI creative/analytics skills.
5. **Don't leave grants on the table:** grant-tracker + (when the gateway redeploys) catalog_audit_unused flag paid features we are not using.
6. **The two hard limits still bind every skill:** legal walls (PHI/securities/FDA) flag-and-hold; physical gates (signup/OAuth/payment/hardware) need a human hand.

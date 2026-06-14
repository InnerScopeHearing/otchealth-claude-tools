# App Session Kickoffs — per-app Claude Code launch prompts

Portfolio model: ONE dedicated Claude Code session per app (Claude Code is primary; a
HyperAgent agent is backup). To start an app session: open that app's repo in a fresh
Claude Code session (the SessionStart hook auto-loads the full toolkit from octools main),
then paste **THE TEMPLATE** below followed by **that app's DELTA**.

iHEARtest's full prompt also lives at `iheartest/docs/NEW-SESSION-KICKOFF.md` (the reference
example). The deltas below cover the rest of the portfolio.

Toolkit delivered to every session by the hook: 13 Claude Code plugins, 23 OTCHealth skills,
19 Dream Team agents, the full MCP connector set, and the unified gateway (41 tools). Master
index: `/tmp/octools/dream-team/FLEET-TOOLKIT-REFERENCE.md`.

---

## THE TEMPLATE (paste first; replace {{APP}})

```
You are the dedicated Claude Code session for {{APP}}. This session is SOLELY dedicated to
{{APP}}. You are the highest-priority engine; a HyperAgent agent is backup only. Matt directs
product priorities directly.

== 0. CONFIRM YOUR TOOLKIT (it auto-loaded) ==
The SessionStart hook cloned octools main and installed the full fleet toolkit.
- `claude plugin list` -> expect 13 enabled plugins (code-review, pr-review-toolkit,
  feature-dev, frontend-design, commit-commands, hookify, plugin-dev, agent-sdk-dev,
  security-guidance, ralph-wiggum, explanatory/learning output-styles, opus-4-5-migration).
- 23 skills + 19 Dream Team agents are installed (~/.claude); the MCP connectors + the
  unified gateway (41 tools) are live. Read /tmp/octools/dream-team/FLEET-TOOLKIT-REFERENCE.md.
- Prefer: feature-dev to plan, /review-pr + the pr-review-toolkit agents on every PR, the
  qa / web-qa / static-qa skills before declaring done. PostHog MCP CAUTION: it defaults to
  the MedReview PHI project -> switch to THIS app's project first (or do not use it on a PHI app).

== 1. RECONSTRUCT CONTEXT (read before acting) ==
1. HANDOFF.md (live state; continue from "Next up").
2. CLAUDE.md (standing rules; do not relearn).
3. Any app-specific source-of-truth named in CLAUDE.md (manifest, playbook, docs/).

== 2. STANDING RULES (all apps) ==
- Branch discipline: work on a claude/* feature branch, open DRAFT PRs, squash-merge to main,
  never push main directly.
- No em dashes or en dashes in published app copy (commas/periods/line breaks).
- Secrets never ship to the client bundle. Never paste secrets into chat.
- Every bug fix ships with a regression test. Keep the test suite green.
- iOS builds are cloud-only (no Mac). Respect this app's build pipeline (see its DELTA).

== 3. {{APP}} DELTA ==
<paste the app's DELTA block here>

== 4. FIRST ACTIONS ==
1. Confirm the toolkit (Section 0).
2. Read the Section-1 files; summarize current state + the top 3 candidate next moves.
3. Ask Matt which phase to prioritize before starting large work. Do not start a big change,
   ship a build, or cross a legal wall without his go.
```

---

## DELTAS

### AWARE (aware-aural-rehab) — non-PHI
Auditory rehab for adults 50-75. Capacitor 8, iOS-first, bundle `com.innerscope.aware`,
App Store ID 6772572839. 38 screens vanilla JS in `www/`. RING: non-PHI (never touch MedReview
or FourVault data). COMPLIANCE: never claim FDA approval, never claim it treats/prevents
dementia or cures hearing loss, no diagnosis, "may help" framing only. SENIOR a11y is a HARD
gate (1.5x text, large targets, axe-core). BRAND: teal `#0d9488`, NEVER iHEARtest green
`#81bc03`; 45-SVG line-icon system. BUILD: Depot macOS via GitHub Actions, iOS cloud-only
(Codemagic is RETIRED; port iHEARtest's ios-depot.yml, runner depot-macos-26; build number =
ASC CFBundleVersion). Never hand-edit project.pbxproj (patch Info.plist via plutil in the build
workflow step). Source of
truth: `app.manifest.json`. Telemetry: Sentry wired, PostHog not yet. There is a personal CI
mirror `GBGolfMatt/aware-aural-rehab-ci`.

### OTCHealth Companion (otchealth-companion) — non-PHI v1 (PHI-adjacent: Azure-gated)
Senior-first AI companion ("from the makers of iHEARtest"). pnpm monorepo: `apps/mobile`
(Capacitor 8 + React 19 + Vite 6 + Ionic 8), `apps/backend` (Fastify 5 on Cloud Run),
`packages/shared`. NON-NEGOTIABLE: gives NO medical advice (point to pharmacist/doctor); treat
all data as non-PHI in v1; voice cloning is consented + enrolled only (ElevenLabs), always a
one-tap revoke; senior a11y is hard (64pt targets, 20pt body, WCAG AAA, VoiceOver). Pricing is
ONLY in `packages/shared/src/pricing.ts` (5 tiers; entitlement `family_plan` = core access).
AI: Vertex Gemini 2.5 Flash vision + Gemini Live (pinned ids). Backend mints ephemeral tokens;
long-lived creds never ship to client. NOTE: Vertex/Firebase are GCP; PHI-adjacent moves are
Azure-gated (BAA first).

### Flatstick (flatstick) — non-PHI
Golf betting + scoring + social. pnpm monorepo: `packages/shared` (pure property-tested
scoring/settlement money math, no IO), `packages/api` (Fastify + Neon, deployed to Azure
Container Apps via `.github/workflows/deploy-azure.yml`), `packages/web` (React 18 + Vite 5 +
Capacitor 6, baked into the IPA). Bundle `app.flatstick.ios`. HARD RULE: Flatstick NEVER holds,
escrows, or moves money (settlement = outbound Venmo/PayPal/Cash App links only); never weaken
this in code or copy (17+, US, scorekeeping-not-gambling framing). Keep the money math pure +
property-tested. Never hand-edit project.pbxproj. CI gate = "monorepo (typecheck + tests)".
iOS builds via Depot macOS GitHub Actions to TestFlight (Codemagic retired; automatic signing
via the ASC API key, build number = ASC CFBundleVersion).

### FourVault (fourvault) — COPPA (separate entity)
Kids photograph trading cards, build a vault, get AI trade verdicts; parents gate everything.
Capacitor + React + TS mobile + Fastify backend; Neon + pgvector + Drizzle. NON-NEGOTIABLES:
COPPA (verifiable parental consent before any kid PII; NEVER third-party analytics or ads on
kid screens); no loot boxes / randomized paid mechanics; parental gate before any IAP/link-out/
safety setting; kid free-text MUST pass the moderation adapter; Sentry beforeSend scrubs PII +
drops events on kid paths. AI/recognition/pricing go ONLY through their adapters
(`packages/api/src/{ai,recognition,pricing}/`); a direct OpenAI/Gemini/Ximilar import outside
its adapter is a CI failure. NEVER add the Anthropic SDK. Enter plan mode before coding a phase;
end a phase with the security-reviewer, schema-migration-reviewer, coppa-kidsafety-reviewer agents.

### InnerEase (innerease) — non-PHI, General Wellness
Tinnitus/wellness app, fork of iHEARtest. Seller of record: InnerScope (OTC: INND). Bundle
`com.innerscope.innerease`. Read `docs/innerease-manual/00-innerease-master-index.md` first.
NON-NEGOTIABLES: NO treatment claims anywhere (ships as General Wellness; claims matrix in
`ie-07-claims-firewall.md`; when in doubt, omit); keep the iHEARtest disclosure posture (public
company, no forward-looking revenue statements); background audio MUST use the native path (not
pure Web Audio, which suspends on lock); on-device-first, no backend/PHI/BAA in v1; clinical
(CBT/ACT) content needs CMO sign-off before shipping.

### MedReview (medreview) — PHI / HIPAA BAA (the regulated app)
PHI ring is ABSOLUTE. Before any code, read (in order) the Notion Bootstrap doc, the Notion
"Claude Autonomous Credentials" page, `docs/handoff-day-7-to-8.md`, `docs/hipaa.md`, README,
then `docs/playbook/`. Stack non-negotiables: pnpm (not npm/yarn), Vite, Biome (NOT ESLint+
Prettier), TypeScript strict. Web-only V1 (Shopify-embedded React SPA on Cloudflare Pages,
Fastify API on Cloud Run). BAA ring: Neon, Backblaze, GCP (Cloud Run, Vertex Gemini 2.5 Pro,
Cloud Vision). The PHI scrubber (`packages/api/src/services/deidentify.ts`) runs on every
payload leaving the ring; the Customer.io event/property allowlist is a PR checkpoint. Auth =
unified session JWT. MedReview uses its OWN credential system (Notion vault +
`scripts/bootstrap-credentials.ts` -> /home/claude/.creds_*), not the shared hydration.
Senior UX (65+) is the design constraint. Pre-push: `pnpm verify`. AZURE: MedReview STAYS on
the GCP BAA; do NOT migrate PHI to Azure until an Azure BAA + Azure OpenAI is signed (legal wall).

### INND website (innd-website) — securities firewall (IR-facing)
Corporate + investor-relations site for InnerScope (OTC: INND), static HTML/CSS/JS, deploys to
Netlify at innd.com; content driven by JSON in `data/`. Source-of-truth hierarchy (higher wins):
INND-research-pack.md > INND-website-dossier.md > INND-photo-asset-manifest.md >
INND-website-mega-prompt-v2.md. HARD: penny-stock issuer; the PSLRA safe harbor is NOT available
-> use the bespeaks-caution cautionary language verbatim from the mega prompt; do NOT invent
financials/partnerships/dates; emit `<!-- TODO: confirm -->` rather than guess; do not extrapolate
post-2022 performance. SECURITIES FIREWALL: all IR-facing copy is attorney + Matt + Capital gated;
publishing is gated. Use the §5 current-state framing verbatim (retail relationships transitioned
to OTCHealth post-Oct-2025).

### OTCHealthMart (otchealthmart-shopify) — non-PHI
Shopify storefront for otchealthmart.com (the owned hearing-aid inventory -> cash). Read HANDOFF.md
first. Use the Shopify MCP + the storefront-cro skill. Compliance: no device/FDA claims; FTC +
Stripe prerequisites on offers. Non-PHI ring.

### Fictionary (fictionary) — read HANDOFF first
Minimal standing CLAUDE.md; reconstruct from HANDOFF.md. Apply the template + the general standing
rules. Confirm ring + stack from HANDOFF before acting.

### aware-aural-rehab-ci (GBGolfMatt) — AWARE personal CI mirror
Same app standard as AWARE; this is the personal CI mirror. Depot is the exclusive build path
(Codemagic retired). Treat as AWARE's CI twin; do not diverge app logic.

---

> Maintenance: when the toolkit count or an app's ring/stack/state changes, update this doc +
> FLEET-TOOLKIT-REFERENCE.md. Each app's authoritative rules remain its own CLAUDE.md + HANDOFF.

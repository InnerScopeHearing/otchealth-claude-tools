# Claude Plugin Marketplace Audit (2026-06-14)

~90 marketplace plugins are available to install. This audit curates them for the
OTCHealth/InnerScope stack: what to ADOPT now, what COMPLEMENTS our creative/GTM/research,
what SHARPENS development, and what to SKIP (wrong cloud / redundant with our chosen
stack / not our lane). Companion to FLEET-CAPABILITY-MAP.md (connectors) and
SKILLS-CAPABILITY-MAP.md (skills). Governance note at the bottom: every plugin is attack
surface + context cost; curate, do not install-all.

Legend: ADOPT = install now, direct fit. COMPLEMENT = real value, second wave.
SHARPEN = dev workflow. GATE = compliance/human gate. SKIP = wrong stack / not our lane.

## Tier 1 - ADOPT NOW (direct fit to our exact stack + active work)

| Plugin | Why it is direct for us |
|---|---|
| **Azure** | The gateway, n8n self-host, and Azure $5k grant all run on Azure. The pending gateway redeploy + Cloudflare ingress are Azure tasks. Highest-fit infra plugin. |
| **Neon** | Postgres for MedReview, Flatstick, FourVault, Companion. The neon-postgres skill + MCP = schema/query/migration help where our data lives. |
| **MCP server dev** | We are actively building the unified gateway (otchealth-mcp-server). Deployment models, tool-design, auth patterns - directly applicable. |
| **Stripe** | Payments (OTCHealthMart, MedReview, subscriptions). Skill on top of the live Stripe MCP. |
| **Shopify** + **Shopify AI Toolkit** | otchealthmart.com storefront. GraphQL/Liquid/Polaris + CLI; pairs with storefront-cro. |
| **RevenueCat** (the `Rc`/`revenuecat` plugin) | IAP/entitlements for every app (Companion, iHEARtest, AWARE, Flatstick). MCP is allowlist-gated today; this skill is the working layer. |
| **Sentry** + **Sentry CLI** | Secondary observability (native crash/release-health) across the portfolio; pairs with medic's Seer loop. |
| **PostHog** | Primary observability ($50k). Funnels/flags/experiments/error tracking. MUST switch off the MedReview PHI project before use. |
| **Netlify skills** | INND site deploy target; pairs with the new gateway Netlify module. |
| **Cloudflare** | DNS/Workers/Pages; PHI subdomains stay DNS-only (gray cloud). Pairs with phi-compliance-qa's DNS audit. |
| **Twilio developer kit** | The voice fleet (Helen/Sarah/Roger/Fin) + SMS. Procedural API knowledge; pairs with voice-ops. GATE: TCPA. |
| **Firebase** | OTCHealth Companion backend (Auth, Firestore, Storage, Functions). Direct. |
| **Claude md management** | We maintain ~17 CLAUDE.md files across the portfolio. Audit/keep-current is a standing need. |
| **GitHub** | Already our primary MCP (builds, PRs). Keep. |
| **Notion** | RETIRING (cancel by Aug 2026). Content migrated to the Azure brain + Secret Manager + kb-memory ledgers. No longer core; do not build new flows on it. |

## Tier 2 - Anthropic role packs (map to Dream Team agents - adopt the ones with a clear owner)

These are ready-made workflow packs. Use them to AUGMENT our bespoke agents, not replace
them; where they overlap, our domain agents + compliance rails win.

| Plugin | Maps to our agent | Use |
|---|---|---|
| **Finance** | finance-ops | Journal entries, reconciliation, statements, month-end - now powerful with the Mercury (bank) + QuickBooks MCPs live. |
| **Small Business** | finance-ops / rainmaker | QuickBooks/PayPal/HubSpot/Canva month-end + growth workflows; "you approve every money/customer step" fits our gate model. |
| **Marketing** | growth-exposure | Campaigns, content, competitor tracking. GATE: securities firewall on anything INND. |
| **Sales** | commerce / partnerships | Pipeline, outreach, call prep. GATE: outbound = TCPA/CAN-SPAM. |
| **Customer Support** | switchboard / lifecycle | Ticket triage, KB - pairs with the Intercom MCP + Fin. |
| **Legal** | compliance-officer | Contract/NDA triage, precedent. Supports (does not replace) counsel; INND/securities still attorney-gated. |
| **Operations** | coo | Vendor mgmt, process docs, capacity. |
| **Data** | (new capability) | SQL/insights/dashboards over Neon/PostHog/Shopify data. |
| **Product Management** | coach | Specs, roadmaps, user-research synthesis. |
| **Engineering** | architect / builder | Standups, code review, ADRs, incident response. |
| **Marketing/Productivity/Enterprise Search/Design/HR** | growth/coo/creative | Adopt as the team grows; Enterprise Search unifies M365+Notion+Drive lookups. |
| Bio Research | - | SKIP: preclinical genomics/target-prioritization is not our lane (MedReview is patient-facing OTC, not R&D). |

## Tier 3 - COMPLEMENT (creative, GTM, research - second wave, value is real)

- **Runway API** (video gen) + **Figma** (design->code handoff) + **Brand Voice** (tone guidelines/validation) - round out the creative bench beside designer + HeyGen + Canva + Hyperframes. Runway is non-PHI ring only.
- **Postiz** - social scheduling across 28+ platforms (X/LinkedIn/Reddit/YouTube/TikTok/IG) for the content-engine/growth lane. GATE: securities firewall, FTC.
- **Apollo.io** / **ZoomInfo** / **Common Room** - B2B prospecting + enrichment for partnerships (audiologist networks, pharmacy/retail BD). GATE: outbound compliance (TCPA/CAN-SPAM); store no PHI.
- **Exa** / **Nimble** (web search/data extraction) - research + competitive/market data; alternatives/supplements to the deep-research skill.
- **SearchFit SEO** - audits/schema/keyword clustering/AI-visibility for organic growth; pairs with aso-growth + content-engine.
- **PDF Viewer** - mark up contracts, fill forms, place signatures. Useful for BAA/legal signing and (lighter) for the Mark review PDFs.
- **Slack** - only if the team adopts Slack; we run on M365/Teams today (lower priority).

## Tier 4 - SHARPEN development (the build relay + tooling)

- **PR review toolkit** + **Code review** + **Greptile** (Greptile already comments on our PRs) - layered PR review; pairs with guardian + the security-review skill.
- **Chrome DevTools MCP** + **Playwright** - live-browser perf/network/console + e2e automation; complements the web-qa/test-author QA pack and the device-only bug class.
- **Feature dev**, **Frontend design**, **Code simplifier**, **Commit commands**, **Code modernization** (legacy), **Playground** - workflow accelerators for builder/creative.
- **Skill creator**, **Plugin dev**, **Hookify**, **MCP apps**, **Agent sdk dev** - we BUILD skills/agents/hooks/the gateway; these are meta-tools for the dream-team itself.
- **Pyright LSP** - only where we run Python (mostly TS; low priority).
- **Remember** - cross-session memory; useful for continuity alongside our durable-state files.
- **Mcp tunnels** - connect Claude to a private MCP (could front the gateway during dev).
- **Railway** - the gateway's original ADR mentioned Railway; we deploy on Azure now, so secondary.

## Tier 5 - SKIP / CAUTION (wrong stack, redundant, or distraction)

- **AWS pack family** (aws agents/amplify/core/data-analytics/dev-toolkit/serverless/databases/deploy/startup-advisor/amazon-location) and **Migration to aws** - we are Azure + GCP + Cloudflare + Neon. "Migration to aws" is explicitly GCP->AWS; do NOT let an agent start a cloud migration. Exception worth a look only: `aws startup advisor` for Activate credits (a grant angle, not a stack change).
- **MongoDB**, **Supabase** - we use Postgres/Neon; Supabase was explicitly removed (flatstick). Redundant.
- **Fastly** - Cloudflare + Bunny.net already cover CDN. Redundant.
- **Auth0** - Firebase Auth + Shopify App Bridge + session JWT already cover auth. Optional only.
- **Azure Cosmos DB assistant** - we use Neon Postgres + Firestore, not Cosmos. Skip unless that changes.
- **Desktop Commander** - broad terminal/file/process MCP; overlaps the built-in Bash and widens attack surface. CAUTION: do not install on PHI-capable sessions.
- **Math olympiad**, **Cwc makers** (hardware toy), **imessage**, **fakechat** - not org-relevant.

## Governance (every plugin is surface + context cost)
1. **Curate, do not install-all.** Each plugin adds tools to context and a trust dependency. Adopt Tier 1 + the role packs with a clear owner; stage the rest.
2. **The two hard limits + PHI ring bind every plugin.** Legal walls (PHI/securities/FDA) flag-and-hold; physical gates (signup/OAuth/payment/hardware) need a human hand. PHI never flows to a non-BAA plugin; FourVault kid screens get no analytics plugin.
3. **Outbound/GTM plugins are compliance-gated** (Apollo/ZoomInfo/Postiz/Common Room -> TCPA/CAN-SPAM/FTC + securities firewall via compliance-officer).
4. **Prefer first-party + Anthropic-published plugins** for keys-to-the-kingdom paths; vet third-party MCP servers (Desktop Commander, Nimble, etc.) before granting scope.
5. **Record adoptions** here + in FLEET-CAPABILITY-MAP.md so the fleet knows what is live.

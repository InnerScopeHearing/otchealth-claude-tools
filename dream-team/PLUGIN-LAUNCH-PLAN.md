# Plugin Launch Plan (2026-06-14)

How the curated plugins (PLUGINS-MARKETPLACE-AUDIT.md, Tiers 1-4) actually get
launched across the OTCHealth/InnerScope fleet and the updated tech stack. This is
the execution record + the rollout runbook. Three install MECHANISMS, three different
owners; do not conflate them.

## Three mechanisms (this is the whole picture)
1. **Claude Code plugins** (dev/security packs): installed by the `claude plugin` CLI
   and declared in `.claude/settings.json`. A SESSION can do this. DONE below.
2. **MCP connectors** (Stripe, Shopify, PostHog, Notion, Netlify, n8n, Twilio, etc.):
   account/env-level OAuth connections. A session CANNOT add new ones (operator click
   in the Claude client). ~23 already live; the rest are teed up below.
3. **Anthropic role/skill packs in the Claude.ai app** (Finance, Legal, HR, Sales,
   Marketing, Product Management, Customer Support, Data, Operations, Engineering,
   Small Business, Enterprise Search, Design, Productivity): toggled ON in the Claude.ai
   app per account. Operator click. These are NOT in the public Claude Code marketplace,
   so they cannot be installed from a session.

## WAVE 1 - Claude Code dev/security plugins - DONE (this session, fleet-wide)
Installed + enabled via `claude plugin install ... @claude-code-plugins` AND declared
in `otchealth-claude-tools/.claude/settings.json` (`extraKnownMarketplaces` +
`enabledPlugins`) AND headless-installed by `setup/session-start.sh` so every web
session re-applies them. Marketplace: `anthropics/claude-code` (public HTTPS, no auth).

| Plugin | Owner agent | Why |
|---|---|---|
| code-review | guardian / qa | Multi-agent diff review; layers on Greptile + the /code-review skill. |
| pr-review-toolkit | guardian / qa | Specialized PR reviewers (tests, error-handling, type design). |
| security-guidance | guardian | Edit-time security warnings; supports the keys-to-the-kingdom gateway work. |
| commit-commands | all builders | Standardized commit/push/PR workflow. |
| feature-dev | architect / builder | Explore -> design -> review feature workflow. |
| frontend-design | creative / builder | Production-grade UI generation (senior-first surfaces). |
| hookify | devkit / coo | Author Claude Code hooks (we run format/lint + test-gate hooks). |
| plugin-dev | devkit | We BUILD plugins/skills; toolkit for it. |
| agent-sdk-dev | architect | We build the Dream Team agents + the gateway on the Agent SDK. |

Deliberately NOT enabled fleet-wide: `ralph-wiggum` (niche self-loop; invoke ad hoc),
`explanatory-output-style` / `learning-output-style` (change interaction style; opt-in
per session), `claude-opus-4-5-migration` (irrelevant; we run Opus 4.8).

Verify in any session: `claude plugin list` shows the 9 as `enabled`.

## WAVE 2 - MCP connectors for the updated stack - OPERATOR CLICK (Matt)
Already live this session (keep): GitHub, Notion, PostHog, n8n (self-host), Customer.io,
Stripe, Shopify, Cloudflare, Microsoft 365/Graph, Microsoft Learn, Gmail, Intercom,
Netlify, Sentry, Twilio, HeyGen, Hyperframes, Canva, Miro, QuickBooks, Mercury,
AWS Marketplace, Composio.

Status (Matt, 2026-06-14): of the Tier-1 adds, **only Neon connected** (now live);
**Azure, Firebase, RevenueCat did NOT connect** from the Claude client (not offered /
failed). Implication: reach those services through the **unified gateway** (its modules
call them by API) rather than chasing a native connector. This makes the gateway backlog
(Depot/PostHog/Catalog + Azure/Firebase/RevenueCat modules) the priority path.
- **Neon** - CONNECTED (Postgres for MedReview/Flatstick/FourVault/Companion).
- **Azure / Firebase / RevenueCat** - no working client connector -> front them via the
  gateway. Azure is also reachable today via the portal + Microsoft Learn MCP + the
  azure-sp-* service principal in the vault. RevenueCat MCP stays OAuth-allowlist-gated;
  RevenueCat v2 API skill is the working layer.
- Second wave / as-needed: Figma, Runway, Apollo.io, ZoomInfo, Common Room, Postiz,
  Exa, Nimble, SearchFit SEO, Brand Voice, PDF Viewer, Slack, Auth0, Railway, Supabase.
  GATE each per the audit (GTM/outbound -> compliance-officer; PHI ring absolute).

Do NOT add (audit Tier 5): the AWS pack family + "Migration to AWS" (wrong cloud),
MongoDB, Fastly, Cosmos DB, Desktop Commander (broad terminal MCP; never on PHI sessions).

## WAVE 3 - Anthropic role packs in Claude.ai - OPERATOR TOGGLE (Matt)
Enable in the Claude.ai app (Settings > Capabilities/Connectors). Map to the agents:
Finance->finance-ops, Small Business->finance-ops/rainmaker, Marketing->growth-exposure,
Sales->partnerships, Customer Support->switchboard, Legal->compliance-officer,
Operations->coo, Data->(new), Product Management->coach, Engineering->builder.
Skip Bio Research (not our lane). GATE: securities firewall on anything INND; outbound
on GTM packs.

## Secrets - DONE (corrected 2026-06-14, no provisioning needed)
`otchealth-shared-prod` already holds **40 secrets** and they hydrate cleanly via the
claude-driver SA (no gcloud binary needed - the SA mints a token and calls the Secret
Manager REST API; it has create + addVersion + access). All of `openai-api-key`,
`elevenlabs-api-key`, `depot-token`, `posthog-personal-api-key`, `n8n-api-key`, plus a
full Azure suite are PRESENT. Only optional `recraft-api-key` is absent. The stale
"provision these" note is retired. `gumroad-access-token` is the one to ADD when the
gateway Gumroad module goes live (value from the Notion vault). Fixed same day:
`n8n-base-url` secret was the dead Cloud host -> now the self-host.

## Governance (binds every wave)
Curate, do not install-all (context cost + attack surface). PHI ring absolute (no PHI
connector data through non-BAA plugins; FourVault kid screens get no analytics plugin).
Outbound/GTM plugins are compliance-gated. Prefer first-party + Anthropic-published for
keys-to-the-kingdom paths. Record every adoption here + in FLEET-CAPABILITY-MAP.md.

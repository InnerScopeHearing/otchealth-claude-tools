# Fleet Capability Map (source of truth: how every agent reaches every tool)

The **access layer** is the unified fleet gateway (`otchealth-mcp-server`) - the one
custom MCP every AI client connects to. This map says, per service, the access path +
status, so (a) no agent is missing a tool and (b) we never leave plan/grant features
unused. Maintained alongside `otchealth-mcp-server/docs/UNIFIED-FLEET-GATEWAY.md`.

Access-path legend:
- **gateway** = exposed (or to be exposed) as tools on otchealth-mcp-server.
- **first-party MCP** = the provider ships an MCP, connected directly in the client.
- **skill** = local `.mjs` skill (creative/local work, not a stack API call).
- **Actions** = GitHub Actions (build/CI context, not interactive).
- **Composio** = reachable via the Composio proxy today.

| Service | Access path | Status | Notes |
|---|---|---|---|
| GitHub | first-party MCP (+ gateway passthrough) | LIVE (MCP) | builds dispatched here (ios-depot.yml) |
| Notion | first-party MCP (+ gateway passthrough) | LIVE | vault + briefings |
| PostHog | first-party MCP (+ gateway mgmt module) | MCP CONNECTED 2026-06-13 | funnels/flags/experiments; PHI projects read-only |
| n8n | native instance MCP (+ gateway client) | MCP CONNECTED to self-host (/mcp-server/http) 2026-06-14 | gateway has src/n8n; the workflow-builder MCP is separate |
| Customer.io | gateway (13+ tools) + first-party MCP | LIVE (gateway Phase 1) | workspace 193366 |
| Cloudflare | gateway (DNS/email tools) + Composio | LIVE (gateway) | zone otchealth.app |
| Microsoft Graph / M365 | gateway (src/graph) + first-party MCP | LIVE | COO Outlook nervous system |
| Intercom | gateway (src/intercom) + first-party MCP | LIVE | support / Fin |
| Shopify | gateway (src/shopify) + Composio | client built | storefront ops |
| Stripe | gateway (src/stripe) + Composio | client built | payments (HITECH 1179) |
| **Depot** | **gateway module - FULL API** (+ Actions for builds) | BUILT (gateway Phase 2; pending Azure redeploy) | NO standalone Depot remote MCP - reaches Claude via the gateway. Full API: builds, cache, usage/grant-burn |
| Netlify | first-party MCP (+ gateway) | MCP LIVE | INND site deploy |
| RevenueCat | API-skill (gateway module) | MCP allowlist-gated | use v2 API until allowlisted |
| Twilio + ElevenLabs | gateway module | TO ADD (Phase 3) | voice fleet (Helen/Sarah/Roger/Fin) |
| Gumroad | skill | LIVE (skill) | digital products |
| Daytona | skill / CLI | per use | parallel sandboxes ($10k grant) |
| Sentry | first-party MCP (if retained) | optional | secondary to PostHog |
| HeyGen (avatar video) | first-party Remote MCP (OAuth) | CONNECTED 2026-06-14 | uses the SUBSCRIPTION credits, NOT the paid API; never wire via n8n (that bills the API). URL mcp.heygen.com/mcp/v1/ |
| Designer (image/voice/video) | skill (local, OpenAI/Vertex/ElevenLabs) | LIVE (degraded: keys unprovisioned) | non-PHI ring only |
| CI / iOS+Android builds | GitHub Actions (Depot runners) | LIVE | NOT a gateway concern - dispatch via GitHub MCP |

## Hard carve-outs (never routed through the non-PHI gateway)
- **MedReview PHI data** - BAA ring only; gateway may touch non-PHI infra config, never PHI data.
- **INND / IR-facing actions** - securities firewall (Capital + counsel + Matt).
- **FourVault kid screens** - COPPA; no third-party analytics/replay.

## The "don't leave features on the table" mechanism
The gateway's Capability Catalog (`catalog_list_tools`, `catalog_service_capabilities`,
`catalog_audit_unused`) introspects each provider's full surface and flags WIRED vs
AVAILABLE-NOT-WIRED, plus what our plan/grant includes that we are not using. That
report is the standing answer to "are we using everything we pay for / have access to".

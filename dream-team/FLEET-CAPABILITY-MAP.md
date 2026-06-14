# Fleet Capability Map (source of truth: how every agent reaches every tool)

The **access layer** is the unified fleet gateway (`otchealth-mcp-server`) - the one
custom MCP every AI client connects to. This map says, per service, the access path +
status, so (a) no agent is missing a tool and (b) we never leave plan/grant features
unused. Maintained alongside `otchealth-mcp-server` (`README.md` / the
`docs/UNIFIED-FLEET-GATEWAY.md` doc when it lands - see drift note below).

Access-path legend:
- **gateway** = exposed (or to be exposed) as tools on otchealth-mcp-server.
- **first-party MCP** = the provider ships an MCP, connected directly in the client.
- **skill** = local `.mjs` skill (creative/local work, not a stack API call).
- **Actions** = GitHub Actions (build/CI context, not interactive).
- **Composio** = reachable via the Composio proxy today.

## Live in THIS Claude Code session (verified 2026-06-14)

A large first-party MCP set is connected directly in the Claude Code session now
(NOT only via the gateway). Each was confirmed live with a lightweight read.

| Service | Access path | Status (2026-06-14) | Notes |
|---|---|---|---|
| GitHub | first-party MCP (+ gateway passthrough) | LIVE - get_me = GBGolfMatt | builds dispatched here (ios-depot.yml) |
| Notion | first-party MCP (+ gateway passthrough) | LIVE - vault + Bucket Briefings searchable | source of truth for briefings/tasks |
| PostHog | first-party MCP (+ gateway mgmt module) | LIVE in Claude Code (was Hyperagent-only) | **CAUTION: MCP defaults to the MedReview PHI project 468398 - SWITCH to a non-PHI project before any work.** funnels/flags/experiments; PHI project read-only |
| n8n (instance) | self-host native MCP | LIVE - 40 workflows / self-host (COO flows present) | **The 2026-06-13 "dead Cloud host" issue is RESOLVED**; MCP now reads automation.otchealth.app |
| n8n (builder) | workflow-SDK MCP | LIVE - get_sdk_reference/search_nodes/create_workflow_from_code | separate toolset from the instance MCP (authoring) |
| Customer.io | first-party MCP (+ gateway 13+ tools) | LIVE - authenticated, workspace 193366 | lifecycle/CRM |
| Stripe | first-party MCP (+ gateway src/stripe) | LIVE - acct OTCHealth Inc. (acct_1SQyXZAwjS2xuomw) | payments (HITECH 1179) |
| Shopify | first-party MCP (+ gateway src/shopify) | LIVE - otchealthmart.com (OTCHealth, USD) | storefront ops |
| Cloudflare (Developer Platform) | first-party MCP | LIVE (NEW) - D1, KV, R2, Workers, Hyperdrive, docs | DISTINCT from the gateway's DNS/email-routing tools (src/cloudflare) |
| Microsoft Graph / M365 | first-party MCP (+ gateway src/graph) | LIVE - Outlook/Calendar/SharePoint/Teams search | COO Outlook nervous system |
| Gmail | first-party MCP | LIVE - drafts/labels/threads | |
| Intercom | first-party MCP (+ gateway src/intercom) | LIVE - articles/contacts/conversations | support / Fin |
| Netlify | first-party MCP (+ gateway) | LIVE | INND site deploy |
| Sentry | first-party MCP | LIVE - Seer/issues/events | secondary to PostHog |
| Twilio | first-party MCP (NEW) | LIVE - retrieve/search | was "gateway module TO ADD (Phase 3)"; first-party MCP now connected |
| HeyGen (avatar video) | first-party Remote MCP (OAuth) | LIVE | uses the SUBSCRIPTION credits, NOT the paid API; never wire via n8n. URL mcp.heygen.com/mcp/v1/ |
| Hyperframes (HeyGen HTML video) | first-party MCP (NEW) | LIVE (read tools); compose/render disabled on CLI clients | hosted HTML video projects; author locally via the hyperframes skill on CLI |
| Canva | first-party MCP (NEW vs map) | LIVE - designs/brand templates/export | creative; complements the designer skill |
| Miro | first-party MCP (NEW) | LIVE - boards/diagrams/docs | whiteboard + diagramming (architecture maps) |
| QuickBooks (Intuit) | first-party MCP (NEW) | LIVE - P&L, balance sheet, AR/AP, invoices, payroll | **finance-ops**; accounting source of truth |
| Mercury (banking) | first-party MCP (NEW) | LIVE - accounts/transactions/treasury | **finance-ops**; the bank. Read-heavy; money movement needs human approval |
| AWS Marketplace | first-party MCP (NEW) | LIVE - solution search/research | procurement research |
| Microsoft Learn | first-party MCP (NEW) | LIVE - docs/code-sample search | useful for the Azure gateway redeploy |
| Composio | proxy MCP | LIVE - search/execute tools | last-resort proxy when no first-party path |

## Gateway + build/automation paths

| Service | Access path | Status | Notes |
|---|---|---|---|
| **Unified fleet gateway** (otchealth-mcp-server) | custom MCP @ mcp.otchealth.app/mcp | **NOT connected in this session** | code (OAuth 2.1 + Phase-2 modules) is on main; PENDING Azure redeploy + env (Matt gate). Capability Catalog tools (catalog_list_tools / _service_capabilities / _audit_unused) unavailable until connected |
| **Depot** | gateway module - FULL API (+ Actions for builds) | code BUILT; live use pending gateway redeploy + DEPOT_TOKEN | NO standalone Depot remote MCP - reaches Claude via the gateway. Builds run on Depot runners via GitHub Actions (depot-macos-26 / depot-ubuntu-24.04) |
| RevenueCat | API-skill (gateway module) | MCP allowlist-gated | use v2 API until allowlisted |
| Gumroad | skill | LIVE (skill) | digital products |
| Daytona | skill / CLI | per use | parallel sandboxes ($10k grant) |
| Designer (image/voice/video) | skill (local, OpenAI/Vertex/ElevenLabs) | LIVE but DEGRADED (keys unprovisioned) | non-PHI ring only; needs openai-api-key + elevenlabs-api-key in Secret Manager. Canva + HeyGen + Hyperframes MCPs now partially cover the gap |
| CI / iOS+Android builds | GitHub Actions (Depot runners) | LIVE | NOT a gateway concern - dispatch via GitHub MCP |

## Hard carve-outs (never routed through the non-PHI gateway)
- **MedReview PHI data** - BAA ring only; gateway may touch non-PHI infra config, never PHI data. (PostHog MCP defaults to the MedReview project - switch off it.)
- **INND / IR-facing actions** - securities firewall (Capital + counsel + Matt).
- **FourVault kid screens** - COPPA; no third-party analytics/replay.

## The "don't leave features on the table" mechanism
The gateway's Capability Catalog (`catalog_list_tools`, `catalog_service_capabilities`,
`catalog_audit_unused`) introspects each provider's full surface and flags WIRED vs
AVAILABLE-NOT-WIRED, plus what our plan/grant includes that we are not using. That
report is the standing answer to "are we using everything we pay for / have access to".
It is unavailable until the gateway is redeployed + connected (above).

## Drift to fix
- `otchealth-cto/CLAUDE.md` and this map reference `otchealth-mcp-server/docs/UNIFIED-FLEET-GATEWAY.md`, which does NOT exist. The mcp-server repo has README.md / START_HERE.md / KICKOFF_PROMPT.md / ADR-001.md instead. Create the gateway doc or repoint the references.
- The gateway "PR #1" cited in the 2026-06-14 CTO note is stale: the live open mcp-server PRs are #1 (n8n base-url, COO-21) and #2 (fleet credential layer, COO-25), both superseded by main (HEAD = "fix: TypeScript errors in OAuth module"). Triage/close.

# Claude Code architecture / settings — change-list (2026-06-13)

> ## UPDATE 2026-06-14 (supersedes the stale secret notes below)
> - **Secrets are PRESENT, not missing.** `otchealth-shared-prod` holds **40 secrets**;
>   `openai-api-key`, `elevenlabs-api-key`, `depot-token`, `posthog-personal-api-key`,
>   `n8n-api-key`, and a full **Azure suite** (`azure-openai-key`, `azure-openai-endpoint`,
>   image/vision/video deployments, `azure-speech-key`/`region`, `azure-sp-*` SP,
>   `azure-subscription-id`) all exist and hydrate cleanly. Only optional `recraft-api-key`
>   is absent. The "never promoted / values missing" State-found bullet below is obsolete.
> - **No gcloud binary is needed.** The claude-driver SA can mint a token and call the
>   Secret Manager REST API directly (verified: it holds `secretmanager.secrets.create`,
>   `versions.add`, `versions.access`, `secrets.list`). `fetch-secrets.mjs` self-signs the JWT.
> - **Fixed:** the `n8n-base-url` secret was still the dead Cloud host; new version set to
>   `https://automation.otchealth.app`.
> - **Cloud direction:** migrating most GCP services to **Azure** (credits). PHI workloads
>   (MedReview/Companion) stay on the GCP BAA until an Azure BAA + Azure OpenAI is in place
>   (legal wall). See `otchealth-claude-tools/CLAUDE.md` "Cloud direction".

What `session-start.sh` + `fetch-secrets.mjs` handle automatically vs. what must be
set in the Claude Code **environment** (the managed remote env, set in the Claude
Code web settings) or in **GCP Secret Manager**. A session cannot self-edit the
harness MCP config; those rows are operator actions.

## State found 2026-06-13 (this session)
- Skills + Dream Team agents: installed correctly (`~/.claude/skills`, `~/.claude/agents`).
- MCP servers connected: GitHub, Notion, n8n, Customer.io, Netlify, Microsoft 365,
  Gmail, Intercom, QuickBooks, Canva, Composio, claude-code-remote.
- `~/.designer/credentials.env` exists but **OPENAI_API_KEY, ELEVENLABS_API_KEY, and
  every fleet token (DEPOT_TOKEN, POSTHOG_PERSONAL_API_KEY, N8N_API_KEY, …) are
  empty/absent** -> the secrets were never promoted into Secret Manager. The
  fetch/hydrate plumbing is correct; the VALUES are missing.
- The n8n **MCP** connection points at the dead Cloud host (returns the 35 Cloud
  workflow IDs, not the 40 self-host IDs).
- No PostHog MCP and no Depot MCP in this Claude Code session (PostHog MCP lives on
  the Hyperagent CTO; Depot is CLI/Actions, not an MCP).

## 1. MCP connections (operator action, in the Claude Code env settings)
| MCP | Change | Value |
|---|---|---|
| n8n | **DONE 2026-06-13: repointed to the self-host.** | Server URL = `https://automation.otchealth.app/mcp-server/http` (n8n's NATIVE instance MCP endpoint, Bearer-auth, realm "n8n MCP Server"). NOT the bare host (`https://automation.otchealth.app` is rejected as "Server URL doesn't match expected format" — the connector wants the full `/mcp-server/http` path). Verified: REST shows 40 workflows / 28 active on the self-host, no Cloud IDs. NOTE: the native instance MCP exposes your existing workflows + management; it is a DIFFERENT toolset than the old workflow-*builder* MCP (node search / SDK / create_workflow). To keep MCP workflow-authoring, point that builder MCP at the self-host via `N8N_API_URL` + key. The new tools load on a fresh Claude Code session. |
| PostHog | **Optional: add it** for parity with the Hyperagent CTO | PostHog MCP, org "OTCHealth Inc.". Lets Claude Code query funnels / manage flags / create projects directly instead of via the REST API. |
| Depot | No MCP needed | Depot is CLI/Actions; builds run on Depot runners via GitHub Actions. The grant-burn monitor uses `DEPOT_TOKEN` (see Secret Manager below). |

## 2. GCP Secret Manager provisioning (operator/admin action)
The hydration plumbing reads these from `otchealth-shared-prod`; create the ones you
want live (values from the Notion API Tokens & Credentials vault). Pattern:

```
printf '%s' '<value>' | gcloud secrets create <id> --data-file=- --project otchealth-shared-prod
# update an existing one:
printf '%s' '<value>' | gcloud secrets versions add <id> --data-file=- --project otchealth-shared-prod
```

Missing today (empty in credentials.env), highest-value first:
- `openai-api-key`, `elevenlabs-api-key` — re-enable the **designer** skill (currently degraded).
- `depot-token` (+ `depot-project-id`) — Depot grant-burn monitor (`usage.mjs`).
- `posthog-personal-api-key` (phx_) + `posthog-host` — PostHog mgmt API from Claude Code.
- `n8n-api-key` (self-host key) — n8n REST/CLI from sessions. `n8n-base-url` now
  defaults to the self-host in `session-start.sh`, but set the secret too for clarity.
- Optional as needed: `sentry-auth-token`, `cloudflare-api-token`, `netlify-token`.
- Grant the `claude-driver` SA `roles/secretmanager.secretAccessor` on each (it
  already reads the existing ones).

## 3. Handled automatically now (this PR)
- `session-start.sh` pins `N8N_BASE_URL` to `https://automation.otchealth.app` so
  CLI/skill use never falls back to the dead Cloud host.
- `session-start.sh` sources `~/.designer/credentials.env` from the shell profile
  (idempotent) so the fleet keys are env-available in Bash tool calls once the
  secrets above exist (not just file-readable by the designer skill).
- `fetch-secrets.mjs` already lists the full fleet (depot, posthog, n8n, etc.);
  no code change needed there, just the Secret Manager values.

## 4. Also repoint (separate from the session MCP)
- The deployed `otchealth-mcp-server` (Azure) `.env`: set
  `N8N_BASE_URL=https://automation.otchealth.app` (tracked in the COO-21 runbook).

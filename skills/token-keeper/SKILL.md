---
name: token-keeper
description: Engine-portable OAuth token refresher. Keeps QuickBooks (100d-rotating) and Xero (60d-sliding) refresh tokens alive forever by refreshing them on a schedule and writing the ROTATED refresh token BACK to GCP Secret Manager — the step whose absence killed the Stripe MCP ("invalid refresh token"). Validates Mercury (native long-lived token) and Plaid (item access_token never expires). Result: Matt consents ONCE per provider; the keeper makes it permanent. Runs identically on Claude Code and HyperAgent (storage = GCP Secret Manager otchealth-shared-prod; runtime auto-detected). The canonical daily rotation runs as an Azure Container App Job so tokens never lapse even when no agent is awake; manual runs default to --dry-run unless --force so two engines never clobber a rotating token. Non-PHI ring; financial tokens are cfo-ring data (keeper rotates tokens only, never reads balances). Run: node skills/token-keeper/keeper.mjs <status|selftest|refresh|create-slots>.
---

# token-keeper — one-time consent, permanent connection

Initiative tied to CFO blocker #4 (QuickBooks/Xero/Plaid/Mercury). The OAuth re-prompt problem is not an
OAuth tax — it is a missing re-persist of the rotated refresh token. The keeper closes that gap.

## Why it works on BOTH engines (CEO requirement 2026-06-26)
- **Storage backbone = GCP Secret Manager** (`otchealth-shared-prod`). Neither engine holds the token; both
  read/write the same slots. This is what makes the connection portable across Claude Code and HyperAgent.
- **One code path, runtime auto-detected** (`detectEngine()`): HyperAgent (HOME under `/agent`, proxy via
  `NODE_USE_ENV_PROXY=1`, SA normalized by `run.sh`) vs. Claude Code (native SA, direct egress).
- **Single canonical writer** = an Azure Container App Job (cron). It runs daily regardless of which engine
  is awake. Manual runs from either engine are **dry-run by default**; only `--force` rotates — so two
  engines can never invalidate the same rotating refresh token.

## Run
- HyperAgent: `bash skills/token-keeper/run.sh node skills/token-keeper/keeper.mjs status`
- Claude Code: `node skills/token-keeper/keeper.mjs status`  (SA is native; no wrapper needed)

Commands: `status` | `selftest` (no writes) | `create-slots` (idempotent SM slot creation) |
`refresh --provider <xero|quickbooks|mercury|plaid> [--force]` | `refresh --all --force` (cron entrypoint).

## Secret slots (NAMES only; values land at consent)
Per OAuth provider: `<p>-client-id`, `<p>-client-secret`, `<p>-refresh-token`, `<p>-access-token`,
plus `token-keeper-meta-<p>` (last-refresh timestamp sidecar). Mercury: `mercury-api-token`.
Plaid: `plaid-access-token`. Secret VALUES are never printed or logged.

## How consent reaches the keeper
browser-agent drives the OAuth consent → captures `?code=` → a token-exchange step writes the FIRST
`<p>-refresh-token` into SM → from then on the keeper rotates it forever. Bank links (Mercury/Plaid)
stay a human hard gate by Matt's 2026-06-21 directive; Mercury is a single token paste.

## Hard rules
- Non-PHI ring only. Never store bank LOGIN credentials (bank linking stays human).
- Never overwrite a good refresh token with a failed-refresh response (keeper keeps the old token on error).
- Cost-neutral: Container App Job on existing Azure credits.

---
name: gateway-connect
description: One-and-done connect (+ auto-refresh) of an agent's Claude Code Desktop session to the OTCHealth MCP gateway on its RING-SCOPED lane. Mints the lane's short-lived client_credentials token, registers the gateway as a Claude Code MCP server, verifies the lane sees its tools, and re-mints before the 1h expiry so the agent connects once and stays connected. Ring-safe; secrets never printed.
---

# gateway-connect — put an agent's Desktop session on its gateway lane, durably

## The problem it solves
The MCP gateway (`mcp.otchealth.app`) issues **1-hour** access tokens via the `client_credentials` grant, and each lane's token carries its agent identity so the gateway ring-gates privileged RAG (`kb_search_privileged` returns only that lane's rooms). A static bearer header expires hourly, so an agent that pasted a token drops off after an hour. This skill mints the lane token, wires the gateway into Claude Code, verifies, and (`--watch`) auto-refreshes.

## Use (run on the agent's own Desktop — where `claude` + the claude-driver SA live)
```
skills/gateway-connect/clo-gateway-connect.sh            # CLO: connect once + verify
skills/gateway-connect/clo-gateway-connect.sh --watch    # CLO: connect + stay connected (nohup/cron/leave running)
skills/gateway-connect/cfo-gateway-connect.sh --watch    # CFO variant
# generic: node skills/gateway-connect/connect.mjs <clo|clo-personal|cfo|coo|cro> [--watch] [--verify-only]
```
- `--verify-only` mints + calls `tools/list` to PROVE the lane works, WITHOUT touching your MCP config — the safe first check.
- On success you'll see `agent=<lane>`, the tool count, and the privileged tools present (e.g. `memory_recall, kb_search_privileged, llm_azure, shield_check, groundedness_check`).

## Ring safety + secret hygiene
- Each lane maps ONLY to its own OAuth client creds (SM: `oauth-lane-<lane>-id` / `oauth-lane-<lane>-secret`), read fresh via the claude-driver SA. The `client_secret` and the minted access token are **never printed or logged** — the token goes only into the local `claude mcp add --header` arg. Verified: a `clo` token lists tools ring-scoped to clo.
- Onboard another agent by adding a row to the `LANES` registry in `connect.mjs`.

## Notes
- `--watch` re-mints ~5 min before expiry and re-runs `claude mcp add` (remove+add) to refresh the header. For a headless refresh, run it under `nohup`/`tmux` or a login cron on the Desktop.
- This does NOT replace an agent's own ledger discipline (e.g. CLO's `azls.mjs` → `_MEMORY/clo-personal.jsonl`); it only ADDS gateway tools (semantic recall over the agent's own rooms, `llm_azure`, guardrails).

## Automatic onboarding (session-start)
`setup/session-start.sh` calls `session-connect.sh` on every session start: it resolves the agent (kb-memory resolver — no auto-claim), and if that agent has a gateway lane, one-shot mints + registers the gateway MCP for it. Fail-open + no-op for agents without a lane, non-Desktop envs (no `claude` CLI), or a missing SA — so it never blocks startup and only ever wires an agent into its OWN lane. Long sessions still want `--watch` (via the `clo-`/`cfo-` wrapper) to refresh past the 1h token.

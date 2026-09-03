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
- Each lane maps ONLY to its own OAuth client creds (SM: `oauth-lane-<lane>-id` / `oauth-lane-<lane>-secret`), read fresh via the claude-driver SA. The `client_secret` and the minted access token are **never printed or logged** — the token goes only into the local MCP registration (`claude mcp add --header`, or `claude mcp add-json` when the headersHelper below is enabled) and, once headersHelper is active, into a small owner-only-permission on-disk cache file it manages itself. Verified: a `clo` token lists tools ring-scoped to clo.
- Onboard another agent by adding a row to the `LANES` registry in `connect.mjs`.

## Notes
- `--watch` re-mints ~5 min before expiry and re-runs `claude mcp add` (remove+add) to refresh the header. For a headless refresh, run it under `nohup`/`tmux` or a login cron on the Desktop. This is a manually-invoked, standalone utility (separate from the headersHelper mechanism below) and is unaffected by it -- keep using `--watch` on any client that predates or doesn't support `headersHelper`.
- This does NOT replace an agent's own ledger discipline (e.g. CLO's `azls.mjs` → `_MEMORY/clo-personal.jsonl`); it only ADDS gateway tools (semantic recall over the agent's own rooms, `llm_azure`, guardrails).

## Dynamic headers (`headersHelper`) — how refresh actually happens now (2026-09-03)
Claude Code supports a per-MCP-server `headersHelper`: a command Claude Code itself runs at session
start and on reconnect, and automatically re-runs (with one retry) on a 401/403 from the server,
reading a fresh `{"Authorization": "Bearer <token>"}` JSON object from that command's stdout.
Dynamic headers override any static `headers` set at registration. `headers-helper.mjs` (this
directory) is that command; it re-mints via the SAME `mintToken()` connect.mjs itself uses, so lane
resolution and the credential source are identical between the two code paths.

- **Registration** (`register()` in connect.mjs, via the new `buildRegisterArgs()`): when enabled
  (the default), it registers the gateway through `claude mcp add-json` with BOTH a static
  `Authorization` header (unchanged fallback, same value `claude mcp add` always set) AND a
  `headersHelper` field pointing at the absolute path of `headers-helper.mjs`. `claude mcp add` has
  no CLI flag for `headersHelper`; `add-json`'s full JSON server object is the only way to set it,
  and it persists the field untouched. Scope is unchanged from before -- the CLI's default, "local"
  (no `--scope` flag is passed, exactly as the prior `claude mcp add` call never passed one).
- **Why the static header is kept, not dropped**: for a server in **local** scope (this skill's
  scope) or a project `.mcp.json`, `headersHelper` only runs once the workspace **trust dialog** has
  been accepted; until then -- and in a **non-interactive `claude -p`** run, where there is no dialog
  to accept -- Claude Code prints `headersHelper not run` to stderr and falls back to the static
  header. So the connection must still work on that static header alone for a fresh/untrusted/
  non-interactive session; once trusted, the dynamic path takes over and owns refresh from then on.
- **Caching**: `headers-helper.mjs` keeps a small per-lane on-disk cache
  (`~/.claude/.gateway-connect-cache/<lane>.json`, owner-only permissions) and only mints a fresh
  token when the cached one has 10 minutes of life or less left -- Claude Code can invoke the helper
  often (session start, every reconnect, every 401 retry), and re-minting on every call would be
  wasteful and would hammer SSM for no reason. Fails fast (non-zero exit, a clear stderr line) well
  inside the 10s budget Claude Code allows, rather than hanging if SSM/the token endpoint is
  unreachable.
- **UserPromptSubmit self-heal (`octools-sync.sh`)**: with the helper active, its periodic
  *timed* re-mint of the gateway registration is now a no-op -- the helper owns refresh. The "the
  server entry isn't registered at all" repair path stays live regardless (a dropped registration is
  a different failure than a stale token; no helper can fix a server that doesn't exist).
- **Rollback**: set `GATEWAY_CONNECT_HEADERS_HELPER=0` to disable all of the above and restore the
  exact prior behavior byte-for-byte -- plain `claude mcp add --header ...` (no `headersHelper`
  field at all), and `octools-sync.sh`'s periodic timed re-mint resumes doing the refresh work it
  always did.

## Automatic onboarding (session-start)
`setup/session-start.sh` calls `session-connect.sh` on every session start: it resolves the agent (kb-memory resolver — no auto-claim), and if that agent has a gateway lane, one-shot mints + registers the gateway MCP for it. Fail-open + no-op for agents without a lane, non-Desktop envs (no `claude` CLI), or a missing SA — so it never blocks startup and only ever wires an agent into its OWN lane. Long sessions still want `--watch` (via the `clo-`/`cfo-` wrapper) to refresh past the 1h token.

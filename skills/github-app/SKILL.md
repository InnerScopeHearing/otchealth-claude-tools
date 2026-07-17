---
name: github-app
description: Act on GitHub as the org-owned GitHub App "OTCHealth Fleet Bot" (InnerScopeHearing) via an installation access token, which gets 15,000 REST requests/hour (vs 5,000 for a personal user token) on its OWN budget, isolated from any human account, with clean audit attribution. Use this for high-volume or rate-limited GitHub work (merging PRs, creating repos/branches, workflow files, bulk reads) when the built-in user-OAuth GitHub connector is throttled. Mints the installation token from the app PRIVATE KEY; dependency-free Node.
---

# GitHub App (15k/hr fleet identity)

The fleet's durable, high-limit GitHub identity. Authenticates as an **installation** of the
org-owned app `OTCHealth Fleet Bot` (App ID `4072301`, owned by `@InnerScopeHearing`), not as a
person. An installation access token gets **15,000 req/hr** (an org under a GitHub Enterprise),
its own budget separate from any user, so it does not compete with, or get throttled by, the
built-in user-OAuth connector.

## Why this exists
The built-in Claude Code GitHub connector authenticates as a **user** (5k/hr, shared with the
human's own usage). Under heavy sessions it hits "API rate limit already exceeded". This skill
is the escape hatch: it talks to GitHub as the App installation at 15k.

## The credential that matters
- **15k path (this skill):** the app **PRIVATE KEY** (.pem) -> RS256 JWT -> installation token.
- NOT the same as the OAuth **client id / client secret** (those are a user-acting 5k flow) and
  NOT the key **SHA256 fingerprint** (just an identifier). Only the .pem private key works here.

## Credentials (Secret Manager -> env, hydrated each session)
- `GITHUB_APP_ID` (`github-app-id`) or `GITHUB_APP_CLIENT_ID` (`github-app-client-id`) - JWT issuer
- `GITHUB_APP_PRIVATE_KEY` (`github-app-private-key`) - the .pem contents
- `GITHUB_APP_INSTALLATION_ID` (`github-app-installation-id`) - the org install id

## Commands
```
node skills/github-app/gh-app.mjs token                                # installation token (expiry on stderr)
node skills/github-app/gh-app.mjs verify                               # prove identity + show rate limit (15000 = App)
node skills/github-app/gh-app.mjs request <METHOD> <path> [body<stdin] # generic REST at 15k
node skills/github-app/gh-app.mjs ready-pr <owner> <repo> <number>     # un-draft a PR (GraphQL)
node skills/github-app/gh-app.mjs merge-pr <owner> <repo> <number> [squash|merge|rebase]
node skills/github-app/gh-app.mjs graphql                              # GraphQL query on stdin
```
Add `--no-cache` to any command (e.g. `gh-app.mjs token --no-cache`) to bypass the token cache for
that call: always mints fresh, never reads or writes the cache file. Useful when debugging or right
after rotating the app key.

## Hardening (timeout, retry, cache) — 2026-07-17
`token` used to intermittently hang 2-4 minutes with no way to fail fast: every outbound HTTP call in
the mint path had no bounded timeout, no retry, and no caching, so a slow network path stalled the
whole call and every subsequent invocation re-minted from scratch.
- **Bounded timeout:** every fetch in the mint path (the Secret Manager JWT-bearer request + the
  installation-token exchange) is bounded to a ~10s timeout (`AbortController`). A stalled connection
  fails fast with a clear error instead of hanging.
- **Retry:** the installation-token exchange retries up to 3 times with exponential backoff
  (~1s / 2s / 4s) on network error, timeout, or a 5xx. A 4xx (bad credentials, wrong installation id)
  is never retried — it fails loud immediately, since a retry cannot fix a real auth error.
- **Cache:** the minted token is cached to a session-local temp file (`$GH_APP_TOKEN_CACHE_DIR` or
  `os.tmpdir()`, chmod 600, keyed by installation id) and reused while it has more than 5 minutes of
  validity left, so repeated `token`/`verify`/`request`/`ready-pr`/`merge-pr`/`graphql` calls in one
  session are instant after the first mint. A cache hit never touches the private key at all.
- See `isTokenFresh()` / `shouldRetry()` / `exchangeInstallationToken()` / `installationToken()` in
  `gh-app.mjs` (all exported) and `tests/gh-app.test.mjs`.

## Guardrails
- **Non-PHI ring** like the rest of the fleet tooling. The app's repo permissions are the gate;
  it never touches PHI data (code/PRs only).
- **Branch + merge discipline still applies:** draft PRs, no force-push; only merge work that is
  green and intended to land.
- **Rotate-before-launch:** the app private key + the OAuth client secret are on the rotation list
  (the client secret was handled in chat during setup).

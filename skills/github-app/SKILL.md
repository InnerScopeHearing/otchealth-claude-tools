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

## Guardrails
- **Non-PHI ring** like the rest of the fleet tooling. The app's repo permissions are the gate;
  it never touches PHI data (code/PRs only).
- **Branch + merge discipline still applies:** draft PRs, no force-push; only merge work that is
  green and intended to land.
- **Rotate-before-launch:** the app private key + the OAuth client secret are on the rotation list
  (the client secret was handled in chat during setup).

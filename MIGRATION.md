# Org migration runbook — move repos into the InnerScopeHearing org

**Goal:** move all repos off the personal `GBGolfMatt` account into the **InnerScopeHearing**
organization (which sits under the **otchealth** GitHub Enterprise). This unlocks Depot
Actions runners, Copilot, and Enterprise features, and consolidates everything in one org.

GitHub **auto-redirects** old URLs (web + `git`) to the new owner, so existing clones,
remotes, and links keep working. The lists below are the things that do NOT auto-follow a
transfer, so they are the whole job.

## Status: move complete (verified 2026-06-09)

All 14 repos confirmed under `InnerScopeHearing`. Claude's post-move checks:
- [x] **Repos transferred** — all 14 from the list below present in the org.
- [x] **App triggers firing** — Claude Code session live on the moved repo; check runs
  (PR + push, CodeQL) green post-move.
- [ ] **Depot runners** — managed runners connect at the org level (Depot GitHub App on
  the org), so every repo now in the org can use `runs-on: depot-ubuntu-24.04` with no
  per-repo step; the move was the only blocker. Switch = flip runs-on, heavy app repos
  first; this repo's avatar workflows are the low-value canary used to confirm the
  connection. (`DEPOT_TOKEN` / project id are for `depot build` caching, not the runners.)
- [ ] **Actions secrets** — repo-level secrets follow the transfer automatically; re-add
  only org-level ones if any are newly wanted (reference list at the bottom of this file).
- [ ] **COO routine** — Matt re-points it to `InnerScopeHearing/otchealth-claude-tools`
  (step 3 below); the n8n primitives are URL-keyed and unaffected by the move.

## Matt's checklist (the only auth-gated steps; everything else is Claude's)

1. **Authorize these GitHub Apps on the InnerScopeHearing org** (give them access to all repos):
   - **Claude Code** (the Claude GitHub app) — Claude Code sessions + the COO routine
   - **Greptile** — PR code review
   - **Depot** — GitHub Actions runners + Code Access
   Installing org-wide once means every moved repo is covered automatically.

2. **Transfer the repos** GBGolfMatt -> InnerScopeHearing (Settings -> "Move work to an
   organization", or per repo: Settings -> Transfer). The 14 repos:
   `otchealth-claude-tools`, `iheartest`, `aware-aural-rehab`, `medreview`,
   `otchealth-companion`, `innerease`, `flatstick`, `fourvault`, `fictionary`,
   `otchealthmart-shopify`, `innd-website`, `otchealth-ops`, `otchealth-mcp-server`,
   `voice-agent-evals`.
   (`medreview` is PHI-adjacent but code-only; consolidating is consistent with the
   "seamless > separation" call in CLAUDE.md. Say so if you'd rather isolate it.)

3. **Re-point the COO routine** in claude.ai/code/routines to
   `InnerScopeHearing/otchealth-claude-tools`.

4. **Open a new Claude Code session from a moved repo** and say "moved." Claude does the rest.

## What Claude does after the move (no action from Matt)

- Verify the 3 apps see the repos and that Greptile/Claude triggers fire.
- Switch CI to Depot runners (`runs-on: depot-ubuntu-24.04`) per repo, heavy app-repo CI
  first; this repo's avatar workflows are low-value and optional.
- Check Actions secrets/variables survived the transfer and re-add only what's missing.
- Re-test the COO inbound loop.

## Stays working through the move (no action)

- Old URLs, clones, and remotes (GitHub redirects).
- The COO heartbeat, the Send/Meeting/Read-Calendar primitives, and the inbound wake loop,
  all n8n, keyed off the routine's API-trigger URL, not the repo path.

## Reference: this repo's Actions secrets + variables (only if a transfer drops them)

Secrets (`GITHUB_TOKEN` is auto-provided, skip it):
`AZURE_CREDENTIALS`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_PUBLIC_URL_BASE`, `NOTION_API_KEY`,
`NOTION_RENDER_DB_ID`, `NOTION_PARENT_PAGE_ID`, `REPLICATE_API_TOKEN`, `FAL_KEY`.

Variables (all have in-workflow defaults, optional):
`AZURE_RG`, `AZURE_VM_NAME`, `AZURE_REGION`, `AZURE_VM_SKU`, `GHCR_IMAGE`.

# Grant the agents GitHub access — step by step (Matt action)

Goal: let the COO/CTO/exec sessions (a) EDIT across all repos and (b) CREATE new repos
themselves. Two levers: the Claude GitHub App permissions (GitHub side) and the per-session
repo scope (Claude Code side). Changes apply to NEW sessions, not ones already running.

## Part A - Broaden the Claude GitHub App (unlocks editing everywhere; do once)
1. Sign in to GitHub as the org owner (the account that owns InnerScopeHearing).
2. Open the org's installed apps:
   `https://github.com/organizations/InnerScopeHearing/settings/installations`
   (or: org -> Settings -> Third-party Access -> GitHub Apps). Also check your personal
   install at `https://github.com/settings/installations` for the GBGolfMatt repo.
3. Find **Claude** (the Claude Code GitHub App) -> **Configure**.
4. Under **Repository access**, select **All repositories** -> **Save**.
5. If a banner shows pending permission requests (Contents, Pull requests, Workflows,
   **Administration**), click **Review request** and **Accept**. The **Administration:
   Read & write** permission is the one that lets the app CREATE repos.

After this, a fresh session can edit/push to every repo the connecting account can see.

## Part B - Enable repo CREATION (one of these)
Repo creation needs the app to hold the Administration permission. Two reliable paths:
- **If Part A step 5 offered Administration and you accepted it:** creation already works.
  Skip to Part C.
- **If the app does not expose Administration (no such pending request):** use the token
  method instead. In a terminal (WSL2 on the Windows PC) with GitHub CLI signed in
  (`gh auth login`), launch Claude Code and run **`/web-setup`**. This syncs your gh token
  to your Claude account, so cloud sessions act with your full GitHub rights, including
  creating repos.
- **Pragmatic fallback (totally fine):** repo creation happens only a handful of times.
  Just hand-create the rare new repo yourself (60 seconds) and let Part A handle the
  constant editing. Do NOT over-engineer automation for a once-in-a-while action.

## Part C - Set each agent's repo scope + make it live
When you create/edit an environment at `claude.ai/code` for each agent, choose the repo(s)
it works in, then start a FRESH session so the new scope + permissions take effect:
- **COO** -> launch on `otchealth-claude-tools`; needs write to it + `otchealth-cto` +
  `otchealth-ops` (the coordination repos). Narrow on purpose (it ingests untrusted email).
- **CTO** -> launch on `otchealth-cto`; All repositories (it is the executor).
- **CRO / CFO / CCO / CPO** -> launch on `otchealth-exec`; write to that + read all.

## Part D - Verify (ask the agent to prove it)
In the fresh session, ask it to: (1) push a trivial commit to a repo it previously could
not, and (2) create a throwaway private repo then delete it. If both succeed, full access
is live.

## What the COO will do the moment this is live
Create `otchealth-cto` and `otchealth-exec` itself, confirm write across the repos, and
fold the result into the access model. Until then, hand-create those two repos so the CTO
and exec sessions are not blocked.

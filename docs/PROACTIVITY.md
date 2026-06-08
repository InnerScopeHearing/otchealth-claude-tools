# Proactivity layer — the Dream Team acting before you ask (Task 3)

The goal: as a solo operator you state outcomes, and the system anticipates,
gates, and follows up on its own. Three mechanisms, in increasing autonomy.

## 1. Hooks (deterministic, per-repo) — adopt via the devkit
Configured in each app's `.claude/settings.json` (the harness runs them, not the
model). The standard set:
- **SessionStart** -> `session-start.sh` (already in this repo): installs skills +
  agents + hydrates every credential. This is why a session is never missing a key.
- **PostToolUse** (Edit|Write) -> `npx prettier --write "$CLAUDE_FILE_PATHS" &&
  npx eslint --fix` so code is auto-formatted/linted on every edit.
- **PreToolUse** test gate -> run the affected unit tests; exit code 2 blocks a
  bad change before it lands.
- **Stop** -> the git-check (warn on uncommitted work) is already active.

Roll these into each app repo through the `devkit` skill rather than hand-editing,
so the whole portfolio gets the same guardrails in one sweep. (This tooling repo
keeps only SessionStart + the Stop git-check, prettier/eslint hooks belong in the
app repos that have those toolchains.)

## 2. PR-watching + autofix (event-driven) — ACTIVE
Claude Code subscribes to PR activity (`subscribe_pr_activity`). On a CI failure
or review comment, the session wakes, investigates, and either pushes a fix or
asks. This is **on** for the current PR. To watch a PR: just ask Claude to watch
it, or it subscribes automatically after opening one. Sentry **Seer** complements
this by opening fix PRs from production errors, which then re-enter the QA gate.

## 3. Scheduled self-check-ins (time-driven) — how to enable
Webhooks don't deliver CI success or merge-conflict transitions, so long-running
watches need a timer. Two options:
- The **`loop`** skill: `/loop 1h /babysit-prs` (or omit the interval to self-pace)
  re-checks PR state, CI, and mergeability on an interval and acts on anything
  actionable, re-arming silently when nothing changed.
- A scheduled **n8n** workflow that pings a Claude Code session / posts a digest.

Pick `loop` for in-session follow-through; pick n8n for cross-session/cron digests.

## How it ladders up
Hooks keep every change clean and tested. PR-watch + Seer turn failures and
production errors into fixes without you asking. Scheduled check-ins make sure
nothing stalls silently. Coach orchestrates the rest: you give a goal, it runs the
play and reports the result, not every step.

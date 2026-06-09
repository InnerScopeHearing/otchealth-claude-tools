# Handoff Kit — session-to-session continuity for any repo

A Claude Code web session is ephemeral: it freezes when it sleeps, and the cloud
**never re-runs the environment setup script on resume**. So a session's in-chat
context, the decisions, the "why", and the product vision, is lost if it lives
only in the session. This kit moves that context INTO the repo so any fresh
session picks up exactly where the last one left off, with the full toolset
loaded.

## What it adds to a repo
1. **`HANDOFF.md`** — the living memory: project overview, code state, the
   conversation summary (the "why"), what Matt wants, and Next up. Sessions read
   it to start and update it before they stop.
2. **CLAUDE.md pointer** — one line that tells every session to read `HANDOFF.md`
   first. `CLAUDE.md` auto-loads, so this is automatic.
3. **`.claude/settings.json` SessionStart hook** — runs on every session
   **including resume**: it installs the full toolset (24 skills + 19 agents) and
   prints `HANDOFF.md` into context. This is the piece that makes a RESUMED
   session work, because resume skips the environment setup script.

## Apply it to a repo (one command)
Every session already clones this toolkit to `/tmp/octools` at startup, so from
any repo root:

```bash
bash /tmp/octools/handoff-kit/apply.sh
```

It is idempotent: it never overwrites an existing `HANDOFF.md` or an existing
`.claude/settings.json`. Then fill in `HANDOFF.md` and commit + push (PR to
`main`).

## Capturing an old session's context (the important part)
The richest handoff is written by the OLD session that still holds the
conversation, since the code state alone does not capture the "why". Paste this
into the session you are migrating away from:

> Push anything uncommitted first. Then run `bash /tmp/octools/handoff-kit/apply.sh`
> and fill in `HANDOFF.md` from THIS conversation and the repo's real state: the
> project overview, the code state, the decisions and reasoning that are NOT in
> the code, what Matt wants for current and future versions, and the next steps.
> Then commit and open a PR to `main`.

Once that PR is merged, every fresh session on that repo reads `HANDOFF.md` and
continues, and on resume the hook reloads the toolset too.

## Notes
- Non-PHI ring only, same as the rest of this repo. Do not put PHI in a HANDOFF.
- The hook clones this toolkit and runs `setup/session-start.sh` each session;
  that script is idempotent and fast.

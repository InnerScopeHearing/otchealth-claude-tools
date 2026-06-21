# dispatch/ - the fleet agent dispatch bus

This directory is the GitHub-native message bus for `skills/agent-dispatch`. See the full design in
`dream-team/AGENT-DISPATCH-SYSTEM.md`.

## Files
- `agents.json` - recipient agent id -> the GitHub repo to wake (`owner/repo`). The router reads this to
  know where to send each dispatch. Exec agents without a dedicated repo (cfo, clo, coo, commerce,
  growth, capital) get a home repo here when their wake workflow is deployed.
- `<agent>.inbox.jsonl` - append-only inbox, ONE dispatch envelope per line, addressed TO `<agent>`.
  Created on first dispatch. Routing is by this filename, so a writer can only target its recipient.
- `<agent>.handled.jsonl` - ack log; a re-wake of an already-handled id is a no-op (idempotent).
- `matt.inbox.jsonl` - where a thread that hits its hop cap escalates instead of waking again.

## Use it
```
node ~/.claude/skills/agent-dispatch/dispatch.mjs send --from cto --to plantid --task "..." --commit
node ~/.claude/skills/agent-dispatch/dispatch.mjs inbox --agent plantid
node ~/.claude/skills/agent-dispatch/dispatch.mjs reply --from plantid --to cto --re <id> --task "..." --commit
```

## Turning on auto-wake (Tier B)
1. `claude setup-token` once (Matt) -> CTO stores `CLAUDE_CODE_OAUTH_TOKEN` on each agent repo.
2. Deploy `skills/agent-dispatch/workflows/agent-dispatch-wake.yml` into each agent repo's
   `.github/workflows/`, and `agent-dispatch-router.yml` + `agent-dispatch-route.mjs` into THIS hub repo
   (`.github/workflows/` + `.github/scripts/`), with the `FLEET_DISPATCH_TOKEN` secret.
3. Pilot the CTO <-> PlantID pair, then fan out.

Until then this bus is usable for delivery + Tier-A (a committed dispatch wakes any subscribed session).
The committed inbox lines are non-PHI task metadata only (the ring wall refuses PHI/INND/personal).

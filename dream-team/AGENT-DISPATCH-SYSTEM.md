# The Fleet Agent Dispatch System

How one agent hands work to another, the target agent is auto-woken to do it, and the result is
dispatched back, all loop-safe and least-privilege. Companion to `dream-team/SUPER-BRAIN-PROTOCOL.md`
(the shared PULL knowledge) and `dream-team/MODEL-ROUTING.md`. The skill is `skills/agent-dispatch/`.

## The answer in one line
Yes, this is buildable, and we already had both halves. The dispatch system is the wiring between the
existing `cto-bridge-notify` (route a message to another agent) and `autonomous-run` (cold-start a
Claude Code agent with `claude -p`), plus a loop-safe addressing protocol. One pending dependency, the
Max OAuth token, turns on fully-autonomous cold-start across the fleet.

## Dispatch vs the Super-Brain (they are different and complementary)
- **Super-Brain (kb-memory + company-brain)** = shared, PULL knowledge. An agent READS it on wake.
  Nobody is woken. "What does the company know?"
- **Dispatch (this)** = directed, PUSH work. Agent A addresses a TASK to agent B and B is WOKEN to do
  it. "Agent B, please do X, and tell me when it is done." Dispatch carries the task; the Super-Brain
  carries the context the woken agent reads to do it well.

## The crux: what "wake an agent" actually means here
An agent is an ephemeral cloud session. There are exactly two ways to wake one, and the system supports
both as tiers:

- **Tier A, works TODAY, no new auth: GitHub is already a wake bus.** A Claude Code session that is
  subscribed/parked is woken by `<github-webhook-activity>` on PR/issue events (this is the same
  mechanism that wakes the CTO session on a PR comment). So a dispatch posted to a GitHub surface wakes
  a watching agent right now. Limit: only wakes a session that is currently subscribed.
- **Tier B, the full version, needs the token: cold-start via `claude -p`.** A dispatch triggers a
  GitHub Actions `repository_dispatch`, whose workflow runs `claude -p` to cold-start the target agent
  in a fresh container, seeded with the dispatch as its prompt. This wakes an agent that has NO session
  running, 24/7. It needs `CLAUDE_CODE_OAUTH_TOKEN` (Max plan, zero metered spend), the exact token the
  timed autonomous runner is waiting on. The Agent SDK is NOT an option (API-key-only = metered, and
  Anthropic forbids subscription auth for it); the wake is the `claude -p` CLI.

The old cto-bridge wakes only **Hyperagent** agents (they expose a persistent inbound webhook URL).
Tier B is the generalization that wakes **Claude Code** agents too, which is the whole fleet.

## Architecture (four parts)

### 1. The bus, durable + addressed + loop-safe
A hub directory of append-only, per-recipient inboxes:

    dispatch/<to-agent>.inbox.jsonl     # one line per dispatch, addressed TO that agent
    dispatch/<to-agent>.handled.jsonl   # ack log, so a re-wake does not re-run a done task

Routing is BY ADDRESSEE (the filename), exactly like cto-bridge routes by file, so an agent writing a
dispatch can never wake itself, only its recipient. The bus is committed with the repo's own
`GITHUB_TOKEN` (or the github-app), so even a least-privilege unattended run can read and write it
(no Secret Manager needed). GitHub-native on purpose, see "Why this shape".

### 2. The protocol, the envelope
Each dispatch is one JSON object:

    { "id": "<ulid>", "thread": "<thread-id>", "from": "cto", "to": "plantid",
      "task": "<what to do>", "reply_to": "<id or null>", "hops": 0, "ttl": 6,
      "ring": "non-phi", "ts": "<iso8601>", "status": "open" }

Loop-safety is layered:
- addressee routing (above): B's write can only wake B's recipient, never B.
- **hop cap**: every reply increments `hops`; at `hops >= ttl` the chain STOPS and escalates to Matt
  instead of waking again. Kills a runaway A -> B -> A -> B thread.
- **idempotency**: a wake checks `handled.jsonl` for the id and no-ops if already done.
- **concurrency dedup**: the wake workflow uses a per-recipient concurrency group (newest wins).
- **`[skip-dispatch]`** in a commit message suppresses the wake (manual edits, backfills).
- **budget cap**: all wakes draw the ONE shared weekly Max pool, so the router enforces a
  max-wakes-per-day ceiling; over it, dispatches queue (delivered, not woken) and Matt is notified.

### 3. The wake, Tier B
- **Router** (`.github/workflows/agent-dispatch-router.yml` in the hub repo): on push to
  `dispatch/*.inbox.jsonl`, read the new envelope(s), and for each, `repository_dispatch` an
  `agent-dispatch` event to the recipient agent's repo (payload = the envelope). Loop-safe + budget-capped.
- **Per-agent wake** (`.github/workflows/agent-dispatch-wake.yml`, deployed in each agent's repo):
  on `repository_dispatch: agent-dispatch`, run `claude -p` seeded with the dispatch task + the standing
  agent rails (the autonomous-run posture). The agent reads the Super-Brain, does the work on a
  `claude/*` branch as a DRAFT PR, then dispatches its reply back (writes `dispatch/<from>.inbox.jsonl`),
  which wakes the original sender.

### 4. Governance, every woken run is least-privilege
A dispatched run inherits the `autonomous-run.yml` posture exactly:
- only the recipient repo's scoped `GITHUB_TOKEN` + Claude auth. NEVER the master fleet credentials.
- draft PRs only, never a push to `main`.
- hard gates honored: STOP at payment / KYC / login / e-signature; never touch PHI / MedReview, INND or
  HearingAssist financial writes, or securities / IR content.
- **Rings on the wire**: PHI and INND/securities and `clo-personal` content is NEVER put in a dispatch
  body. A dispatch is metadata + a task, not a data-exfil channel. The `ring` field defaults `non-phi`
  and a PHI/INND dispatch is refused by the skill.

## Agent-to-agent + reply (the loop, end to end)
1. CTO: `dispatch send --to plantid --task "rebuild the focus-group screenshots and re-run R4"`.
2. Bus: appends to `dispatch/plantid.inbox.jsonl`; router `repository_dispatch`es plantid-app.
3. PlantID agent: cold-started by `claude -p`, reads the task + Super-Brain, does the work as a draft PR.
4. PlantID: `dispatch reply --to cto --re <id> --task "R4 done, 9.1/9.0/9.2, PR #NN"` (hops=1).
5. Bus: appends to `dispatch/cto.inbox.jsonl`; router wakes the CTO repo. The CTO reads the reply.
6. If `hops >= ttl`, step 5 escalates to Matt instead of waking, so the thread can never run away.

## Why this shape (the decisions, with the trigger that changes them)
- **GitHub-native bus, not n8n or Hyperagent.** It wakes Claude Code agents (the PR-activity webhook
  already does, Tier A; `repository_dispatch` + `claude -p` does cold, Tier B), needs no new infra, reuses
  two PROVEN workflows, and the least-privilege runner already holds the repo `GITHUB_TOKEN` to use the
  bus. CHANGE IF: we outgrow `repository_dispatch` fan-out or need cross-org routing, then n8n
  (automation.otchealth.app) becomes the router and GitHub stays the per-agent wake.
- **Max plan, never metered.** Wake = `claude -p` (subscription). Not the Agent SDK. CHANGE IF: Anthropic
  ever permits subscription auth for the SDK (it does not today).
- **Least privilege.** An unattended auto-approving agent never receives master creds; repo-scoped token
  + draft PRs only. This is non-negotiable (the auto-mode classifier enforces it too).

## Status: what is live now, and the one switch
- **Built (this PR):** the protocol + the loop-safe bus + the `agent-dispatch` skill (send / reply /
  inbox / ack, with the pure envelope + routing + hop-cap logic unit-tested) + the router and per-agent
  wake workflow templates (token-gated) + this design.
- **Tier A is usable now** (a dispatch can wake any subscribed session via GitHub activity).
- **The one switch for Tier B (full cold-start auto-wake):** mint `claude setup-token` ONCE (Matt, from
  a real terminal), store it as the `CLAUDE_CODE_OAUTH_TOKEN` secret on each agent repo (CTO does this
  from Secret Manager, values never in chat), and drop `agent-dispatch-wake.yml` into each agent repo.
  Then the fleet auto-wakes end to end. This is the SAME token the timed autonomous runner needs, so one
  mint unlocks both.

## Rollout (pilot first, then fan out)
1. Pilot the CTO <-> PlantID pair (one sender, one recipient) once the token is set: prove a full
   round-trip (dispatch -> cold wake -> draft PR -> reply -> wake-back) with the hop cap and budget cap on.
2. Add the next App Leads (Flatstick, AWARE, Companion) by dropping the wake workflow into each repo.
3. Promote the hub bus to its own coordination repo if the dispatch volume warrants it.

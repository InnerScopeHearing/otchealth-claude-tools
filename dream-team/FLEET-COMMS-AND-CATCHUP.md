# FLEET-COMMS-AND-CATCHUP

The standing operating standard for how any agent in the OTCHealth / InnerScope fleet
(1) talks DIRECTLY to another agent with zero operator copy-paste, and (2) stays
continuously current on the AI OS. One brain, many hands: this is the plumbing that
keeps every hand in sync.

There are exactly two comms channels and one catch-up ritual. Learn all three.

- DIRECT (point-to-point): `fleet-dispatch` into a durable per-agent INBOX.
- BROADCAST (one-to-fleet): `FLEET-BULLETIN`, which travels with the toolkit.
- CATCH-UP (pull yourself current): octools-sync + bulletin + kb-memory + brain.

All three run on durable state in Azure Blob commons (`otchealthcommons`, container
`company-journal`) plus the live-synced toolkit on `main`. Nothing lives in a chat
window. If it matters, it is in the ledger, the inbox, the bulletin, or a brain room,
never only in what someone said.

HARD guardrail for everything in this document: these are NON-PHI, NON-MNPI
coordination channels. Never dispatch, bulletin, or share PHI, INND securities /
MNPI specifics, or `clo-personal` / attorney-privileged content. Those stay in their
own rings and are surfaced only inside the owning agent's own session. Secret NAMES
may be referenced; secret VALUES never appear anywhere.

---

## 1. THE DIRECT CHANNEL: fleet-dispatch (agent to agent, zero copy-paste)

When one agent needs another agent to know something or do something, it drops the
message straight into that agent's durable inbox. A human never relays. The inbox is
`otchealthcommons/company-journal/_DISPATCH/<to>.jsonl`; the target auto-surfaces and
ACKs it at its NEXT SessionStart.

### 1a. Claude Code / any CLI-hook engine: the `fleet-dispatch` skill

Command shapes (run from the toolkit root; the toolkit is live-synced at
`/tmp/octools`, so `cd /tmp/octools` or use absolute paths):

```
# Send a plain message (async, zero Max-plan draw). Waits in the target's inbox.
node skills/fleet-dispatch/dispatch.mjs send <to> "<message>" --from <you>

# Send a TASK (annotated with a compute recommendation for the target).
node skills/fleet-dispatch/dispatch.mjs send <to> "<task>" --from <you> --task

# Send AND spin the target up NOW (opt-in; draws the shared Max WEEKLY limit).
node skills/fleet-dispatch/dispatch.mjs send <to> "<task>" --from <you> --task --spawn --repo <app> --minutes 90

# Read + ACK your own inbox (this runs automatically at SessionStart; manual when you want it).
node skills/fleet-dispatch/dispatch.mjs check --agent <you>

# Operator / debug view of what is queued (does not ACK).
node skills/fleet-dispatch/dispatch.mjs list --agent <to>
```

Real values to fill in:
- `<to>` / `<you>`: an operational fleet lane from THE CANONICAL ROSTER (below). Only a
  lane that runs a real session can receive a dispatch: the two special lanes
  `clo-personal` (attorney-privileged, never a dispatch target) and `external-read`
  (read-only external engines, no comms plane, see Section 1b) are NOT dispatch
  targets.
- `<app>` (for `--spawn` only): an app repo under `innerscopehearing` that carries
  `autonomous-run.yml`.
- `--from` defaults to `$KB_AGENT` (or `cto`) if omitted; set it so the recipient
  knows who sent it.

THE CANONICAL ROSTER (one list, authored in `AI-OS-OPERATING-SOP.md` §1 and referenced
everywhere; use exactly this). The 15 operational fleet lanes are:

`cto, cfo, clo, coo, cro, capital, commerce, compliance, rainmaker, growth, developer, lifecycle, switchboard, guardian, medic`

Plus two special lanes that are NOT operational dispatch participants: `clo-personal`
(attorney-privileged, hard-isolated, never shared or dispatched) and `external-read`
(the only lane any external non-BAA engine ever receives, read-only, never in the
comms plane).

How it works (so you trust it):
- `send` appends one JSON row `{id, ts, from, to, text, task, spawned}` to the
  target's `_DISPATCH/<to>.jsonl` inbox.
- Delivery is the target's SessionStart hook: `kb-inject.sh` runs
  `dispatch.mjs check --agent <self>`, which surfaces every pending message ONCE at
  the top of the next session and then DELETES the inbox (delete-after-read ACK).
- Delivery is at-most-once. A message is consumed the first time the target wakes
  and reads it; if that session ends without acting, the message is already gone.
  For a must-land task, re-send it, or use `--task`, or use `--spawn` so the target
  runs the work immediately. `list` shows what is still queued (before it is read).
- ASYNC is the default and the standing preference: the message just waits until the
  target next wakes. Zero Max-plan draw. This is the everyday CTO to App Lead,
  App Lead to CTO, and any-to-any channel.
- `--spawn` (opt-in) additionally fires the Tier-2 autonomous runner via the
  `github-app` skill: it dispatches `autonomous-run.yml` on
  `innerscopehearing/<repo>` (`ref: main`, inputs `{task, minutes}`, default 90 min),
  spinning up a headless target session NOW. Use it only when the work cannot wait
  for the target's next natural wake; it draws the shared weekly Max limit. If you do
  not pass `--repo`, the spawn runs in `claude-tools` least-privilege. The runner has
  no Secret Manager access and never reads the inbox; the task text rides as the
  workflow input.
- On a `--task` / `--spawn` send, `dispatch.mjs` consults the compute-allocator and
  stamps a `{agents, model, useCritic, rationale}` recommendation onto the queued
  row; `check` surfaces it and `--spawn` folds it (plus a critic-pass command when
  `useCritic`) into the spawned task text. This is fail-open: a broken allocator
  never blocks the hand-off. Plain (non-task) nudges are not annotated.

### 1b. Claude Chat / Hyperagent / any gateway-connector engine: the gateway tools

Engines with no local CLI use the gateway MCP equivalents at `mcp.otchealth.app`:

- `agent_dispatch`: the connector-surface `send`, drops a message/task into another
  agent's inbox.
- `inbox_read`: the connector-surface `check`, reads (and ACKs) your own inbox.

Same durable `_DISPATCH/<to>.jsonl` substrate, same delete-after-read semantics, so
a Claude Code agent and a Claude Chat agent can hand off to each other seamlessly.

WHO can dispatch (resolved, no open question). `agent_dispatch` / `inbox_read` are
SHIP-LANE tools. They surface only for a lane that holds the ship toolset:
- `client_credentials` fleet lanes (Claude Code on any operational role) see the full
  catalog including dispatch;
- confidential ship connectors, that is the `cto` lane via the Hyperagent MCP-UI and
  a privileged exec on its confidential `occ_<lane>` client (for example the CFO
  escalating to the CTO via `agent_dispatch`), see dispatch too.

They do NOT surface on `external-read`. The `external-read` toolset is read-only
(`brain_search, kb_search, web_search, catalog_*, wake, memory_recall, memory_search,
gateway_fetch_result`) and contains neither `agent_dispatch` nor `inbox_read`.
CONSEQUENCE: external non-BAA engines (ChatGPT, Perplexity, any DCR self-add) are
READ-ONLY research consumers of the brain and are NOT participants in the comms plane.
No operator or agent should expect to reach ChatGPT or Perplexity through
`agent_dispatch`, and those engines cannot dispatch to anyone. If you need a
fleet-reachable identity, connect on an operational lane (Claude Code
`client_credentials`, a Chat `occ_<lane>` confidential client, or the Hyperagent cto
lane), not a self-added external-read connector.

### 1c. The rule

fleet-dispatch / `agent_dispatch` is a NON-PHI, NON-MNPI, NON-privileged
coordination channel ONLY. Never route MNPI (INND securities specifics), PHI, or
`clo-personal` / privileged content through it. Route those inside their own ring, in
the owning agent's own session. When in doubt, do not dispatch it.

---

## 2. THE BROADCAST CHANNEL: FLEET-BULLETIN (one change, the whole fleet)

When a change affects the whole fleet (a new skill, a moved command, a changed
default, a new gate, a rotated identity), you do not dispatch it to a dozen inboxes.
You write one bulletin line. It travels WITH the toolkit, so the change and its
announcement propagate atomically on the same `git pull` to `main`.

Write it (CTO / whoever ships the change):

```
node setup/bulletin.mjs add "<one-line fleet-affecting change, present tense>"
# then commit + push claude-tools main
```

That appends `- <UTC-ts> | <line>` to `FLEET-BULLETIN.md`.

Surface it (every agent, automatically):

```
node setup/bulletin.mjs since
```

`since` prints only entries new to THIS environment, tracked by a per-env
seen-count marker at `~/.claude/.octools-bulletin-seen` (a brand-new environment sees
only the last 3 as an intro, not all history). It is run automatically by BOTH
`octools-sync.sh` (every prompt, throttled) and `session-start.sh` (every wake), so
you do not have to remember to run it. You will see unseen bulletin lines at the top
of your session and mid-session on your next prompt after a fleet change lands.

CTO rule (from CLAUDE.md): when a fleet-affecting change closes, MERGE TO MAIN and
write a `bulletin.mjs add` line. A change that is not on `main` with a bulletin line
did not really ship to the fleet.

Dispatch vs bulletin, in one line: dispatch is "this agent, do/know this"; bulletin
is "everyone, this changed."

---

## 3. THE CATCH-UP RITUAL: how an agent gets current

Any agent that wants to be sure it is current runs this pull sequence. Most of it is
automatic (below); this is the explicit version you run when you doubt your context,
resume after a gap, or are about to assert a fact.

1. Sync the toolkit (automatic via the UserPromptSubmit hook; manual if needed):
   ```
   git -C /tmp/octools fetch origin main && git -C /tmp/octools reset --hard origin/main
   ```
   octools-sync does this for you, throttled, and re-copies skills + re-wires hooks.

2. Read what changed for the fleet since you last looked:
   ```
   node /tmp/octools/setup/bulletin.mjs since
   ```

3. Read your own memory: pitfalls first, then recent facts, then the team feed:
   ```
   node /tmp/octools/skills/kb-memory/mem.mjs tail --agent <role>
   node /tmp/octools/skills/kb-memory/mem.mjs team
   ```
   `tail` surfaces your recurring pitfalls (knowing the wrong beliefs matters as much
   as the facts), your recent entries, and an INBOUND banner if another agent left you
   a cross-lane note (ack with `mem.mjs inbound` then `mem.mjs reconcile`). `team`
   shows what every other exec is working on.

4. Ask the brain what changed on a specific topic since a date (the precise
   catch-up move, so you do not re-read the whole ledger):
   ```
   node /tmp/octools/skills/company-brain/brain.mjs diff "<topic>" --since <date>
   ```
   `diff` renders a structured added / changed / retired / still-true delta with the
   full supersedes chains. For an open question rather than a delta, use
   `brain.mjs ask "<question>"`, or the gateway `brain_search` tool
   (`mode:"deep"` for LLM-planned multi-round retrieval). Ground-first, always:
   answer company questions from retrieved, cited results, never from general
   knowledge.

Ring note: `company-brain diff` / `brain_search` drop MNPI and privileged rows unless
the caller is the owning lane; `legal-personal` is excluded unless
`--include-personal --agent clo`. The catch-up ritual respects rings automatically.

---

## 4. THE CONTINUOUS-CONNECTION GUARANTEE: waking is enough

The design goal: an agent that simply WAKES is already current, without running the
ritual by hand. Three mechanisms deliver that.

- Live-sync of the shared layer. `octools-sync.sh` is a UserPromptSubmit hook: on
  your next prompt it live-pulls `/tmp/octools` from `main`, re-copies every skill
  into `~/.claude/skills`, re-wires hooks idempotently, self-heals the gateway MCP
  lane if the ~1h token is aging (opt-out `OCTOOLS_NO_GATEWAY_SYNC=1`), and runs
  `bulletin.mjs since`. It is throttled (default 300s, `OCTOOLS_SYNC_THROTTLE`) and
  `/tmp`-guarded so it can never reset a real working checkout. So when the CTO
  merges to `main`, every running agent picks up the change on its NEXT prompt, with
  no restart and no lost context.

- Wake hooks bring your state to you. At SessionStart: `repo-freshen.sh` safely
  fast-forwards your OWN app repo to `origin/main` (only if clean and behind; it never
  touches a dirty tree or a branch with local commits, it prints the catch-up command
  instead; opt-out `OCTOOLS_NO_REPO_FRESHEN=1`); `kb-inject.sh` injects your
  kb-memory `tail` (pitfalls + recent + inbound banner) and runs `fleet-dispatch
  check` so any dispatched messages surface once; `session-start.sh` runs
  `bulletin.mjs since`. PreCompact reminds you to persist unsaved facts before the
  window compacts; Stop reminds you to flush. You wake holding the truth.

- Self-maintaining jobs keep the brain fresh underneath you. Tier-1 Azure Container
  Apps Jobs (zero Max draw) run without any human: the librarians re-index the
  finance / legal / commerce rooms, `brain-reindex` re-embeds the shared exec memory,
  `daily-digest` journals the day, and `azure-canary` pages if any index goes stale
  or any scheduled job stops succeeding (freshness measured by AGE of the newest doc,
  which is what catches a frozen index). So `brain_search` / `company-brain` answers
  are fresh whenever you ask.

If you wake and are NOT current (context feels incomplete, or you doubt you captured
prior work): do NOT act from chat. Reconstruct from durable state.

On a Claude Code (shell + hooks) engine, re-run sunrise. Note that
`otchealth-claude-tools` is a PRIVATE org repo, so in a genuinely cold shell (where
the SessionStart hook has NOT already cloned `/tmp/octools`) an unauthenticated clone
404s; the clone needs the org GitHub-App installation token. The normal case is that
the SessionStart hook already ran and `/tmp/octools` exists; only for a truly bare
shell do you mint the token first:

```
# NORMAL: /tmp/octools already exists (SessionStart cloned it) -> skip straight to sunrise.

# COLD SHELL, a copy of the toolkit is present anywhere (e.g. a session repo's vendored copy):
bash <octools>/setup/add-repo.sh otchealth-claude-tools main   # clones via the org GitHub-App token (gh-app skill)

# TRULY BARE SHELL (no toolkit at all): mint the installation token, then clone with it (never echo/store the token):
TOKEN=$(node <gh-app>/gh-app.mjs token)
git clone https://x-access-token:$TOKEN@github.com/innerscopehearing/otchealth-claude-tools /tmp/octools
bash /tmp/octools/setup/session-start.sh

# Then, either path:
mkdir -p ~/.claude && echo <role> > ~/.claude/.kb-agent
node /tmp/octools/skills/kb-memory/mem.mjs whoami --agent <role>       # expect RESULT: PASS
node /tmp/octools/skills/sunset-protocol/protocol.mjs sunrise --agent <role>
```

Precondition for the cold-shell clone: the `gh-app` credential (the org GitHub-App
private key in Secret Manager) must already be present in the environment. If it is
not, a plain public clone will 404 on the private repo; that is a cold-start blocker,
so STOP and escalate to Matt (names only, values never into chat).

`whoami` must print PASS. If it reports the claude-driver service account missing,
STOP and tell Matt. That SA is the keystone that makes memory + brain work; do not
proceed as if you are current. Then run the Section 3 ritual to close any gap.

Engine caveat: the sunrise block above is the Claude Code path (filesystem + shell +
hooks). The sunset-protocol handoff is role-aware: the exec roles that run on Claude
Chat (cto, cfo, clo, coo, cro) have no shell, no `/tmp/octools`, and no hooks, so they
do NOT run the git-clone block. Instead they verify their pre-configured gateway MCP
connector ("OTCHealth Brain - <ROLE>" at `https://mcp.otchealth.app/mcp`) is present
and authenticated on its confidential `occ_<lane>` client, report to Matt if it is
missing, then use the connector's `wake`, `memory_*`, `inbox_read`, and `brain_search`
tools to get current. Everyone else uses the Claude Code path above. (Canonical boot
detail: `AI-OS-OPERATING-SOP.md` §3.)

---

## 5. THE CADENCE: when to do which, and how the fleet compounds

When to DISPATCH: the moment one specific agent needs to know or do something and you
want zero operator relay. Async by default (it waits in their inbox). Use `--spawn`
only when the work genuinely cannot wait for the target's next natural wake.

When to BULLETIN: the moment a fleet-affecting change CLOSES. Merge to `main`, then
`bulletin.mjs add "<line>"`, then commit + push. One line per change. This is a CTO
rule, but any agent that lands a fleet-wide change writes the line.

When to CATCH UP: automatically every wake and every prompt (the hooks). Explicitly
(Section 3) whenever you resume after a gap, doubt your context, or are about to
assert a company fact. Ground-first: retrieve before you answer.

When to SUNSET (spin an agent down): before you stop, so nothing in-flight is left in
chat. Flush to the ledger (`mem.mjs decision|remember|correct|pitfall --agent <role>`),
snapshot the ring-safe handoff
(`node skills/sunset-protocol/protocol.mjs sunset --agent <role>`), confirm tests
green / PRs opened / memory PASS, then sign off to the operator with, on its own line,
exactly: `Goodnight friend`. To spin the WHOLE fleet down with no sessions and zero
Max draw: `node skills/sunset-protocol/protocol.mjs sunset-fleet`. It iterates the
`sunset-fleet` default roster, which is the 14 always-on operational roles from THE
CANONICAL ROSTER: `cto, cfo, clo, coo, cro, developer, commerce, rainmaker, lifecycle,
switchboard, capital, growth, guardian, medic`. `compliance` (the 15th operational
lane) is deliberately EXCLUDED from that default because it currently owns no
scheduled home to spin down; sunset it on demand with `sunset-fleet --roles compliance`
if it ever runs a live session. This is the documented reason, not an oversight.
`sunset-fleet` is ring-safe: it embeds no ledger text for the sensitive roles (`cfo,
clo, clo-personal, capital`), only counts and pointers, and `clo-personal` is never
part of any fleet sunset.

When to SUNRISE (spin an agent up): at the start of a session on a new engine, the
block in Section 4. Prove identity (PASS), self-update, then greet the operator with
exactly `I am fully updated and ready to go, Sir.`, present the last 3 things worked
on (numbered, most recent first, pulled from your durable ledger, never from memory or
invention), and ask `Which of these would you like to work on?`.

How the fleet compounds its knowledge: every mutating tool call auto-journals an
episode; nightly reflection distills recurring episodes into ledger lessons; `reflect`
distills each session; shared entries index into `memory-exec` within the minute; the
librarians keep the doc rooms fresh; `daily-digest` (nightly) journals what the
company shipped, decided, and learned and pushes it into the brain; `brain_search` /
`company-brain` federate all of it into cited answers; JIT doctrine binds the sharpest
pitfalls to the tools where they bite. So every shipped fix, every decision, and every
focus-group review becomes retrievable by every agent and by Matt, and the brain gets
measurably smarter each day. Your job in the loop is small and non-negotiable: write
facts through the instant they happen, dispatch what a peer needs, and bulletin what
the fleet needs. The plumbing does the rest.

---

### One-screen summary

| Need | Channel | Command |
|---|---|---|
| Tell / task ONE agent (CLI engine) | fleet-dispatch | `node skills/fleet-dispatch/dispatch.mjs send <to> "<msg>" --from <you> [--task] [--spawn --repo <app>]` |
| Tell / task ONE agent (Chat / Hyperagent, ship lane) | gateway | `agent_dispatch` (send) / `inbox_read` (check) |
| Read your own inbox | fleet-dispatch | `node skills/fleet-dispatch/dispatch.mjs check --agent <you>` (auto at SessionStart) |
| Announce a fleet-wide change | FLEET-BULLETIN | `node setup/bulletin.mjs add "<line>"` then push `main` |
| See what changed for the fleet | FLEET-BULLETIN | `node setup/bulletin.mjs since` (auto) |
| Read your memory + team status | kb-memory | `node skills/kb-memory/mem.mjs tail --agent <role>` ; `... team` |
| What changed on a topic since a date | company-brain | `node skills/company-brain/brain.mjs diff "<topic>" --since <date>` |
| Ask the brain a grounded question | brain | `brain_search` (gateway, `mode:"deep"`) or `brain.mjs ask "<q>"` |
| Spin down (safe stop) | sunset-protocol | `node skills/sunset-protocol/protocol.mjs sunset --agent <role>` then `Goodnight friend` |
| Spin up (get current) | sunset-protocol | `... sunrise --agent <role>` then `I am fully updated and ready to go, Sir.` |

Two channels, one ritual, one guarantee: dispatch to one, bulletin to all, pull to
get current, and simply waking already makes you current. Non-PHI, non-MNPI,
non-privileged only, and external-read engines are read-only research consumers, not
comms-plane participants. The ledger and the brain are the truth; the chat window is
disposable.

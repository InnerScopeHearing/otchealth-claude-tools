---
name: task-claim
description: A typed, cross-agent exclusive claim (mutex) primitive built on the gateway's existing Cosmos-backed work-ledger tools (task_create / task_claim / task_update / task_heartbeat / task_get), not a new task system. Gives any agent a genuine claim-with-expiry lock on a named resource (acquire / release / heartbeat / status), so two agents can never both believe they hold the same claim the way a hand-maintained markdown convention (e.g. cto-bridge's ACTIVE-CTO-THREAD line) cannot guarantee. Use when coordinating exclusive access to a shared resource across agents/engines: "who owns this build dispatch," "is another CTO thread already working this," "claim this deploy slot before I touch it."
---

# task-claim -- a real mutex on top of the gateway's work-ledger

## What this is, and what it is NOT

This is **not** a new task-tracking system. The gateway (`otchealth-mcp-server`) already has a
real, typed, Cosmos-backed work-ledger (`src/agentstate/ledger.ts`, tools `task_create` /
`task_list` / `task_get` / `task_claim` / `task_update` / `task_complete` / `task_heartbeat`).
Task ownership and status are already typed. What was still missing was a genuine cross-agent
**exclusive claim (mutex)** primitive on a stable, reusable resource identity, the same thing
`cto-bridge/README.md`'s `ACTIVE-CTO-THREAD:` line is trying to be, except that line is prose: a
convention an agent reads, reasons about, and edits by hand, with nothing enforcing "only one
writer" except the agent choosing to follow the protocol. This skill closes that specific gap with
new tooling that calls the gateway's **existing** tools, it does not talk to Cosmos directly and
does not duplicate any of ledger.ts's logic.

## Usage

```
node skills/task-claim/claim.mjs acquire <resource> --agent <a> [--lane cto] [--board mutex] [--created-by <who>]
node skills/task-claim/claim.mjs release <task-id> --agent <a> --lease-version <n> [--lane cto] [--board mutex]
node skills/task-claim/claim.mjs heartbeat <task-id> --agent <a> [--lease-version <n>] [--lane cto] [--board mutex]
node skills/task-claim/claim.mjs status <resource> [--lane cto] [--board mutex]
```

`<resource>` is any caller-chosen stable string identifying the thing being locked, e.g.
`cto-bridge:iheartest` or `ios-build-dispatch:flatstick`. Every subcommand prints a JSON result and
sets the exit code (0 = the operation succeeded, 1 = it did not, 2 = bad usage) so a calling script
can branch on `$?` without parsing JSON. `--lane` selects which gateway OAuth lane authenticates the
call (`task_*` tools are not role-gated server-side, so any lane works; default `cto`).

**The full flow, in Node, for a piece of code that wants exclusive access to a resource:**

```js
import { createGatewayLedger } from './skills/task-claim/gateway-ledger.mjs';
import * as mutex from './skills/task-claim/mutex.mjs';

const ledger = createGatewayLedger({ lane: 'cto' });
const claim = await mutex.acquire(ledger, { resource: 'cto-bridge:iheartest', agent: 'cto' });
if (!claim.acquired) {
  // claim.conflict / claim.held_by / claim.dead_lettered / claim.reason tell you exactly why.
  process.exit(1);
}
try {
  // ... do the exclusive work, calling mutex.heartbeat(ledger, {...}) every ~15-20 min if it
  // might run longer than the lease window (see "Design" below) ...
} finally {
  await mutex.release(ledger, { taskId: claim.task_id, agent: 'cto', leaseVersion: claim.lease_version });
}
```

## Design

**Resource identity.** One work-ledger task per mutex resource, on a dedicated `board="mutex"` by
default (so mutex bookkeeping never shows up mixed into real work-item `task_list` views), get-or-
created via `task_create`'s `idempotency_key = resource`. This is what turns the ledger's one-shot
"create once, claim, eventually complete" tools into a reusable resource identity: the SAME resource
string always maps to the SAME task id, forever, and `task_create`'s own idempotent-create handling
(deterministic id + conflict-then-reread) means a concurrent double-create collapses to one winner
plus one deduped reader, never two resource tasks for one name.

**TTL / expiry.** `task_claim` grants a lease. The gateway hardcodes `LEASE_MINUTES = 45`
(`ledger.ts`) and the tool has **no ttl/duration input at all** today, so this module cannot request
a shorter or longer window per call (see gap #3 below). 45 minutes happens to be in the same
ballpark as cto-bridge's own convention ("a stale claim older than ~30 min... may be reclaimed"), so
it is a reasonable fit as-is. For legitimate long-running work, call `heartbeat()` every ~15-20
minutes (well inside the 45-minute window) to extend the lease before it lapses; only a holder that
crashes or hangs without heartbeating or releasing ever produces a real expiry-based reclaim.

**Atomicity: genuinely achieved, not approximated.** The task prompt this skill was built for
anticipated that true atomicity might not be achievable client-side over HTTP and asked for the gap
to be documented if so. It IS achievable, and the reason is worth being precise about: the actual
lock-acquiring operation, `task_claim`, is a SINGLE gateway tool call that does its read, its
decision, and its conditional write (Cosmos `PUT` with `If-Match` on the doc's ETag) entirely
server-side, inside one HTTP round trip. Cosmos itself resolves a genuinely simultaneous write race
by rejecting the loser's `PUT` with `412 Precondition Failed`; `claimTask` retries once against the
freshly-read doc before giving up. So even though `acquire()` in this module issues `task_create`
then `task_claim` as two separate HTTP calls, the race window that actually matters, two agents both
trying to WIN the claim, closes entirely **inside** the single `task_claim` call. There is no
client-side "read, decide, then write" gap in the acquisition itself; this module never has to
invent its own compare-and-swap because the gateway's existing tool already has a correct one. See
`tests/task-claim-race.test.mjs` for a test that exercises this directly (`Promise.all` of two/three
concurrent `acquire()` calls against a store that injects randomized async delay on every read and
write, over 40+15+25 trials): exactly one caller ever wins, the loser(s) always get a coherent,
correctly-attributed conflict, never both, never neither.

**How two racing claimants are handled.** Exactly as production would: the loser's `task_claim` call
gets `{claimed: false, conflict: true, reason: "leased to <winner> until <iso>"}`. `mutex.acquire()`
enriches that into a structured, honest result (`acquired: false, conflict: true, held_by: <winner
agent>, lease_until: <iso>, reason`), never a silent "sort of worked." Nothing about a lost race is
swallowed or misreported as success.

## Gap analysis: what closing this required finding, precisely

Everything above (get-or-create resource identity + atomic claim) already works cleanly on the
gateway's existing tool surface. Building and testing this primitive against it surfaced four real,
specific mismatches between "one-shot work item" semantics and "reusable mutex" semantics, each
documented here rather than papered over:

1. **`task_update`'s fencing is opt-in, not enforced.** `updateTask` only rejects a stale/foreign
   write when the caller supplies `expected_lease_version` AND it no longer matches; the parameter is
   optional, and `updateTask` never checks that `actor === owner_agent` at all. A caller could flip
   ANY task's status, including one it does not hold, by simply omitting the fencing token. This
   module's `release()` treats `leaseVersion` as **required** (throws if omitted) as a client-side
   mitigation, but that only protects callers that go through this module. **Follow-on needed on the
   gateway itself (out of scope for this repo):** a dedicated `task_release` tool (or a hardened
   `task_update`) that requires `expected_lease_version` unconditionally for any status-changing call
   on a `claimed`/`in_progress` task, not merely honors it when present.

2. **`attempt_count` / `dead_letter` is a poor fit for a repeatedly-claimed mutex resource, and it is
   a genuine dead end once tripped.** `attempt_count` is monotonic across a resource's ENTIRE life and
   is never reset by a clean release; it increments on every RECLAIM (a claim that finds the task
   already `status: "claimed"`, whether that is a stale abandoned lease or, notably, the SAME agent
   re-claiming its own still-valid hold). `MAX_CLAIM_ATTEMPTS = 3` is tuned for "give up on this
   one-shot task nobody ever finishes," not "this resource gets claimed and released thousands of
   times over its life." Three lifetime abandonments (a crash before release, an agent that dies
   mid-hold) permanently `dead_letter`s the resource, and **no exposed gateway tool can reset
   `attempt_count`** (`task_update`'s patch shape has no such field) or move a task back out of
   `dead_letter`. `mutex.acquire()` detects this and returns `dead_lettered: true` with an explicit
   `suggestion` to acquire a rotated resource name (e.g. `"cto-bridge:iheartest#2"`), rather than
   retrying forever or silently failing. **Follow-on needed on the gateway (out of scope for this
   repo):** either exempt a designated board (e.g. `mutex`) from the dead-letter policy entirely, make
   `MAX_CLAIM_ATTEMPTS` configurable per board/task, or add a `task_revive`/reset verb. Proven in
   `tests/task-claim-expiry.test.mjs`'s dead-letter test.

3. **The lease TTL is not configurable by the caller.** `LEASE_MINUTES = 45` is a hardcoded constant
   in `ledger.ts`; `task_claim`'s input shape has no `ttl_minutes` (or similar) field. Every claim
   through this tool, on any board, for any purpose, gets the same 45-minute window. It happens to be
   a reasonable fit for the cto-bridge use case, but is a real API gap for anything that would want a
   shorter (fast-moving, want-quick-reclaim) or longer window. **Follow-on needed on the gateway (out
   of scope for this repo):** an optional `ttl_minutes` input on `task_claim`, bounded server-side to
   a sane min/max.

4. **The "conflict" response from `task_claim` carries no structured holder identity.** When a claim
   loses to an active lease, `claimTask`'s `leasedToOther` branch returns only `{conflict: true,
   reason: "leased to <agent> until <iso>"}`, no `task` field at all, so the only way to learn WHO
   holds it programmatically is to parse free-form prose out of `reason`. This module does not do
   that: `mutex.acquire()` makes one additional, read-only `task_get` call to report a real,
   structured `held_by` / `lease_until` instead. A related, smaller inconsistency: `dead_lettered:
   true` is present only on the call that PERFORMS the open->dead_letter transition; a later call
   against an already-dead-lettered task hits the terminal-status early return instead
   (`reason: "task already dead_letter"`, no `dead_lettered` field, no `task` field), so this module
   pattern-matches both shapes into one consistent `dead_lettered: true` signal for every caller.
   **Follow-on suggested (optional, smaller than the others):** have `task_claim` include the current
   `task` doc on every non-granted response (conflict AND already-terminal), not only on success.

None of these four are "atomicity is not achievable," the actual claim operation is genuinely atomic,
as designed above. They are precise mismatches between the ledger's one-shot-task shape and a
reusable-mutex's shape, each with a concrete workaround in this module and a concrete, scoped
follow-on named for whoever next touches the gateway.

## Testing

`tests/mock-ledger.mjs` is a hermetic, in-process stand-in for the gateway's real tools. It is not a
simplification that hand-waves the hard part: it reimplements the SAME mechanism `ledger.ts` uses to
make `task_claim` atomic (a single-document store with ETag-based optimistic concurrency, a
synchronous check-and-set mirroring what Cosmos's `If-Match` `PUT` guarantees server-side), wrapped
in randomized async "network hop" delays on every read and write so concurrent calls genuinely
interleave in an unpredictable order, the same race shape a real two-agent claim race over HTTP has.
`leaseMs` / `maxClaimAttempts` are constructor knobs purely so tests do not have to wait 45 real
minutes or run huge trial counts; the CAS / lease / reclaim / dead-letter DECISION logic mirrors
`ledger.ts`'s `claimTask` / `heartbeatTask` / `updateTask` step-for-step.

- `tests/task-claim.test.mjs` -- pure helpers + single-actor happy/unhappy paths for every verb, plus
  `gateway-ledger.mjs`'s `parseToolResult()` against fixture response bodies (plain JSON, SSE-framed,
  tool-level `isError`, JSON-RPC-level error).
- `tests/task-claim-race.test.mjs` -- **the race-condition proof.** 40 trials of two agents racing
  `acquire()` on a fresh resource, 15 trials of three agents racing, 25 trials where `create()` itself
  is also raced (not just `claim()`), plus a direct re-read of the ledger after a race to confirm only
  the winner's write landed (`lease_version == 1`, not 2). Every trial asserts: exactly one winner,
  exactly the rest losers, the loser(s) correctly report `conflict: true` and the correct `held_by`,
  and both racers always resolve to the same underlying task id.
- `tests/task-claim-expiry.test.mjs` -- **the TTL/expiry proof.** An abandoned claim cannot be
  reclaimed before its lease lapses; it CAN be reclaimed by a different agent after the lease lapses
  (and that reclaim correctly increments `attempt_count`, per gap #2); a `heartbeat()` before the
  lease lapses legitimately blocks a reclaim that would otherwise have succeeded by then; a resource
  abandoned past `MAX_CLAIM_ATTEMPTS` is permanently dead-lettered and stays that way on every
  subsequent attempt.

Run just this skill's tests: `node --test skills/task-claim/tests/*.test.mjs`. They run as part of
the full toolkit gate: `bash run-tests.sh`.

The real network transport (`gateway-ledger.mjs`, which mints a lane bearer via
`skills/gateway-connect/connect.mjs`'s `mintToken()` and calls the gateway's `/mcp` HTTP endpoint) is
deliberately NOT exercised by the automated suite, consistent with the rest of this toolkit's test
conventions (e.g. `cosmos-auth.test.mjs` stubs `fetch` rather than hitting live Azure; the
`RUN_BROWSER_TESTS` gate in `run-tests.sh` keeps live-network skill tests opt-in). `parseToolResult()`
(the one piece of real-response-shape parsing logic) IS unit-tested against fixture bodies mirroring
the gateway's actual `structuredContent` shape (verified by reading `otchealth-mcp-server`'s
`src/tools/registry.ts registerTool()` directly, not guessed).

## Explicitly out of scope for this change

This skill builds and proves the primitive. It does **not** migrate `cto-bridge/`'s actual markdown
files onto it, that is a deliberate follow-on once the primitive has been proven (which this change
does) and the cto-bridge protocol's authors are ready to move the `ACTIVE-CTO-THREAD:` claim from a
hand-edited line to `acquire()`/`release()` calls around the existing entry-writing flow. A rough
sketch for that follow-on, not built here: `resource = "cto-bridge:<app-repo>"`, `acquire()` in place
of reading-then-writing the claim line, `release()` (or a heartbeat loop) in place of clearing it, and
the existing `ACTIVE-CTO-THREAD:` line kept as a human-readable mirror of `status()`'s output rather
than the enforcement mechanism itself.

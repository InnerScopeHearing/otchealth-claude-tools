---
name: compute-allocator
description: Advisory compute router that turns signal-radar's live risk signals (severity, subject, detector) into a difficulty/risk estimate, then combines it with fleet-dispatch's pure effort-scale baseline (agent fan-out) and fleet-telemetry's task-router (opus vs sonnet model pick) to recommend agents, model, and whether to run critic-pass. Pure decision core (allocateCompute), one fail-open Cosmos read helper (recentSignalsFor). Advisory only, the orchestrator makes the final call.
---

# compute-allocator, route more compute where the fleet's own signals say the risk is

## The idea

Three skills already exist and each answers one narrow question well:

- `fleet-dispatch/effort-scale.mjs` answers "how many subagents does this task's TEXT alone suggest,"
  a pure baseline with no notion of what is currently going wrong in the fleet.
- `signal-radar` answers "what is quietly going wrong right now," a stream of Signals
  (`{ severity: high|medium|low, subject, detector, ... }`) written to its Cosmos `signals` container.
- `fleet-telemetry/task-router.mjs` answers "which model tier does this task's text need."

None of these three talk to each other. compute-allocator is the thin composition layer that does:
it takes the same task text, asks effort-scale for a baseline fan-out, asks signal-radar (via the
caller-supplied `recentSignals`) whether the task's lane is currently flapping, and uses that to
decide whether to escalate fan-out and whether to turn on critic-pass, then asks task-router for the
model tier. The result is one recommendation object instead of three separate calls the orchestrator
would otherwise have to reconcile by hand.

## Why signals matter here

A lane with a recent HIGH severity signal (a Sentry error spike, an eval regression, a stale/contradicted
memory row) is a lane where a routine task is more likely to interact with something already broken.
That is exactly the situation where more parallel angles (higher fan-out) and a second cheap look
(critic-pass) pay for themselves. A quiet lane with no recent signals gets the plain effort-scale
baseline, unless the task text itself is high-stakes (security, migration, money, compliance, PHI,
credentials, delete, production, irreversible), in which case critic-pass is still turned on as a
floor, independent of whether anything has actually gone wrong yet.

## How it composes with the other three skills

- **`fleet-dispatch/effort-scale.mjs`** supplies the pure text-derived baseline fan-out
  (`recommendFanout(taskText)` gives `{ agents, mode, rationale }`). compute-allocator never
  second-guesses this baseline on a quiet lane; it only escalates it when a relevant signal says to.
- **`signal-radar`** supplies the live risk signal. compute-allocator does not read signal-radar's
  Cosmos store directly inside its pure core; the caller (or `recentSignalsFor`) fetches
  `recentSignals` and passes them in, which is what keeps `allocateCompute` itself hermetic and
  trivially testable with fabricated signal arrays.
- **`critic-pass`** is the gate this skill toggles. compute-allocator never calls
  `buildCriticPrompt`/`parseCriticVerdict` itself; it only decides `useCritic: true|false` for the
  orchestrator to act on, exactly the same advisory relationship effort-scale has to fan-out.
- **`fleet-telemetry/task-router.mjs`** supplies model routing (`classifyTask`). compute-allocator
  calls it when available (via `allocateComputeAsync`) and floors its recommendation at `sonnet`
  (never downgrades to `haiku`) since this skill exists to allocate MORE compute under risk, not to
  trim cost. If `task-router.mjs` is ever missing or fails to import, a local keyword-based fallback
  (`inferModel`, deep-reasoning/architecture/security/design-heavy language to `opus`, else `sonnet`)
  keeps `allocateCompute`/`allocateComputeAsync` working without a hard dependency.

**This skill is ADVISORY ONLY.** It never dispatches an agent, never calls critic-pass, never picks a
model for you. It returns a recommendation; the orchestrator decides whether to follow it, exactly
like `effort-scale.mjs` and `critic-pass.mjs` already do.

## API

```js
import { allocateCompute, allocateComputeAsync, recentSignalsFor } from "./allocate.mjs";

// Pure core: pass recentSignals in directly (already filtered to the task's domain by the caller,
// or fetched via recentSignalsFor below). No I/O, never throws.
const rec = allocateCompute({
  taskText: "Compare Postgres vs DynamoDB for the ledger store",
  recentSignals: [{ severity: "high", subject: "ledger-service", detector: "sentry-error-spike" }],
});
// -> { agents, model, useCritic, rationale }

// Convenience async wrapper that also resolves model via fleet-telemetry/task-router.mjs when present.
const rec2 = await allocateComputeAsync({ taskText: "...", recentSignals: [] });

// The one impure helper: live Cosmos read, mirrors signal-radar's own common.mjs/schema.mjs read
// pattern exactly (same cosmosConfig/cosmosQuerySignals, same owner-partitioned query shape). Fails
// open to [] on ANY error (no creds, no network, bad JSON, missing module).
const live = await recentSignalsFor("ledger-service");
```

## CLI

```
node skills/compute-allocator/allocate.mjs "<task text>" \
  [--signals '[{"severity":"high","subject":"x","detector":"y"}]'] \
  [--lane <subjectOrLane>] [--live]
```

`--signals` accepts a JSON array of `{severity, subject, detector}` objects (already filtered by the
caller). `--live --lane <subjectOrLane>` fetches recent signals from signal-radar's own Cosmos store
via `recentSignalsFor` and merges them in. Prints the `{ agents, model, useCritic, rationale }`
recommendation as JSON on stdout, same style as `effort-scale.mjs`'s CLI.

## Fail-open contract

`allocateCompute` never throws: a null/undefined/non-array `recentSignals`, or entries missing
`severity`/`subject`/`detector`, are treated as "no relevant signal" rather than crashing. That is
the same discipline `effort-scale.mjs` applies to malformed `taskText`/`hints` and `critic.mjs`
applies to malformed critic output. `recentSignalsFor` is wrapped end to end in try/catch: any failure
in the Cosmos read path (missing GCP service account, Cosmos not provisioned, network error, malformed
response, or signal-radar's own files failing to import) returns `[]`, which makes `allocateCompute`
degrade cleanly to the pure `effort-scale` baseline with `useCritic` decided purely by the task text's
own high-stakes keywords. A broken signal store can only ever make this skill LESS aggressive, never
cause it to error out the caller's pipeline.

## Wired into fleet-dispatch (the orchestration path consults it)
`skills/fleet-dispatch/dispatch.mjs` consults this skill on every TASK dispatch: it calls
`recentSignalsFor(to)` for the target lane's live signals, then `allocateComputeAsync` for the
`{ agents, model, useCritic }` recommendation, stamps it on the queued inbox row (surfaced by `check`),
and folds it into `--spawn`'s task text. The dispatch import is dynamic + fail-open, so this skill being
absent or erroring never blocks a hand-off — it just means no recommendation is attached. Still advisory:
the receiving/ spawned orchestrator decides whether to follow the fan-out/model/critic recommendation.

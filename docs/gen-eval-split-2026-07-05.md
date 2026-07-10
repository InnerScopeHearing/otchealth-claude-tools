# C9-GEN-EVAL-SPLIT: pre-negotiated "done" for externally-shipped work

Status: **design only**. The concrete change (a new field on the Cosmos `Task` schema + `task_create`
input) lives in `otchealth-mcp-server`'s TypeScript (`/tmp/mcpsrv`), a separate repo/service from this
one. This doc is read-only research against that repo plus a proposal; implementation needs to happen
there, not in `otchealth-claude-tools`.

## What already exists (read, not modified)

`/tmp/mcpsrv/src/agentstate/ledger.ts` already enforces a real Generator/Evaluator split at the
narrowest possible point: `completeTask()`.

```ts
/** Complete a task: REJECTS unless artifact_uri resolves. done = artifact landed. */
export async function completeTask(
  id: string,
  artifactUri: string,
  ...
): Promise<{ task?: Task; rejected?: boolean; reason?: string; resolution?: unknown; fenced?: boolean }> {
  const resolution = await resolveArtifact(artifactUri);
  if (!resolution.resolved) {
    await appendEvent(id, 'complete_rejected', who, `${artifactUri} :: ${resolution.detail}`);
    return {
      rejected: true,
      reason: `done = artifact landed. artifact_uri did not resolve (...). Land the work-product first (commons blob:, a resolvable URL, a cosmos: doc, or gh:).`,
      resolution,
    };
  }
  ...
}
```

(`ledger.ts:10` and `ledger.ts:240-267`.) The generator (the agent doing the work) calls
`completeTask(id, artifactUri, ...)`; the evaluator here is entirely mechanical — `resolveArtifact()`
(in `resolver.ts`) either resolves the URI scheme (`blob:`, a resolvable URL, `cosmos:`, `gh:`) or it
doesn't. This is already exactly the generator/evaluator split the roadmap item asks for, just with a
single, fixed evaluation criterion: **"did SOMETHING land."** It says nothing about whether the artifact
that landed is the RIGHT artifact, matches an agreed shape, or satisfies whatever the task actually
needed.

That gap is what "pre-negotiated done" closes: let the task's CREATOR (the one negotiating the work, at
`task_create` time) attach an explicit, checkable definition of done alongside `artifact_uri`, so
`completeTask`'s evaluation isn't just "resolves" but "resolves AND matches what was agreed before work
started." This is the same idea `skills/agent-evals/run-evals.mjs` already applies to golden tasks (each
task ships with its own `rubric: string[]`, checked by an LLM judge at grading time — see
`run-evals.mjs:72-80`, `judge(task, rubric, answer)`) — just moved from an offline eval harness onto the
live task-completion path.

## Proposed schema addition: `done_criteria` on `Task`

```diff
--- a/src/agentstate/ledger.ts
+++ b/src/agentstate/ledger.ts
@@ export interface Task
   artifact_uri: string | null;
+  // Pre-negotiated definition of done, set at create time (never mutated after — see below), so
+  // "done" is agreed BEFORE work starts, not argued about after. Optional: tasks created without it
+  // behave exactly as today (artifact_uri resolving is the only bar). Structured, not free text, so
+  // it is machine-checkable rather than another prose field nobody re-reads at completion time.
+  done_criteria: DoneCriteria | null;
   created_by: string;
```

```ts
// New type, colocated with Task (or in a small done-criteria.ts alongside resolver.ts).
export interface DoneCriteria {
  // Human/agent-readable checklist, mirrors run-evals.mjs's per-task `rubric: string[]` shape exactly,
  // so the SAME judge infrastructure (or a human) can grade against it with no new format to learn.
  rubric: string[];
  // Optional structural checks resolveArtifact-adjacent logic can verify WITHOUT an LLM call at all
  // (cheap, deterministic, always run first): e.g. "artifact_uri scheme must be gh: (a real PR, not
  // just any resolvable blob)" or "artifact must include a file matching *.test.*". Keeps the common
  // case (a PR landed, matching what was asked) evaluable without paying for an LLM judge call.
  required_artifact_scheme?: string;        // e.g. "gh" — reuses resolver.ts's existing scheme parsing
  // Who negotiated this — for audit ("who signed off on this definition of done"), not enforcement.
  negotiated_by: string;
  negotiated_at: string; // ISO
}
```

## Where it plugs into `task_create` / `completeTask`

- `task_create` (wherever the MCP tool schema for creating a task is defined — not shown here since it
  wasn't in scope to fetch beyond `ledger.ts`, but it clearly calls into the `input` shape `createTask`
  already takes near `ledger.ts:90-113`) gains an optional `done_criteria` field, validated the same way
  `priority`/`tags` already default safely when omitted. **Never required** — this must not become a
  blocking requirement for every task_create call on day one; that would break every existing caller
  that doesn't know the new field exists yet.
- `completeTask()` gains a step BEFORE the existing `resolveArtifact()` gate:
  1. If `task.done_criteria` is null -> behave exactly as today (artifact_uri resolving is sufficient).
  2. If `task.done_criteria.required_artifact_scheme` is set -> cheap, deterministic scheme check
     (string comparison against what `resolveArtifact`/the URI parsing already extracts) BEFORE any LLM
     call — reject fast and free if the artifact is the wrong SHAPE of thing entirely (e.g. a blob when
     a PR was required).
  3. If `task.done_criteria.rubric` is non-empty -> call an evaluator (structurally identical to
     `run-evals.mjs`'s `judge()`) with the task's `description` + `done_criteria.rubric` + the resolved
     artifact's content (or a summary/diff of it) as the "answer" being judged. Reject `completeTask`
     with the judge's `notes` as `reason` if the rubric isn't satisfied, exactly mirroring today's
     `resolution.detail` rejection message shape.
- Rejection stays a REJECTION, not a silent pass-through with a warning — same posture as the existing
  `artifact_uri did not resolve` rejection. "Done" must mean "the pre-negotiated bar was met," full stop,
  matching this repo's `PASS_AT = 0.7` (`run-evals.mjs:31`) convention of a hard, not advisory, bar. That
  said, ship it REPORT-ONLY first (log rejection candidates without actually blocking `completeTask`)
  for one deploy cycle, mirroring `skills/agent-evals/eval-gate.mjs`'s explicit "report-first, then
  `--enforce` once trust is established" rollout pattern (`eval-gate.mjs:1-24`) — the exact same caution
  this repo already applies to a structurally identical judge-gate.

## Negotiation, not unilateral declaration

"Pre-negotiated" implies two parties agree before work starts, not that the creator unilaterally writes
a rubric and the generator finds out at completion time. Concretely: `done_criteria` should be visible
to the generator the moment it claims the task (`claimTask` already returns the full `Task` doc, so
`done_criteria` rides along for free with zero new plumbing) — so a generator that thinks the bar is
wrong/unachievable can push back (e.g. via a task note, `updateTask`'s existing `note` patch field)
BEFORE spending effort, rather than discovering after the fact that "done" meant something it didn't
expect. This is a workflow/convention change (how task_create is used), not something enforceable purely
in the schema — flag this explicitly to whoever implements it in `/tmp/mcpsrv`, since it is easy to build
the field and skip the actual negotiation step it's meant to support.

## Why this belongs in `/tmp/mcpsrv`, not here

Every piece of this — the `Task`/`DoneCriteria` TypeScript interfaces, the `completeTask()` gate logic,
the `task_create` MCP tool's input schema and validation — lives in `otchealth-mcp-server`'s
`src/agentstate/ledger.ts` and its sibling files (`resolver.ts`, the MCP tool definitions). This repo
(`otchealth-claude-tools`) only consumes that gateway; it has no ledger/Cosmos schema of its own to
change. The one thing this repo COULD usefully add once the gateway ships `done_criteria` is a
convenience helper (e.g. in `skills/agent-evals/`) that turns a golden-task's existing `rubric: string[]`
directly into a `done_criteria` payload for `task_create` calls — reusing the exact rubric format that
already exists here — but that is a follow-up, not part of this design note.

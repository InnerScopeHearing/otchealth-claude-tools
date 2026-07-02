---
name: critic-pass
description: Cheap self-verification loop for high-stakes deep-reasoning drafts. Before committing an Opus-routed output (architecture, migrations, money- or clinical-adjacent analysis), run a cheap critic pass (Sonnet or llm_azure tier:'high') over the DRAFT that checks for unsupported claims, logical gaps, missed constraints, math/factual errors, and unstated assumptions. Report-mode: logs the verdict, does not hard-block by default. Pure, dependency-free, exported + CLI.
---

# critic-pass - cheap verifier for expensive drafts

## The problem
Opus deep-reasoning calls are the most expensive thing the fleet does. When one produces a draft
that is subtly wrong, the usual failure mode is: nobody notices until later, and the fix is to
re-run Opus again, or worse, ship the mistake. That is the most expensive possible place to catch
an error.

## The pattern
Insert a cheap CRITIC pass between "Opus produced a draft" and "the draft gets committed":

1. Opus (or another deep-reasoning call) produces a draft answer.
2. `buildCriticPrompt(task, draftAnswer, opts)` builds a prompt asking a CHEAP model to check the
   draft for unsupported claims, logical gaps, missed constraints, math/factual errors, and
   unstated assumptions, and to answer in strict JSON.
3. The orchestrator/gateway sends that prompt to a cheap model - a Sonnet subagent, or
   `llm_azure` with `tier:'high'` (credit-funded, per FLEET-BULLETIN.md's cost protocol: route
   commodity/verification LLM work off metered Claude tokens where possible; keep the original
   hard reasoning on Claude/Opus).
4. `parseCriticVerdict(rawModelText)` tolerantly parses the critic's response into
   `{ verdict, issues, confidence, malformed }`.
5. `shouldRevise(verdict, { minSeverity })` gives an advisory revise/approve signal.

This module never calls a model itself. It is pure prompt-building + verdict-parsing, so it is
trivially unit-testable and safe to import from any orchestrator without adding a network
dependency.

## Report-mode-first posture
- **Default behavior is to log, not block.** `shouldRevise` is advisory. A caller can choose to
  gate a commit on it, but the skill's own default posture (and the CLI's) is to surface the
  verdict for a human or a downstream step to see, not to hard-fail the pipeline.
- **Fail-safe, not fail-closed.** Any malformed, empty, or unparseable critic response resolves to
  `{ verdict: "approve", malformed: true }` in `parseCriticVerdict`, and `shouldRevise` always
  returns `false` for a malformed verdict. A broken or flaky critic pass must never brick a
  pipeline that was otherwise fine - the cost of a missed catch is lower than the cost of a
  spurious block on every run.
- Escalate the block/revise decision to a human or a stricter gate only where the stakes justify
  it (e.g. money-movement or clinical-adjacent changes); everywhere else, log and move on.

## When to use
Reach for critic-pass on outputs from **Opus / deep-reasoning-routed** tasks, specifically:
- Architecture or system-design proposals
- Schema or data migrations
- Money-logic (billing, payments, refunds) or clinical-adjacent analysis
- Anything else `task-router`'s `classifyTask` marks with a `DEEP_SIGNALS` match (opus) or a
  `QUALITY_SIGNALS` match held at Sonnet+ where the output is high-stakes enough to be worth a
  second cheap look

Skip it for low-stakes or already-cheap (Haiku-routed) work - the point is ROI: a cheap check
before an expensive commit, not a check on everything.

## How it composes
- **With `fleet-telemetry/task-router.mjs` (model routing):** `classifyTask` decides which model
  produces the draft (Opus for `DEEP_SIGNALS`, Sonnet+ for `QUALITY_SIGNALS`). critic-pass is the
  natural next stage for anything routed to `opus` - the draft is expensive, so a cheap Sonnet or
  `llm_azure tier:'high'` critic pass is a small tax relative to a bad Opus output shipping or a
  full Opus re-run.
- **With effort-scaling:** the critic pass itself should stay on the cheap end (low/standard
  effort, small max-tokens) - it is a targeted check, not a second deep-reasoning pass. If the
  critic returns `revise` with high-severity issues, that is the signal to spend more (re-run
  Opus, or escalate effort), not to have run the critic itself at high effort.
- **Standalone:** any pipeline that produces a high-stakes draft can call
  `buildCriticPrompt` / `parseCriticVerdict` / `shouldRevise` directly without depending on the
  other two.

## API
```js
import { buildCriticPrompt, parseCriticVerdict, shouldRevise } from "./critic.mjs";

const prompt = buildCriticPrompt(task, draftAnswer, { constraints: ["must not exceed budget X"], context: "..." });
// -> send `prompt` to a cheap model (Sonnet subagent, or llm_azure tier:'high')

const verdict = parseCriticVerdict(rawModelText);
// -> { verdict: "approve" | "revise", issues: [{ severity, note }], confidence, malformed }

if (shouldRevise(verdict, { minSeverity: "high" })) {
  // advisory only - log it, or escalate, per the report-mode posture above
}
```

## CLI (report-mode; does not call an LLM itself)
```
node critic.mjs prompt --task "<task>" --draft "<draft>" [--constraints "a;b;c"] [--context "..."]
node critic.mjs parse < raw_model_output.txt [--min-severity high]
```
The CLI only builds prompts and parses verdicts. The orchestrator/gateway supplies the actual
model call and pipes the raw text into `parse`.

## Executor (run.mjs) — actually RUNS the pass

`critic.mjs` is pure (prompt + parse). `run.mjs` is the executor that supplies the real model call, so
the orchestrator can RUN a critic pass in one command instead of hand-wiring prompt->model->parse:

```
node skills/critic-pass/run.mjs --task "<task>" --draft-file <path> [--constraints "a;b"] \
  [--context "..."] [--min-severity high] [--tier standard] [--if-critic] [--live] [--fail-on-revise]
```

- Makes ONE real Azure OpenAI chat call via `setup/model-routing.mjs` (default tier `standard` = gpt-4o,
  the Sonnet-tier analog critic-pass is designed for; NOT the banned `cheap`/gpt-4.1-mini). Override with
  `CRITIC_MODEL`. Foundry fallback on sustained throttle, same as agent-evals.
- **`--if-critic`**: consult `compute-allocator` (allocateCompute on the task text; `--live` also pulls
  signal-radar signals) and RUN the pass only when it recommends `useCritic=true`; otherwise print
  `{ran:false}` and spend nothing. This is the compute-allocator -> critic-pass wiring.
- **Fail-safe / report-mode**: any failure (no creds, throttle, malformed output) degrades to
  `{verdict:"approve", malformed:true}` — a broken critic NEVER blocks. Exit 0 by default;
  `--fail-on-revise` exits 3 when the verdict is `revise` (hard CI gate).

### Programmatic API
```js
import { runCriticPass, criticGate } from "./run.mjs";
// criticGate short-circuits (no model call) unless useCritic is true:
const r = await criticGate({ useCritic: alloc.useCritic, task, draft, minSeverity: "medium" });
// -> { ran, verdict, issues, confidence, shouldRevise, malformed, model }
// Inject a chatFn for tests/offline: runCriticPass({ task, draft, chatFn: async()=>'{"verdict":"approve"}' })
```

### Wired into the orchestration path
`app-kit/ORCHESTRATION-STANDARD.md` Rule 5 mandates running this on the draft when the allocator sets
`useCritic=true`, and `fleet-dispatch`'s `--spawn` folds the exact `run.mjs` command into the spawned
session's task text whenever the dispatched task was flagged `useCritic=true`.

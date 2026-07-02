# Orchestration Standard (how the orchestrator scales fan-out)

Owner: whoever is acting as orchestrator for a session. Status: STANDING POLICY.

This is the effort-scaling lesson written down so it stops being relearned the hard way:
do not fan out 4 subagents for a single lookup, and do fan out when the work is genuinely
multi-facet. It is short on purpose. Follow it every time you consider spawning more than
one subagent.

## The Iron Rule

**Fan-out size matches task complexity, not habit.** Spinning up four agents to answer "what
is X" wastes budget and produces four answers to reconcile instead of one. Running a single
agent on "reverse-engineer this system and investigate every angle" under-covers the work.
The fix is the same discipline both ways: size the fan-out to the task, every time, using the
same rule instead of a gut call.

## Rule 0: use the helper, do not eyeball it

```
node skills/fleet-dispatch/effort-scale.mjs "<task text>" [--max N] [--min N]
```
```js
import { recommendFanout } from "skills/fleet-dispatch/effort-scale.mjs";
const { agents, mode, rationale } = recommendFanout(taskText, hints);
```

`recommendFanout` is a pure function (no I/O, no network) that reads signals in the task text
and returns how many agents to dispatch, a mode label, and a one-line rationale. It is the
source of truth for sizing; do not override it silently. If you disagree with its call, that is
a signal the task text was ambiguous, not a license to skip it.

## The sizing rules

1. **Single-fact lookup -> 1 agent.** "What is X", "who owns Y", a quick lookup or one-off
   check. There is nothing to reconcile across parallel angles, so parallelism only adds
   synthesis overhead for zero benefit.
2. **Comparison / tradeoffs -> 2-3 agents.** "A vs B", "compare", "tradeoffs across", "pros and
   cons." Splits naturally along the options being compared; one agent per option (or angle)
   up to 3 keeps the comparison tractable to synthesize.
3. **Multi-facet research -> up to 4 agents.** "Reverse-engineer", "investigate the issue",
   broad/open-ended research, an audit. Genuinely benefits from parallel angles attacking the
   problem from different directions at once.
4. **Red-team -> 3-4 agents.** "Break it, then fix it", adversarial/attack work. Different
   agents probing different attack surfaces in parallel beats one agent serially trying angles.
5. **Build touching disjoint files -> up to 3-4 builders.** Only when the work cleanly splits
   across non-overlapping files/modules. If the files are not disjoint, do not fan out; a
   single builder avoids merge conflicts entirely.

## Rule 1: 4 is a hard cap, not a target

Past 4 in-flight subagents, two things break down at once: nobody can verify every diff before
calling the work real (see Rule 2), and the merge queue stops being tractable, PRs pile up
faster than they can be reviewed and landed. `recommendFanout` enforces this cap internally;
hints can push the count down, never above 4.

## Rule 2: synthesis is an explicit step, not a side effect of aggregation

Collecting N subagents' messages into one place is not synthesis. Synthesis is the orchestrator
actually reading every result, forming one conclusion, and **writing that conclusion to the
ledger** as its own entry, distinct from the raw subagent outputs. If the session ends with
"here is what each agent said" and no separate synthesized takeaway, the fan-out was wasted;
the whole point of parallel angles is a single sharper conclusion, not a longer transcript.

- Do: `agent A found X, agent B found Y, agent C found Z -> conclusion: Z is the root cause,
  ship the fix from agent C's branch, log this conclusion to the ledger.`
- Do not: paste all three agents' raw output into the ledger and call it done.

## Rule 3: verify every subagent diff before it is real

A subagent's diff is a proposal until the orchestrator (or a human) has actually looked at it.
"The agent said it passed tests" is not verification; running the tests, or reading the diff,
is. This applies per-agent, not just to the synthesized whole, before any of it is merged or
reported as done.

## Rule 4: fresh-fetch each file

Every subagent that will edit a file starts from a fresh fetch of that file (fresh clone,
fresh read) rather than a cached or inherited copy. Stale local state is how disjoint-file
fan-outs quietly stop being disjoint, two agents editing what they each believe is an
up-to-date file, one of them silently clobbering the other's work on merge.

## Definition of Done (paste into any orchestration task)

A fan-out decision is DONE when:
- [ ] `recommendFanout` (or equivalent reasoning against these rules) sized the dispatch, not habit;
- [ ] agent count did not exceed 4;
- [ ] every subagent's diff was verified (read or tested) before being treated as real;
- [ ] a synthesized conclusion was written to the ledger, separate from raw subagent output;
- [ ] each subagent fresh-fetched the files it touched.

## Content rule
No em dashes or en dashes. Use commas, periods, or line breaks.

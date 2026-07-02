---
name: semantic-trust
description: Cross-agent corroboration and trust-decay scoring on top of the kb-memory ledger. Takes episodic ledger entries (or structured-notes) from MULTIPLE agents and scores how trustworthy a shared claim is, based on how many DISTINCT agents corroborate it, how fresh those assertions are (half-life decay), and whether any agent contradicts it. Produces an advisory-only recommendation to promote a claim to a shared "semantic/durable" layer; never writes anywhere itself. Use when deciding whether a fact repeated across the exec team feed has become durable company knowledge versus still being one agent's unverified claim.
---

# semantic-trust - cross-agent corroboration and trust decay

## Why this exists
`kb-memory/dedupe.mjs` (Wave 1) is an INTRA-agent guard: it stops one agent from piling up
near-duplicate rows in its own private ledger lane, or silently restating a changed value instead of
writing a proper `correct --was ... --supersedes` row. That is necessary but not sufficient. Once
facts start flowing into the shared exec team feed (`--share` / `status`, see `skills/kb-memory`),
the SAME real-world fact often gets asserted independently, in different words, by SEVERAL agents.
That is a much stronger truth signal than one agent repeating itself, and it deserves its own model:
episodic ledger entries become corroborated SEMANTIC facts as independent confirmation accumulates
over time.

## The model
A claim moves through a small set of states as evidence accumulates or ages out:

```
unverified  ->  corroborated  ->  durable
                    \-> contested (if an unresolved conflict shows up at any point)
```

- **unverified** - only one distinct agent has ever asserted this claim. One voice, no corroboration.
- **corroborated** - two or more distinct agents agree, but fewer than the durable threshold `N`
  (default 3), and there is no unresolved contradiction.
- **durable** - `N` or more distinct agents agree (default 3) and there is no unresolved
  contradiction. This is the state a claim needs to reach before promotion is even considered.
- **contested** - a contradicting claim exists for the same subject and it is not clearly outweighed
  by the corroborating side. Contested takes priority over every other status: a claim with 5
  corroborating agents but an unresolved live contradiction is "contested", not "durable".

## Distinct-agent corroboration (the core rule)
Corroboration is counted PER DISTINCT AGENT, never per assertion. If the same agent restates a claim
three times, that is still one agent's belief, not three independent confirmations - `scoreClaim`
dedupes assertions by agent (keeping the most recent one per agent) before computing anything, so
`distinctAgents` can never be inflated by one chatty agent. The same dedupe rule applies to the
contradicting side.

## Time-decay of trust (half-life)
Trust is not a permanent stamp; agreement from six months ago is weaker evidence than agreement from
last week. Each assertion's contribution to trust decays with a half-life (default 30 days):

```
weight = confidence * 0.5 ^ (ageMs / halfLifeMs)
```

An old, stale corroboration still counts for something, but far less than a fresh one. `nowMs` is
always an explicit input to `scoreClaim` (never an internal `Date.now()` call in the scoring path)
so the same inputs always produce the same trust number - this is what makes the module safely
testable and safely callable from a batch job re-scoring the whole ledger at any point in time.

## Contradiction handling
An assertion from another agent that conflicts with a claim's value applies a sharp penalty to trust
(also age-decayed and deduped by distinct contradicting agent, using the same rules as corroboration).
If the conflicting side is not clearly outweighed - either it has as many or more distinct agents
behind it, or the penalty has driven trust down to a contested floor - the claim's status becomes
"contested" regardless of how high its raw trust number would otherwise be. Contested claims are
never recommended for promotion (see below), even if their numeric trust happens to be high.

## Grouping raw rows into claims
`groupAssertions(rows)` takes a flat list of ledger rows (kb-memory shape:
`{id, ts, type, text, tags, source, agent, ekey, evalue, ...}`) and/or structured-notes shape
(`{subject, claim, evidence, confidence}`, see `skills/structured-notes/note-schema.mjs`) and
clusters them into candidate claims. It buckets by subject (`ekey`/`subject` when present), then
within a bucket clusters by text similarity using the SAME `tokenize`/`jaccard` heuristic
`kb-memory/dedupe.mjs` uses for intra-agent near-duplicate detection - just applied across agents.
The largest cluster in a bucket becomes the claim's corroborating assertions; every other cluster in
that bucket (same subject, dissimilar wording) becomes its contradictions. See the function's doc
comment in `trust.mjs` for the exact deterministic steps.

## Promotion is advisory only
`promoteRecommendation(scored, { threshold })` looks at a `scoreClaim` result and returns
`{ promote, toStatus }`. It is a pure function: it never mutates the ledger, never writes to the
shared exec team feed, and never touches any shared index. `promote` is only ever true when status
is `"durable"` AND trust is at or above the threshold (default 0.75) - a contested claim is never
promoted no matter how high its trust number happens to be, because status gates promotion, not the
number alone. Acting on a `promote: true` recommendation (actually writing the claim to a shared
`semantic/durable` layer) is a decision for a human, an orchestrator, or a CTO-level process outside
this skill. This skill is purely additive: it never deletes or mutates existing ledger rows, never
mutates the shared feed, and can be run repeatedly and safely re-scored as new assertions arrive.

## Usage
As a module:
```js
import { scoreClaim, groupAssertions, promoteRecommendation } from "./trust.mjs";

const groups = groupAssertions(rows); // rows pulled from multiple agents' shared feed entries
for (const g of groups) {
  const scored = scoreClaim({ subject: g.subject, claim: g.claim, assertions: g.assertions, contradictions: g.contradictions, nowMs: Date.now() });
  const rec = promoteRecommendation(scored, { threshold: 0.75 });
  if (rec.promote) console.log(`recommend promoting "${g.claim}" to ${rec.toStatus}`);
}
```

As a CLI:
```
node trust.mjs score '{"assertions":[{"agent":"cfo","ts":1750000000000},{"agent":"coo","ts":1750000000000}],"nowMs":1750100000000}'
node trust.mjs group '[{"agent":"cfo","ekey":"xero-cap","evalue":"5000/day","ts":1750000000000}, ...]'
node trust.mjs promote '{"trust":0.9,"status":"durable"}' 0.75
```

## Guardrails
- Pure, dependency-free (Node builtins only), no network or filesystem writes.
- Deterministic given `nowMs`; never calls `Date.now()` in the scoring path except as an unused
  fallback default parameter.
- Additive and non-destructive: does not delete or mutate ledger rows or the shared feed, and does
  not write to any shared index. It only reads what it is handed and returns a score plus an advisory
  recommendation.

## Wired into kb-memory semantic recall
`kb-memory/semantic.mjs recall` now trust-ranks results via this skill (see `rankHitsByTrust`). Because
recall hits are SUBJECT-LESS, the wiring is **corroboration-only**: it clusters like claims across agents
by the same tokenize/jaccard heuristic, scores each cluster's distinct-agent corroboration with
`scoreClaim` (no fabricated contradictions), and floats memories MULTIPLE agents independently recorded
(`durable`/`corroborated`) ahead of a lone `unverified` assertion. Purely additive + fail-open: it
re-orders and annotates hits, never drops one, and degrades to the plain score-ordered list if this module
is missing or throws.

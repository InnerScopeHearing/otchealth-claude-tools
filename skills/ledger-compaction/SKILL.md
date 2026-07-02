---
name: ledger-compaction
description: Produces a compact, human-readable markdown summary of a kb-memory ledger (or any ndjson ledger in the same row shape) without ever touching the source file. Use when a ledger has grown large and you want a smaller artifact to read, while every decision, correction, pitfall, and current entity value is still preserved verbatim.
---

# ledger-compaction

## Why this exists
`skills/kb-memory/mem.mjs` keeps each agent's working memory as an append-only ndjson ledger
(`_MEMORY/<agent>.jsonl`). Append-only is the whole point: nothing is ever deleted, so corrections,
decisions, and pitfalls are never silently lost. The tradeoff is that the ledger grows without bound.
After months of daily writes it becomes slow to skim by hand and expensive to pull whole into a
per-prompt context window. ledger-compaction produces a much smaller, organized markdown summary of
that same ledger so a human or an agent has something short to read, while the full ledger keeps
growing untouched underneath it as the real system of record.

## The non-destructive guarantee
This is the most important property of this skill and it is enforced by the code, not just by
convention:

- The source ledger file (or the rows array passed to the compaction function) is never deleted,
  overwritten, or mutated. `compactLedger()` is a pure function: rows in, a new result object out.
- The CLI (`compact.mjs`) never writes to the path you gave it. It only ever writes to a new,
  separately named file (`<ledger-path>.compacted.md`, and optionally `.compacted.ndjson`).
- The scheduled job (`job/run-compaction.mjs`) only ever reads the ledger blob and writes to a
  separate blob (`_MEMORY/<agent>.compacted.md`). It never writes to `_MEMORY/<agent>.jsonl`.
- Tests in `tests/ledger-compaction.test.mjs` freeze the input rows and the input array before
  calling the compaction function, then assert the input is byte-identical afterward, so any future
  change that tries to mutate the source is caught by the test gate.

If you need to remove or edit an old ledger entry, that is a different, deliberate operation on the
ledger itself; this skill never does it.

## What is preserved verbatim
- Every row whose type is `decision`, `correction`, or `pitfall`. These are the highest-signal rows
  in the kb-memory schema and are never summarized, deduplicated, or dropped.
- The current value of every entity: for rows with an `ekey` (type `entity`), the latest row by
  timestamp (following any `supersedes` chain) is kept in full, so its `evalue`/`text` is exact.

## What gets consolidated (and how)
- **Superseded chains.** When a row's `id` is referenced by another row's `supersedes` field, the
  chain collapses to the latest row (kept in full) plus a single-line history note such as
  `release_build: superseded 3 earlier value(s) (from 2026-05-01T00:00:00Z id=ent1): 10 -> 11 -> 12 -> 13`.
  The old values are listed in the note itself, not just a count, so nothing substantive is lost even
  though the full old rows are not repeated.
- **Near-duplicate facts.** Non-decision/correction/pitfall/entity rows with high token overlap
  (Jaccard similarity, default threshold 0.8, matching the threshold kb-memory's own `dedupe.mjs`
  already uses at write time) collapse into one representative row plus a count, for example
  `... (x3, near-duplicate cluster collapsed)`. `compact.mjs` reuses `../kb-memory/dedupe.mjs`'s
  `tokenize`/`jaccard` when that module is importable, and falls back to a local, equivalent
  implementation otherwise, so a future rename or move of that file cannot break compaction.
- **Old status rows.** `status` is the highest-frequency, lowest-signal row type kb-memory writes
  (a running log of "what am I working on"). The most recent rows (configurable, default the 5 most
  recent, or anything newer than 7 days) are kept in full. Everything older rolls into one digest
  row, for example `42 additional status updates between 2026-04-01 and 2026-05-30 (collapsed)`.

## Output
Running compaction produces a markdown artifact with these sections: Decisions, Corrections,
Pitfalls, Current Entity Values, Superseded Chains, Consolidated Facts, and Status Digest. Each
preserved row keeps its original `ts` and `id` so you can trace it back to the source ledger.
`compact.mjs` can also emit a compacted ndjson file in the same row shape, for tooling that prefers a
flat list of rows over the markdown sections.

## When to run it
Run it once a ledger's row count gets large enough that reading the raw `.jsonl` or the rendered
`.md` is unwieldy (a rough starting point is a few hundred rows, or whenever a ledger's shared
`_MEMORY/<agent>.md` view is taking a long time to scan), or on a recurring schedule via the Azure
Container App Job so a fresh compacted summary is always available without anyone having to remember
to run it.

## Usage

CLI, on a local ledger file:
```
node skills/ledger-compaction/compact.mjs path/to/agent.jsonl
node skills/ledger-compaction/compact.mjs path/to/agent.jsonl --out /tmp/agent-summary.md
node skills/ledger-compaction/compact.mjs path/to/agent.jsonl --ndjson   # also emit a compacted ndjson
```
Prints a stats object (`{ before, after, preserved, collapsed, outPath, ... }`) as JSON on stdout.
The source path is only ever read, never written.

Scheduled job (mirrors `skills/signal-radar/job/radar.sh`):
```
sh skills/ledger-compaction/job/compaction.sh
sh skills/ledger-compaction/job/compaction.sh --agents cfo,clo
```
This reads each agent's `_MEMORY/<agent>.jsonl` ledger blob and writes the compacted summary to
`_MEMORY/<agent>.compacted.md` in the same storage container kb-memory already uses, right next to
the live ledger and its rendered `.md` view. It is fail-open: a missing ledger, a bad credential, or
an unexpected error for one agent is logged and skipped, never crashes the job, and the process
always exits 0 so a scheduled run is never marked failed by a transient issue.

## Guardrails
- Non-PHI ring, same as the rest of the fleet tooling. This skill only ever reads/writes the ledger
  and summary artifacts kb-memory already manages; it introduces no new data store.
- Dependency-free Node ESM, matching the rest of the toolkit's skills.
- Read the source before trusting a summary: the compacted markdown is a derived view for quick
  reading, not a replacement for the ledger. If they ever disagree, the ledger wins, exactly like the
  rest of kb-memory's own discipline.

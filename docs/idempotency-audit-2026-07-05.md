# Idempotency audit — A7-IDEMPOTENT-JOBS (code-review half)

2026-07-05. Companion to `setup/replica-timeout-audit.mjs` (the automatable half of A7: current
`replicaTimeout` / `replicaRetryLimit` per job, report-only). This half is not automatable — it is a
manual read of representative job entrypoints asking one question: **if this job's previous run died
mid-way (OOM, node killed, network blip, hit its `replicaTimeout`) and Container Apps Jobs retries it
(or the next cron tick fires while the old run's partial output is still sitting there), does the
retried/re-triggered run produce duplicate or corrupted output, or does it correctly resume/skip
already-done work?**

Three representative entrypoints were reviewed, plus `mem.mjs` (imported by `memory-librarian.mjs`)
since the librarian's actual persistence path lives there, not in the librarian file itself.

---

## 1. `skills/doc-indexer/deep-pass.mjs` — SAFE (idempotent by design, well-documented)

**Verdict: safe to retry/re-trigger.** This is the strongest example in the fleet.

- **Cron-safe lock with staleness takeover** (lines 78–87, `acquireLock`/`refreshLock`/`releaseLock`):
  a blob-based lock (`_CATALOG/.deep.lock`) with a 15-minute TTL (`LOCK_TTL`), refreshed on every
  flush during the run. A concurrent/re-triggered execution that finds a *fresh* lock just exits 0
  immediately (line 242: `"another execution holds a fresh lock ... exiting 0 (cron-safe, no
  double-run)"`) — no double-processing. If the lock-holder died, the lock goes stale past
  `LOCK_TTL` with no refresh, and the **next** tick takes over and resumes (comment at lines 79–81
  states this explicitly: *"if the holder died/stalled ... the next tick takes over and RESUMES"*).
- **Resumable by row-state, not by run**: the `todo` selection at line 251 —
  `rows.filter((r) => r.path && !r.path.startsWith('_') && (REINDEX || !r.deep || unresolved(r)))`
  — only picks up rows that are NOT already marked `deep: true` (unless `--reindex` is explicitly
  passed) or that are still `unresolved()` (thin-flagged and not yet healed/classified terminal). A
  retried run re-reads the full catalog and only re-does the tail that never got marked done; it does
  not redo work that already landed.
- **Idempotent completion markers are terminal, not re-triggerable forever**: `unresolved()` (line
  250) explicitly excludes rows where `non_text_asset` or `reocr` is already true — resolution is
  terminal per the inline comment (lines 246–248: *"Resolution is terminal ... so the */30 cron
  self-terminates instead of retrying forever"*).
- **Flush is periodic and idempotent overwrite, not append**: `flush()` (line 231) does a full `PUT`
  of the whole catalog JSONL on every 100-row batch (line 271) and once more at the end (line 275).
  A `PUT` of the same content is a no-op; a retried run re-derives the same rows for anything already
  processed, so re-flushing is safe.
- **The one soft risk**: the review-queue CSV and dedup-fields CSV (lines 278–282) are fully
  regenerated from `rows` on every run (not appended), so those artifacts are also naturally
  idempotent — a duplicate run produces the *same* CSV, not a duplicated one.

No changes recommended here; this is the pattern the other two files should be measured against.

---

## 2. `skills/ledger-compaction/job/run-compaction.mjs` — SAFE (idempotent by construction, simpler mechanism)

**Verdict: safe to retry/re-trigger**, though by a different (simpler, less general) mechanism than
deep-pass's lock+row-state approach.

- **Read source / write derived-only, never read-modify-write the source** (lines 110–124): the job
  reads `_MEMORY/<agent>.jsonl` (the ledger) but writes ONLY to a **separate** blob,
  `_MEMORY/<agent>.compacted.md` (line 111, 123). The inline comment at lines 120–122 states the
  invariant explicitly: *"Write ONLY the separate compacted artifact. Never write back to
  ledgerName: the source ledger blob is read-only from this job's point of view."* Since
  `compact.mjs` is described as pure (`compactLedger`, `parseLedgerText`, `renderMarkdown` — line 29,
  and the file-header comment at line 11: *"runs the PURE compact.mjs against the in-memory rows,
  never touches the source blob"*), the output blob is a deterministic function of the current
  ledger content at read time. Re-running with the same (or slightly newer) ledger content produces
  the same (or a superset) `.compacted.md` — a full `PUT` overwrite, not an append. Re-running twice
  in a row, or interrupting mid-run and re-triggering, cannot corrupt or duplicate anything: there is
  no partial-write state to resume from because each agent's compaction is a single read + single
  write, and the write is last.
- **Per-agent fail-open, not fail-fast** (lines 144–151): one agent's blob error is caught and logged,
  the loop continues to the next agent — a retried run does not need to "pick up where it left off"
  mid-loop because each agent's step is already atomic (single read, single write) and independent of
  the others.
- **Caveat, not a correctness bug**: because each agent-write is a full overwrite rather than
  append/patch, a run that dies **after** writing agent A's `.compacted.md` but before reaching agent
  B just means B's compacted artifact is stale until the next successful tick — not corrupted, just
  behind. That is an acceptable staleness window for a compaction summary, not a data-integrity risk.

No changes recommended.

---

## 3. `skills/kb-memory/memory-librarian.mjs` (+ its persistence path in `mem.mjs`) — MOSTLY SAFE, ONE SOFT RISK

**Verdict: safe from a crash/retry perspective for the digest step; the distillation step has a
soft (non-corrupting) duplication risk baked into the ledger's append-only design, not into this
file specifically.**

- **Digest write is idempotent overwrite** (line 78): `_DIGEST.md` is a full `PUT` per agent/day,
  keyed by `agent/date`. Re-running the same agent-day (crash + retry, or two ticks covering an
  overlapping `--days` window) just rewrites the same digest file with freshly-generated (LLM,
  non-deterministic in wording but semantically equivalent) content. No duplication risk — later
  write wins, same as deep-pass's catalog flush.
- **Distillation write is append-only and only *advisory*-deduped, not blocked** (lines 79–85,
  `writeMem` → `mem.mjs`'s `append()`, line 292 there). `mem.mjs`'s own header comments describe
  dedup as a **soft LLM instruction plus a non-blocking write-time advisory**
  (`skills/kb-memory/dedupe.mjs`'s header, lines 5–8: *"dedup today is only a soft LLM instruction
  ... a live `mem.mjs remember|fact|decision` call has no guard against piling up near-identical
  rows"*; and `mem.mjs` line 302–303: *"Non-blocking write-time advisory (dedupe/contradiction).
  Never blocks the write."*). This means: if `processAgentDay` runs twice for the same
  `agent`/`date` (crash after the digest write but before/during distillation, then a retry or the
  next day's `--days 2` window re-covers yesterday), the distillation LLM call in
  `memory-librarian.mjs` is given the **recently written memory** as context (`recentMemory(agent)`,
  line 80, feeds the model *"RECENT MEMORY (do NOT duplicate)"* — line 81) so a well-behaved model
  run will usually decline to re-emit an item it just wrote. But this is a **soft (LLM judgment)
  guard, not a hard (code) one** — nothing in `writeMem`/`mem.mjs.append()` rejects a genuine
  duplicate row. A retried run is not guaranteed byte-identical output, and in the worst case a
  duplicate `pitfall`/`decision`/`remember` row lands in the ledger. This is explicitly the class of
  risk `dedupe.mjs` exists to *flag* (to stderr) but not to *prevent*.
  - **Severity is low, not a correctness bug**: the ledger is designed to be append-only with
    ring-correct/supersede semantics (`mem.mjs` line 5 comment: *"RING-CORRECT ... `correct
    --supersedes <id>`"*), so a stray near-duplicate row degrades ranking quality slightly rather
    than corrupting state or producing wrong answers. It is the kind of drift the nightly librarian
    itself is partly designed to clean up over time, not a crash-safety bug.
  - **The job process itself is fail-open by design** (line 119: `main().catch(...)` still
    `process.exit(0)` even on a fatal error) so a partial run never blocks or fails the schedule —
    consistent with the rest of the fleet's "report-only, never block" philosophy — but it does mean
    a partial/retried run is more likely to occur (a crash never surfaces as a failed job to force
    investigation) and the soft-duplicate risk above is correspondingly more likely to actually
    manifest over time than in a fleet where crashes are loud.
- **Reindex step is naturally idempotent** (line 112): `semantic.mjs reindex` is a full rebuild of the
  search index, not an incremental append — re-running it after a partial distillation run just
  reindexes whatever rows exist at that moment; no special handling needed.

**Recommendation (not implemented in this pass, flagged for the reviewer):** if A7 wants to close
this specific gap, the fix belongs in `dedupe.mjs`/`mem.mjs`, not in `memory-librarian.mjs` — e.g.
making `writeAdvisory`'s jaccard-similarity check into an actual **hard** guard (reject or fold an
append whose token-similarity to an existing recent row exceeds a threshold, rather than only
logging to stderr) would make every caller of `mem.mjs remember/fact/decision` — not just the
librarian — safe to retry without relying on the LLM's own judgment. That is a real code change with
its own review, deliberately out of scope for this report.

---

## Summary table

| Job | Re-run from scratch mid-way | Mechanism |
|---|---|---|
| `deep-pass.mjs` | Safe — resumes, skips done rows | blob lock w/ staleness takeover + per-row `deep`/terminal-resolution flags + full-overwrite flush |
| `run-compaction.mjs` | Safe — full overwrite, never touches source | read-only source ledger, single derived-artifact overwrite per agent, per-agent fail-open |
| `memory-librarian.mjs` | Mostly safe — digest overwrite is safe; distillation append has a soft (LLM-judgment-only) duplicate-append risk | digest = full overwrite; distillation = append-only ledger, advisory-only (non-blocking) dedup in `dedupe.mjs`/`mem.mjs` |

None of the three examined jobs need a `replicaRetryLimit`/`replicaTimeout` change purely on
idempotency grounds — all three are safe to be retried by Container Apps Jobs' own retry mechanism.
The one soft gap (memory-librarian's distillation append) is a ledger-design question, not a
"don't let this job retry" question, and is called out above as a candidate for separate follow-up
rather than folded into this audit's scope.

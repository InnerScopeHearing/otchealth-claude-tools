# PR Hygiene Standard (Definition of Done for the fleet)

Owner: the Developer seat. Status: STANDING POLICY (Matt directive 2026-06-30).

Matt, 2026-06-30: "If the work is done, the PRs need to be closed out and merged
or need to be cut off. As the developer it is your responsibility... create a
process in place so this does not happen again."

This is that process. It is short on purpose. Follow it every session.

## The Iron Rule

**Done work never sits in an open PR.** A task is not "done" when the code is
written or even merged to the branch. It is done when its PR is **merged** or
**closed**, and the open-PR list reflects reality. Anything else is work-in-limbo,
and work-in-limbo is the failure mode this standard exists to kill.

## Rule 0: never assert PR state from memory

Before you say a repo is "clean", "0 open", or "done", you **run the sweep**:

```bash
node skills/pr-sweep/sweep.mjs <repo>
```

The sweep is the source of truth. Memory is not. (This standard was written
because "Companion is 7 -> 0" was asserted from memory while 4 PRs were still open.)

## Every open PR has exactly one disposition

When you work a repo, every open PR must be driven to one of these. None may be
left undecided.

1. **MERGE** - green, mergeable, in-scope, reviewed -> squash-merge now.
2. **REBASE -> MERGE** - good change but behind/conflicting -> rebase, re-green CI, merge.
3. **CLOSE** - superseded, obsolete, duplicate, or abandoned -> close with a one-line
   reason comment. A stale draft that newer work replaced gets closed, not left.
4. **HOLD** - genuinely blocked (a gate: clinical/CPO, security review, a human/Matt
   decision, a dependency cooldown). Allowed ONLY with a written reason **and an
   owner** recorded in the ledger and as a PR comment. "HOLD" without a named blocker
   is just a zombie; close it instead.
5. **SPLIT** - too big or mixes concerns -> carve the mergeable slice out, merge that,
   close or re-scope the rest.

If a PR does not clearly fit 1, 2, 4, or 5, it is a 3 (CLOSE). Bias to closing
zombies over letting them linger.

## Session lifecycle (do this, every repo session)

- **On open:** run `pr-sweep` for the repo(s) in scope. That is your work list.
- **While working:** as each PR resolves, merge/close it immediately. Do not batch
  "I'll clean up at the end" - that is how PRs get forgotten.
- **On close:** re-run `pr-sweep`. The only dev-owned PRs allowed to remain in an
  ACTION-REQUIRED bucket are ones you have written a HOLD reason + owner for. Record
  the end state in the kb-memory ledger (`status`).

## Cadence

- **Per-repo:** the open/close sweep above, every time you touch a repo.
- **Weekly fleet sweep:** run `node skills/pr-sweep/sweep.mjs` across the whole
  portfolio, drive every ACTION-REQUIRED PR to a disposition, log the result.
  (Wire-up target: a Tier-1 Container Apps Job or the overnight runner emitting the
  `--json` report; until then it is a standing manual weekly.)

## Ownership lines (do not cross silently)

- **iOS builds + TestFlight uploads are CTO-only.** The Developer merges product PRs
  to main and escalates "ready to build" with the SHA; the Developer does not dispatch
  builds. Merging a PR that *edits* a CTO-owned build workflow (e.g. `ios-depot.yml`)
  is allowed for trivial dependency/SHA bumps, but log it to the shared ledger so the
  CTO sees it.
- **medreview / PHI** is CTO/BAA-owned. The sweep counts it read-only; the Developer
  does not dispose of its PRs.
- **Dependabot / CI bumps** are in scope for the Developer and count under this
  standard: a green, mergeable Actions/dep bump is a `READY-MERGE`, not background noise.

## Definition of Done (paste into any task)

A task is DONE when:
- [ ] code merged to `main` (squash) OR the PR is closed with a reason;
- [ ] `pr-sweep <repo>` shows no dev-owned ACTION-REQUIRED PR for this work;
- [ ] any remaining open PR carries a written HOLD reason + owner;
- [ ] the end state is recorded in the kb-memory ledger.

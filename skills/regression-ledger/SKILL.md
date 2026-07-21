---
name: regression-ledger
description: Durable, append-only record of every bug found across the fleet -- root cause (not just symptom), fix commit, and whether that same root cause has ever fired before. Run "node ledger.mjs check <tag>" before closing out any fix to see if it's a genuine repeat rather than a new finding. Run "add" to record a fix -- it writes via the authenticated GitHub API directly and verifies the commit landed via an independent read before reporting success, never trusting its own push response alone. Also tracks AUDIT / RECONCILIATION findings (a separate, mutable-status record) via "node ledger.mjs finding add|list|close|check" in a sibling file, FINDINGS-LEDGER.md, so a finding raised in one session cannot silently vanish by the next one; run "finding check" before reporting any audit or PR done.
---

# regression-ledger

Built 2026-07-12 in direct response to Matt's question: "How do I know you're making progress
instead of continually breaking and fixing the same things, forgetting the whole process each time?"
The honest answer required real git archaeology (checking actual commit history/authorship for
several bugs found that same session) rather than a self-report -- this tool makes that check cheap
and routine instead of a one-off forensic exercise.

## The rule

**Before reporting any bug as "found and fixed," run `check` for its root-cause tag first.** If it
has fired before, that's a REGRESSION -- say so explicitly, and be honest about whether the new fix
is structurally different from the old one (a code-level fix that makes the mistake impossible, vs. a
memory/habit note asking future-you to "remember" -- the latter is why regressions happen at all).

## Usage

```
node skills/regression-ledger/ledger.mjs add --tag <root-cause-tag> --bug "<one-line>" \
  --root-cause "<why, not just what>" --fix-repo <owner/repo> --fix-commit <sha> \
  --fix-summary "<one-line>" [--verified-by "<how you confirmed the fix, e.g. 'live-tested twice'>"]

node skills/regression-ledger/ledger.mjs check <tag>     # has this exact root cause ever fired before?
node skills/regression-ledger/ledger.mjs list [--json]   # dump everything
```

Run through the kb-memory wrapper for injected credentials, same as fleet-search/brain.mjs:
```
bash /agent/workspace/skills/kb-memory/run.sh node /tmp/octools/skills/regression-ledger/ledger.mjs ...
```

## Design notes

- Lives as a git-tracked file (`REGRESSION-LEDGER.md`, this repo) rather than an Azure Blob object,
  specifically so it cross-references commit SHAs directly and is reachable via `github__search_code`
  / `fleet-search` for free.
- `add` writes via the authenticated GitHub Contents API directly and then independently re-reads
  the commit history to confirm the push actually landed before printing success -- this tool must
  not repeat `bulletin.mjs`'s exact mistake (silently editing a local file, printing a message that
  implies a push happened when none did), which is the incident that motivated building this in the
  first place.
- Tags should describe the ROOT CAUSE, not the symptom, and should be stable/reusable across
  unrelated-looking bugs that share a cause (e.g. `arm-list-pagination`, not `signal-radar-missing`)
  so the `check` command actually catches repeats across different surface symptoms.

## Findings ledger (Wave 1.1, 2026-07-21)

Extends this same skill to track AUDIT / RECONCILIATION findings, the recurrence class where a real
gap gets found in one session (an audit, a security review, a reconciliation pass) and then quietly
disappears by the next one because "merged" / "shipped" / "task completed" gets mistaken for "the
finding was actually fixed and verified live." A finding has a MUTABLE lifecycle (open, then fixed or
wontfix), unlike a regression entry above (an immutable historical fact once written), so findings
live in their own git-tracked file, `FINDINGS-LEDGER.md` (this same repo), written through the exact
same GitHub Contents API write plus independent reread verify pattern as the bug ledger above.

### Schema

```
{ id, severity: critical|high|medium|low, source_audit_doc, title,
  status: open|fixed|wontfix, fix_commit, verified_by, opened, closed }
```

### Usage

```
node skills/regression-ledger/ledger.mjs finding add --severity <critical|high|medium|low> \
  --source-audit-doc "<path to the audit/reconciliation doc this came from>" \
  --title "<one-line>" [--id <id>] [--status open|fixed|wontfix] \
  [--fix-commit <sha>] [--verified-by "<how you confirmed the fix>"]

node skills/regression-ledger/ledger.mjs finding list [--status <s>] [--severity <s>] [--source <substring>] [--json]
node skills/regression-ledger/ledger.mjs finding close <id> [--status fixed|wontfix] [--fix-commit <sha>] [--verified-by "<how>"]
node skills/regression-ledger/ledger.mjs finding check [<id-or-source-substring>]
```

`add` auto-generates an id (`FND-YYYYMMDD-<hex>`) when `--id` is omitted, and refuses to overwrite an
existing id (use `close` to update one). `close` sets status to `fixed` or `wontfix` and stamps
`closed`; it never accepts `--status open` (that is not a close). Both are fail-open: a network or
auth failure resolves to `{ ok:false, error }` rather than throwing, so a caller does not need its own
try/catch around every call.

### THE RECONCILE GATE (what the audit / PR-done protocol should call)

**Before reporting any audit clean, or any PR/task done, run:**

```
node skills/regression-ledger/ledger.mjs finding check                    # everything, fleet-wide
node skills/regression-ledger/ledger.mjs finding check <source-audit-doc>  # scoped to one audit's findings
node skills/regression-ledger/ledger.mjs finding check <finding-id>        # one specific finding's status
```

This is the mechanical answer to "is this actually done, or does an open finding say otherwise." It
prints every still-open finding in the scope, and fails (`RECONCILE FAILED`, non-zero exit) when any
open finding is `critical` or `high` severity; `medium`/`low` opens are surfaced but non-blocking
(visible backlog). Any process that closes out work, an audit report, a "PR done" checklist, a
session-end summary, should run this check for the relevant source doc (or with no argument for the
fleet-wide view) and say so plainly if it comes back non-clean, rather than declaring victory over an
unreconciled finding. Programmatic callers can import `reconcileOpenFindings(sourceOrId)` directly
(same fail-open contract: an unreachable ledger reports `{ ok:false, clean:true }`, never blocks a
caller on ledger downtime, but is never silently reported as "verified clean" either).

### Relationship to decision-clock

`decision-clock` (sibling skill, Cosmos-backed) tracks OPEN GATES with an owner and an SLA (rotate a
secret, a Matt-only decision, a pending review) and pages the owner when one goes overdue. This
findings ledger is a different concern: a durable, git-tracked, human-readable RECORD of what an
audit found and whether it was actually fixed, reconciled against on demand rather than paged on a
clock. They are complementary, not merged: for a `critical`/`high` finding that also needs an
owner/SLA nudge, additionally open a decision-clock row (e.g.
`node skills/decision-clock/decision.mjs open --category security-finding --owner cto ...`) rather
than building paging into this tool.

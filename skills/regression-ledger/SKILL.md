---
name: regression-ledger
description: Review regression history and existing findings. Public findings-ledger writes are disabled pending a verified private destination; preserve sensitive findings in their owner seat.
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
were historically stored in `FINDINGS-LEDGER.md` in this public repo. New finding writes and status
updates to that file are disabled pending a verified private, owner-scoped destination. Keep sensitive
findings in their authorized owner seat; do not copy them to shared memory as a substitute. This guard
does not remediate existing public history or protect other write paths.

### Schema

```
{ id, severity: critical|high|medium|low, source_audit_doc, title,
  status: open|fixed|wontfix, fix_commit, verified_by, opened, closed }
```

### Usage

```
node skills/regression-ledger/ledger.mjs finding list [--status <s>] [--severity <s>] [--source <substring>] [--json]
node skills/regression-ledger/ledger.mjs finding check [<id-or-source-substring>]
```

`finding add` and `finding close` return `public_findings_writes_disabled` before obtaining credentials
or calling the network. Direct CLI invocation exits nonzero. Existing link/junction invocation has a
known separate dispatch issue, so do not treat its exit status as evidence that any command ran.
Reads and checks retain their existing behavior; they do not prove a new finding was recorded.

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
unreconciled finding. The current checker can return `{ ok:false, clean:true }` when the ledger is
unavailable, and its CLI can exit zero in that case. A missing ledger can also be reported clean.
Treat both as unverified; do not rely on `clean` or the exit code alone. Its parser is not a
complete corruption detector.

### Relationship to decision-clock

`decision-clock` (sibling skill, Cosmos-backed) tracks OPEN GATES with an owner and an SLA (rotate a
secret, a Matt-only decision, a pending review) and pages the owner when one goes overdue. This
findings ledger is a different concern: a historical, git-tracked, human-readable RECORD of what an
audit found and whether it was actually fixed, reconciled against on demand rather than paged on a
clock. They are complementary, not merged: for a `critical`/`high` finding that also needs an
owner/SLA nudge, additionally open a decision-clock row (e.g.
`node skills/decision-clock/decision.mjs open --category security-finding --owner cto ...`) rather
than building paging into this tool.

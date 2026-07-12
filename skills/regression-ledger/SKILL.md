---
name: regression-ledger
description: Durable, append-only record of every bug found across the fleet -- root cause (not just symptom), fix commit, and whether that same root cause has ever fired before. Run "node ledger.mjs check <tag>" before closing out any fix to see if it's a genuine repeat rather than a new finding. Run "add" to record a fix -- it writes via the authenticated GitHub API directly and verifies the commit landed via an independent read before reporting success, never trusting its own push response alone.
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

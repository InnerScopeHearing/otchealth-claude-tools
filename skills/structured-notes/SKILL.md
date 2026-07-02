---
name: structured-notes
description: Optional, backward-compatible schema + validator for STRUCTURED agent notes that layer on top of kb-memory's existing free-text ledger row. Gives agents a machine-consumable shape (subject/claim/evidence/confidence) that the recall harness (signal-radar detectors, recall-evals) can parse deterministically, while every existing free-text row keeps working unchanged. Dependency-free; pure functions + a small CLI.
---

# structured-notes -- machine-consumable notes, encoded into the existing ledger text field

## Why this exists
kb-memory's ledger row (`{id, ts, type, text, tags, source, was, supersedes, ekey, evalue, agent}`)
stores `text` as free prose. That is fine for a human skimming the rendered `.md` view, but a RECALL
HARNESS (precision@k / hit-rate scoring in `skills/recall-evals`, contradiction-staleness detection
in `skills/signal-radar`) does better with explicit fields: WHAT is this about (subject), WHAT is
being claimed (claim), how strong is the source (evidence), and how sure is the writer (confidence).
Free text makes all of that a fuzzy string-match guess. This skill gives agents an OPTIONAL way to
write notes with that shape while changing nothing about the ledger itself.

## Backward compatibility (read this first)
- **No ledger schema change.** A structured note is not a new row shape; it is encoded into the
  SAME `text` field every ledger row already has, as one canonical line (see "Encoding" below).
- **Fully optional.** An agent that never touches this skill is completely unaffected. Existing
  free-text rows (`"Xero refresh tokens expire after 60 days of inactivity"`) remain valid forever;
  nothing here requires migrating them.
- **No breaking read-path change.** Every existing consumer of `text` (rendered `.md`, `recall`,
  `pack`, `recall-evals` substring matching, signal-radar detectors) keeps working on a structured
  note's `text` exactly as it does on free text, because a structured note's `text` IS a string --
  just one with a predictable internal shape a smarter reader can parse if it chooses to.

## The schema
```
{
  subject:      string,               // required -- the entity/topic (a person, a system, a decision, ...)
  claim:        string,               // required -- the statement being made about the subject
  evidence?:    string,               // optional -- source/citation, e.g. "Xero docs 2026-05" or a URL
  confidence?:  "low" | "med" | "high", // optional -- how sure the writer is
  supersedes?:  string,                // optional -- an id this note replaces (ledger row id or note id)
  tags?:        string[],              // optional -- free-form labels
}
```
Only `subject` and `claim` are required. Everything else is additive detail a writer supplies when
they have it.

## Encoding (the bridge to the ledger's `text` field)
A structured note renders to ONE canonical line:
```
SUBJECT: Xero OAuth token | CLAIM: refresh token expires after 60 days of inactivity | SRC: Xero docs 2026-05 | CONF: high
```
Only present fields get a segment; there is no fixed-width padding and segment order is fixed but
tolerant to parse in any order. This line IS what you pass as the free-text argument to any existing
`mem.mjs` verb, e.g.:
```
node skills/kb-memory/mem.mjs remember \
  "$(node skills/structured-notes/note-schema.mjs to-ledger-text '{"subject":"Xero OAuth token","claim":"refresh token expires after 60 days of inactivity","evidence":"Xero docs 2026-05","confidence":"high"}')" \
  --agent cto --tags structured,xero
```
The ledger row is unchanged (`text` just happens to hold a structured line); tagging it `structured`
is a convention, not a requirement, so a reader can cheaply filter for structured rows if it wants to.

## API (`note-schema.mjs`)
Pure, dependency-free, importable and CLI-usable:
- `validateNote(obj) -> { ok: boolean, errors: string[] }` -- required: `subject`, `claim`. Checks
  types of the optional fields too (`confidence` must be one of `low|med|high`, `tags` an array of
  strings, etc).
- `normalizeNote(input) -> note` -- accepts EITHER a structured object OR a free-text string in the
  `"SUBJECT: X | CLAIM: Y | SRC: Z"` form (any subset/order of labeled segments) and returns a plain
  note object with only the fields it found. Never throws; run the result through `validateNote` if
  you need to confirm `subject`/`claim` made it through.
- `toLedgerText(note) -> string` -- renders the canonical single line described above. Round-trips:
  `normalizeNote(toLedgerText(note))` reproduces the same fields that were present on `note`.

## CLI
```
node skills/structured-notes/note-schema.mjs validate '{"subject":"x","claim":"y"}'
node skills/structured-notes/note-schema.mjs normalize 'SUBJECT: x | CLAIM: y | CONF: high'
node skills/structured-notes/note-schema.mjs to-ledger-text '{"subject":"x","claim":"y","tags":["a","b"]}'
```

## Using it end to end with kb-memory
1. Build the note object in your head (subject/claim/evidence/confidence).
2. `validateNote(note)` -- fix any errors before writing.
3. `toLedgerText(note)` -- get the canonical line.
4. Pass that line as the text argument to the existing `mem.mjs remember|decision|correct|pitfall`
   verb, same as any other free-text note (optionally add `--tags structured` as a marker).
5. A later reader (a detector, a recall-eval query, another agent) calls `normalizeNote(row.text)`
   to get the structured fields back out, falling back to treating `row.text` as opaque prose if
   `normalizeNote` finds no recognizable `SUBJECT:`/`CLAIM:` segments -- exactly what happens today
   for every pre-existing free-text row, so nothing regresses.

## Guardrails
- This module does no IO (no fetch/fs/network/credentials). It is pure string/object transformation,
  safe to import from anywhere, including the signal-radar detectors and recall-evals scoring core.
- It never writes to a ledger itself; writing still goes through `kb-memory/mem.mjs` as usual. This
  skill only shapes the text you hand to that write.
- Do not put secrets in `evidence` or `claim`, same rule as any other kb-memory `text`.

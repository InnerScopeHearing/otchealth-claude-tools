---
name: persona-drift-canary
description: The fleet's ONE-BRAIN PERSONA DRIFT CANARY. The "One Brain" persona block (the paragraph starting "You are the OTCHealth AI Operating System" through the "Voice:" sentence that ends it) is hand-copy-pasted, in full, into 11+ separate repos' CLAUDE.md files (see skills/persona-drift-canary/expected-repos.json for the registry) because each repo's Claude Code session reads its own CLAUDE.md directly at session start and a short "see the canonical doc" pointer would be an unsafe de-duplication (a session that never follows the pointer silently loses the persona instructions). That is a genuine drift surface: any one of those 11+ copies can be hand-edited, partially updated, or left behind when the fleet-wide wording changes, with nothing to notice. This tool extracts each registered repo's copy of the block and diffs it (after whitespace-only normalization) against the single canonical copy in dream-team/ONE-BRAIN-PERSONA.md, flagging any repo whose copy has MEANINGFULLY drifted (DRIFTED), lost the block entirely (ABSENT), or could not be read (NO_DATA). Mirrors skills/continuity-canary/continuity-canary.mjs's exact shape and conventions (config-driven registry, pure classifier, --report default / --strict pager convention, PostHog emit, fail-open, never auto-edits a repo). Detection only, never remediation -- it reports drift, it never fixes it.
---

# persona-drift-canary -- catch a One-Brain persona copy that quietly diverged

## Why this exists

`dream-team/ONE-BRAIN-PERSONA.md`'s own "Why this is not a pointer" section explains why the persona
block cannot be de-duplicated the normal way: each repo's session reads its own `CLAUDE.md` at session
start, and there is no guaranteed mechanism that makes a session additionally fetch a separate
canonical doc first. So the block stays full-text, independently, in 11+ repos on purpose. The actual
gap that leaves open is DRIFT: nothing has ever asserted those 11+ copies stay in sync with each other
or with a canonical wording. This is the same problem class `skills/continuity-canary/` solves for
whole continuity docs (detect staleness by commit AGE), applied instead to a single shared paragraph
that is supposed to be byte-identical everywhere it appears (detect divergence by TEXT DIFF).

## What it checks

For every repo in `expected-repos.json`:
1. **Extraction** -- reads the repo's `CLAUDE.md`, finds the line containing the literal sentence
   "You are the OTCHealth AI Operating System", and captures everything from that line through the
   next "Voice:" line (inclusive) within a bounded lookahead window. A repo whose file cannot be read
   is `NO_DATA`; a repo whose file can be read but no longer contains the block at all is `ABSENT`
   (the block was removed or never landed -- distinct from a repo that still has it but reworded).
2. **Normalization** -- both the extracted block and the canonical block are flattened (all whitespace,
   including line breaks and blank-line paragraph gaps, collapsed to single spaces, then trimmed)
   before comparison. This tolerates purely cosmetic differences (line-wrap length, trailing blank
   lines, CRLF vs LF) without tolerating any actual wording, punctuation, or content change -- those
   still change the flattened word sequence and are still caught.
3. **Comparison** -- normalized extracted block `===` normalized canonical block. Equal is `MATCH`;
   not equal is `DRIFTED` (with a short first-divergence context snippet in the report, to make the
   finding actionable without dumping the full block on every row).

## Run

```
node skills/persona-drift-canary/persona-drift-canary.mjs [--report] [--strict] [--json]
```
- `--report` (default): always exits 0. Safe for a manual/local run; anomalies still print as
  `::warning::` lines and still emit the PostHog event.
- `--strict` (or `PERSONA_DRIFT_CANARY_STRICT=1`): any anomaly (a `DRIFTED`, `ABSENT`, or `NO_DATA`
  repo) becomes a non-zero exit, so a scheduled workflow can gate/page on it the same way
  `continuity-canary.mjs --strict` and `azure-canary.mjs --strict` do.
- `--json`: machine-readable summary instead of the text report.

This skill only builds the check + its unit tests. Wiring it into a cron / Container Apps Job /
GitHub Actions workflow (the way `nightly-azure-canary` wires `azure-canary.mjs`, and the way
continuity-canary's own nightly pager workflow wires it) is a separate follow-on, left to whoever owns
that scheduling surface -- this task was scoped to detection + one live baseline run, not to standing
up a schedule.

## Config

- `skills/persona-drift-canary/expected-repos.json` -- one entry per watched repo: `{ path, name,
  optional, note }`. `path` is the repo's `CLAUDE.md` absolute path (fleet session sandboxes
  consistently mount each repo at a fixed `/home/user/<repo>` path). Hand-curated on purpose, same
  convention as `continuity-canary`'s `expected-docs.json` -- there is no auto-discovery at runtime; a
  new repo adopting the persona block needs a new entry here to be watched. Re-run
  `grep -rl "You are the OTCHealth AI Operating System" /home/user/*/CLAUDE.md` periodically to catch
  a repo that adopted the block without being registered yet.
- `dream-team/ONE-BRAIN-PERSONA.md` -- the canonical text, between its own `PERSONA-BLOCK-START`/
  `PERSONA-BLOCK-END` HTML-comment markers. Extracted with the exact same `extractPersonaBlock()`
  function used on every repo's `CLAUDE.md`, so there is exactly one extraction rule in the codebase.

## Reused, not duplicated

- The config-driven registry + pure classifier + pure exit-code function + `--strict` non-zero exit +
  PostHog emit + fail-open/never-throw shape all mirror `skills/continuity-canary/continuity-canary.mjs`
  (itself mirroring `skills/azure-canary/canary.mjs`'s `assessFreshness()` / `pageExitCode()` /
  `emitPosthog()` pattern) directly. `pageExitCode()` here is semantically identical to
  continuity-canary's version of the same name.
- The PostHog secret resolution reuses the same `skills/kb-memory/azure-secret.mjs` `kvSecret()` chain
  continuity-canary already uses; no new credential path was introduced.

## What this tool deliberately does NOT do

- It never edits any repo's `CLAUDE.md`, including the ones it finds drifted. Reconciling real drifted
  wording across repos is a separate, deliberate review with its own judgment calls about which
  customization is intentional (e.g. `otchealth-cto/CLAUDE.md`'s copy is more elaborate on purpose,
  naming `brain_search` and specific privileged-agent roles) versus which is accidental staleness --
  not something a detection canary should silently resolve on its own.
- It does not attempt to fetch or verify the Notion-hosted global doc `otchealth-cto/CLAUDE.md` names
  as the aspirational canonical spec ("One Brain, Canonical Persona and Ground-First Protocol") --
  that doc lives behind an interactive OAuth grant this tool has no path to. See
  `dream-team/ONE-BRAIN-PERSONA.md`'s Provenance section for the full reasoning behind using this
  repo's own copy as the practical canonical text instead.

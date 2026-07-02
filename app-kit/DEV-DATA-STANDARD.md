# Dev/Test Data Standard (synthetic by default, never real PHI)

Owner: the CTO seat. Status: STANDING POLICY (Matt directive 2026-07-01).

Every App Lead and every dev/test/agent task across the portfolio uses this. It
is short on purpose. Follow it every session.

## The Iron Rule

**Dev and test data is synthetic by default. Real PHI never touches a non-BAA
runtime.** If you need records to build against, screenshot, seed a database,
demo a flow, feed an agent, or write a test fixture, you generate them with the
`synthetic-health-data` skill. You do not pull, copy, export, or paste real
patient/customer health records into a dev environment, a prompt, a fixture
file, a ticket, or a chat. There is no "just this once for testing" exception:
HIPAA has no development or internal-use carve-out, and this runtime (Hyperagent)
is a non-BAA third party, so real PHI flowing through it is an impermissible
disclosure the moment it happens, regardless of who ever sees the output.

## The one command

Generate the canonical, reproducible fixture bundle for the common app shapes:

```bash
node skills/synthetic-health-data/seed-fixtures.mjs
# writes skills/synthetic-health-data/fixtures/synthetic/{hearing-screening,patient,customer,order}.json
# + manifest.json (seed + per-file sha256). Same seed -> byte-identical output.
```

Need a one-off shape or a custom size? Call the generator directly:

```bash
node skills/synthetic-health-data/gen.mjs hearing-screening --count 500 --seed 42
node skills/synthetic-health-data/gen.mjs patient  --count 100 --csv --out patients.csv
node skills/synthetic-health-data/gen.mjs customer --count 1000
node skills/synthetic-health-data/gen.mjs order    --count 200
```

All output is 100% fabricated: reserved 555 phone exchange, RFC-2606 `.test`
email TLDs, `SYN-` MRN prefix, name pools with no lookup against any real roster.
Nothing in `gen.mjs` reads a file, hits a network endpoint, or pulls a real
record. It only fabricates. Safe on any runtime, including this one.

## When you genuinely have a real extract

Only inside the BAA-covered environment (the MedReview/production boundary, i.e.
Claude Code), and only when the task truly requires real-shaped data, run it
through the de-identifier first. The de-identified output (plus its strip report)
is the ONLY thing that may leave that boundary:

```bash
node skills/synthetic-health-data/deident.mjs --file real_extract.json --report report.json
```

`deident.mjs` is fail-closed (default-deny): any column not on the explicit safe
allowlist is dropped, not passed through. It only processes data you hand it, it
never fetches PHI. Its output is de-identified to HIPAA Safe Harbor and is no
longer PHI. Read that skill's `SKILL.md` for the 18 categories and the two
documented heuristic limitations (bare city/town names in prose; names in prose
without an honorific) before you rely on it for a real extract.

## What this means per App Lead

- **Default your seed scripts, fixtures, and Vitest/Maestro test data to
  `seed-fixtures.mjs` output.** Check the fixture bundle (or the seed command)
  into the app repo so every contributor and CI run gets identical data.
- **Never** wire a dev/staging build to a production PHI datastore, and never
  paste a real record into a prompt to an agent (including this one).
- If a bug genuinely reproduces only on real data, that investigation stays on
  the BAA-covered environment; bring back a de-identified repro, not the raw PHI.

## Why the rule is also the fast path

This is not a speed brake. Synthetic fixtures are reproducible (a fixed seed
gives byte-identical data), require zero access-control ceremony, and can be
committed to the repo and shared freely. Fighting PHI access controls for every
dev task is slower than `node seed-fixtures.mjs`. The one command IS the
velocity.

## Content rule

Anything here that ends up in published app copy: no em dashes or en dashes. Use
commas, periods, or line breaks.

# SPEC: <feature / change name>

> Copy this to `SPEC.md` (or `docs/specs/<slug>.md`) and fill it in BEFORE writing
> code for any non-trivial app change. Get it approved, then execute, ideally in a
> fresh session with clean context. The research is unambiguous: teams that ship
> working software write the spec and define the verification first. The two bugs
> that shipped broken this week (FourVault splash, PlantID green screen) both came
> from jumping to implementation. This template is procedure #1 of the App-Building
> Bible made concrete.

## 1. Goal (one sentence)
What this change accomplishes for the user. If you cannot state it in one sentence,
the change is too big — split it.

## 2. The aha / value it serves
Which user value moment does this touch (e.g. first card scanned, first test result,
first ID)? If it does not move the user toward value, justify why it is worth doing.

## 3. Files & interfaces (name them)
- Files this WILL create/modify: `path/...`
- Interfaces/contracts it touches (API routes, DB schema, shared types, env vars):
  - Confirm each EXISTS before relying on it. Do not trust a remembered field/endpoint.
  - List the REAL backend/contract this runs against (no mocks for external infra).

## 4. Out of scope (name it)
What this change deliberately does NOT do. Prevents scope creep and hallucinated work.

## 5. Acceptance — the golden task (eval-first)
The ONE end-to-end check that proves this works, written BEFORE the code:
- Given <state>, when <user action>, then <observable result>.
- The exact command/spec that returns pass/fail: `...`
- If it is a user journey, the route(s) + the assertion (a real interactive element
  appears, the screen is not blank, the expected text/value renders).

## 6. Verification plan (how I will prove it, with evidence)
- [ ] Unit/regression test that fails on the old code, passes on the new.
- [ ] `typecheck` + `lint` green (necessary, not sufficient).
- [ ] **Boot-gate**: the BUILT bundle reaches an interactive screen at 402x874 with
      zero console errors (`skills/boot-gate`). Required for any UI/boot-path change.
- [ ] **Render**: every touched screen screenshotted at device size; not a flat
      color; art-director judge no-FAIL.
- [ ] Build-env: required `VITE_*` non-empty (`check-build-env.mjs`) if a release.
- [ ] Evidence to show: the command(s) run + their output, or the screenshot.

## 7. Risks / gotchas / rollback
- Known platform gotchas (recall the ledger + `app-kit/LESSONS.md` first).
- PHI/compliance ring check (non-PHI unless this is a BAA app).
- How to revert if it regresses.

## 8. Decision log
- Open questions for the human (use AskUserQuestion). Record the answer here as a
  durable DECISION, then write it through to the ledger (`mem.mjs decision`).

---
After approval: implement in small commits, run section 6 top to bottom, show the
evidence, write-through the lessons, THEN declare done. "Looks done" is not done.

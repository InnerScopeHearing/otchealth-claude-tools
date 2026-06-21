# Autonomous toolkit-hardening backlog

A prioritized, SAFE queue for the timed autonomous runner (`.github/workflows/autonomous-run.yml`) or
any agent hardening this toolkit. Every item is self-contained, testable, and stays in
`otchealth-claude-tools` (least-privilege: no Secret Manager, no other repos, draft PRs only). Work top
to bottom, one draft PR per item, run `bash run-tests.sh` before each commit.

## Rules for this queue
- Branch `claude/harden-*`, open DRAFT PRs, never push to main.
- Do NOT call any skill that needs live credentials (no Secret Manager / Azure / GitHub-app token). Test
  PURE LOGIC by importing functions, not by hitting APIs.
- Every fix ships with a test under `tests/` or a skill `selftest.mjs`. Keep `bash run-tests.sh` green.
- Make a skill importable for testing with an ESM main-guard so importing it does not run the CLI:
  `if (import.meta.url === \`file://\${process.argv[1]}\`) { /* CLI dispatch */ }` and `export` the pure
  functions. This changes NO runtime behavior.

## P1 — test the gate-integrity + ring-safety logic shipped this week
1. **focus-group-loop `fgl.mjs`**: main-guard + export `avg`, `parseFails`, `parseJson`. Test: a
   parse-failed persona (`{_parse_fail:true, rating:null}`) is EXCLUDED from `avg` (not scored 0); `avg`
   of `[9,9,null-failed]` is 9, not 6; `parseJson` strips a ```json fence and trailing prose.
   (Guards the bug that made the 90% gate unreachable.)
2. **company-brain `brain.mjs`**: export the room-selection logic. Test: with no flags, `legal-personal`
   is NOT in the target rooms; only `--include-personal --agent clo` includes it; any other agent with
   `--include-personal` still excludes it. (Guards the attorney-privilege wall.)
3. **browser-agent**: extend `selftest.mjs` (or add a unit test) for the HARD_GATE / TWOFA regexes
   directly: assert "Card number"+"CVV", "SSN", "DocuSign", "routing number" match HARD_GATE; "enter the
   verification code" matches TWOFA; ordinary copy does not. (Guards the unattended-consent safety rails.)
4. **kb-memory `semantic.mjs`**: export `docId`. Test it is stable + collision-safe
   (`agent__id` sanitized) so reindex never duplicates or collides.

## P2 — fleet resilience (Fleet Intelligence #5: model routing)
5. Port the company-brain primary->fallback chat routing (gpt-4o -> foundry gpt-4.1-mini, separate quota)
   into `reflect.mjs`, `fgl.mjs` (the `ask` retry), and `agent-evals`, so a transient Azure OpenAI 429
   never silently degrades them. Keep each one's existing graceful-exit behavior. Add a small unit test of
   the provider-fallback selection (pure function), not a live call.
6. Standardize the 429 backoff helper: one shared `azure-chat.mjs` util (honors Retry-After, primary
   then fallback) and have the skills import it, removing the duplicated retry loops.

## P3 — consistency + hygiene
7. Frontmatter is now gated by `tests/frontmatter.test.mjs` (87/87). Keep it green; add the same gate for
   `name:` matching the directory name where that is the convention.
8. Audit every skill `*.mjs` with `node --check` in `run-tests.sh` (syntax gate) so a broken skill is
   caught before it ships.
9. SKILL.md hygiene: ensure each has a one-line Usage block and a "Non-PHI ring" note where applicable.
10. README/index: regenerate `dream-team/FLEET-TOOLKIT-REFERENCE.md`'s skill list from the actual
    `skills/*/SKILL.md` frontmatter so the master index never drifts from reality.

## Done (seed)
- `run-tests.sh` test gate + `tests/frontmatter.test.mjs` (caught + fixed agent-evals and fleet-telemetry
  missing frontmatter, they were not registering).

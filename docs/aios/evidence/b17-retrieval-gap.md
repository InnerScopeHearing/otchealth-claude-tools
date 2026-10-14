# B17 retrieval/indexing gap

Inspected the staged EvalRunV1 wrapper and retrieval index-key assignment in isolated worktree `/workspace/aios-b17-retrieval-gap-20261014`, based on local commit `6d4ea12760790026fb98276f563e7d219bbc7235` (source-equivalent to Root's accepted revision; exact remote `8d6e` object unavailable locally). Shared source checkout and untracked files were left untouched.

The reproduced defect is in `skills/kb-memory/semantic.mjs`: sanitized raw IDs such as `doc/a` and `doc_a` both map to `cto__doc_a`; previously identical text caused distinct source rows to share one exact index document ID. A temporal extension also showed that identity assignments could shift when a later different-text row arrived. Both are addressed in the frozen source: multi-identity groups always use stable identity+normalized-text hashes. Single-identity groups with different text preserve the byte-exact legacy text-hash IDs.

Legacy hashed IDs from previous multi-identity assignments are collected as per-base aliases and pruned by the actual `reindex()` path only after all currently assigned replacement IDs are confirmed present (already indexed or successfully embedded). Aliases are not treated as base keys, and currently assigned IDs are excluded from deletion. If any replacement embedding/index presence is missing, cleanup is deferred. Independent review also exercised supersession, partial replacement, and current-ID protection. Initial and temporal HOLD history remains in `/workspace/b17-source-group-review.json` and `.md`; independent final review closed the temporal alias finding.

Final frozen source hashes:

- `skills/kb-memory/semantic.mjs`: `c1b2d0976af42a813603edcd826ac56297bf12a2949e48a38ef6b7f56b15c83d`
- `tests/semantic-docid.test.mjs`: `d1c03ee18800e39d799c031a98fab6a961c84be333686800329031c21965941c`

Verification: final `node --test tests/semantic-docid.test.mjs skills/kb-memory/tests/semantic-opensearch-dispatch.test.mjs` passed 17/17; `git diff --check` passed. Root reports a broader focused suite at 28/28. RED history is preserved in the JSON receipt. Tests use synthetic, non-sensitive rows. No private corpus/index body or live provider/index was read or mutated; no model calls, external writes, corpus/eval mutations, commits, or integration were performed. Therefore live-corpus occurrence and live-index impact remain unverified.

The scoped EvalRunV1 wrapper review found no separate reproducible coverage defect in the inspected artifact-byte hash, ordinal mapping, metadata categorization, or explicit unknown evidence/rank/currentness fields. Root owns source publication. A future authorized metadata-only source/index check may establish whether sanitized collisions occur in a live corpus; do not claim live omission without it.

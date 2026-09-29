// push-rules.mjs -- which catalog objects the doc-indexer may ever index or push. PURE (no I/O), so a
// test or another tool (skills/brain-save, the aws-dr-canary) can assert against the SAME list the
// indexer enforces instead of source-scanning indexer.mjs or keeping a drifting parallel copy.
//
// SKIP_PREFIXES history (moved here verbatim from indexer.mjs on 2026-09-29; indexer.mjs re-exports it):
//   * our own artifacts: _CATALOG/ _TEXT/ _SUMMARY/ _TRASH/ _NON-ACCOUNTING/ _DUPLICATES/ _ARCHIVE/
//   * (2026-07-12, ring-safety fix) the kb-memory/sunset-protocol ledger prefixes in the commons
//     container -- _MEMORY/ holds the CFO/CLO exec-feed ledgers (MNPI/privileged), already indexed
//     ring-aware into memory-exec by semantic.mjs; _HANDOFF/ and _DISPATCH/ are lane-scoped ops
//     traffic. If a commons index/push-search run ever crawled the WHOLE container instead of a
//     prefix-scoped slice, these would otherwise get their raw text embedded into the UNRESTRICTED
//     commons-company-journal index (the room every lane, including external connectors, can query).
//     Never remove one without adding an equivalent ring wall to the commons profile itself.
//   * (2026-08-04) _SUMMARY/ and _TRASH/ (the legal_blob_delete soft-delete destination) added
//     defensively as top-level entries so a soft-deleted document is never re-indexed as live.
//   * (2026-09-29, brain-save directive) _KNOWLEDGE-META/ -- brain-save's raw sources (HTML mockups,
//     JSON), version registry, by-hash aliases and override audit records. Only the normalized
//     _KNOWLEDGE/ doc is meant to be searchable; the raw HTML twin would index as script/CSS noise.
//     _KNOWLEDGE/ itself must NEVER be listed here (tests/brain-save-prefixes pins that), and neither
//     prefix is a string prefix of the other ("_KNOWLEDGE/" vs "_KNOWLEDGE-META/").
//   * (2026-09-29, brain-save adjudication round 2) the PRIVILEGED lanes' session journals
//     (_JOURNAL/<lane>/<date>/*.jsonl + the memory-librarian _DIGEST.md): 17 CFO digest chunks were found
//     live in the open commons room. Only the privileged lanes (the kb-memory ring lanes cfo, clo,
//     clo-personal, exec, plus capital = INND raise / MNPI) are skipped: the other lanes' digests remain
//     ordinary commons knowledge. An unscoped commons push-search is ALSO refused outright
//     (unscopedPushRefusal below), so nothing under _JOURNAL/ is ever pushed by accident.
export const RING_PRIVATE_JOURNAL_LANES = Object.freeze(["cfo", "clo", "clo-personal", "exec", "capital"]);
export const RING_PRIVATE_PREFIXES = Object.freeze([
  "_MEMORY/", "_HANDOFF/", "_DISPATCH/", ...RING_PRIVATE_JOURNAL_LANES.map((l) => `_JOURNAL/${l}/`),
]);
export const SKIP_PREFIXES = Object.freeze([
  "_CATALOG/", "_TEXT/", "_SUMMARY/", "_TRASH/", "_NON-ACCOUNTING/", "_DUPLICATES/", "_ARCHIVE/",
  ...RING_PRIVATE_PREFIXES, "_KNOWLEDGE-META/",
]);

/** A push-search that must be refused before any catalog read or embedding call, or "" when allowed.
 *  The commons profile feeds commons-company-journal, the room EVERY gateway lane (external connectors
 *  included) can read, and its container holds session journals, handoffs and older ring-sensitive
 *  research; an unscoped push would embed all of it (adjudication round 2: only nightly.sh guarded
 *  this, `indexer.mjs push-search --profile commons` itself pushed every row). Pure. */
export const COMMONS_ROOM = "commons-company-journal";
export function unscopedPushRefusal(profile, scope, index = "") {
  const commons = String(profile || "").toLowerCase() === "commons" || String(index || "").toLowerCase() === COMMONS_ROOM;
  if (!commons) return "";
  if (scope != null) return "";
  return "refusing an UNSCOPED commons push-search: commons-company-journal is readable by every lane; pass --prefixes <allow-list> (e.g. --prefixes _KNOWLEDGE/,_DAILY/) or save documents with brain-save";
}

/** True when `name` (a path relative to the room's container root) must never be cataloged/pushed. */
export function isSkippedPath(name) {
  const s = String(name || "");
  return SKIP_PREFIXES.some((p) => s.startsWith(p));
}

/** Parse a comma-separated prefix list ("_KNOWLEDGE/,_DAILY/") into a clean array. Blank entries are
 *  dropped; whitespace trimmed. Returns [] for empty/undefined input. */
export function parsePrefixList(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  return String(raw || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Select which catalog rows push-search may push. `prefixes` null/undefined = unscoped (legacy
 *  behavior: every row). An EMPTY array selects NOTHING -- an allow-list that resolved to nothing must
 *  never be read as "no restriction" (that inversion is exactly how an unscoped commons push would
 *  sneak back in). Rows under SKIP_PREFIXES are always excluded, scoped or not. Pure. */
export function selectPushRows(rows, prefixes) {
  const list = Array.isArray(rows) ? rows : [];
  const base = list.filter((r) => r && r.path && !isSkippedPath(r.path));
  if (prefixes == null) return base;
  const allow = parsePrefixList(prefixes);
  if (!allow.length) return [];
  return base.filter((r) => allow.some((p) => r.path.startsWith(p)));
}

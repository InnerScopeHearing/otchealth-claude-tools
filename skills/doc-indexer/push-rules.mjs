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
//   * (2026-09-29, brain-save adjudication round 2, tightened in round 4) session journals: 17 CFO digest
//     chunks were found live in the open commons room. Round 2 skipped only the privileged lanes'
//     journals; round 4 skips ALL of _JOURNAL/ (and _VAULT/, the credential registry). An unscoped commons
//     push-search is ALSO refused outright (unscopedPushRefusal below), and a scoped one may name only the
//     reviewed COMMONS_PUSH_ALLOWED_PREFIXES, so nothing under _JOURNAL/ is ever pushed by accident.
export const RING_PRIVATE_PREFIXES = Object.freeze([
  "_MEMORY/", "_HANDOFF/", "_DISPATCH/", "_JOURNAL/", "_VAULT/",
]);
export const SKIP_PREFIXES = Object.freeze([
  "_CATALOG/", "_TEXT/", "_SUMMARY/", "_TRASH/", "_NON-ACCOUNTING/", "_DUPLICATES/", "_ARCHIVE/",
  ...RING_PRIVATE_PREFIXES, "_KNOWLEDGE-META/",
]);
// (2026-09-29, adjudication round 4) ALL of _JOURNAL/ is now never-push, not only the five privileged lanes:
// per-lane allow/deny lists were exactly the shape that let 17 CFO digest chunks through, and the other
// lanes' digests are reachable through kb-memory / brain-save anyway. _VAULT/ (the credential registry:
// names + metadata) is added for the same reason. The per-lane list was deleted rather than kept.

/** The ONLY prefixes a commons push-search may ever be scoped to (adjudication round 4). A reviewed,
 *  frozen allow-SET: `--prefixes` / COMMONS_PUSH_PREFIXES naming anything else (a wider prefix such as
 *  "_", a sibling such as "_RESEARCH/", a case variant) is refused before any I/O. Widening this list is a
 *  code change that needs the same review as the ring gate. */
export const COMMONS_PUSH_ALLOWED_PREFIXES = Object.freeze(["_KNOWLEDGE/", "_DAILY/"]);

/** A push-search that must be refused before any catalog read or embedding call, or "" when allowed.
 *  The commons profile feeds commons-company-journal, the room EVERY gateway lane (external connectors
 *  included) can read, and its container holds session journals, handoffs and older ring-sensitive
 *  research; an unscoped push would embed all of it (adjudication round 2: only nightly.sh guarded
 *  this, `indexer.mjs push-search --profile commons` itself pushed every row). Pure. */
export const COMMONS_ROOM = "commons-company-journal";
export function isCommonsTarget(profile, index = "") {
  return String(profile || "").toLowerCase() === "commons" || String(index || "").toLowerCase() === COMMONS_ROOM;
}
export function unscopedPushRefusal(profile, scope, index = "") {
  if (!isCommonsTarget(profile, index)) return "";
  if (scope != null) return "";
  return "refusing an UNSCOPED commons push-search: commons-company-journal is readable by every lane; pass --prefixes <allow-list> (e.g. --prefixes _KNOWLEDGE/,_DAILY/) or save documents with brain-save";
}

/** The whole commons scope check in one call: unscoped, or scoped outside the reviewed allow-set. */
export function commonsScopeRefusal(profile, scope, index = "") {
  if (!isCommonsTarget(profile, index)) return "";
  return unscopedPushRefusal(profile, scope, index) || commonsPrefixRefusal(scope);
}

/** A path relative to the room's container root in ONE comparable form: backslashes and repeated slashes
 *  collapsed, `.` segments dropped, `..` resolved, leading `/` and `./` stripped. NOT case-folded (the
 *  caller folds for deny checks and does not for allow checks). Pure. */
export function normalizeRelPath(name) {
  const out = [];
  for (const seg of String(name || "").replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { out.pop(); continue; }
    out.push(seg);
  }
  const joined = out.join("/");
  return /\/\s*$/.test(String(name || "")) && joined ? joined + "/" : joined;
}

const SKIP_FOLDED = SKIP_PREFIXES.map((p) => p.toLowerCase());
/** True when `name` (a path relative to the room's container root) must never be cataloged/pushed. The
 *  comparison is on the NORMALIZED, CASE-FOLDED path: `/_MEMORY/x`, `./_MEMORY/x`, `_MEMORY//x`,
 *  `_memory/x` and `_KNOWLEDGE/../_MEMORY/x` are all skipped (adjudication round 4: a plain
 *  `startsWith` let each of them through). */
export function isSkippedPath(name) {
  const s = normalizeRelPath(name).toLowerCase();
  return SKIP_FOLDED.some((p) => s.startsWith(p));
}

/** Parse a comma-separated prefix list ("_KNOWLEDGE/,_DAILY/") into a clean array. Blank entries are
 *  dropped; whitespace trimmed. Returns [] for empty/undefined input. */
export function parsePrefixList(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  return String(raw || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** A push scope that must be refused for the commons room, or "" when every entry is in the reviewed
 *  allow-set (COMMONS_PUSH_ALLOWED_PREFIXES, exact, case-sensitive). Pure. An EMPTY list is allowed (it
 *  selects nothing); a missing scope is unscopedPushRefusal's job. */
export function commonsPrefixRefusal(prefixes) {
  if (prefixes == null) return "";
  const list = parsePrefixList(prefixes);
  const bad = list.filter((p) => !COMMONS_PUSH_ALLOWED_PREFIXES.includes(p));
  if (!bad.length) return "";
  return `refusing commons push-search prefix(es) [${bad.join(", ")}]: commons-company-journal is readable by every lane, so only the reviewed allow-set [${COMMONS_PUSH_ALLOWED_PREFIXES.join(", ")}] may be pushed (a code change in skills/doc-indexer/push-rules.mjs COMMONS_PUSH_ALLOWED_PREFIXES, reviewed like the ring gate, is the only way to widen it)`;
}

/** Select which catalog rows push-search may push. `prefixes` null/undefined = unscoped (legacy
 *  behavior: every row). An EMPTY array selects NOTHING -- an allow-list that resolved to nothing must
 *  never be read as "no restriction" (that inversion is exactly how an unscoped commons push would
 *  sneak back in). Rows under SKIP_PREFIXES are always excluded (normalized + case-folded, see
 *  isSkippedPath), scoped or not. The allow-list itself matches the path AS STORED, case-sensitively:
 *  a row whose spelling only matches after normalization (`/_KNOWLEDGE/x`, `_knowledge/x`) is not
 *  selected. Pure. */
export function selectPushRows(rows, prefixes) {
  const list = Array.isArray(rows) ? rows : [];
  const base = list.filter((r) => r && r.path && !isSkippedPath(r.path));
  if (prefixes == null) return base;
  const allow = parsePrefixList(prefixes);
  if (!allow.length) return [];
  return base.filter((r) => allow.some((p) => r.path.startsWith(p)) && normalizeRelPath(r.path) === r.path);
}

/** Pull `--prefixes` / `--prefix` (space or `=` form) out of an argv WITHOUT swallowing the next flag
 *  (adjudication round 4, N4): the indexer's generic takeVal consumed whatever followed, so
 *  `push-search --prefixes --s3` silently ran with prefixes "--s3" and `--prefixes` as the last argument (or
 *  `--prefixes=_KNOWLEDGE/`) ran UNSCOPED. A missing or flag-like value is an ERROR (the caller exits 2 before
 *  any I/O). An empty string is a real (empty) value. Returns { argv: <argv without the flags>, prefixes,
 *  prefix, error } where prefixes/prefix are null / "" when the flag was absent. Pure. */
export function extractScopeArgs(argv) {
  const rest = [];
  let prefixes = null;
  let prefix = "";
  let error = "";
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i]);
    const m = a.match(/^(--prefixes|--prefix)(?:=(.*))?$/s);
    if (!m) { rest.push(list[i]); continue; }
    let v;
    if (m[2] !== undefined) v = m[2];
    else {
      const next = list[i + 1];
      if (next === undefined || String(next).startsWith("--")) { error = `${m[1]} needs a value (got ${next === undefined ? "nothing" : `"${String(next).slice(0, 40)}"`}); refusing to guess a scope`; continue; }
      v = String(next); i++;
    }
    if (m[1] === "--prefixes") prefixes = v; else prefix = v;
  }
  return { argv: rest, prefixes, prefix, error };
}

/** The `_count` / `_search` query for "every chunk whose path starts with this full room path prefix"
 *  (`otchealthcommons/company-journal/_MEMORY/`), CASE-INSENSITIVE (adjudication round 4, N2): a residue
 *  chunk written under a case variant (`_memory/`, `_Journal/`) was invisible to the canary and the purge.
 *  LIMIT (documented, not covered): other spelling variants of the path (`//`, a leading `/`, `./`) are not
 *  matched by a prefix query; the push side normalizes them away (isSkippedPath), and the room's own chunk
 *  paths are written from a normalized catalog path, so they should not occur. Pure. */
export function pathPrefixQuery(fullPrefix) {
  return { prefix: { "path.keyword": { value: String(fullPrefix), case_insensitive: true } } };
}

// pipeline-paths.mjs — pure path predicates for the doc-indexer pipeline. No IO, no argv, no
// top-level side effects, so it can be imported by a unit test directly (enrich.mjs and indexer.mjs
// both parse process.argv at import time and dispatch a CLI command, which makes importing either
// of them from a test its own hazard -- see the note in tests/storage-backend-default.test.mjs).

// Which catalog rows are PIPELINE BOOKKEEPING rather than documents (2026-08-19).
//
// The rule this replaced was a blanket `path.startsWith("_")`. Its INTENT was to skip the
// directories this pipeline writes for itself -- the _TEXT/ sidecars, the catalog, the review
// queue. It silently did far more, because the commons room uses an underscore prefix as a NAMING
// CONVENTION for real content. Measured on the live catalog: of 4,218 commons rows, 4,143 were
// excluded, including _NOTION (3,234 company Notion pages), _RESEARCH (322), _DOCS (231) and
// _JOURNAL (222). Exactly 75 survived. So the knowledge-graph enrichment covered ~2% of the room
// holding the company's own written knowledge, and reported itself complete while doing it.
// legal-company loses 188 _NOTION rows to the same bug; finance loses 7, which is why it never
// looked wrong there.
//
// The rule is now an explicit list of what the pipeline itself writes. Each prefix carries its
// trailing slash on purpose, so a longer folder that merely starts with the same letters
// (_TEXTBOOK/, _CATALOGUE/) is not swept up by the fix for the previous over-broad rule.
//
//   _TEXT/     the extracted-text sidecars (enriching one would enrich a sidecar of a sidecar)
//   _CATALOG/  catalog.jsonl, the lock files, the sqlite index
//   _REVIEW/   the low-confidence review queues the enricher itself emits
//   _MEMORY/   agent ledger JSONL files -- append-only logs, separately indexed as memory rooms
//   _STATE/    pipeline state
//   _ARCHIVE/  cold snapshots (the retired brain snapshot is 3.12 GB in a single file)
//
// Deliberately NOT excluded: operational-exhaust folders like _DAILY, _HEARTBEAT, _FLEET-WATCH and
// _MEDIC. They are low-value for retrieval, but this predicate's job is "document vs bookkeeping",
// not "interesting vs boring". Relevance belongs to the retrieval layer and is already handled
// there by room hygiene (otchealth-mcp-server #110 ranks ops chatter down at query time). Encoding
// a second, differently-shaped relevance policy here would put the two out of sync.
export const PIPELINE_PREFIXES = Object.freeze([
  "_TEXT/", "_CATALOG/", "_REVIEW/", "_MEMORY/", "_STATE/", "_ARCHIVE/",
]);

/** True when a catalog path is the pipeline's own bookkeeping and must not be enriched. */
export function isPipelineInternal(path) {
  const p = String(path == null ? "" : path);
  return PIPELINE_PREFIXES.some((prefix) => p.startsWith(prefix));
}

// isLegalPersonalRoom (2026-08-29): the same "never let attorney-privileged content reach an LLM
// call" instinct deep-pass.mjs's isLlmExcludedRoom() already enforces for its own pipeline, applied
// here for enrich.mjs. enrich.mjs's STORAGE_PROFILES hardcodes legal's container to "company", but
// its CLI accepts a `--container` override (`CONTAINER = containerOverride || P.azContainer`) with
// nothing stopping `--profile legal --container personal` from resolving -- a real, reachable
// eligibility surface, not a hypothetical one, since the override exists precisely so an operator
// can target a non-default room. legal-personal is attorney-client-privileged material bound to
// PERSONAL_LEGAL_RING (['clo-personal','exec']) at the search-access layer (see
// otchealth-cto/CLAUDE.md's 2026-07-16 P0 personal-legal cross-ring leak entry) -- no LLM provider,
// Bedrock included even though it runs entirely inside this fleet's own AWS account, is authorized
// to RECEIVE that content in the first place, categorically, regardless of which provider is
// selected. Deliberately a case-insensitive EXACT match on both profile and container (not a
// substring/regex), so a room named e.g. "legal-personal-archive" is not swept up by accident and a
// room that merely contains the word "personal" elsewhere in its name does not false-positive.
export function isLegalPersonalRoom(profile, container) {
  return String(profile == null ? "" : profile).toLowerCase() === "legal" &&
    String(container == null ? "" : container).toLowerCase() === "personal";
}

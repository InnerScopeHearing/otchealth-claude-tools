// kb-memory / blobwrite.mjs, pure helpers for optimistic-concurrency ledger writes.
//
// The ledger .jsonl is edited read-modify-write. With TWO engines (Hyperagent + Claude) writing the
// same blob, an unconditional PUT lets a later writer silently clobber an earlier one's just-appended
// row, and a same-tick newId() computed from a stale snapshot collides. This module holds the pure,
// testable pieces of the fix; mem.mjs supplies the thin Azure Blob glue (getTextMeta/putTextCond) and
// the retry loop that reloads + reapplies on a precondition failure.

import crypto from "node:crypto";

// Parse the ndjson ledger into rows (skips blank/corrupt lines, never throws).
export function parseNdjson(text) {
  return String(text || "").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Serialize rows back to ndjson (trailing newline, matches the existing on-blob format).
export function serializeNdjson(rows) {
  return (rows || []).map((r) => JSON.stringify(r)).join("\n") + "\n";
}

// Salted, monotonic id: YYYYMMDD-NNN-xxxx. The NNN counter preserves human readability and the
// existing startsWith(YYYYMMDD) counting; the random suffix guarantees two writers on the same day/tick
// never mint the same id even before the ETag guard catches the race. `now`/`rand` are injectable for tests.
export function nextId(rows, now = new Date(), rand = () => crypto.randomBytes(2).toString("hex")) {
  const d = now.toISOString().slice(0, 10).replace(/-/g, "");
  const n = (rows || []).filter((r) => (r.id || "").startsWith(d)).length + 1;
  return `${d}-${String(n).padStart(3, "0")}-${rand()}`;
}

// A precondition-failed (If-Match/If-None-Match) or conflict status means a concurrent writer changed
// the blob since we read it; the caller must reload the fresh rows, reapply its change, and retry.
export function isConflict(status) { return status === 412 || status === 409; }

// Conditional-PUT headers for an optimistic append. When we read an ETag, require the blob to be
// UNCHANGED (If-Match); when the blob did not exist (no ETag), create-only (If-None-Match:*) so two
// simultaneous creators race safely - exactly one wins, the loser gets a conflict and reloads.
export function condHeaders(etag) {
  return etag ? { "If-Match": etag } : { "If-None-Match": "*" };
}

// verify.mjs -- what "proven retrievable" means. A successful PUT is never proof.
//   1. Room proof (required): a keyword query on the doc's unique tokens (brain_id + the key's sha8)
//      must return this key at rank 1, and a HYBRID (BM25 + kNN, parent-collapsed; the same shape the
//      gateway uses) query on the title must return it within the top 10.
//   2. Gateway proof: kb_search through mcp.otchealth.app on a minted `coo` lane token (the
//      least-privileged internal lane that reads commons, so a hit proves every lane can find it).
//      Title query first; if not in the top 10, the unique-token query. Token cannot mint -> warning
//      only (room proof stands). Token mints and the key is missing -> NOT searchable.
import { roomPathFor, keyRefFor } from "./provenance.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 1-based rank of `key` in a hit list whose items carry `path` (room path or bare key), or 0. */
export function rankOf(hits, key) {
  const full = roomPathFor(key);
  const i = (hits || []).findIndex((h) => h && (h.path === full || h.path === key || String(h.path || "").endsWith("/" + key)));
  return i >= 0 ? i + 1 : 0;
}

// The id query must be unique to THIS STORED KEY and must actually be an indexed BM25 token. Live and
// adjudicated defects shaped this:
//  1. brain_id is shared by every version of a document, and the room's multi_match is best_fields
//     (dis_max: the best single field wins, tokens do not add across fields), so "<brain_id> <sha8>"
//     ranked a shorter live v1 above the just-pushed v2: every content update failed with exit 3.
//  2. sha8 (the key's 8-hex suffix) is NOT reliably a token: the standard tokenizer keeps
//     "836ff0fd.md" as ONE token when the last hex char is a letter (a-f).
//  3. (adjudication round 2) the body's content_sha256 is unique per BODY, not per key: the same body
//     saved as `--id alpha` then `--id beta` ranked the second at 2, which was then deleted as "not
//     searchable". Every object now carries `key_ref: "<sha1(key)>"` (a clean 40-hex token) in its
//     chunk-0 header; that is the primary id query. content_sha256 remains the fallback for objects
//     saved before key_ref existed.
/** The ordered id queries for a stored key: key_ref first, then content_sha256 (legacy objects). */
export function idQueriesFor(brainId, key, contentSha) {
  const out = [keyRefFor(key)];
  const full = String(contentSha || "").trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(full)) out.push(full);
  else {
    const sha8 = (String(key).match(/-([0-9a-f]{8})\.md$/) || [])[1] || "";
    out.push(sha8 || String(brainId || "").trim());
  }
  return out;
}
/** Back-compat single query (the first, strongest one). */
export function idQueryFor(brainId, key, contentSha) { return idQueriesFor(brainId, key, contentSha)[0]; }

/**
 * Room proof with retries. Returns { ok, idRank, titleRank, top3, error, cleanMiss }.
 * `embedTitle` (async text -> vector) is optional: without it the title query is keyword-only.
 * NEVER throws (adjudication round 4, C1): a search exception inside the retry loop is caught and retried.
 *   ok         the doc is findable (id query rank 1, title query in the top 10)
 *   cleanMiss  the FINAL attempt ran to completion without an exception and the doc was NOT findable: the
 *              only outcome that proves it is not searchable. Callers may delete a document's chunks only
 *              on a clean miss.
 *   error      the FINAL attempt threw (the proof could not run); "" when ok or on a clean miss.
 */
export async function verifyInRoom(backend, { key, brainId, title, contentSha, retries = 3, delayMs = 2000, embedTitle }) {
  let vector = null;
  if (embedTitle) { try { vector = await embedTitle(title); } catch { vector = null; } }
  let last = { ok: false, idRank: 0, titleRank: 0, top3: [], error: "", cleanMiss: false };
  const queries = idQueriesFor(brainId, key, contentSha);
  for (let a = 0; a < Math.max(1, retries); a++) {
    if (a > 0) await sleep(delayMs);
    try {
      let idRank = 0;
      let idHits = [];
      for (const q of queries) {
        const hits = await backend.search({ queryText: q, top: 10 });
        const r = rankOf(hits, key);
        if (!idHits.length) idHits = hits;
        if (r && (!idRank || r < idRank)) { idRank = r; idHits = hits; }
        if (r === 1) break;
      }
      const titleHits = await backend.search({ queryText: title, vector, top: 10 });
      const titleRank = rankOf(titleHits, key);
      const ok = idRank === 1 && titleRank >= 1 && titleRank <= 10;
      last = { ok, idRank, titleRank, top3: (idRank === 1 ? titleHits : idHits).slice(0, 3).map((h) => h.path), error: "", cleanMiss: !ok };
      if (ok) return last;
    } catch (e) {
      last = { ok: false, idRank: last.idRank, titleRank: last.titleRank, top3: last.top3, error: String((e && e.message) || e).replace(/Bearer\s+\S+/g, "Bearer [redacted]").slice(0, 200), cleanMiss: false };
    }
  }
  return last;
}

/** Gateway proof. Returns { status: "ok"|"skipped"|"missing"|"error", rank, query, reason }.
 *  A CLEAN miss ("not in the top 10" on a query that ran) is remembered: a later transport error on another
 *  query or retry can no longer overwrite it into "error" (adjudication round 4, C2). */
export async function verifyViaGateway(backend, { key, brainId, title, contentSha, retries = 2, delayMs = 2000 }) {
  let lastReason = "";
  let missReason = "";
  const missing = () => ({ status: "missing", rank: 0, query: "", reason: missReason });
  for (let a = 0; a < retries; a++) {
    if (a > 0) await sleep(delayMs);
    for (const [label, q] of [["title", title], ...idQueriesFor(brainId, key, contentSha).map((x) => ["id", x])]) {
      let r;
      try { r = await backend.gatewayKbSearch(q, 10); }
      catch (e) {
        const reason = `gateway call failed: ${String((e && e.message) || e).replace(/Bearer\s+\S+/g, "Bearer [redacted]").slice(0, 160)}`;
        // A timed-out call means a black-holed dependency: do not spend the remaining retries on it.
        if (e && e.deadline) return missReason ? missing() : { status: "error", rank: 0, query: label, reason };
        r = { ok: false, skipped: false, reason };
      }
      if (r.skipped) return { status: "skipped", rank: 0, query: label, reason: r.reason };
      if (!r.ok) { lastReason = r.reason || "gateway error"; continue; }
      const rank = rankOf(r.matches, key);
      if (rank) return { status: "ok", rank, query: label };
      missReason = `not in the top 10 for the ${label} query`;
    }
  }
  if (missReason) return missing();
  return { status: "error", rank: 0, query: "", reason: lastReason };
}

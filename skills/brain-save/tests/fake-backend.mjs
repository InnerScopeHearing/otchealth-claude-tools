// In-memory fake of lib/backend.mjs's interface, with call counters. No network.
// S3: a Map of key -> {text, etag}. Room: a Map of chunk id -> doc. search() does a crude BM25-ish
// token match over title + chunk so ranks behave like the real room for unique tokens.
import { rankOf } from "../lib/verify.mjs";

export function createFakeBackend(opts = {}) {
  const s3 = new Map();
  const room = new Map();
  let etagN = 0;
  const calls = { get: 0, putCond: 0, put: 0, del: 0, embed: 0, embedTexts: 0, pushDocs: 0, deleteByParent: 0, refresh: 0, search: 0, gateway: 0, countByPath: 0 };
  const fail = { push: opts.failPush || false, embed: opts.failEmbed || false, search: opts.failSearch || false, gatewayMissing: opts.gatewayMissing || false, gatewaySkip: opts.gatewaySkip || false, delKeys: new Set(opts.failDelKeys || []), putCondConflicts: opts.putCondConflicts || 0, deleteByParent: opts.failDeleteByParent || false, searchThrows: opts.searchThrows || false, gatewayThrows: opts.gatewayThrows || false, gatewayError: opts.gatewayError || false, putCondKeys: new Set(opts.failPutCondKeys || []) };
  // Emulates the live analyzer quirk that bit verify round 1: the standard tokenizer keeps "836ff0fd.md"
  // as ONE token when a letter sits on both sides of the dot (so a sha8 ending in a-f is not a token).
  // Unicode-aware like the real standard analyzer (Hangul/CJK/accented words are tokens too).
  const tokens = (s) => String(s || "").toLowerCase().replace(/([a-z])\.(?=[a-z])/g, "$1dotjoin").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  function search({ queryText, top = 10 }) {
    const q = new Set(tokens(queryText));
    // document frequency per token over chunks, so rare tokens dominate like real BM25 (IDF)
    const df = new Map();
    const docs = [...room.values()];
    for (const d of docs) for (const t of new Set([...tokens(d.title), ...tokens(d.chunk)])) df.set(t, (df.get(t) || 0) + 1);
    const idf = (t) => Math.log(1 + docs.length / (df.get(t) || 1));
    const best = new Map();
    for (const d of docs) {
      const toks = [...tokens(d.title), ...tokens(d.title), ...tokens(d.chunk)];
      let score = 0;
      for (const t of toks) if (q.has(t)) score += idf(t);
      if (!score) continue;
      const cur = best.get(d.parent_id);
      if (!cur || score > cur.score) best.set(d.parent_id, { score, path: d.path, text: d.chunk });
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, top);
  }
  const api = {
    name: "fake", s3, room, calls, fail,
    async get(key) { calls.get++; const v = s3.get(key); return v ? { text: v.text, etag: v.etag } : { text: null, etag: null }; },
    async putCond(key, body, ct, etag) {
      calls.putCond++;
      for (const pre of fail.putCondKeys) if (key.startsWith(pre)) { const e = new Error("s3 put 403 AccessDenied"); e.status = 403; throw e; }
      if (fail.putCondConflicts > 0 && key.includes("registry/")) { fail.putCondConflicts--; const e = new Error("412"); e.status = 412; throw e; }
      const cur = s3.get(key);
      if (!etag && cur) { const e = new Error("s3 put 412"); e.status = 412; throw e; }
      if (etag && (!cur || cur.etag !== etag)) { const e = new Error("s3 put 412"); e.status = 412; throw e; }
      const t = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
      s3.set(key, { text: t, etag: `"e${++etagN}"`, ct });
      return { etag: `"e${etagN}"` };
    },
    async put(key, body, ct) { calls.put++; const t = Buffer.isBuffer(body) ? body.toString("utf8") : String(body); s3.set(key, { text: t, etag: `"e${++etagN}"`, ct }); return { etag: `"e${etagN}"` }; },
    async del(key) { calls.del++; if (fail.delKeys.has(key)) throw new Error("delete failed"); return s3.delete(key); },
    async listMeta(prefix) { return [...s3.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name, size: s3.get(name).text.length, lastModified: new Date().toISOString() })); },
    async roomShape() { return opts.shape || "chunked"; },
    async embed(texts) { calls.embed++; calls.embedTexts += texts.length; if (fail.embed) throw new Error("embed down"); return texts.map(() => [0.1, 0.2, 0.3]); },
    async pushDocs(docs) { calls.pushDocs++; if (fail.push) return { ok: false, errors: [{ id: docs[0].id, error: "boom" }] }; for (const d of docs) room.set(d.id, d); return { ok: true, errors: [] }; },
    async deleteByParent(parentId, { keepIds = null } = {}) { calls.deleteByParent++; if (fail.deleteByParent) throw new Error("opensearch delete 503"); let n = 0; for (const [id, d] of room) if (d.parent_id === parentId && !(keepIds && keepIds.has(String(id)))) { room.delete(id); n++; } return n; },
    async refresh() { calls.refresh++; },
    async chunksByParent(parentId) { return [...room.values()].filter((d) => d.parent_id === parentId).map((d) => ({ id: d.id, chunk: d.chunk, content_hash: d.content_hash })); },
    async countByPath(fullPath) { calls.countByPath++; let n = 0; for (const d of room.values()) if (d.path === fullPath) n++; return n; },
    async search(q) { calls.search++; if (fail.searchThrows) throw new Error("opensearch 503"); if (fail.search) return []; return search(q); },
    async gatewayKbSearch(query, top = 10) {
      calls.gateway++;
      if (fail.gatewayThrows) throw new TypeError("fetch failed");
      if (fail.gatewayError) return { ok: false, skipped: false, reason: "gateway kb_search HTTP 502", matches: [] };
      if (fail.gatewaySkip) return { ok: false, skipped: true, reason: "no coo lane token (test)" };
      if (fail.gatewayMissing) return { ok: true, matches: [] };
      return { ok: true, matches: search({ queryText: query, top }).map((h) => ({ path: h.path })) };
    },
  };
  api.rankOf = rankOf;
  return api;
}

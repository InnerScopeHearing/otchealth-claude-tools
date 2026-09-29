// backend.mjs -- the REAL I/O backend brain-save runs against: the S3 commons (via kb-memory's
// commons-store facade), the OpenSearch brain room commons-company-journal (via the fleet's proven
// SigV4 client + opensearch-write.mjs's embed/bulk primitives), and the gateway's kb_search (via a
// minted `coo` lane token). Every pipeline step talks to this through the same small interface, so the
// unit tests swap in an in-memory fake (tests/fake-backend.mjs) with call counters and no network.
//
// Interface (all async):
//   get(key) -> {text, etag} (both null on 404)        putCond(key, body, ct, etag|null) -> {etag}
//   put(key, body, ct) -> {etag}                        del(key) -> boolean
//   listMeta(prefix) -> [{name,size,lastModified}]      roomShape() -> "chunked"|"flat"|"unknown"|"absent"
//   embed(texts) -> number[][]                          pushDocs(docs) -> {ok, errors}
//   deleteByParent(parentId, {keepIds}) -> number       refresh() -> void
//   countByPath(fullPath) -> number                     search({queryText, vector, top}) -> [{path,...}]
//   chunksByParent(parentId) -> [{id, chunk, content_hash}]
//   gatewayKbSearch(query, top) -> {ok, matches:[{path}]} | {ok:false, skipped:true, reason}
import { ROOM_INDEX } from "./provenance.mjs";
import { withTimeout, callTimeoutMs } from "./deadline.mjs";

const GATEWAY_MCP = "https://mcp.otchealth.app/mcp";

/** Parse a gateway tools/call response body (JSON or SSE `data:` lines) into the tool's result object.
 *  The structured result lives in result.structuredContent.result, else JSON inside
 *  result.content[0].text (the known response-shape pitfall). Pure, exported for tests. */
export function parseGatewayToolResponse(bodyText) {
  const candidates = [];
  const t = String(bodyText || "").trim();
  try { candidates.push(JSON.parse(t)); } catch { /* maybe SSE */ }
  if (!candidates.length) {
    for (const line of t.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try { candidates.push(JSON.parse(line.slice(5).trim())); } catch { /* skip */ }
    }
  }
  for (const env of candidates) {
    const r = env && env.result;
    if (!r) continue;
    const sc = r.structuredContent;
    if (sc && sc.result && Array.isArray(sc.result.matches)) return sc.result;
    if (sc && Array.isArray(sc.matches)) return sc;
    const c0 = Array.isArray(r.content) && r.content[0] && r.content[0].text;
    if (c0) {
      try {
        const j = JSON.parse(c0);
        if (j && j.result && Array.isArray(j.result.matches)) return j.result;
        if (j && Array.isArray(j.matches)) return j;
      } catch { /* not JSON */ }
    }
    if (r.isError) return { error: true, matches: [] };
  }
  return null;
}

/** Every method is wrapped by the caller in lib/deadline.mjs withDeadlines(); the gateway fetch ALSO gets
 *  an AbortSignal (so its socket is released, not just abandoned) and the lane-token mint is one memoized,
 *  time-boxed promise (a hung mint used to be re-started by every later call). `deadlineAt` (epoch ms, 0 =
 *  none) caps both. */
export async function createRealBackend({ lane = "coo", gateway = "auto", deadlineAt = 0 } = {}) {
  const CS = await import("../../kb-memory/commons-store.mjs");
  const OS = await import("../../kb-memory/opensearch-write.mjs");
  const OC = await import("../../doc-indexer/opensearch-client.mjs");
  const { classifyRoomShape } = await import("../../doc-indexer/chunking.mjs");
  const Rooms = await import("../../company-brain/opensearch-rooms.mjs");
  let cfg = null;
  const osCfg = async () => (cfg ||= await OS.resolveOpenSearchConfig());
  let token = null;
  let tokenErr = null;
  let tokenPromise = null;
  const budget = () => Math.max(1, Math.min(callTimeoutMs(), deadlineAt ? deadlineAt - Date.now() : Infinity));

  function laneToken() {
    tokenPromise ||= (async () => {
      try {
        const { mintToken } = await import("../../gateway-connect/connect.mjs");
        token = (await withTimeout(mintToken(lane), budget(), `${lane} lane token mint`)).token || null;
        if (!token) tokenErr = "no token in response";
      } catch (e) { tokenErr = String((e && e.message) || e).replace(/Bearer\s+\S+/g, "Bearer [redacted]").slice(0, 200); }
      return token;
    })();
    return tokenPromise;
  }

  return {
    name: "real",
    get: (key) => CS.cGetMeta(key),
    putCond: (key, body, ct, etag) => CS.cPutCond(key, body, ct, etag),
    put: (key, body, ct) => CS.cPut(key, body, ct),
    del: (key) => CS.cDel(key),
    listMeta: (prefix) => CS.cListMeta(prefix),
    async roomShape() {
      const m = await OC.osGetMapping(await osCfg(), ROOM_INDEX);
      if (m.status === 404) return "absent";
      if (!m.ok) throw new Error(`opensearch mapping GET ${ROOM_INDEX}: ${m.status}`);
      return classifyRoomShape(m.json, ROOM_INDEX);
    },
    embed: (texts) => OS.embedOpenAI(texts, "brain-save"),
    pushDocs: (docs) => OS.pushDocs(ROOM_INDEX, docs),
    async deleteByParent(parentId, { keepIds = null } = {}) {
      const res = await OC.osSearch(await osCfg(), ROOM_INDEX, { size: 1000, _source: false, query: { term: { parent_id: parentId } } });
      if (!res.ok) throw new Error(`opensearch parent lookup ${res.status}`);
      const ids = (res.json?.hits?.hits || []).map((h) => String(h._id)).filter((id) => id.startsWith(parentId + "_") && !(keepIds && keepIds.has(id)));
      if (!ids.length) return 0;
      const d = await OS.deleteDocs(ROOM_INDEX, ids);
      if (!d.ok) throw new Error(`opensearch delete: ${JSON.stringify(d.errors.slice(0, 2))}`);
      return ids.length;
    },
    /** Chunk texts of one parent (audit --repair rebuilds a lost object from them). */
    async chunksByParent(parentId) {
      const res = await OC.osSearch(await osCfg(), ROOM_INDEX, { size: 1000, _source: ["chunk", "chunk_id", "content_hash"], query: { term: { parent_id: parentId } } });
      if (!res.ok) throw new Error(`opensearch chunk lookup ${res.status}`);
      return (res.json?.hits?.hits || []).map((h) => ({ id: String(h._id), chunk: h._source?.chunk, content_hash: h._source?.content_hash || "" }));
    },
    async refresh() { await OS.refresh(ROOM_INDEX); },
    async countByPath(fullPath) {
      const r = await OC.osCount(await osCfg(), ROOM_INDEX, { term: { "path.keyword": fullPath } });
      if (!r.ok) throw new Error(`opensearch _count ${r.status}`);
      return Number(r.json?.count ?? 0);
    },
    async search({ queryText, vector, top = 10 }) {
      const { hits } = await Rooms.searchRoom(ROOM_INDEX, { queryText, vector, top });
      return hits;
    },
    async gatewayKbSearch(query, top = 10) {
      if (gateway === "off") return { ok: false, skipped: true, reason: "--gateway off" };
      const tok = await laneToken();
      if (!tok) return { ok: false, skipped: true, reason: `no ${lane} lane token (${tokenErr || "unavailable"})` };
      const r = await fetch(GATEWAY_MCP, {
        signal: AbortSignal.timeout(budget()),
        method: "POST",
        headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kb_search", arguments: { index: ROOM_INDEX, query, top } } }),
      });
      const text = await r.text();
      const parsed = parseGatewayToolResponse(text);
      if (!r.ok || !parsed || parsed.error) return { ok: false, skipped: false, reason: `gateway kb_search HTTP ${r.status}${parsed && parsed.error ? " (tool error)" : ""}`, matches: [] };
      return { ok: true, matches: parsed.matches || [] };
    },
  };
}

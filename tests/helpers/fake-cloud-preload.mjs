// fake-cloud-preload.mjs -- `node --import` preload that replaces globalThis.fetch with an IN-MEMORY fake of the
// four services skills/doc-indexer/indexer.mjs talks to on a commons push-search: the S3 commons mirror, the
// OpenSearch room, OpenAI embeddings and SSM (secret values). No real network: any other host is an
// "unexpected-fetch" error, so a test can never reach production. Scenario in / call log out are files:
//   FAKE_CLOUD_SCENARIO  JSON { s3: {relKey: text}, s3Status: {relKey: httpStatus for HEAD/GET}, osShape, osExisting: [fullPath],
//                               embedFail: bool, ssm: [{name, value}] }
//   FAKE_CLOUD_LOG       JSONL of every observable call: {type:"embed"|"bulk"|"os-create"|"os-mapping-put"|"s3-put"|"ssm"|"unexpected-fetch", ...}
// Pair it with a minimal env (fake AWS keys, OPENSEARCH_ENDPOINT=fake-os.local, OPENAI_API_KEY=sk-fake).
import { readFileSync, appendFileSync } from "node:fs";
import { OS_VECTOR_FIELD_CHUNKED } from "../../skills/doc-indexer/chunking.mjs";

const sc = JSON.parse(readFileSync(process.env.FAKE_CLOUD_SCENARIO, "utf8"));
const LOG = process.env.FAKE_CLOUD_LOG;
const log = (o) => appendFileSync(LOG, JSON.stringify(o) + "\n");
const KEY_PREFIX = "otchealthcommons/company-journal/";
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

function s3(url, method) {
  const path = decodeURIComponent(url.pathname);
  if (path === "/" && url.searchParams.get("list-type") === "2") {
    const prefix = url.searchParams.get("prefix") || "";
    const items = Object.keys(sc.s3 || {}).map((k) => KEY_PREFIX + k).filter((k) => k.startsWith(prefix))
      .map((k) => `<Contents><Key>${k}</Key><Size>${(sc.s3[k.slice(KEY_PREFIX.length)] || "").length}</Size><LastModified>2026-09-01T00:00:00.000Z</LastModified></Contents>`).join("");
    return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`, { status: 200 });
  }
  const rel = path.startsWith("/" + KEY_PREFIX) ? path.slice(1 + KEY_PREFIX.length) : null;
  if (rel == null) return new Response("bad key", { status: 400 });
  const forced = sc.s3Status && sc.s3Status[rel];
  if (method !== "PUT") log({ type: method === "HEAD" ? "s3-head" : "s3-get", key: rel });
  if (method === "PUT") { log({ type: "s3-put", key: rel }); return new Response("", { status: 200, headers: { etag: '"fake"' } }); }
  if (forced && forced !== 404) return new Response("forced failure", { status: forced });
  const text = sc.s3 && sc.s3[rel];
  if (text == null || forced === 404) return new Response("", { status: 404 });
  if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(Buffer.byteLength(text)), etag: '"fake"' } });
  return new Response(text, { status: 200, headers: { etag: '"fake"' } });
}

function os(url, method, init) {
  const p = decodeURIComponent(url.pathname);
  const body = typeof init.body === "string" ? init.body : "";
  const m = p.match(/^\/([^/]+)\/(_mapping|_search|_bulk|_refresh|_count)$/);
  if (p === "/_search/scroll") return json({ _scroll_id: "s2", hits: { hits: [] } });
  if (m && m[2] === "_mapping" && method === "GET") {
    if (sc.osShape === "absent") return json({ error: "index_not_found_exception" }, 404);
    const props = sc.osShape === "unknown" ? {} : { [sc.osShape === "flat" ? "contentVector" : OS_VECTOR_FIELD_CHUNKED]: { type: "knn_vector" } };
    return json({ [m[1]]: { mappings: { properties: props } } });
  }
  if (m && m[2] === "_mapping" && method === "PUT") { log({ type: "os-mapping-put", index: m[1] }); return json({ acknowledged: true }); }
  if (m && m[2] === "_search") return json({ _scroll_id: "s1", hits: { hits: (sc.osExisting || []).map((path, i) => ({ _id: `existing_${i}`, _source: { path, parent_id: `p${i}` } })) } });
  if (m && m[2] === "_refresh") return json({ _shards: { failed: 0 } });
  if (m && m[2] === "_bulk") {
    const lines = body.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const docs = lines.filter((_, i) => i % 2 === 1).map((l) => l.doc);
    const ids = lines.filter((_, i) => i % 2 === 0).map((l) => l.update && l.update._id);
    log({ type: "bulk", index: m[1], ids, paths: [...new Set(docs.map((d) => d.path))] });
    return json({ errors: false, items: ids.map((id) => ({ update: { _id: id, status: 200 } })) });
  }
  if (method === "PUT" && /^\/[^/]+$/.test(p)) { log({ type: "os-create", index: p.slice(1) }); return json({ acknowledged: true }); }
  log({ type: "unexpected-fetch", host: "os", method, path: p });
  return json({ error: "unexpected" }, 500);
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = String(init.method || "GET").toUpperCase();
  if (/\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)) return s3(url, method);
  if (url.hostname === "fake-os.local") return os(url, method, init);
  if (url.hostname === "api.openai.com") {
    const b = JSON.parse(init.body);
    log({ type: "embed", n: b.input.length, texts: b.input.map((t) => String(t).slice(0, 60)) });
    if (sc.embedFail) return new Response("embedding backend down", { status: 500 });
    return json({ data: b.input.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })), usage: { prompt_tokens: 1 } });
  }
  if (url.hostname === "ssm.us-east-1.amazonaws.com") {
    const target = init.headers && (init.headers["x-amz-target"] || init.headers["X-Amz-Target"]);
    log({ type: "ssm", target });
    if (target !== "AmazonSSM.GetParametersByPath") return json({ __type: "ParameterNotFound", message: "not found" }, 400);
    return json({ Parameters: (sc.ssm || []).map((p) => ({ Name: `/otchealth/${p.name}`, Value: p.value, Type: "SecureString" })) });
  }
  log({ type: "unexpected-fetch", url: url.href });
  throw new Error(`fake-cloud: unexpected network call to ${url.href}`);
};

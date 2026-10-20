import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { countOf, prefixQuery, purgePrefixes, sanitizePurgeError, ROOM } from "../skills/doc-indexer/purge-ring-residue.mjs";
import { RING_PRIVATE_PREFIXES } from "../skills/doc-indexer/push-rules.mjs";

test("purge count accepts only nonnegative safe integers and zero failed shards", () => {
  for (const count of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "0"]) {
    assert.throws(() => countOf({ ok: true, json: { count, _shards: { failed: 0 } } }, "_MEMORY/"));
  }
  assert.throws(() => countOf({ ok: true, json: { count: 0, _shards: { failed: 1 } } }, "_MEMORY/"));
  assert.equal(countOf({ ok: true, json: { count: 0, _shards: { failed: 0 } } }, "_MEMORY/"), 0);
  assert.equal(countOf({ ok: true, json: { count: Number.MAX_SAFE_INTEGER, _shards: { failed: 0 } } }, "_MEMORY/"), Number.MAX_SAFE_INTEGER);
});

test("purge failure rendering is fixed and cannot disclose bulk IDs or exception text", () => {
  const hostile = { message: "private-id-123 credential=secret", errors: [{ _id: "private-id-123" }] };
  const rendered = sanitizePurgeError(hostile);
  assert.equal(rendered, "purge failed; details withheld");
  assert.doesNotMatch(rendered, /private-id|secret|credential/);
});

test("real --commit purge CLI sanitizes bulk item IDs and details after five clean counts", async () => {
  const sentinel = "SENSITIVE_DOC_ID_SENTINEL_91";
  const requests = [];
  const tlsDir = mkdtempSync(join(tmpdir(), "purge-local-tls-"));
  const certPath = join(tlsDir, "cert.pem"), keyPath = join(tlsDir, "key.pem");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ed25519", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
  } catch (error) {
    rmSync(tlsDir, { recursive: true, force: true });
    throw error;
  }
  const server = createServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method, path: req.url, body });
      res.setHeader("content-type", "application/json");
      if (req.url.endsWith("/_count")) {
        const query = JSON.parse(body).query.prefix["path.keyword"].value;
        res.end(JSON.stringify({ count: query.endsWith("_MEMORY/") ? 1 : 0, _shards: { total: 1, successful: 1, skipped: 0, failed: 0 } }));
      } else if (req.url.endsWith("/_search")) {
        res.end(JSON.stringify({ hits: { hits: [{ _id: sentinel }] } }));
      } else if (req.url.endsWith("/_bulk")) {
        res.writeHead(200);
        res.end(JSON.stringify({ errors: true, items: [{ delete: { _index: ROOM, _id: sentinel, status: 403, error: { type: "synthetic_error", reason: sentinel } } }] }));
      } else {
        res.writeHead(404); res.end(JSON.stringify({ error: "unexpected route" }));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const child = spawn(process.execPath, [resolve("skills/doc-indexer/purge-ring-residue.mjs"), "--commit"], {
      env: { ...process.env, OPENSEARCH_ENDPOINT: `127.0.0.1:${server.address().port}`, OPENSEARCH_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "synthetic-access", AWS_SECRET_ACCESS_KEY: "synthetic-secret", NODE_EXTRA_CA_CERTS: certPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const [code] = await once(child, "close");
    assert.equal(code, 1);
    assert.match(stderr, /FATAL: purge failed; details withheld/);
    assert.equal(requests.filter((r) => r.path.endsWith("/_count")).length, 5, `requests=${JSON.stringify(requests)} stdout=${stdout} stderr=${stderr}`);
    const search = requests.find((r) => r.path.endsWith("/_search"));
    assert.ok(search, "the reviewed _search phase was reached");
    assert.equal(JSON.parse(search.body)._source, false);
    const bulk = requests.find((r) => r.path.endsWith("/_bulk"));
    assert.ok(bulk, "the synthetic delete request was reached");
    assert.match(bulk.body, /SENSITIVE_DOC_ID_SENTINEL_91/);
    assert.doesNotMatch(`${stdout}\n${stderr}`, /SENSITIVE_DOC_ID_SENTINEL_91|synthetic-secret|synthetic_error|403/);
    // Counterfactual: the removed pre-fix interpolation of deleteDocs' errors exposes both id and raw reason.
    const oldBulkDetail = JSON.stringify([{ id: sentinel, error: JSON.stringify({ type: "synthetic_error", reason: sentinel }) }].slice(0, 2)).slice(0, 200);
    assert.match(oldBulkDetail, /SENSITIVE_DOC_ID_SENTINEL_91/);
  } finally { server.close(); await once(server, "close"); rmSync(tlsDir, { recursive: true, force: true }); }
});

test("purge retains the reviewed five prefixes and case-insensitive commons path.keyword query", () => {
  assert.equal(RING_PRIVATE_PREFIXES.length, 5);
  assert.deepEqual(purgePrefixes(null), RING_PRIVATE_PREFIXES);
  assert.equal(ROOM, "commons-company-journal");
  assert.deepEqual(prefixQuery("_MEMORY/"), { prefix: { "path.keyword": { value: "otchealthcommons/company-journal/_MEMORY/", case_insensitive: true } } });
});

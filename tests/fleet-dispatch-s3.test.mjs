// Tests for skills/fleet-dispatch/dispatch.mjs's S3 port (2026-08-27, off dead Azure Blob). Same
// `--import` fetch-stub subprocess technique as tests/heartbeat-s3.test.mjs and
// skills/doc-indexer/tests/push-search-opensearch.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const DISPATCH_MJS = join(HERE, "..", "skills", "fleet-dispatch", "dispatch.mjs");

const S3_BUCKET = "otchealth-brain-dr-55c84f6b";
const S3_KEY_PREFIX = "otchealthcommons/company-journal/";
const S3_HOST = `${S3_BUCKET}.s3.us-east-1.amazonaws.com`;
const AZURE_HOST_RE = /blob\.core\.windows\.net/i;

function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
function pathOf(u) { try { return new URL(u).pathname; } catch { return ""; } }

function preloadSource(logPath, storePath) {
  return `
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
function pathOf(u) { try { return new URL(u).pathname; } catch { return ""; } }
function loadStore() { return existsSync(${JSON.stringify(storePath)}) ? JSON.parse(readFileSync(${JSON.stringify(storePath)}, "utf8")) : {}; }
function saveStore(s) { writeFileSync(${JSON.stringify(storePath)}, JSON.stringify(s)); }
globalThis.fetch = async (url, opts) => {
  const u = String(typeof url === "string" ? url : url?.url || url);
  const method = ((opts && opts.method) || "GET").toUpperCase();
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method, url: u }) + "\\n");
  if (isHost(u, ${JSON.stringify(S3_HOST)})) {
    const p = pathOf(u);
    const store = loadStore();
    if (method === "GET" && u.includes("list-type=2")) {
      const qs = new URL(u).searchParams;
      const prefix = qs.get("prefix") || "";
      const keys = Object.keys(store).filter(k => k.startsWith("/" + prefix));
      const contents = keys.map(k => \`<Contents><Key>\${k.slice(1)}</Key><Size>\${store[k].length}</Size><LastModified>2026-08-27T00:00:00.000Z</LastModified></Contents>\`).join("");
      return new Response(\`<ListBucketResult>\${contents}<IsTruncated>false</IsTruncated></ListBucketResult>\`, { status: 200 });
    }
    if (method === "GET") {
      if (!(p in store)) return new Response("not found", { status: 404 });
      return new Response(store[p], { status: 200, headers: { etag: '"fake-etag"' } });
    }
    if (method === "PUT") {
      const bodyStr = Buffer.isBuffer(opts.body) ? opts.body.toString("utf8") : String(opts.body);
      store[p] = bodyStr;
      saveStore(store);
      return new Response("", { status: 200, headers: { etag: '"fake-etag"' } });
    }
    if (method === "DELETE") {
      const existed = p in store;
      delete store[p];
      saveStore(store);
      // 204 is a null-body status per the Fetch spec; Node's Response constructor throws if a body
      // (even an empty string) is supplied alongside it. A real S3 DELETE truly has no body, so match
      // that here rather than passing "" (which real fetch() never does for a real 204 response).
      return new Response(existed ? null : "not found", { status: existed ? 204 : 404 });
    }
    return new Response("method not stubbed", { status: 500 });
  }
  return new Response("not found", { status: 404 });
};
`;
}

function runDispatch(args, { presetStore } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-s3-test-"));
  const logPath = join(dir, "calls.log");
  const storePath = join(dir, "store.json");
  writeFileSync(logPath, "");
  writeFileSync(storePath, JSON.stringify(presetStore || {}));
  const preload = join(dir, "preload.mjs");
  writeFileSync(preload, preloadSource(logPath, storePath));
  const env = {
    PATH: process.env.PATH,
    AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000",
    AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
  };
  return execFileP(process.execPath, ["--import", preload, DISPATCH_MJS, ...args], { env, timeout: 15000 })
    .then((r) => ({ status: 0, stdout: r.stdout, stderr: r.stderr, calls: readCalls(logPath), store: JSON.parse(readFileSync(storePath, "utf8")) }))
    .catch((e) => ({ status: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || "", calls: readCalls(logPath), store: JSON.parse(readFileSync(storePath, "utf8")) }));
}
function readCalls(logPath) { return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }

test("send writes the inbox to S3 (otchealth-brain-dr-55c84f6b) at _DISPATCH/<to>.jsonl, with ZERO Azure calls", async () => {
  const r = await runDispatch(["send", "porttest-s3", "hello from the port test", "--from", "cto"]);
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  assert.deepEqual(r.calls.filter((c) => AZURE_HOST_RE.test(c.url)), [], "must never reach an Azure Blob host");
  const putCall = r.calls.find((c) => isHost(c.url, S3_HOST) && c.method === "PUT");
  assert.ok(putCall, "no S3 PUT was captured");
  assert.equal(pathOf(putCall.url), "/" + S3_KEY_PREFIX + "_DISPATCH/porttest-s3.jsonl");
  const rows = r.store["/" + S3_KEY_PREFIX + "_DISPATCH/porttest-s3.jsonl"].trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "hello from the port test");
  assert.equal(rows[0].from, "cto");
});

test("check surfaces a preseeded inbox message and ACKs by deleting the blob (not merely emptying it)", async () => {
  const presetStore = { ["/" + S3_KEY_PREFIX + "_DISPATCH/porttest-s3.jsonl"]: JSON.stringify({ id: "x", ts: new Date().toISOString(), from: "cto", to: "porttest-s3", text: "surface me" }) + "\n" };
  const r = await runDispatch(["check", "--agent", "porttest-s3"], { presetStore });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /surface me/);
  assert.deepEqual(r.calls.filter((c) => AZURE_HOST_RE.test(c.url)), [], "must never reach an Azure Blob host");
  const delCall = r.calls.find((c) => isHost(c.url, S3_HOST) && c.method === "DELETE");
  assert.ok(delCall, "check must ACK by deleting the inbox blob");
  assert.equal(r.store["/" + S3_KEY_PREFIX + "_DISPATCH/porttest-s3.jsonl"], undefined, "the blob must actually be gone after ACK");
});

test("list enumerates every non-empty inbox under _DISPATCH/ via the S3 listing", async () => {
  const presetStore = {
    ["/" + S3_KEY_PREFIX + "_DISPATCH/agent-a.jsonl"]: JSON.stringify({ id: "1", from: "cto", to: "agent-a", text: "task A" }) + "\n",
    ["/" + S3_KEY_PREFIX + "_DISPATCH/agent-b.jsonl"]: JSON.stringify({ id: "1", from: "cto", to: "agent-b", text: "task B" }) + "\n",
  };
  const r = await runDispatch(["list"], { presetStore });
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  assert.match(r.stdout, /agent-a/);
  assert.match(r.stdout, /agent-b/);
  assert.deepEqual(r.calls.filter((c) => AZURE_HOST_RE.test(c.url)), [], "must never reach an Azure Blob host");
});

// ---- counterfactual guard: no Azure Blob code remains in the ported file --------------------------
test("dispatch.mjs no longer talks to Azure Blob directly (ported to S3 via commons-store, 2026-08-27)", async () => {
  const src = readFileSync(DISPATCH_MJS, "utf8");
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.doesNotMatch(stripped, /blob\.core\.windows\.net/, "must not construct any Azure Blob URL");
  assert.doesNotMatch(stripped, /azure-commons-storage-(account|key)/, "must not read the old Azure Blob storage creds");
  assert.doesNotMatch(stripped, /buildSas|commonsInit|saJwt\(\)/, "the old hand-rolled Azure SAS primitives must be gone");
  assert.match(src, /from "\.\.\/kb-memory\/commons-store\.mjs"/, "must route storage through the shared commons-store facade");
});

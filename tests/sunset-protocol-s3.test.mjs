// Tests for skills/sunset-protocol/protocol.mjs's S3 port (2026-08-27, off dead Azure Blob).
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
const PROTOCOL_MJS = join(HERE, "..", "skills", "sunset-protocol", "protocol.mjs");

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
    return new Response("method not stubbed", { status: 500 });
  }
  return new Response("not found", { status: 404 });
};
`;
}

function runProtocol(args, { presetStore, envExtra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sunset-s3-test-"));
  const logPath = join(dir, "calls.log");
  const storePath = join(dir, "store.json");
  writeFileSync(logPath, "");
  writeFileSync(storePath, JSON.stringify(presetStore || {}));
  const preload = join(dir, "preload.mjs");
  writeFileSync(preload, preloadSource(logPath, storePath));
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000",
    AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
    ...envExtra,
  };
  return execFileP(process.execPath, ["--import", preload, PROTOCOL_MJS, ...args], { env, timeout: 20000 })
    .then((r) => ({ status: 0, stdout: r.stdout, stderr: r.stderr, calls: readCalls(logPath), store: JSON.parse(readFileSync(storePath, "utf8")) }))
    .catch((e) => ({ status: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || "", calls: readCalls(logPath), store: JSON.parse(readFileSync(storePath, "utf8")) }));
}
function readCalls(logPath) { return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }

test("sunset writes the handoff doc to S3 at _HANDOFF/<agent>.md, with ZERO Azure calls", async () => {
  const r = await runProtocol(["sunset", "--agent", "porttest-s3"]);
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  assert.deepEqual(r.calls.filter((c) => AZURE_HOST_RE.test(c.url)), [], "must never reach an Azure Blob host");
  const putCall = r.calls.find((c) => isHost(c.url, S3_HOST) && c.method === "PUT" && pathOf(c.url).includes("_HANDOFF/"));
  assert.ok(putCall, "no S3 PUT to _HANDOFF/ was captured");
  assert.equal(pathOf(putCall.url), "/" + S3_KEY_PREFIX + "_HANDOFF/porttest-s3.md");
  const doc = r.store["/" + S3_KEY_PREFIX + "_HANDOFF/porttest-s3.md"];
  assert.match(doc, /SUNRISE HANDOFF - PORTTEST-S3/);
});

test("last3 reads the ledger from the SAME S3 location mem.mjs writes to (_MEMORY/<agent>.jsonl), not a dead Azure account", async () => {
  const rows = [
    { id: "1", ts: "2026-08-20T00:00:00Z", type: "decision", text: "Decided to port the S3 cluster." },
    { id: "2", ts: "2026-08-21T00:00:00Z", type: "status", text: "Working on heartbeat.mjs next." },
  ];
  const presetStore = { ["/" + S3_KEY_PREFIX + "_MEMORY/porttest-s3.jsonl"]: rows.map((r) => JSON.stringify(r)).join("\n") + "\n" };
  const r = await runProtocol(["last3", "--agent", "porttest-s3", "--json"], { presetStore });
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  const l3 = JSON.parse(r.stdout);
  assert.equal(l3.length, 2);
  assert.match(l3[0].title, /Working on heartbeat/);
  assert.deepEqual(r.calls.filter((c) => AZURE_HOST_RE.test(c.url)), [], "must never reach an Azure Blob host");
});

test("a SENSITIVE-role handoff (cfo/clo/capital) written via the S3 path still embeds NO ledger text (ring safety survives the storage swap)", async () => {
  const rows = [{ id: "1", ts: "2026-08-20T00:00:00Z", type: "decision", text: "SECRET MNPI CONTENT THAT MUST NEVER LEAK" }];
  const presetStore = { ["/" + S3_KEY_PREFIX + "_MEMORY/cfo.jsonl"]: rows.map((r) => JSON.stringify(r)).join("\n") + "\n" };
  const r = await runProtocol(["sunset", "--agent", "cfo"], { presetStore });
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  const doc = r.store["/" + S3_KEY_PREFIX + "_HANDOFF/cfo.md"];
  assert.ok(doc, "the cfo handoff must have been written");
  assert.doesNotMatch(doc, /SECRET MNPI CONTENT/, "sensitive ledger text must never land in the commons-shared handoff doc");
  assert.match(doc, /RING-PROTECTED/);
});

// ---- counterfactual guard: no Azure Blob code remains in the ported file --------------------------
test("protocol.mjs no longer talks to Azure Blob directly (ported to S3 via commons-store, 2026-08-27)", async () => {
  const src = readFileSync(PROTOCOL_MJS, "utf8");
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.doesNotMatch(stripped, /blob\.core\.windows\.net/, "must not construct any Azure Blob URL");
  assert.doesNotMatch(stripped, /azure-commons-storage-(account|key)/, "must not read the old Azure Blob storage creds");
  assert.doesNotMatch(stripped, /buildSas|commonsInit|fetchRetry|saJwt\(\)/, "the old hand-rolled Azure SAS primitives must be gone");
  assert.match(src, /from "\.\.\/kb-memory\/commons-store\.mjs"/, "must route storage through the shared commons-store facade");
});

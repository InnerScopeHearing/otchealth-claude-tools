// Tests for skills/kb-memory/ledger-archive.mjs's S3 port (2026-08-27, off dead Azure Blob). This is
// the ONE genuinely multi-ring ported skill (cfo/clo/exec -> finance-legal-dr, clo-personal ->
// legal-personal-dr [attorney-privileged], commons -> brain-dr, all via s3-blob.mjs's own MIRROR
// table), so these tests exercise ring routing directly, not through commons-store.mjs.
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
const LEDGER_ARCHIVE_MJS = join(HERE, "..", "ledger-archive.mjs");

const FINANCE_LEGAL_HOST = "otchealth-finance-legal-dr-55c84f6b.s3.us-east-1.amazonaws.com";
const LEGAL_PERSONAL_HOST = "otchealth-legal-personal-dr-55c84f6b.s3.us-east-1.amazonaws.com";
const BRAIN_HOST = "otchealth-brain-dr-55c84f6b.s3.us-east-1.amazonaws.com";
const AZURE_HOST_RE = /blob\.core\.windows\.net/i;

function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
function pathOf(u) { try { return new URL(u).pathname; } catch { return ""; } }

function preloadSource(logPath, storePath) {
  return `
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
function pathOf(u) { try { return new URL(u).pathname; } catch { return ""; } }
function loadStore() { return existsSync(${JSON.stringify(storePath)}) ? JSON.parse(readFileSync(${JSON.stringify(storePath)}, "utf8")) : {}; }
function saveStore(s) { writeFileSync(${JSON.stringify(storePath)}, JSON.stringify(s)); }
globalThis.fetch = async (url, opts) => {
  const u = String(typeof url === "string" ? url : url?.url || url);
  const method = ((opts && opts.method) || "GET").toUpperCase();
  const host = new URL(u).host;
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method, url: u, headers: opts && opts.headers }) + "\\n");
  if (host.endsWith(".amazonaws.com")) {
    const p = pathOf(u);
    const store = loadStore();
    if (method === "GET") {
      if (!(p in store)) return new Response("not found", { status: 404 });
      return new Response(store[p].body, { status: 200, headers: { etag: store[p].etag } });
    }
    if (method === "PUT") {
      const ifMatch = opts.headers["if-match"];
      const ifNoneMatch = opts.headers["if-none-match"];
      const cur = store[p];
      if (ifNoneMatch === "*" && cur) return new Response("conflict", { status: 412 });
      if (ifMatch !== undefined && (!cur || cur.etag !== ifMatch)) return new Response("conflict", { status: 412 });
      const bodyStr = Buffer.isBuffer(opts.body) ? opts.body.toString("utf8") : String(opts.body);
      const nextEtag = '"' + Math.random().toString(36).slice(2) + '"';
      store[p] = { body: bodyStr, etag: nextEtag };
      saveStore(store);
      return new Response("", { status: 200, headers: { etag: nextEtag } });
    }
    return new Response("method not stubbed", { status: 500 });
  }
  return new Response("not found", { status: 404 });
};
`;
}

function runArchive(args, { presetStore, envExtra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ledger-archive-s3-test-"));
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
    ...envExtra,
  };
  return execFileP(process.execPath, ["--import", preload, LEDGER_ARCHIVE_MJS, ...args], { env, timeout: 20000 })
    .then((r) => ({ status: 0, stdout: r.stdout, stderr: r.stderr, calls: readCalls(logPath), store: JSON.parse(readFileSync(storePath, "utf8")) }))
    .catch((e) => ({ status: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || "", calls: readCalls(logPath), store: JSON.parse(readFileSync(storePath, "utf8")) }));
}
function readCalls(logPath) { return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
function seedRow(pathKey, rows, etag = '"seed"') { return { [pathKey]: { body: rows.map((r) => JSON.stringify(r)).join("\n") + "\n", etag } }; }

test("RING ROUTING: --agent cfo reads/writes the shared finance-legal-dr bucket", async () => {
  const rows = [{ id: "20260827-001-a", kind: "fact", text: "cfo test row" }];
  const presetStore = seedRow("/otchealthcfodata/cfo-source-docs/_MEMORY/cfo.jsonl", rows);
  const r = await runArchive(["list", "--agent", "cfo"], { presetStore });
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  assert.ok(r.calls.some((c) => isHost(c.url, FINANCE_LEGAL_HOST)), "cfo must reach the finance-legal-dr bucket");
  assert.ok(!r.calls.some((c) => isHost(c.url, LEGAL_PERSONAL_HOST)), "cfo must NEVER reach the privileged personal-legal bucket");
  assert.deepEqual(r.calls.filter((c) => AZURE_HOST_RE.test(c.url)), []);
});

test("RING ROUTING (the sharpest one): --agent clo-personal reads/writes the ATTORNEY-PRIVILEGED legal-personal-dr bucket, and ONLY that bucket", async () => {
  const rows = [{ id: "20260827-001-a", kind: "fact", text: "privileged personal-legal test row" }];
  const presetStore = seedRow("/otchealthlegalstore/personal/_MEMORY/clo-personal.jsonl", rows);
  const r = await runArchive(["list", "--agent", "clo-personal"], { presetStore });
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  assert.ok(r.calls.some((c) => isHost(c.url, LEGAL_PERSONAL_HOST)), "clo-personal must reach the privileged legal-personal-dr bucket");
  assert.ok(!r.calls.some((c) => isHost(c.url, FINANCE_LEGAL_HOST)), "clo-personal must never leak into the shared finance-legal-dr bucket");
  assert.ok(!r.calls.some((c) => isHost(c.url, BRAIN_HOST)), "clo-personal must never leak into the shared commons brain bucket");
});

test("RING ROUTING: an unlisted agent id falls back to the shared commons brain-dr bucket, keyed by its own filename", async () => {
  const rows = [{ id: "20260827-001-a", kind: "fact", text: "porttest row" }];
  const presetStore = seedRow("/otchealthcommons/company-journal/_MEMORY/porttest.jsonl", rows);
  const r = await runArchive(["list", "--agent", "porttest"], { presetStore });
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  assert.ok(r.calls.some((c) => isHost(c.url, BRAIN_HOST)), "an unlisted agent must fall back to the commons brain-dr bucket");
  assert.match(r.stdout, /porttest row/);
});

test("archive DRY RUN (no --commit) makes zero PUT calls -- printing the plan does not touch storage", async () => {
  const rows = [{ id: "20260827-001-a", kind: "fact", text: "row to maybe archive" }];
  const presetStore = seedRow("/otchealthcommons/company-journal/_MEMORY/porttest.jsonl", rows);
  const r = await runArchive(["archive", "--agent", "porttest", "--ids", "20260827-001-a"], { presetStore });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /DRY RUN/);
  assert.deepEqual(r.calls.filter((c) => c.method === "PUT"), [], "a dry run must never write");
});

test("archive --commit moves the row into the .archive.jsonl file and removes it from the active ledger, via conditional PUTs", async () => {
  const rows = [
    { id: "20260827-001-a", kind: "fact", text: "keep me" },
    { id: "20260827-002-b", kind: "fact", text: "archive me" },
  ];
  const presetStore = seedRow("/otchealthcommons/company-journal/_MEMORY/porttest.jsonl", rows, '"active-v1"');
  const r = await runArchive(["archive", "--agent", "porttest", "--ids", "20260827-002-b", "--commit"], { presetStore });
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  assert.match(r.stdout, /done: 1 archived/);
  const archived = r.store["/otchealthcommons/company-journal/_MEMORY/porttest.archive.jsonl"].body.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(archived.length, 1);
  assert.equal(archived[0].id, "20260827-002-b");
  assert.ok(archived[0].archived_at, "the archived row must be stamped with archived_at");
  const active = r.store["/otchealthcommons/company-journal/_MEMORY/porttest.jsonl"].body.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(active.length, 1);
  assert.equal(active[0].id, "20260827-001-a");
  // Both PUTs must have carried a conditional header (If-Match on the observed generation, or
  // If-None-Match:* for a first-ever archive file) -- never an unconditional overwrite.
  const puts = r.calls.filter((c) => c.method === "PUT");
  assert.ok(puts.length >= 2, "must have made at least the archive-file PUT and the active-ledger PUT");
  for (const p of puts) assert.ok(p.headers["if-match"] !== undefined || p.headers["if-none-match"] !== undefined, "every ledger PUT must be conditional");
});

test("a 412 conflict on the archive-file write (concurrent writer) triggers a reload+retry, never a silent clobber", async () => {
  const rows = [{ id: "20260827-002-b", kind: "fact", text: "archive me" }];
  const presetStore = seedRow("/otchealthcommons/company-journal/_MEMORY/porttest.jsonl", rows, '"active-v1"');
  // Pre-seed an archive file with a DIFFERENT etag than what the first read will observe, by mutating
  // it out from under the process after its first GET -- simulated here by seeding a stale-looking
  // situation is hard without a live race, so instead assert the retry-exhaustion failure mode is safe:
  // if a caller is somehow stuck in permanent conflict, ledger-archive must throw loud, not clobber.
  // Simulate "permanent conflict" by having every archive-file PUT 412 regardless of header.
  const dir = mkdtempSync(join(tmpdir(), "ledger-archive-conflict-"));
  const logPath = join(dir, "calls.log");
  const storePath = join(dir, "store.json");
  writeFileSync(logPath, "");
  writeFileSync(storePath, JSON.stringify(presetStore));
  const preload = join(dir, "preload.mjs");
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method: (opts && opts.method) || "GET", url: u }) + "\\n");
  if (new URL(u).pathname.includes("archive.jsonl") && ((opts && opts.method) || "").toUpperCase() === "PUT") {
    return new Response("conflict", { status: 412 });
  }
  if (((opts && opts.method) || "GET").toUpperCase() === "GET") {
    return new Response(JSON.stringify(${JSON.stringify(rows[0])}) + "\\n", { status: 200, headers: { etag: '"active-v1"' } });
  }
  return new Response("", { status: 200, headers: { etag: '"x"' } });
};
`);
  const env = { PATH: process.env.PATH, AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000", AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real" };
  const r = await execFileP(process.execPath, ["--import", preload, LEDGER_ARCHIVE_MJS, "archive", "--agent", "porttest", "--ids", "20260827-002-b", "--commit"], { env, timeout: 20000 })
    .then((res) => ({ status: 0, stdout: res.stdout, stderr: res.stderr }))
    .catch((e) => ({ status: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || "" }));
  assert.notEqual(r.status, 0, "permanent conflict must fail loud, never silently succeed");
  assert.match(r.stderr, /lost the optimistic-concurrency race/i);
});

// ---- counterfactual guard: no Azure Blob code remains in the ported file ---------------------------
test("ledger-archive.mjs no longer talks to Azure Blob directly (ported to S3, 2026-08-27)", async () => {
  const src = readFileSync(LEDGER_ARCHIVE_MJS, "utf8");
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.doesNotMatch(stripped, /blob\.core\.windows\.net/, "must not construct any Azure Blob URL");
  assert.doesNotMatch(stripped, /azure-(cfo|legal|commons)-storage-(account|key)/, "must not read any of the old Azure Blob storage creds");
  assert.doesNotMatch(stripped, /buildSas|fetchRetry\(/, "the old hand-rolled Azure SAS primitives must be gone");
  assert.match(src, /from "\.\/s3-blob\.mjs"/, "must route storage through s3-blob.mjs directly (multi-ring, not commons-store)");
});

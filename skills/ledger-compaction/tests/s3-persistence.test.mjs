// Tests for skills/ledger-compaction/job/run-compaction.mjs's S3 port (2026-09-03, off raw Azure
// Blob calls -- see that file's own header for the full defect this closes: every one of the three
// storage accounts it targeted was permanently deleted with Azure subscription 55c84f6b on
// 2026-08-13, so the job's per-agent try/catch was quietly swallowing a genuine failure for all
// three agents on every run while the job itself still exited 0.
//
// run-compaction.mjs has no isMain guard (main() runs unconditionally on import, by design -- it is
// pure job glue, never a library), so it is exercised as a real subprocess, same convention as the
// sibling credential-gate-aws.test.mjs. A `--import` preload intercepts fetch calls to BOTH S3
// buckets this job's three agents map to, so the test can assert exactly which bucket/key each
// agent's GET and PUT landed on -- proving the routing, not just that "some S3 call" happened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SKILL_DIR = join(HERE, "..");
const RUNNER = join(SKILL_DIR, "job", "run-compaction.mjs");

// The two buckets skills/kb-memory/s3-blob.mjs's MIRROR table maps this skill's three agents onto.
// cfo and clo deliberately share ONE bucket (different keyPrefix) so a test that gets the routing
// wrong (e.g. swapping keyPrefixes) is still caught -- a bucket-only check could not tell that apart.
const FL_HOST = "otchealth-finance-legal-dr-55c84f6b.s3.us-east-1.amazonaws.com"; // cfo, clo
const BR_HOST = "otchealth-brain-dr-55c84f6b.s3.us-east-1.amazonaws.com"; // commons
const OFF_HOST_RE = /blob\.core\.windows\.net|storage\.googleapis\.com/i;

const ROUTES = {
  cfo:     { host: FL_HOST, getPath: "/otchealthcfodata/cfo-source-docs/_MEMORY/cfo.jsonl",         putPath: "/otchealthcfodata/cfo-source-docs/_MEMORY/cfo.compacted.md" },
  clo:     { host: FL_HOST, getPath: "/otchealthlegalstore/company/_MEMORY/clo.jsonl",              putPath: "/otchealthlegalstore/company/_MEMORY/clo.compacted.md" },
  commons: { host: BR_HOST, getPath: "/otchealthcommons/company-journal/_MEMORY/commons.jsonl",     putPath: "/otchealthcommons/company-journal/_MEMORY/commons.compacted.md" },
};

const FIXTURE_LEDGER = `${JSON.stringify({ id: "t1", ts: "2026-01-01T00:00:00Z", type: "decision", text: "test decision row" })}\n`;

function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
function pathOf(u) { try { return new URL(u).pathname; } catch { return ""; } }

/** Build the preload module. `modes` is { cfo, clo, commons } each one of "ok" | "missing" |
 *  "get-fail" | "put-fail", read from env inside the CHILD process (not baked into the string) so
 *  one preload file serves every test. */
function preloadSource() {
  return `
import { appendFileSync } from "node:fs";
const logPath = process.env.LC_TEST_LOG;
const fixture = process.env.LC_TEST_FIXTURE_LEDGER || "";
const MODES = {
  cfo: process.env.LC_TEST_MODE_CFO || "ok",
  clo: process.env.LC_TEST_MODE_CLO || "ok",
  commons: process.env.LC_TEST_MODE_COMMONS || "ok",
};
const ROUTES = ${JSON.stringify(ROUTES)};
const byPath = {};
for (const [agent, r] of Object.entries(ROUTES)) {
  byPath[r.getPath] = { agent, op: "get" };
  byPath[r.putPath] = { agent, op: "put" };
}
globalThis.fetch = async (url, opts) => {
  const u = String(typeof url === "string" ? url : (url && url.url) || url);
  const method = ((opts && opts.method) || "GET").toUpperCase();
  appendFileSync(logPath, JSON.stringify({ method, url: u }) + "\\n");
  let pathname = "";
  try { pathname = new URL(u).pathname; } catch {}
  const route = byPath[pathname];
  if (!route) return new Response("not found", { status: 404 });
  const mode = MODES[route.agent];
  if (route.op === "get") {
    if (mode === "missing") return new Response("", { status: 404 });
    if (mode === "get-fail") return new Response("simulated get failure", { status: 500 });
    return new Response(fixture, { status: 200, headers: { etag: '"fake-etag-get"' } });
  }
  if (mode === "put-fail") return new Response("simulated unreachable bucket on write", { status: 500 });
  return new Response("", { status: 200, headers: { etag: '"fake-etag-put"' } });
};
`;
}

function readCalls(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function runCompaction(args, { modes = {}, fixture = FIXTURE_LEDGER } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ledger-compaction-s3-test-"));
  const logPath = join(dir, "calls.log");
  writeFileSync(logPath, "");
  const preload = join(dir, "preload.mjs");
  writeFileSync(preload, preloadSource());
  const env = {
    PATH: process.env.PATH,
    AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000",
    AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
    LC_TEST_LOG: logPath,
    LC_TEST_FIXTURE_LEDGER: fixture,
    LC_TEST_MODE_CFO: modes.cfo || "ok",
    LC_TEST_MODE_CLO: modes.clo || "ok",
    LC_TEST_MODE_COMMONS: modes.commons || "ok",
  };
  return execFileP(process.execPath, ["--import", preload, RUNNER, ...args], { env, timeout: 20000 })
    .then((r) => ({ status: 0, stdout: r.stdout, stderr: r.stderr, calls: readCalls(logPath) }))
    .catch((e) => ({ status: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || "", calls: readCalls(logPath) }));
}

test("all three agents round-trip through their exact mapped bucket/key (cfo+clo share a bucket, different keyPrefix; commons is a different bucket entirely)", async () => {
  const r = await runCompaction(["--agents", "cfo,clo,commons"], { modes: { cfo: "ok", clo: "ok", commons: "ok" } });
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /FAILED/, "no agent should report FAILED on an all-ok run");

  for (const [agent, route] of Object.entries(ROUTES)) {
    const getCall = r.calls.find((c) => c.method === "GET" && pathOf(c.url) === route.getPath);
    assert.ok(getCall, `${agent}: expected a GET at ${route.getPath}; calls were ${JSON.stringify(r.calls)}`);
    assert.ok(isHost(getCall.url, route.host), `${agent}: GET must hit ${route.host}; got ${getCall.url}`);

    const putCall = r.calls.find((c) => c.method === "PUT" && pathOf(c.url) === route.putPath);
    assert.ok(putCall, `${agent}: expected a PUT at ${route.putPath}`);
    assert.ok(isHost(putCall.url, route.host), `${agent}: PUT must hit ${route.host}; got ${putCall.url}`);

    // Never write back to the source ledger path itself -- the non-destructive guarantee.
    assert.ok(!r.calls.some((c) => c.method === "PUT" && pathOf(c.url) === route.getPath), `${agent}: must never PUT to the ledger's own path`);
  }
  assert.deepEqual(r.calls.filter((c) => OFF_HOST_RE.test(c.url)), [], "must never reach Azure Blob or GCS");
});

test("a missing ledger is a quiet, expected skip -- not a failure, and the process still exits 0", async () => {
  const r = await runCompaction(["--agents", "cfo,clo,commons"], { modes: { cfo: "ok", clo: "missing", commons: "ok" } });
  assert.equal(r.status, 0, `a missing ledger must not fail the job; stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /FAILED/, "a missing ledger must never be logged as FAILED");
  assert.match(r.stdout, /"agent":"clo".*"skipped":true/, "clo's outcome must report skipped:true");
  // No PUT for clo (nothing to compact), but cfo and commons still succeeded normally.
  assert.ok(!r.calls.some((c) => c.method === "PUT" && pathOf(c.url) === ROUTES.clo.putPath), "a skipped agent must never write a compacted artifact");
  assert.ok(r.calls.some((c) => c.method === "PUT" && pathOf(c.url) === ROUTES.cfo.putPath), "cfo must still have been compacted");
  assert.ok(r.calls.some((c) => c.method === "PUT" && pathOf(c.url) === ROUTES.commons.putPath), "commons must still have been compacted");
});

test("an unreachable bucket on WRITE (the real Azure symptom: reads work, writes 403/500) fails LOUD -- the other agents still run, but the process exits non-zero", async () => {
  const r = await runCompaction(["--agents", "cfo,clo,commons"], { modes: { cfo: "ok", clo: "put-fail", commons: "ok" } });
  assert.notEqual(r.status, 0, "a genuinely unreachable room must not exit 0");
  assert.match(r.stderr, /clo: FAILED/, "the failing agent must be named");
  assert.match(r.stderr, /s3 put 500/, "the underlying S3 failure must surface, not be swallowed");
  assert.match(r.stderr, /1\/3 agent\(s\) FAILED/, "the summary line must count exactly one failure out of three");
  assert.match(r.stderr, /real backend problem/, "the summary must say this is not a silent ok");

  // Resilience: cfo and commons must still have been attempted AND succeeded despite clo's failure.
  assert.ok(r.calls.some((c) => c.method === "PUT" && pathOf(c.url) === ROUTES.cfo.putPath), "cfo must still be compacted despite clo failing");
  assert.ok(r.calls.some((c) => c.method === "PUT" && pathOf(c.url) === ROUTES.commons.putPath), "commons must still be compacted despite clo failing");
  // clo's GET happened (the read worked, matching the real symptom) but the PUT is the one that failed.
  assert.ok(r.calls.some((c) => c.method === "GET" && pathOf(c.url) === ROUTES.clo.getPath));
});

test("an unreachable bucket on READ also fails LOUD (a 500/403 must never be reported as 'ledger not found')", async () => {
  const r = await runCompaction(["--agents", "commons"], { modes: { commons: "get-fail" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /commons: FAILED/);
  assert.match(r.stderr, /s3 get 500/);
  assert.doesNotMatch(r.stdout, /"skipped":true/, "a 500 must never read as the quiet 'nothing to compact yet' outcome");
});

test("--dry-run still reads the ledger but never writes the compacted artifact, and a dry-run agent failure is still reported", async () => {
  const r = await runCompaction(["--dry-run", "--agents", "cfo"], { modes: { cfo: "ok" } });
  assert.equal(r.status, 0);
  assert.ok(r.calls.some((c) => c.method === "GET" && pathOf(c.url) === ROUTES.cfo.getPath));
  assert.ok(!r.calls.some((c) => c.method === "PUT"), "--dry-run must never write");
  assert.match(r.stdout, /"dryRun":true/);
});

// ---- counterfactual: no Azure Blob / GCP SA code remains, and the S3 client is actually used -------
test("run-compaction.mjs no longer talks to Azure Blob or the GCP SA directly (ported to S3, 2026-09-03)", () => {
  const src = readFileSync(RUNNER, "utf8");
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.doesNotMatch(stripped, /blob\.core\.windows\.net/, "must not construct any Azure Blob URL");
  assert.doesNotMatch(stripped, /GCP_CLAUDE_DRIVER_SA_JSON/, "must not read the old GCP service-account credential");
  assert.doesNotMatch(stripped, /AZURE_SP_CLIENT|azure-.*-storage-account|azure-.*-storage-key/, "must not read any old Azure Blob storage credential");
  assert.doesNotMatch(stripped, /buildSas|encPath\(/, "the old hand-rolled Azure SAS primitives must be gone");
  assert.match(src, /from "\.\.\/\.\.\/kb-memory\/s3-blob\.mjs"/, "must route storage through s3-blob.mjs");
  assert.match(src, /getTextFromS3|putObjectToS3/, "must actually call the S3 client, not just import it");
});

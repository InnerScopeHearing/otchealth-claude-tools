// Tests for notion-export.mjs's RING=OPERATIONAL S3 port (FND-20260827-bcfc, 2026-08-28) and the
// fail-loud gate on RING=MNPI-INND / RING=PERSONAL-PRIVILEGED (pending FND-20260827-e7c7).
//
// Mirrors the fetch-stub + subprocess convention already used by tests/heartbeat-s3.test.mjs:
// notion-export.mjs is a CLI script (top-level code, calls process.exit()/throws to a top-level
// .catch()), so these run it as a real subprocess with `--import` preloading a fake `fetch` before
// the script's own top-level code runs. Never a real network call.
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
const NOTION_EXPORT_MJS = join(HERE, "..", "notion-export.mjs");

// otchealthcommons/company-journal's real MIRROR row (skills/kb-memory/s3-blob.mjs) -- copied here,
// not re-derived, so this test fails loudly if that mapping ever changes underneath it.
const S3_BUCKET = "otchealth-brain-dr-55c84f6b";
const S3_KEY_PREFIX = "otchealthcommons/company-journal/";
const S3_HOST = `${S3_BUCKET}.s3.us-east-1.amazonaws.com`;
const NOTION_HOST = "api.notion.com";
const AZURE_HOST_RE = /blob\.core\.windows\.net|management\.azure\.com|login\.microsoftonline\.com|vault\.azure\.net/i;

const PAGE_ID = "12345678-90ab-cdef-1234-567890abcdef"; // 32 hex chars once dashes are stripped
const PAGE_ID_HEX = PAGE_ID.replace(/-/g, "");

function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
function pathOf(u) { try { return new URL(u).pathname; } catch { return ""; } }

/** Preload module: a stateful fake `fetch` covering (a) the S3 host (an in-memory object store keyed
 *  by pathname, same shape as tests/heartbeat-s3.test.mjs) and (b) the Notion API host (a fixed,
 *  benign single-page response with no children, so blocksMd terminates in one call). Every call is
 *  logged so assertions can inspect both WHICH host was hit and WHAT was sent. `s3PutStatus` lets one
 *  test inject a real upload failure to prove the fail-loud path without touching notion-export.mjs. */
function preloadSource(logPath, storePath, { s3PutStatus = 200 } = {}) {
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

  if (isHost(u, ${JSON.stringify(NOTION_HOST)})) {
    const p = pathOf(u);
    if (method === "GET" && p === "/v1/pages/${PAGE_ID}") {
      return new Response(JSON.stringify({ last_edited_time: "2026-01-01T00:00:00.000Z" }), { status: 200 });
    }
    if (method === "GET" && p === "/v1/blocks/${PAGE_ID}/children") {
      return new Response(JSON.stringify({ results: [], has_more: false }), { status: 200 });
    }
    return new Response("notion route not stubbed: " + method + " " + p, { status: 500 });
  }

  if (isHost(u, ${JSON.stringify(S3_HOST)})) {
    const p = pathOf(u);
    const store = loadStore();
    if (method === "GET") {
      if (u.includes("list-type=2")) {
        const qs = new URL(u).searchParams;
        const prefix = qs.get("prefix") || "";
        const keys = Object.keys(store).filter(k => k.startsWith("/" + prefix));
        const contents = keys.map(k => \`<Contents><Key>\${k.slice(1)}</Key><Size>\${store[k].length}</Size><LastModified>2026-08-28T00:00:00.000Z</LastModified></Contents>\`).join("");
        return new Response(\`<ListBucketResult>\${contents}<IsTruncated>false</IsTruncated></ListBucketResult>\`, { status: 200 });
      }
      if (!(p in store)) return new Response("not found", { status: 404 });
      return new Response(store[p], { status: 200, headers: { etag: '"fake-etag"' } });
    }
    if (method === "PUT") {
      if (${JSON.stringify(s3PutStatus)} !== 200) {
        return new Response("injected S3 failure for test", { status: ${JSON.stringify(s3PutStatus)} });
      }
      const bodyStr = Buffer.isBuffer(opts.body) ? opts.body.toString("utf8") : String(opts.body);
      store[p] = bodyStr;
      saveStore(store);
      return new Response("", { status: 200, headers: { etag: '"fake-etag"' } });
    }
    return new Response("method not stubbed", { status: 500 });
  }

  return new Response("host not stubbed: " + u, { status: 500 });
};
`;
}

function writeManifest(dir, rows) {
  const p = join(dir, "manifest.json");
  writeFileSync(p, JSON.stringify(rows));
  return p;
}

function runNotionExport(args, { presetStore, s3PutStatus, dir: dirIn } = {}) {
  const dir = dirIn || mkdtempSync(join(tmpdir(), "notion-export-s3-test-"));
  const logPath = join(dir, "calls.log");
  const storePath = join(dir, "store.json");
  writeFileSync(logPath, "");
  writeFileSync(storePath, JSON.stringify(presetStore || {}));
  const preload = join(dir, "preload.mjs");
  writeFileSync(preload, preloadSource(logPath, storePath, { s3PutStatus }));
  const env = {
    PATH: process.env.PATH,
    AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000",
    AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
  };
  return execFileP(process.execPath, ["--import", preload, NOTION_EXPORT_MJS, ...args], { env, timeout: 15000 })
    .then((r) => ({ status: 0, stdout: r.stdout, stderr: r.stderr, calls: readCalls(logPath) }))
    .catch((e) => ({ status: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || "", calls: readCalls(logPath) }));
}
function readCalls(logPath) { return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }

// ---- OPERATIONAL ring: happy path writes through commons-store (S3), never Azure -------------------
test("RING=OPERATIONAL exports a page via S3 (commons-store), at the real key prefix, with ZERO Azure calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notion-export-s3-test-"));
  const keyfile = join(dir, "notion.key");
  writeFileSync(keyfile, "fake-notion-key");
  const manifest = writeManifest(dir, [{ id: PAGE_ID, type: "page", title: "Test Page", ring: "OPERATIONAL" }]);
  const r = await runNotionExport(["OPERATIONAL", "--manifest", manifest, "--key", keyfile], { dir });
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  assert.deepEqual(r.calls.filter((c) => AZURE_HOST_RE.test(c.url)), [], "must never reach an Azure Blob host");
  const putCalls = r.calls.filter((c) => isHost(c.url, S3_HOST) && c.method === "PUT");
  assert.equal(putCalls.length, 1, "expected exactly one S3 PUT (one page, one .md object)");
  assert.equal(pathOf(putCalls[0].url), `/${S3_KEY_PREFIX}_NOTION/operational/page-${PAGE_ID_HEX}-test-page.md`);
  const store = JSON.parse(readFileSync(join(dir, "store.json"), "utf8"));
  const body = store[`/${S3_KEY_PREFIX}_NOTION/operational/page-${PAGE_ID_HEX}-test-page.md`];
  assert.ok(body && body.includes("Test Page"), "the uploaded body must contain the page title");
  assert.match(r.stdout, /DONE ring=OPERATIONAL: 1 pages, 0 dbs.*errors 0/);
});

// ---- FAIL LOUD (OPERATIONAL): an S3 write failure must surface distinctly and non-zero -------------
test("RING=OPERATIONAL: an S3 PUT failure exits non-zero and reports FATAL, never a silent 'DONE' success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notion-export-s3-test-"));
  const keyfile = join(dir, "notion.key");
  writeFileSync(keyfile, "fake-notion-key");
  const manifest = writeManifest(dir, [{ id: PAGE_ID, type: "page", title: "Test Page", ring: "OPERATIONAL" }]);
  const r = await runNotionExport(["OPERATIONAL", "--manifest", manifest, "--key", keyfile], { dir, s3PutStatus: 500 });
  assert.notEqual(r.status, 0, "a real upload failure must exit non-zero -- this is the exact silent-success bug the fix closes");
  assert.match(r.stderr, /FATAL/);
  assert.match(r.stderr, /1 item\(s\) failed to export/);
  // The old bug: the process would still print "DONE ... errors 1" as its LAST line and exit 0. Prove
  // the DONE line is still printed (so an operator still sees the count) but the run is no longer
  // reported as an overall success via the exit code.
  assert.match(r.stdout, /DONE ring=OPERATIONAL:.*errors 1/);
});

// ---- FAIL LOUD (legal rings): pending the e7c7 S3 port, never a silent Azure write or no-op --------
for (const ring of ["MNPI-INND", "PERSONAL-PRIVILEGED"]) {
  test(`RING=${ring} refuses immediately (pending FND-20260827-e7c7), with ZERO network calls of any kind`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "notion-export-s3-test-"));
    // Deliberately point --manifest at a file that does not exist: the gate must fire before the
    // manifest is ever read, so this proves the refusal happens first, not merely "eventually".
    const manifest = join(dir, "does-not-exist.json");
    const r = await runNotionExport([ring, "--manifest", manifest, "--key", "/does/not/exist"], { dir });
    assert.notEqual(r.status, 0, "a pending-dependency ring must exit non-zero, never succeed");
    assert.equal(r.status, 3, "expected the dedicated 'not runnable yet' exit code");
    assert.match(r.stderr, /FND-20260827-e7c7/);
    assert.match(r.stderr, /not runnable/);
    assert.deepEqual(r.calls, [], "must make ZERO network calls (no Azure, no S3, no Notion) -- fail loud before any I/O, not a silent no-op deep into a run");
  });
}

// ---- counterfactual guard: the OPERATIONAL path really goes through commons-store.mjs, and the
// fail-loud gate + errs-check are not silently reverted by a future edit --------------------------
test("notion-export.mjs routes RING=OPERATIONAL through commons-store.mjs, and keeps its fail-loud gates", async () => {
  const src = readFileSync(NOTION_EXPORT_MJS, "utf8");
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.match(src, /from "\.\.\/kb-memory\/commons-store\.mjs"/, "must import the shared commons-store S3 facade");
  assert.match(stripped, /\bcPut\(/, "the upload path must call cPut (S3), not only reference it");
  assert.match(stripped, /\bcList\(/, "the resume-listing path must call cList (S3), not only reference it");
  // The legal-ring gate: selecting a non-s3-backed ring must refuse before doing anything else.
  assert.match(stripped, /D\.backend\s*!==\s*"s3"/, "the pending-legal-ring fail-loud gate must still exist");
  assert.match(src, /FND-20260827-e7c7/, "the gate must still name the tracking finding for the pending legal-store S3 port");
  // The overall-failure gate: errs>0 must still cause a thrown (non-zero-exit) failure.
  assert.match(stripped, /errs\s*>\s*0/, "the fail-loud errs>0 check must still exist");
});

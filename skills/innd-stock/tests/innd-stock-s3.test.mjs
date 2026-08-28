// Tests for skills/innd-stock/innd-stock.mjs's S3 port (2026-08-27, off dead GCS + Azure Blob).
//
// This script has no isMain guard and no exported pure helpers (its top-level code runs the CLI
// directly on import), so every test here runs it as a real subprocess. The `xlsx` package is
// lazily npm-installed by the skill itself on first run (skills/innd-stock/node_modules, gitignored);
// these tests assume that install has already happened at least once in this environment (it has,
// verified via a real `node innd-stock.mjs status` run against the live S3 mirror) -- if node_modules
// is absent, the first affected test will trigger the same lazy install the skill always does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const execFileP = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SKILL_DIR = join(HERE, "..");
const INND_STOCK_MJS = join(SKILL_DIR, "innd-stock.mjs");
const require = createRequire(import.meta.url);

const S3_BUCKET = "otchealth-finance-legal-dr-55c84f6b";
const S3_KEY_PREFIX = "otchealthcfodata/innd-stock/";
const S3_HOST = `${S3_BUCKET}.s3.us-east-1.amazonaws.com`;
const OFF_HOST_RE = /blob\.core\.windows\.net|storage\.googleapis\.com/i;

function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
function pathOf(u) { try { return new URL(u).pathname; } catch { return ""; } }

/** Build a minimal, REAL, valid .xlsx buffer (via the actual xlsx lib the skill itself lazy-installs)
 *  matching the "INND Daily" sheet shape sheetToRows() expects, so the GET stub below serves something
 *  XLSX.read() can genuinely parse -- not a synthetic/fake binary shape. */
function buildFixtureWorkbookBuffer() {
  const XLSX = require(join(SKILL_DIR, "node_modules", "xlsx"));
  const headers = ["Date", "Open", "High", "Low", "Close", "Split-Adj Close", "Volume", "VWAP", "Trades", "Daily Change ($)", "Daily Change (%)", "Dollar Volume (Close x Vol)", "Traded Value ($) (Vol x VWAP)", "Day Range (H-L)", "Press Release / Corporate Event", "Source"];
  const row = ["2026-08-01", 0.001, 0.0012, 0.0009, 0.001, 0.001, 1000000, 0.001, 12, "", "", 1000, 1000, 0.0003, "", "Massive (Polygon): as-traded, true VWAP + trade count, OTC consolidated"];
  const ws = XLSX.utils.aoa_to_sheet([headers, row]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "INND Daily");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function preloadSource(logPath, xlsxBase64OrNull) {
  return `
import { appendFileSync } from "node:fs";
function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
function pathOf(u) { try { return new URL(u).pathname; } catch { return ""; } }
globalThis.fetch = async (url, opts) => {
  const u = String(typeof url === "string" ? url : url?.url || url);
  const method = ((opts && opts.method) || "GET").toUpperCase();
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method, url: u }) + "\\n");
  if (isHost(u, ${JSON.stringify(S3_HOST)})) {
    const p = pathOf(u);
    if (p !== ${JSON.stringify("/" + S3_KEY_PREFIX + "INND-daily-stock-history.xlsx")}) {
      return new Response("not found", { status: 404 });
    }
    ${xlsxBase64OrNull
      ? `return new Response(Buffer.from(${JSON.stringify(xlsxBase64OrNull)}, "base64"), { status: 200 });`
      : `return new Response("", { status: 404 });`}
  }
  // Any other host (Yahoo, Massive, a stray secret lookup) degrades harmlessly -- these tests only
  // exercise the storage-read side (status), which never reaches a market-data source.
  return new Response("not found", { status: 404 });
};
`;
}

function runInndStock(args, { xlsxBase64OrNull = null, envExtra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "innd-stock-s3-test-"));
  const logPath = join(dir, "calls.log");
  writeFileSync(logPath, "");
  const preload = join(dir, "preload.mjs");
  writeFileSync(preload, preloadSource(logPath, xlsxBase64OrNull));
  const env = {
    PATH: process.env.PATH,
    AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000",
    AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
    ...envExtra,
  };
  return execFileP(process.execPath, ["--import", preload, INND_STOCK_MJS, ...args], { env, timeout: 20000 })
    .then((r) => ({ status: 0, stdout: r.stdout, stderr: r.stderr, calls: readCalls(logPath) }))
    .catch((e) => ({ status: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || "", calls: readCalls(logPath) }));
}
function readCalls(logPath) { return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }

test("STORAGE_BACKEND guard: a stale non-s3 value (e.g. the old azure default) fails LOUD before any network call, never silently ignored", async () => {
  const r = await runInndStock(["status"], { envExtra: { STORAGE_BACKEND: "azure" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /STORAGE_BACKEND=azure is no longer supported/);
  assert.deepEqual(r.calls, [], "must fail before making any network call at all");
});

test("STORAGE_BACKEND=gcs also fails loud (both dead backends are rejected identically, not just azure)", async () => {
  const r = await runInndStock(["status"], { envExtra: { STORAGE_BACKEND: "gcs" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /STORAGE_BACKEND=gcs is no longer supported/);
});

test("status with no stored workbook reports 'no workbook stored yet', reading a genuine S3 404 correctly (not a crash)", async () => {
  const r = await runInndStock(["status"], { xlsxBase64OrNull: null });
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  assert.match(r.stdout, /no workbook stored yet/);
  assert.deepEqual(r.calls.filter((c) => OFF_HOST_RE.test(c.url)), [], "must never reach GCS or Azure");
  const getCall = r.calls.find((c) => isHost(c.url, S3_HOST));
  assert.ok(getCall, "must have made a real S3 GET attempt");
});

test("status with a real stored workbook reads it back correctly via getBufferFromS3 (binary-safe) and reports the exact row/date range", async () => {
  const buf = buildFixtureWorkbookBuffer();
  const r = await runInndStock(["status"], { xlsxBase64OrNull: buf.toString("base64") });
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  assert.match(r.stdout, /stored workbook: 1 trading days, 2026-08-01\.\.2026-08-01/);
  assert.match(r.stdout, /s3:\/\/otchealthcfodata\/innd-stock\/INND-daily-stock-history\.xlsx/);
  assert.deepEqual(r.calls.filter((c) => OFF_HOST_RE.test(c.url)), [], "must never reach GCS or Azure");
});

// ---- counterfactual guard: no GCS or Azure Blob code remains in the ported file --------------------
test("innd-stock.mjs no longer talks to GCS or Azure Blob directly (ported to a single S3 backend, 2026-08-27)", () => {
  const src = readFileSync(INND_STOCK_MJS, "utf8");
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.doesNotMatch(stripped, /blob\.core\.windows\.net/, "must not construct any Azure Blob URL");
  assert.doesNotMatch(stripped, /storage\.googleapis\.com/, "must not construct any GCS URL");
  assert.doesNotMatch(stripped, /GCP_CLAUDE_DRIVER_SA_JSON/, "must not read the old GCP service-account credential");
  assert.doesNotMatch(stripped, /AZURE_STORAGE_(ACCOUNT|KEY|CONTAINER)/, "must not read the old Azure Blob storage creds");
  assert.doesNotMatch(stripped, /gcsToken|gcsDownload|gcsUpload|azureUpload|azureDownload|azSig\(/, "the old hand-rolled GCS/Azure primitives must be gone");
  assert.match(src, /from "\.\.\/kb-memory\/s3-blob\.mjs"/, "must route storage through s3-blob.mjs");
});

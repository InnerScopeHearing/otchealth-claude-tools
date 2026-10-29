// Tests for skills/innd-stock/innd-stock.mjs's S3 port (2026-08-27, off dead GCS + Azure Blob).
//
// This script has no isMain guard and no exported pure helpers (its top-level code runs the CLI
// directly on import), so every test here runs it as a real subprocess. The `xlsx` package is
// lazily npm-installed by the skill itself on first run (skills/innd-stock/node_modules, gitignored).
//
// THAT LAZY INSTALL USED TO RUN INSIDE A TIMED SUBPROCESS, which made this suite pass or fail on the
// state of a gitignored directory (2026-09-02). An earlier version of this header simply recorded the
// assumption -- "these tests assume that install has already happened at least once in this
// environment" -- which is not something a test may assume. On a warm checkout all five passed; on a
// cold one the install consumed the 20-second subprocess budget and tests 3 and 4 failed at
// `duration_ms: 20007` with `expected a clean exit; stderr: installing xlsx ...`, which reads as an
// S3 or exit-code bug and was filed as one (FND-20260902-2cc5, "innd-stock S3 failure"). Nothing was
// wrong with S3. The `before` hook below does the install once, outside any timeout, so the suite
// behaves identically cold or warm. Production was never affected: the doc-indexer image bakes xlsx
// with an explicit RUN npm install, so the lazy path never fires there.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

// Warm the skill's lazily-installed dependency BEFORE any timed subprocess runs. Idempotent and a
// no-op on a warm checkout; the generous timeout covers a cold npm install on a slow network.
before(
  () => {
    if (existsSync(join(SKILL_DIR, "node_modules", "xlsx"))) return;
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: SKILL_DIR, stdio: "ignore" });
  },
  { timeout: 300000 },
);

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

function buildHistoricalMassiveWorkbookBuffer() {
  const XLSX = require(join(SKILL_DIR, "node_modules", "xlsx"));
  const headers = ["Date", "Open", "High", "Low", "Close", "Split-Adj Close", "Volume", "VWAP", "Trades", "Daily Change ($)", "Daily Change (%)", "Dollar Volume (Close x Vol)", "Traded Value ($) (Vol x VWAP)", "Day Range (H-L)", "Press Release / Corporate Event", "Source"];
  const row = ["2024-08-01", 0.0002, 0.00024, 0.00018, 0.00021, 0.00021, 123456, 0.000205, 31, "", "", 25.92576, 25.30848, 0.00006, "Historical source row", "Massive (Polygon): as-traded, true VWAP + trade count, OTC consolidated"];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, row]), "INND Daily");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function updatePreloadSource(logPath, objectsPath, initialWorkbookBase64) {
  return `
import { appendFileSync, writeFileSync } from "node:fs";
const RealDate = Date;
const fixedNow = RealDate.parse("2026-10-29T16:00:00Z"); // noon in New York, before the completed-session cutoff
globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [fixedNow])); } static now() { return fixedNow; } };
const objects = new Map([["/otchealthcfodata/innd-stock/INND-daily-stock-history.xlsx", Buffer.from(${JSON.stringify(initialWorkbookBase64)}, "base64")]]);
const dateTs = date => Math.floor(RealDate.parse(date + "T00:00:00Z") / 1000);
const yahoo = { chart: { result: [{
  timestamp: [dateTs("2026-10-28"), dateTs("2026-10-29")],
  indicators: { quote: [{ open: [0.00019, 0.0002], high: [0.00022, 0.00023], low: [0.00018, 0.00019], close: [0.0002, 0.00022], volume: [100000, 50000] }] }
}] } };
const massive = { results: [{ t: dateTs("2026-10-27") * 1000, o: 0.0002, h: 0.00022, l: 0.00018, c: 0.00021, v: 90000, vw: 0.000205, n: 17 }] };
globalThis.fetch = async (url, opts = {}) => {
  const u = String(typeof url === "string" ? url : url?.url || url);
  const method = ((opts && opts.method) || "GET").toUpperCase();
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method, url: u }) + "\\n");
  const parsed = new URL(u);
  if (parsed.host === ${JSON.stringify(S3_HOST)}) {
    const key = parsed.pathname;
    if (method === "PUT") { objects.set(key, Buffer.from(opts.body)); return new Response("", { status: 200 }); }
    const bytes = objects.get(key);
    return bytes ? new Response(bytes, { status: 200 }) : new Response("not found", { status: 404 });
  }
  if (parsed.host === "query1.finance.yahoo.com") return new Response(JSON.stringify(yahoo), { status: 200, headers: { "content-type": "application/json" } });
  if (parsed.host === "api.massive.com") return new Response(JSON.stringify(massive), { status: 200, headers: { "content-type": "application/json" } });
  return new Response("unexpected host", { status: 500 });
};
process.on("exit", () => writeFileSync(${JSON.stringify(objectsPath)}, JSON.stringify([...objects.entries()].map(([k, v]) => [k, v.toString("base64")]))));
`;
}

function runUpdateWithPublication() {
  const dir = mkdtempSync(join(tmpdir(), "innd-stock-update-test-"));
  const logPath = join(dir, "calls.log");
  const objectsPath = join(dir, "objects.json");
  const preload = join(dir, "preload.mjs");
  writeFileSync(logPath, "");
  writeFileSync(preload, updatePreloadSource(logPath, objectsPath, buildHistoricalMassiveWorkbookBuffer().toString("base64")));
  const env = {
    PATH: process.env.PATH,
    AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000",
    AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
    MASSIVE_API_KEY: "unit-test-massive-key",
  };
  return execFileP(process.execPath, ["--import", preload, INND_STOCK_MJS, "update"], { env, timeout: 20000 })
    .then(r => ({ status: 0, stdout: r.stdout, stderr: r.stderr, calls: readCalls(logPath), objects: JSON.parse(readFileSync(objectsPath, "utf8")) }))
    .catch(e => ({ status: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || "", calls: readCalls(logPath), objects: existsSync(objectsPath) ? JSON.parse(readFileSync(objectsPath, "utf8")) : [] }));
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
function parseCsv(csv) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  return rows;
}

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

test("update publishes identical workbook bytes and a 16-column blank-preserving CSV, retaining deep Massive data and excluding the partial Yahoo session", async () => {
  const r = await runUpdateWithPublication();
  assert.equal(r.status, 0, `expected clean update; stdout: ${r.stdout}; stderr: ${r.stderr}`);
  const objects = new Map(r.objects.map(([key, value]) => [key, Buffer.from(value, "base64")]));
  const canonicalKey = "/otchealthcfodata/innd-stock/INND-daily-stock-history.xlsx";
  const readerKey = "/otchealthcfodata/cfo-source-docs/innd-stock/INND-daily-stock-history.xlsx";
  const textKey = "/otchealthcfodata/cfo-source-docs/_TEXT/innd-stock/INND-daily-stock-history.xlsx.txt";
  const canonical = objects.get(canonicalKey);
  assert.ok(canonical, "update must write the canonical workbook");
  assert.ok(objects.has(readerKey), "update must publish the workbook to the CFO reader path");
  assert.deepEqual(objects.get(readerKey), canonical, "CFO reader workbook must preserve the identical XLSX bytes");
  assert.ok(objects.has(textKey), "update must write the text sidecar at the mirrored _TEXT path");
  const csv = parseCsv(objects.get(textKey).toString("utf8"));
  assert.equal(csv[0].length, 16, "CSV header must have all 16 daily-sheet columns");
  const headers = csv[0];
  const dateCol = headers.indexOf("Date"), tradesCol = headers.indexOf("Trades"), sourceCol = headers.indexOf("Source"), vwapCol = headers.indexOf("VWAP");
  const rows = new Map(csv.slice(1).map(row => [row[dateCol], row]));
  assert.equal(rows.get("2024-08-01")?.[sourceCol].startsWith("Massive"), true, "deep historical Massive source tag must survive update");
  assert.equal(rows.get("2024-08-01")?.[vwapCol], "0.000205", "deep historical Massive VWAP must survive update");
  assert.equal(rows.get("2024-08-01")?.[tradesCol], "31", "deep historical Massive trade count must survive update");
  assert.equal(rows.get("2026-10-28")?.[tradesCol], "", "Yahoo-only trades cell stays blank in CSV");
  assert.ok(rows.has("2026-10-27"), `completed Massive daily row must be included; stderr: ${r.stderr}; output dates: ${[...rows.keys()].slice(-8).join(",")}`);
  assert.ok(!rows.has("2026-10-29"), "partial current Yahoo daily bar before 16:00 New York must be excluded");
  assert.ok(r.calls.filter(c => c.method === "PUT").length >= 3, "update must put canonical, CFO workbook, and CSV targets");
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

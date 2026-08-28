// Tests for skills/fleet-medic/medic.mjs's S3 port + credentials-gate fix (2026-08-27).
//
// THE GATE FIX THIS FILE EXISTS TO PIN: the pre-port gate (`!_saRaw && !process.env.AZURE_SP_CLIENT_ID`)
// was TRUE on every AWS-only seat (ECS task role, no GCP SA, no Azure SP env) -- exactly the
// environment fleet-medic actually runs in on the fleet's Container Apps/ECS jobs -- so `scan` exited
// 0 without ever scanning, silently, on every single run. This is the exact "component that produces
// nothing produces no error" bug class fleet-medic itself exists to detect in OTHER agents.
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
const MEDIC_MJS = join(HERE, "..", "skills", "fleet-medic", "medic.mjs");

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
  // Anything else (readHealth's execFileSync shells out to a REAL node process that is NOT this
  // preloaded process, so it never sees this stub at all -- mem.mjs's own network calls, if any,
  // are unaffected and unexercised by this file) degrades harmlessly.
  return new Response("not found", { status: 404 });
};
`;
}

function runMedic(args, { presetStore, envExtra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "medic-s3-test-"));
  const logPath = join(dir, "calls.log");
  const storePath = join(dir, "store.json");
  writeFileSync(logPath, "");
  writeFileSync(storePath, JSON.stringify(presetStore || {}));
  const preload = join(dir, "preload.mjs");
  writeFileSync(preload, preloadSource(logPath, storePath));
  const env = {
    PATH: process.env.PATH,
    HOME: dir, // no real ~/.claude/skills/kb-memory/mem.mjs candidate path resolves under this HOME
    ...envExtra,
  };
  return execFileP(process.execPath, ["--import", preload, MEDIC_MJS, ...args], { env, timeout: 20000 })
    .then((r) => ({ status: 0, stdout: r.stdout, stderr: r.stderr, calls: readCalls(logPath), store: JSON.parse(readFileSync(storePath, "utf8")) }))
    .catch((e) => ({ status: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || "", calls: readCalls(logPath), store: JSON.parse(readFileSync(storePath, "utf8")) }));
}
function readCalls(logPath) { return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }

const FAKE_AWS = { AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000", AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real" };

test("THE GATE FIX: scan with ONLY OTC_AWS_* creds (no GCP SA, no AZURE_SP_*) actually scans instead of silently exiting 0 at the creds gate", async () => {
  const r = await runMedic(["scan", "--json"], {
    envExtra: { OTC_AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0001", OTC_AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real-2", GCP_CLAUDE_DRIVER_SA_JSON: "" },
  });
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  // The old bug printed exactly this message and produced NO --json output at all (process.exit(0)
  // before the classify()/console.log(JSON...) ever ran). Proving --json output parses as the real
  // scan result shape is the strongest possible proof the gate did not fire.
  assert.doesNotMatch(r.stderr, /no credentials \(neither Azure SP nor GCP SA\)/, "the OLD gate message must never fire again for an AWS-only seat");
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.results), "a real scan must have run and produced classify() results");
});

test("scan with genuinely ZERO credentials anywhere still fails open (exit 0, clear message), not a crash", async () => {
  const r = await runMedic(["scan", "--json"], { envExtra: { GCP_CLAUDE_DRIVER_SA_JSON: "" } });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /no AWS credentials/i, "must name the missing credential clearly");
  assert.equal(r.stdout.trim(), "", "must not print a fake/empty scan result when it never ran");
});

test("scan --dispatch writes a directive to S3 (otchealth-brain-dr-55c84f6b) at _MEDIC/<agent>.md for a NO-MEMORY agent, with ZERO Azure calls", async () => {
  const r = await runMedic(["scan", "--dispatch"], FAKE_AWS ? { envExtra: FAKE_AWS } : {});
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  assert.deepEqual(r.calls.filter((c) => AZURE_HOST_RE.test(c.url)), [], "must never reach an Azure Blob host");
  const putCalls = r.calls.filter((c) => isHost(c.url, S3_HOST) && c.method === "PUT");
  assert.ok(putCalls.length > 0, "at least one directive/state PUT must have gone out for an EXEC roster with no health data");
  const statePut = r.store["/" + S3_KEY_PREFIX + "_MEDIC/_state.json"];
  assert.ok(statePut, "the medic state file must have been written to the exact expected S3 key");
});

test("check surfaces a preseeded directive and ACKs by deleting it", async () => {
  const presetStore = { ["/" + S3_KEY_PREFIX + "_MEDIC/porttest.md"]: "# MEDIC DIRECTIVE for PORTTEST\nrestore your memory\n" };
  const r = await runMedic(["check", "--agent", "porttest"], { presetStore, envExtra: FAKE_AWS });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /restore your memory/);
  assert.deepEqual(r.calls.filter((c) => AZURE_HOST_RE.test(c.url)), [], "must never reach an Azure Blob host");
  assert.equal(r.store["/" + S3_KEY_PREFIX + "_MEDIC/porttest.md"], undefined, "the directive must actually be deleted after ACK (surface once)");
});

test("clear deletes an agent's directive via the S3 store", async () => {
  const presetStore = { ["/" + S3_KEY_PREFIX + "_MEDIC/porttest.md"]: "stale directive\n" };
  const r = await runMedic(["clear", "--agent", "porttest"], { presetStore, envExtra: FAKE_AWS });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /cleared medic directive for porttest/);
  assert.equal(r.store["/" + S3_KEY_PREFIX + "_MEDIC/porttest.md"], undefined);
});

// ---- counterfactual guard: no Azure Blob / GCP-JWT code remains in the ported file -----------------
test("medic.mjs no longer talks to Azure Blob directly or builds a GCP service-account JWT (ported to S3, 2026-08-27)", async () => {
  const src = readFileSync(MEDIC_MJS, "utf8");
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.doesNotMatch(stripped, /blob\.core\.windows\.net/, "must not construct any Azure Blob URL");
  assert.doesNotMatch(stripped, /azure-commons-storage-(account|key)/, "must not read the old Azure Blob storage creds");
  assert.doesNotMatch(stripped, /buildSas|commonsInit|resolveSa\(\)|saJwt\(\)/, "the old hand-rolled Azure SAS + GCP JWT primitives must be gone");
  assert.doesNotMatch(stripped, /secretmanager\.googleapis\.com/, "the dead GCP Secret Manager fallback leg must be gone");
  assert.doesNotMatch(stripped, /!_saRaw && !process\.env\.AZURE_SP_CLIENT_ID/, "the old always-true-on-AWS-only-seats creds gate must be gone");
  assert.match(src, /awsCredsPresent\(\)\.any/, "the creds gate must check for the credential the S3 store actually needs");
  assert.match(src, /from "\.\.\/kb-memory\/commons-store\.mjs"/, "must route storage through the shared commons-store facade");
});

// Tests for drift.mjs's OpenSearch/OpenAI backend port (2026-08-28) — the same class of fix as
// skills/kb-memory/tests/semantic-opensearch-dispatch.test.mjs and
// skills/kb-memory/tests/index-one-dispatch.test.mjs (SEARCH_BACKEND=opensearch /
// EMBEDDINGS_PROVIDER=openai are now the defaults; Azure AI Search + Azure OpenAI died with
// subscription 55c84f6b). Before this fix, drift.mjs's initClients() threw unconditionally on missing
// azure-search-endpoint/-admin-key regardless of what the caller wanted, leaving the whole recall-drift
// monitor dark (FND-20260819-c9bb).
//
// TWO layers, matching this repo's established convention for a hard-to-mock CLI script:
//   1. IN-PROCESS dispatch tests (dynamic import + a global fetch stub) — drift.mjs's own isMain guard
//      means importing it never triggers main()/process.exit(), so initClients/embed/searchIndex are
//      directly exercisable exactly like semantic.mjs's exported init().
//   2. A subprocess integration test using the `--import` global-fetch-stub preload technique (proven
//      by skills/kb-memory/tests/index-one-dispatch.test.mjs), which proves the REAL CLI end to end,
//      including the fail-loud exit-code contract this port also adds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(HERE, "..", "drift.mjs");
const OS_HOST = "unit-test-cluster.us-east-1.es.amazonaws.com";

const AZURE_HOST_RE = /\.(search\.windows\.net|openai\.azure\.com|cognitiveservices\.azure\.com|vault\.azure\.net)/i;

/** Exact host comparison, not a substring test on the whole URL — a URL that merely MENTIONS a host in
 *  a path or query would satisfy a naive .includes() check, and this file exists to prove WHICH host
 *  was reached. Same fix already applied fleet-wide (semantic-opensearch-dispatch.test.mjs,
 *  index-one-dispatch.test.mjs, push-search-opensearch.test.mjs — CodeQL js/incomplete-url-substring-
 *  sanitization). */
function isHost(u, host) {
  try { return new URL(u).host === host; } catch { return false; }
}

// =========================================================================================
// Layer 1: in-process dispatch tests (dynamic import + global fetch stub, no subprocess)
// =========================================================================================

function installFetchStub() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(typeof url === "string" ? url : url?.url || url);
    calls.push(u);
    if (AZURE_HOST_RE.test(u)) {
      throw new Error(`TEST-FAIL: fetch reached an Azure host with SEARCH_BACKEND=opensearch + EMBEDDINGS_PROVIDER=openai: ${u}`);
    }
    if (isHost(u, "api.openai.com") && u.includes("/v1/embeddings")) {
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(3072).fill(0.001) }] }), { status: 200 });
    }
    if (isHost(u, OS_HOST)) {
      // drift.mjs's searchIndex() only ever calls osSearch (POST /<index>/_search) via hybridSearch —
      // never _mapping or _bulk (it is read-only). One canned hit is enough to exercise RRF fusion
      // (hybridSearch issues bm25 + knn queries against this same stub) and give probeIndex a
      // non-trivial topScore/coverage to compute.
      return new Response(JSON.stringify({ hits: { hits: [{ _id: "cto__unit-test-1", _source: { agent: "cto", type: "pitfall", ts: "2026-08-16T00:00:00.000Z", text: "reconnect accounting via xero", tags: "xero" } }] } }), { status: 200 });
    }
    throw new Error(`TEST-FAIL: unexpected fetch during the dispatch test: ${u}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function setOpenSearchEnv() {
  process.env.SEARCH_BACKEND = "opensearch";
  process.env.EMBEDDINGS_PROVIDER = "openai";
  process.env.OPENSEARCH_ENDPOINT = OS_HOST;
  process.env.OPENSEARCH_REGION = "us-east-1";
  process.env.AWS_ACCESS_KEY_ID = "AKIAUNITTESTFAKE0000";
  process.env.AWS_SECRET_ACCESS_KEY = "unit-test-fake-secret-access-key-not-real";
  process.env.OPENAI_API_KEY = "sk-unit-test-fake-not-real";
}

test("SEARCH_BACKEND=opensearch + EMBEDDINGS_PROVIDER=openai: initClients() succeeds with ZERO Azure fetch calls (before this fix it threw 'missing azure-search-endpoint/admin-key' unconditionally)", async () => {
  setOpenSearchEnv();
  const { calls, restore } = installFetchStub();
  try {
    const { initClients } = await import("../drift.mjs");
    await assert.doesNotReject(() => initClients(), "initClients() must not throw once SEARCH_BACKEND=opensearch is honored");
  } finally {
    restore();
  }
  assert.deepEqual(calls.filter((u) => AZURE_HOST_RE.test(u)), [], "initClients() must not call any Azure endpoint under the fully Azure-free configuration");
});

test("embed(text) dispatches to OpenAI-direct and returns a single flat 3072-dim vector (not an array-of-vectors)", async () => {
  setOpenSearchEnv();
  const { calls, restore } = installFetchStub();
  let vec;
  try {
    const { embed } = await import("../drift.mjs");
    vec = await embed("how do we reconnect accounting after a token expiry");
  } finally {
    restore();
  }
  assert.ok(Array.isArray(vec), "embed() must return a flat vector, matching probeIndex()'s embedFn(q) contract");
  assert.equal(vec.length, 3072, "must be the pinned text-embedding-3-large dimension, matching the live index");
  assert.ok(calls.some((u) => isHost(u, "api.openai.com") && u.includes("/v1/embeddings")));
  assert.deepEqual(calls.filter((u) => AZURE_HOST_RE.test(u)), []);
});

test("searchIndex() dispatches to OpenSearch hybridSearch and returns hits shaped with '@search.score' (the exact contract probeIndex() reads)", async () => {
  setOpenSearchEnv();
  const { calls, restore } = installFetchStub();
  let hits;
  try {
    const { searchIndex } = await import("../drift.mjs");
    hits = await searchIndex("memory-exec", "compute allocator routing decisions", new Array(3072).fill(0.002));
  } finally {
    restore();
  }
  assert.ok(Array.isArray(hits) && hits.length > 0, "the canned OpenSearch stub hit must come back");
  assert.ok(Number.isFinite(hits[0]["@search.score"]), "hits must carry a numeric @search.score, the exact field probeIndex() reads");
  assert.ok(calls.some((u) => isHost(u, OS_HOST)));
  assert.deepEqual(calls.filter((u) => AZURE_HOST_RE.test(u)), []);
});

test("a full probeIndex-shaped cycle (embed -> searchIndex, exactly as main() wires them) completes with ZERO Azure calls and produces a sane report", async () => {
  setOpenSearchEnv();
  const { calls, restore } = installFetchStub();
  let report;
  try {
    const drift = await import("../drift.mjs");
    report = await drift.probeIndex("memory-exec", ["how do we reconnect accounting after a token expiry", "critic pass findings on a draft PR"], { embed: drift.embed, search: drift.searchIndex });
  } finally {
    restore();
  }
  assert.equal(report.probes.length, 2);
  assert.ok(report.probes.every((p) => p.ok), `every probe must succeed against the stub, got: ${JSON.stringify(report.probes)}`);
  assert.equal(report.coverage, 1, "the canned stub returns a hit for every probe");
  assert.ok(report.topScore > 0);
  assert.deepEqual(calls.filter((u) => AZURE_HOST_RE.test(u)), []);
});

test("source-level regression lock: the azure/foundry branches are still present and reachable — the port made them conditional, it did not delete them", async () => {
  const src = await readFile(new URL("../drift.mjs", import.meta.url), "utf8");
  assert.match(src, /throw new Error\("missing azure-search-endpoint\/admin-key"\)/, "the azure search-config guard must still exist for the non-default backend");
  assert.match(src, /throw new Error\("missing azure-openai endpoint\/key"\)/, "the azure embeddings-config guard must still exist for the non-default provider");
  assert.match(src, /SEARCH_BACKEND === "opensearch"/, "initClients()/searchIndex() must actually branch on SEARCH_BACKEND, not just carry a dead opensearch import");
  assert.match(src, /EMBEDDINGS_PROVIDER === "openai"/, "initClients()/embed() must actually branch on EMBEDDINGS_PROVIDER");
  assert.match(src, /const SEARCH_BACKEND = \(process\.env\.SEARCH_BACKEND \|\| "opensearch"\)/, "SEARCH_BACKEND must default to opensearch, not azure");
  assert.match(src, /const EMBEDDINGS_PROVIDER = \(process\.env\.EMBEDDINGS_PROVIDER \|\| "openai"\)/, "EMBEDDINGS_PROVIDER must default to openai, not foundry");
});

// =========================================================================================
// Layer 2: subprocess integration tests (--import fetch-stub preload; proves the real CLI)
// =========================================================================================

/** A preload module that replaces globalThis.fetch BEFORE drift.mjs's own top-level code runs (module-
 *  load-time consts only — no network at import time — but this also has to survive main() actually
 *  executing, unlike the Layer-1 tests above), records every URL to a file, and answers only the
 *  OpenSearch/OpenAI calls this configuration legitimately makes. Mirrors index-one-dispatch.test.mjs's
 *  proven preloadSource() exactly. */
function preloadSource(logPath) {
  return `
import { appendFileSync } from "node:fs";
function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
globalThis.fetch = async (url) => {
  const u = String(typeof url === "string" ? url : url?.url || url);
  appendFileSync(${JSON.stringify(logPath)}, u + "\\n");
  if (isHost(u, "api.openai.com") && u.includes("/v1/embeddings")) {
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(3072).fill(0.001) }] }), { status: 200 });
  }
  if (isHost(u, ${JSON.stringify(OS_HOST)})) {
    return new Response(JSON.stringify({ hits: { hits: [{ _id: "cto__unit-test-1", _source: { agent: "cto", type: "pitfall", ts: "2026-08-16T00:00:00.000Z", text: "reconnect accounting via xero", tags: "xero" } }] } }), { status: 200 });
  }
  // Anything else (a stray secret lookup via SSM/Key Vault) degrades harmlessly to "not found" rather
  // than reaching a real host, so hermeticity never depends on this sandbox's ambient credentials.
  return new Response("not found", { status: 404 });
};
`;
}

async function runDrift(args, envOverride = {}) {
  const dir = mkdtempSync(join(tmpdir(), "drift-dispatch-test-"));
  const logPath = join(dir, "calls.log");
  writeFileSync(logPath, "");
  const preload = join(dir, "preload.mjs");
  writeFileSync(preload, preloadSource(logPath));
  let status = 0, stdout = "", stderr = "";
  try {
    const r = await execFileP(process.execPath, ["--import", preload, SCRIPT, ...args], {
      env: {
        ...process.env,
        SEARCH_BACKEND: "opensearch",
        EMBEDDINGS_PROVIDER: "openai",
        OPENSEARCH_ENDPOINT: OS_HOST,
        OPENSEARCH_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000",
        AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
        OPENAI_API_KEY: "sk-unit-test-fake-not-real",
        ...envOverride,
      },
      timeout: 30000,
    });
    stdout = r.stdout; stderr = r.stderr;
  } catch (e) {
    // execFile rejects on a non-zero exit code; the rejection still carries status/stdout/stderr.
    status = e.code ?? 1; stdout = e.stdout ?? ""; stderr = e.stderr ?? "";
  }
  const { readFileSync } = await import("node:fs");
  const calls = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  return { status, stdout, stderr, calls };
}

test("CLI end-to-end: a fully-configured run probes memory-exec, exits 0, and reaches ZERO Azure hosts", async () => {
  const r = await runDrift(["--index", "memory-exec"]);
  assert.equal(r.status, 0, `a healthy run must exit 0; stderr was: ${r.stderr}`);
  assert.deepEqual(r.calls.filter((u) => AZURE_HOST_RE.test(u)), [], "must never reach an Azure host under the fully Azure-free configuration");
  assert.ok(r.calls.some((u) => isHost(u, "api.openai.com")), "must have embedded via OpenAI-direct");
  assert.ok(r.calls.some((u) => isHost(u, OS_HOST)), "must have searched the OpenSearch cluster");
  assert.match(r.stdout, /SUMMARY: 1 index\(es\) probed/);
});

test("CLI end-to-end FAIL LOUD: an unresolvable OpenSearch backend exits NON-ZERO with a distinct FATAL message, never a silent 'ran clean' 0", async () => {
  // No AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY, no ECS task role, no Azure Key Vault fallback (the preload's
  // catch-all 404 blocks kvSecret's fetch-based tiers regardless of this sandbox's ambient credentials;
  // GCP_CLAUDE_DRIVER_SA_JSON="" blocks the SP-JWT path so kvSecret's own sm() helper can't mint a token
  // either) -- resolveOpenSearchConfig() has nothing left to resolve credentials from.
  const r = await runDrift(["--index", "memory-exec"], {
    AWS_ACCESS_KEY_ID: "",
    AWS_SECRET_ACCESS_KEY: "",
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "",
    AWS_CONTAINER_CREDENTIALS_FULL_URI: "",
    GCP_CLAUDE_DRIVER_SA_JSON: "",
  });
  assert.notEqual(r.status, 0, "an unresolvable backend must not exit 0 — that would silently report a clean 'no drift' run that never actually ran");
  assert.equal(r.status, 2, `expected the loud-failure exit code 2; stderr was: ${r.stderr}`);
  assert.match(r.stderr, /FATAL \(could not run/, "must print a message distinct from the per-index 'ERROR' line used for an individual probe hiccup");
  assert.match(r.stderr, /no AWS credentials resolvable/, "must name exactly what is missing, not a generic failure");
  assert.doesNotMatch(r.stdout, /SUMMARY:/, "must never print a report summary line when it never actually probed anything");
  assert.deepEqual(r.calls.filter((u) => AZURE_HOST_RE.test(u)), [], "a failed opensearch-backend run must never silently fall through to Azure");
});

test("CLI end-to-end FAIL LOUD: an unresolvable OpenAI embeddings key exits NON-ZERO with a distinct FATAL message", async () => {
  const r = await runDrift(["--index", "memory-exec"], { OPENAI_API_KEY: "", GCP_CLAUDE_DRIVER_SA_JSON: "" });
  assert.notEqual(r.status, 0, "an unresolvable embeddings provider must not exit 0");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /FATAL \(could not run/);
  assert.match(r.stderr, /no OPENAI_API_KEY resolvable/, "must name exactly what is missing");
  assert.doesNotMatch(r.stdout, /SUMMARY:/);
});

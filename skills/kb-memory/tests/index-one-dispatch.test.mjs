// index-one.mjs is the fleet's write-through indexer: mem.mjs spawns it DETACHED and fire-and-forget
// after a shared write, so a fact stated this minute is semantically recallable this minute.
//
// That detached fire-and-forget spawn is exactly why its Azure dependency was dangerous. The original
// guard was `if (!AIS_EP || !AIS_KEY || !AOAI_EP || !AOAI_KEY) process.exit(0)`, and the whole script
// is fail-open-exit-0. So under an Azure outage (or a billing block) every write-through evaporated
// silently: no error, no log, no exit code any caller reads, and the parent write still reported
// success. This file proves the port removed that -- under SEARCH_BACKEND=opensearch +
// EMBEDDINGS_PROVIDER=openai it reaches the OpenSearch cluster and NEVER an Azure host.
//
// index-one.mjs is a SCRIPT (it reads process.argv and calls process.exit), not a module with
// exports, so it is exercised as a subprocess rather than imported -- which is also how it actually
// runs in production. The fetch stub is injected via --import so it is installed before the script's
// own top-level code executes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(HERE, "..", "index-one.mjs");
const OS_HOST = "unit-test-cluster.us-east-1.es.amazonaws.com";

/** A preload module that replaces globalThis.fetch, records every URL to a file, and answers the
 *  OpenSearch/OpenAI calls this configuration legitimately makes. Written to a temp dir per test. */
function preloadSource(logPath) {
  return `
import { appendFileSync } from "node:fs";
// Exact host comparison, not a substring test on the whole URL: a URL that merely MENTIONS a host in
// a path or query would satisfy a substring check, and this file exists to prove WHICH host was
// reached. (Same fix already applied to the other two writer ports.)
function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
globalThis.fetch = async (url, opts) => {
  const u = String(typeof url === "string" ? url : url?.url || url);
  appendFileSync(${JSON.stringify(logPath)}, u + "\\n");
  if (isHost(u, "api.openai.com") && u.includes("/v1/embeddings")) {
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(3072).fill(0.001) }] }), { status: 200 });
  }
  if (isHost(u, ${JSON.stringify(OS_HOST)})) {
    if (u.includes("_mapping")) return new Response("not found", { status: 404 });
    if (u.includes("_bulk")) return new Response(JSON.stringify({ errors: false, items: [{ update: { _id: "x", status: 200 } }] }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  }
  // Anything else (a stray secret lookup) degrades harmlessly rather than throwing, so the assertion
  // below is about what WAS called, not about the stub's own control flow.
  return new Response("not found", { status: 404 });
};
`;
}

const AZURE_HOST_RE = /\.(search\.windows\.net|openai\.azure\.com|cognitiveservices\.azure\.com|vault\.azure\.net)/i;

async function runIndexOne(entry) {
  const dir = mkdtempSync(join(tmpdir(), "index-one-test-"));
  const logPath = join(dir, "calls.log");
  writeFileSync(logPath, "");
  const preload = join(dir, "preload.mjs");
  writeFileSync(preload, preloadSource(logPath));
  await execFileP(process.execPath, ["--import", preload, SCRIPT, "cto", JSON.stringify(entry)], {
    env: {
      ...process.env,
      SEARCH_BACKEND: "opensearch",
      EMBEDDINGS_PROVIDER: "openai",
      OPENSEARCH_ENDPOINT: OS_HOST,
      OPENSEARCH_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000",
      AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
      OPENAI_API_KEY: "sk-unit-test-fake-not-real",
      // Ensure no ambient GCP service account can turn a "no calls" pass into a false negative.
      GCP_CLAUDE_DRIVER_SA_JSON: "",
    },
    timeout: 30000,
  });
  const { readFileSync } = await import("node:fs");
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
}

test("SEARCH_BACKEND=opensearch + EMBEDDINGS_PROVIDER=openai: a write-through embeds via OpenAI and upserts to OpenSearch, with ZERO Azure calls", async () => {
  const calls = await runIndexOne({
    id: "20260816-999-test",
    text: "a shared decision about the aws cutover",
    type: "decision",
    ts: "2026-08-16T00:00:00.000Z",
    tags: ["aws"],
  });

  assert.deepEqual(
    calls.filter((u) => AZURE_HOST_RE.test(u)),
    [],
    "the write-through must not reach any Azure host under the fully Azure-free configuration",
  );
  assert.ok(
    calls.some((u) => u.includes("api.openai.com") && u.includes("/v1/embeddings")),
    "must have embedded via the OpenAI-direct path",
  );
  assert.ok(
    calls.some((u) => u.includes(OS_HOST) && u.includes("_bulk")),
    "must have upserted into the OpenSearch memory-exec index",
  );
});

test("the entry-validation guards are unchanged: a malformed entry still exits 0 having called nothing", async () => {
  // Pre-existing contract (`if (!agent || !entry.id || !entry.text) process.exit(0)`), pinned so the
  // port cannot have widened what this script is willing to index.
  const calls = await runIndexOne({ id: "", text: "" });
  assert.deepEqual(calls, [], "a malformed entry must short-circuit before any network call");
});

test("the azure branch is still present and reachable for the default backend (the port made it conditional, it did not delete it)", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(SCRIPT, "utf8");
  assert.match(src, /azure-search-endpoint/, "the azure endpoint lookup must still exist for SEARCH_BACKEND=azure");
  assert.match(src, /"@search\.action": "mergeOrUpload"/, "the azure merge action must still be sent on the azure path");
  assert.match(src, /SEARCH_BACKEND === "opensearch"/, "the script must actually branch on SEARCH_BACKEND");
  assert.match(src, /EMBEDDINGS_PROVIDER === "openai"/, "the script must actually branch on EMBEDDINGS_PROVIDER");
});

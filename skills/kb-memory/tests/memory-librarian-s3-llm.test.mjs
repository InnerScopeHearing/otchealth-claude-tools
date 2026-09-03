// Tests for skills/kb-memory/memory-librarian.mjs's S3 + LLM port (2026-08-27). Both halves ported
// together, deliberately (see the file's own header): storage off dead Azure Blob onto the S3 DR
// mirror via commons-store.mjs, and the LLM off dead Azure Foundry onto OpenAI direct, split into a
// QUALITY tier (the daily digest, narrative summarization) and a CHEAP tier (the bounded
// pitfall/decision/fact extraction) -- closing the "gpt-4.1-mini is BANNED for quality summarization"
// TODO the pre-port code left in its own comments.
//
// This script has no isMain guard (top-level `main().catch(...)` runs immediately on import), so
// every test here runs it as a real subprocess with the `--import` fetch-stub preload technique.
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
const LIBRARIAN_MJS = join(HERE, "..", "memory-librarian.mjs");

const S3_BUCKET = "otchealth-brain-dr-55c84f6b";
const S3_KEY_PREFIX = "otchealthcommons/company-journal/";
const S3_HOST = `${S3_BUCKET}.s3.us-east-1.amazonaws.com`;
const AZURE_HOST_RE = /blob\.core\.windows\.net|cognitiveservices\.azure\.com|openai\.azure\.com/i;
const TODAY = new Date().toISOString().slice(0, 10); // memory-librarian's lastDates(1) always resolves to the REAL current date

function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
function pathOf(u) { try { return new URL(u).pathname; } catch { return ""; } }

/** Preload: stubs S3 (an in-memory object store seeded with a synthetic journal) AND OpenAI's chat
 *  endpoint (returns a fixed digest for the quality-tier model, an empty `[]` for the cheap-tier
 *  model -- so the child `mem.mjs` distillation write-through, an UNMODIFIED dependency of this port,
 *  is never actually invoked and cannot flakily depend on this sandbox's real AWS/SSM reachability).
 *  Also stubs SSM's GetParameter for "openai-api-key" as ParameterNotFound, for the negative test. */
function preloadSource(logPath, storePath, { openaiKeyInSsm = false } = {}) {
  return `
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
function pathOf(u) { try { return new URL(u).pathname; } catch { return ""; } }
function loadStore() { return existsSync(${JSON.stringify(storePath)}) ? JSON.parse(readFileSync(${JSON.stringify(storePath)}, "utf8")) : {}; }
function saveStore(s) { writeFileSync(${JSON.stringify(storePath)}, JSON.stringify(s)); }
globalThis.fetch = async (url, opts) => {
  const u = String(typeof url === "string" ? url : url?.url || url);
  const method = ((opts && opts.method) || "GET").toUpperCase();
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method, url: u, body: opts && opts.body ? String(opts.body).slice(0, 4000) : null }) + "\\n");
  const host = new URL(u).hostname;

  if (host.endsWith(".amazonaws.com") && host.includes(".s3.")) {
    const p = pathOf(u);
    const store = loadStore();
    if (method === "GET" && u.includes("list-type=2")) {
      const prefix = new URL(u).searchParams.get("prefix") || "";
      const keys = Object.keys(store).filter(k => k.startsWith("/" + prefix));
      const contents = keys.map(k => \`<Contents><Key>\${k.slice(1)}</Key><Size>\${store[k].length}</Size><LastModified>2026-08-27T00:00:00.000Z</LastModified></Contents>\`).join("");
      return new Response(\`<ListBucketResult>\${contents}<IsTruncated>false</IsTruncated></ListBucketResult>\`, { status: 200 });
    }
    if (method === "GET") {
      if (!(p in store)) return new Response("not found", { status: 404 });
      return new Response(store[p], { status: 200, headers: { etag: '"e"' } });
    }
    if (method === "PUT") {
      store[p] = Buffer.isBuffer(opts.body) ? opts.body.toString("utf8") : String(opts.body);
      saveStore(store);
      return new Response("", { status: 200, headers: { etag: '"e"' } });
    }
    return new Response("method not stubbed", { status: 500 });
  }

  if (host.startsWith("ssm.") && host.endsWith(".amazonaws.com")) {
    const body = JSON.parse(opts.body);
    if (body.Name === "/otchealth/openai-api-key") {
      ${openaiKeyInSsm
        ? `return new Response(JSON.stringify({ Parameter: { Value: "sk-from-ssm-fake" } }), { status: 200 });`
        : `return new Response(JSON.stringify({ __type: "ParameterNotFound" }), { status: 400 });`}
    }
    return new Response(JSON.stringify({ __type: "ParameterNotFound" }), { status: 400 });
  }

  if (u === "https://api.openai.com/v1/chat/completions") {
    const body = JSON.parse(opts.body);
    // QUALITY_MODEL/CHEAP_MODEL resolve through setup/model-routing.mjs's OPENAI_TIERS (2026-08-29
    // fix) -- gpt-5.6-terra (standard/mid) for the digest, gpt-5.6-luna (cheap) for the distillation.
    const content = body.model === "gpt-5.6-terra"
      ? "# fixture digest\\nWorked on the S3 port."
      : "[]"; // cheap-tier distillation: nothing new to extract in this fixture
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }

  return new Response("not found", { status: 404 });
};
`;
}

function seedJournal(dir, agent, date, sessionId, rows) {
  const key = "/" + S3_KEY_PREFIX + `_JOURNAL/${agent}/${date}/${sessionId}.jsonl`;
  return { [key]: rows.map((r) => JSON.stringify(r)).join("\n") + "\n" };
}

function runLibrarian(args, { presetStore, envExtra = {}, openaiKeyInSsm = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "librarian-s3-llm-test-"));
  const logPath = join(dir, "calls.log");
  const storePath = join(dir, "store.json");
  writeFileSync(logPath, "");
  writeFileSync(storePath, JSON.stringify(presetStore || {}));
  const preload = join(dir, "preload.mjs");
  writeFileSync(preload, preloadSource(logPath, storePath, { openaiKeyInSsm }));
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000",
    AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
    ...envExtra,
  };
  return execFileP(process.execPath, ["--import", preload, LIBRARIAN_MJS, ...args], { env, timeout: 30000 })
    .then((r) => ({ status: 0, stdout: r.stdout, stderr: r.stderr, calls: readCalls(logPath), store: JSON.parse(readFileSync(storePath, "utf8")) }))
    .catch((e) => ({ status: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || "", calls: readCalls(logPath), store: JSON.parse(readFileSync(storePath, "utf8")) }));
}
function readCalls(logPath) { return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }

test("THE SILENT-SUCCESS FIX: with OPENAI_API_KEY unset AND unresolvable via SSM, the run fails LOUD (exit 2) before processing any agent-day", async () => {
  const rows = [{ ts: "2026-08-27T01:00:00Z", dir: "IN", agent: "porttest", session: "s1", len: 10, text: "hello" }];
  const presetStore = seedJournal("x", "porttest", TODAY, "s1", rows);
  const r = await runLibrarian(["--agents", "porttest", "--days", "1", "--no-reindex"], {
    presetStore, envExtra: { OPENAI_API_KEY: "" }, openaiKeyInSsm: false,
  });
  assert.notEqual(r.status, 0, "a genuinely unresolvable LLM key must not exit 0");
  assert.equal(r.status, 2, `expected the loud config-error exit code 2; stderr: ${r.stderr}`);
  assert.match(r.stderr, /Missing openai-api-key/);
  assert.deepEqual(r.calls.filter((c) => c.url === "https://api.openai.com/v1/chat/completions"), [], "must never attempt a chat call with no key");
});

test("the daily digest uses the QUALITY-tier model (gpt-5.6-terra, 2026-08-29 OPENAI_TIERS refresh) shaped for its reasoning family, and writes to S3 at _JOURNAL/<agent>/<date>/_DIGEST.md, with ZERO Azure calls", async () => {
  const rows = [
    { ts: "2026-08-27T01:00:00Z", dir: "IN", agent: "porttest", session: "s1", len: 20, text: "please port the S3 cluster" },
    { ts: "2026-08-27T01:05:00Z", dir: "OUT", agent: "porttest", session: "s1", len: 30, text: "ported heartbeat and dispatch, working on the rest now" },
  ];
  const presetStore = seedJournal("x", "porttest", TODAY, "s1", rows);
  const r = await runLibrarian(["--agents", "porttest", "--days", "1", "--no-reindex"], { presetStore, envExtra: { OPENAI_API_KEY: "sk-test-fake-not-real" } });
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  assert.deepEqual(r.calls.filter((c) => AZURE_HOST_RE.test(c.url)), [], "must never reach any Azure host (Blob or Foundry)");
  const digestCall = r.calls.find((c) => c.url === "https://api.openai.com/v1/chat/completions" && JSON.parse(c.body).model === "gpt-5.6-terra");
  assert.ok(digestCall, "the digest must have been generated with the quality/mid-tier model (gpt-5.6-terra)");
  // gpt-5.6-terra is reasoning-family (2026-08-29 refresh) -- chatBody() must use max_completion_tokens
  // with NO temperature override, never the old hardcoded {max_tokens, temperature} literal that would
  // 400 on this model.
  const digestBody = JSON.parse(digestCall.body);
  assert.equal("max_completion_tokens" in digestBody, true, "reasoning-family (gpt-5.6-terra) must use max_completion_tokens");
  assert.equal("temperature" in digestBody, false, "reasoning-family models reject a temperature override");
  assert.equal("reasoning_effort" in digestBody, false, "the quality-tier digest call must NOT get the cheap-tier's reasoningEffort:'low' (2026-09-03)");
  const digestKey = "/" + S3_KEY_PREFIX + `_JOURNAL/porttest/${TODAY}/_DIGEST.md`;
  assert.ok(r.store[digestKey], "the digest must have been written to the exact expected S3 key");
  assert.match(r.store[digestKey], /Worked on the S3 port/);
});

test("the distillation step uses the CHEAP-tier model (gpt-5.6-luna, 2026-08-29 OPENAI_TIERS refresh), not the quality model used for the digest, and is shaped for its reasoning family", async () => {
  const rows = [{ ts: "2026-08-27T01:00:00Z", dir: "IN", agent: "porttest", session: "s1", len: 10, text: "hello there" }];
  const presetStore = seedJournal("x", "porttest", TODAY, "s1", rows);
  const r = await runLibrarian(["--agents", "porttest", "--days", "1", "--no-reindex"], { presetStore, envExtra: { OPENAI_API_KEY: "sk-test-fake-not-real" } });
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  const distillCall = r.calls.find((c) => c.url === "https://api.openai.com/v1/chat/completions" && JSON.parse(c.body).model === "gpt-5.6-luna");
  assert.ok(distillCall, "the distillation step must use the cheap-tier model (gpt-5.6-luna)");
  // gpt-5.6-luna is ALSO reasoning-family now (2026-08-29: cheap moved off chat-family, unlike its
  // gpt-4o-mini predecessor) -- same family-aware shaping requirement as the digest call above.
  const distillBody = JSON.parse(distillCall.body);
  assert.equal("max_completion_tokens" in distillBody, true, "reasoning-family (gpt-5.6-luna) must use max_completion_tokens");
  assert.equal("temperature" in distillBody, false, "reasoning-family models reject a temperature override");
  assert.equal(distillBody.reasoning_effort, "low", "the cheap-tier bounded extraction call must set reasoning_effort:'low' (2026-09-03)");
});

test("initModel resolves the OpenAI key via the SSM fleet-secret path when OPENAI_API_KEY is unset (kvSecret's SSM-first default), not just from env", async () => {
  const rows = [{ ts: "2026-08-27T01:00:00Z", dir: "IN", agent: "porttest", session: "s1", len: 10, text: "hello there" }];
  const presetStore = seedJournal("x", "porttest", TODAY, "s1", rows);
  const r = await runLibrarian(["--agents", "porttest", "--days", "1", "--no-reindex"], {
    presetStore, envExtra: { OPENAI_API_KEY: "" }, openaiKeyInSsm: true,
  });
  assert.equal(r.status, 0, `expected a clean exit when the key resolves via SSM; stderr: ${r.stderr}`);
  const ssmCall = r.calls.find((c) => new URL(c.url).hostname.startsWith("ssm.") && c.body && JSON.parse(c.body).Name === "/otchealth/openai-api-key");
  assert.ok(ssmCall, "must have actually queried SSM for the key rather than only checking env");
});

// ---- counterfactual guard: no Azure Blob / Foundry code remains in the ported file -----------------
test("memory-librarian.mjs no longer talks to Azure Blob or Azure OpenAI/Foundry directly (ported to S3 + OpenAI direct, 2026-08-27)", () => {
  const src = readFileSync(LIBRARIAN_MJS, "utf8");
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.doesNotMatch(stripped, /blob\.core\.windows\.net/, "must not construct any Azure Blob URL");
  assert.doesNotMatch(stripped, /azure-foundry-openai-endpoint|azure-openai-endpoint|azure-openai-key|azure-foundry-key/, "must not read any of the old Azure OpenAI/Foundry secrets");
  assert.doesNotMatch(stripped, /azure-commons-storage-(account|key)/, "must not read the old Azure Blob storage creds");
  assert.doesNotMatch(stripped, /buildSas|loadSA\(\)|GCP_CLAUDE_DRIVER_SA_JSON/, "the old hand-rolled Azure SAS + GCP JWT primitives must be gone");
  assert.match(src, /api\.openai\.com\/v1\/chat\/completions/, "must call OpenAI direct");
  assert.match(src, /from "\.\/commons-store\.mjs"/, "must route storage through the shared commons-store facade");
  assert.match(src, /QUALITY_MODEL/, "must have a distinct quality-tier model for the digest");
  assert.match(src, /CHEAP_MODEL/, "must have a distinct cheap-tier model for the bounded extraction");
});

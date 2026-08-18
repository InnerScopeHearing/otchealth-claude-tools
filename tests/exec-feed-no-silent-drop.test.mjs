// Regression test for the exact defect class this session was dispatched to close: a per-lane read
// failure inside readExecFeedRows() (company-brain's diff-mode exec-feed ledger walk) used to be
// swallowed with a bare `if (!r.ok) continue;` -- no record, no return value, nothing. The sibling
// LISTING call a few lines above had already been hardened to throw on failure; the per-file GET was
// left in the exact "failure returned as a plausible value" shape the listing fix was supposed to have
// eliminated file-wide.
//
// CONCRETE FAILURE THIS PINS: 4 of 5 exec-feed lanes list and read fine; the 5th (e.g. cfo.jsonl) GETs
// a 503. Pre-fix, the function returned the 4 lanes' rows as a plain array with ZERO indication the 5th
// lane was never read -- diffCmd()/renderDiff() would print "ADDED (0) / CHANGED (0) / RETIRED (0)" for
// that lane's topic exactly as if the ledger had been read and found nothing. For a grounding tool,
// that is the worst possible shape: it manufactures confidence that a lane said nothing.
//
// Two things are pinned:
//   1. assessExecFeedOutcome() -- the pure verdict function -- classifies every combination of
//      (lanes attempted, per-lane failures, rows returned) correctly (hermetic, no I/O).
//   2. readExecFeedRows() itself, exercised end-to-end against a stubbed Azure Blob surface (no real
//      network, no real Azure/GCP credentials -- Azure subscription 55c84f6b is permanently deleted),
//      proves that a per-lane GET failure lands in a `failures` array the caller can see, that lane's
//      rows are simply absent (not silently zero-padded), and the OTHER lanes' rows still come through.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { assessExecFeedOutcome, readExecFeedRows } from "../skills/company-brain/brain.mjs";

// ─────────────────────── 1. assessExecFeedOutcome (pure, hermetic) ───────────────────────

test("every exec-feed lane failing is a hard error, never rendered as 'no history'", () => {
  const out = assessExecFeedOutcome({ lanesAttempted: 3, failures: [{ lane: "cto", error: "boom" }, { lane: "cfo", error: "boom" }, { lane: "clo", error: "boom" }], rows: 0 });
  assert.equal(out.ok, false);
  assert.match(out.message, /FAILED/);
  assert.match(out.message, /NOT evidence/i);
});

test("a partial failure with zero rows overall is INCONCLUSIVE, not 'nothing changed'", () => {
  const out = assessExecFeedOutcome({ lanesAttempted: 3, failures: [{ lane: "cfo", error: "HTTP 503" }], rows: 0 });
  assert.equal(out.ok, false);
  assert.match(out.message, /INCONCLUSIVE/);
  assert.match(out.message, /cannot be distinguished/);
});

test("a partial failure WITH rows still answers, but is labelled PARTIAL and names the dead lane", () => {
  const out = assessExecFeedOutcome({ lanesAttempted: 3, failures: [{ lane: "cfo", error: "HTTP 503" }], rows: 12 });
  assert.equal(out.ok, true);
  assert.equal(out.degraded, true);
  assert.match(out.message, /PARTIAL/);
  assert.match(out.message, /cfo/, "the failed lane must be named so the gap is actionable");
  assert.match(out.message, /HTTP 503/, "the underlying error must be surfaced, not just 'a lane failed'");
});

test("no failures at all is a clean, non-degraded result", () => {
  const out = assessExecFeedOutcome({ lanesAttempted: 3, failures: [], rows: 5 });
  assert.equal(out.ok, true);
  assert.equal(out.degraded, false);
  assert.equal(out.message, "");
});

test("zero lanes attempted (e.g. the whole ledger is empty) does not spuriously read as FAILED", () => {
  const out = assessExecFeedOutcome({ lanesAttempted: 0, failures: [], rows: 0 });
  assert.equal(out.ok, true);
  assert.equal(out.degraded, false);
});

// ─────────────────── 2. readExecFeedRows against a stubbed Azure Blob surface ───────────────────

const ACCT = "otchealthcommons";
const KEY_B64 = Buffer.from("test-key-material-not-real").toString("base64");

// Minimal Azure Blob "list container" XML the fixed code's regex-based parser expects.
function listXml(names) {
  return `<?xml version="1.0" encoding="utf-8"?><EnumerationResults>${names.map((n) => `<Blobs><Blob><Name>${n}</Name></Blob></Blobs>`).join("")}</EnumerationResults>`;
}

/** Stubs every network call readExecFeedRows()'s dependency chain can make: the managed-identity
 * token mint (so kvSecret() resolves the two `sm()` reads without touching real Azure/GCP/AWS), the
 * two Key Vault secret GETs, the container listing, and the per-file blob GETs. `fileHandler(name)`
 * decides each individual blob GET's outcome -- this is where the test injects the 503. */
async function withStubbedExecFeed({ acct = ACCT, key = KEY_B64, files, fileHandler }, fn) {
  const savedFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  process.env.IDENTITY_ENDPOINT = "https://identity.example.invalid/token";
  process.env.IDENTITY_HEADER = "test-identity-header";
  delete process.env.AZURE_SP_CLIENT_ID;
  delete process.env.SECRET_BACKEND;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("https://identity.example.invalid/token")) {
      return new Response(JSON.stringify({ access_token: "fake-identity-token" }), { status: 200 });
    }
    if (u.includes(".vault.azure.net/secrets/azure-commons-storage-account")) {
      return new Response(JSON.stringify({ value: acct }), { status: 200 });
    }
    if (u.includes(".vault.azure.net/secrets/azure-commons-storage-key")) {
      return new Response(JSON.stringify({ value: key }), { status: 200 });
    }
    if (u.includes("restype=container&comp=list")) {
      return new Response(listXml(files), { status: 200, headers: { "content-type": "application/xml" } });
    }
    // A per-file blob GET: https://{acct}.blob.core.windows.net/company-journal/{path}?{sas}
    const m = u.match(/blob\.core\.windows\.net\/company-journal\/([^?]+)\?/);
    if (m) {
      const name = decodeURIComponent(m[1]).replace(/%2F/gi, "/");
      // encPath uses encodeURIComponent per-segment; the join above is a safety net for '/'.
      const decodedFull = decodeURIComponent(m[1]);
      return fileHandler(decodedFull.split("/").pop().replace(/\.jsonl$/, ""), decodedFull);
    }
    throw new Error(`unstubbed fetch in test: ${u}`);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = savedFetch;
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  }
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

test("a single lane's GET failure (503) is recorded in `failures`, NEVER silently dropped, and the other lanes still come through", async () => {
  const files = ["_MEMORY/_exec/cto.jsonl", "_MEMORY/_exec/cfo.jsonl", "_MEMORY/_exec/clo.jsonl"];
  await withStubbedExecFeed(
    {
      files,
      fileHandler: (lane) => {
        if (lane === "cfo") return new Response("service unavailable", { status: 503 });
        const rows = [{ id: `${lane}-1`, type: "fact", ts: "2026-08-01T00:00:00Z", text: `${lane} said something` }];
        return new Response(jsonl(rows), { status: 200 });
      },
    },
    async () => {
      const result = await readExecFeedRows({ agent: "", includePersonal: false });
      assert.ok(result && typeof result === "object" && Array.isArray(result.rows) && Array.isArray(result.failures), "readExecFeedRows must return {rows, failures, lanesAttempted}, not a bare array");
      assert.equal(result.lanesAttempted, 3, "all 3 discovered lanes are allowed for a non-personal agent");
      assert.equal(result.failures.length, 1, "exactly one lane failed and it must be visible");
      assert.equal(result.failures[0].lane, "cfo");
      assert.match(result.failures[0].error, /503/);
      const laneNames = result.rows.map((r) => r.agent);
      assert.ok(laneNames.includes("cto"), "a healthy lane's rows must still come through");
      assert.ok(laneNames.includes("clo"), "a healthy lane's rows must still come through");
      assert.ok(!laneNames.includes("cfo"), "the failed lane must contribute ZERO rows, not fabricated empty-but-successful ones");
      // Wire the raw output straight through assessExecFeedOutcome, exactly as diffCmd() does, and
      // confirm the end-to-end verdict is PARTIAL (not silently "clean").
      const outcome = assessExecFeedOutcome({ lanesAttempted: result.lanesAttempted, failures: result.failures, rows: result.rows.length });
      assert.equal(outcome.ok, true);
      assert.equal(outcome.degraded, true);
      assert.match(outcome.message, /cfo/);
    },
  );
});

test("every lane's GET failing surfaces as failures for ALL of them (not an empty-but-clean result)", async () => {
  const files = ["_MEMORY/_exec/cto.jsonl", "_MEMORY/_exec/cfo.jsonl"];
  await withStubbedExecFeed(
    { files, fileHandler: () => new Response("gateway timeout", { status: 504 }) },
    async () => {
      const result = await readExecFeedRows({ agent: "", includePersonal: false });
      assert.equal(result.rows.length, 0);
      assert.equal(result.failures.length, 2);
      assert.deepEqual(result.failures.map((f) => f.lane).sort(), ["cfo", "cto"]);
      const outcome = assessExecFeedOutcome({ lanesAttempted: result.lanesAttempted, failures: result.failures, rows: result.rows.length });
      assert.equal(outcome.ok, false, "total failure must not read as a clean empty diff");
      assert.match(outcome.message, /FAILED/);
    },
  );
});

test("a thrown network error on one lane's GET is captured into failures exactly like a non-2xx response", async () => {
  const files = ["_MEMORY/_exec/cto.jsonl", "_MEMORY/_exec/clo.jsonl"];
  await withStubbedExecFeed(
    {
      files,
      fileHandler: (lane) => {
        if (lane === "clo") throw new TypeError("fetch failed: getaddrinfo ENOTFOUND");
        return new Response(jsonl([{ id: "cto-1", type: "fact", ts: "2026-08-01T00:00:00Z", text: "cto said something" }]), { status: 200 });
      },
    },
    async () => {
      const result = await readExecFeedRows({ agent: "", includePersonal: false });
      assert.equal(result.failures.length, 1);
      assert.equal(result.failures[0].lane, "clo");
      assert.match(result.failures[0].error, /ENOTFOUND/);
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].agent, "cto");
    },
  );
});

test("clo-personal lane is walled off from a non-clo agent BEFORE any GET is attempted (privilege wall unaffected by the failure-visibility fix)", async () => {
  const files = ["_MEMORY/_exec/cto.jsonl", "_MEMORY/_exec/clo-personal.jsonl"];
  let personalLaneFetched = false;
  await withStubbedExecFeed(
    {
      files,
      fileHandler: (lane) => {
        if (lane === "clo-personal") personalLaneFetched = true;
        return new Response(jsonl([{ id: `${lane}-1`, type: "fact", ts: "2026-08-01T00:00:00Z", text: "x" }]), { status: 200 });
      },
    },
    async () => {
      const result = await readExecFeedRows({ agent: "cfo", includePersonal: true });
      assert.equal(personalLaneFetched, false, "a disallowed lane must never even be fetched");
      assert.equal(result.lanesAttempted, 1, "the personal lane does not count toward lanesAttempted for an agent that cannot read it");
      assert.equal(result.failures.length, 0);
    },
  );
});

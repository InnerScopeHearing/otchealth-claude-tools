// Tests for growth-room.mjs's S3 persistence port (2026-09-03, off a hardcoded `--azure` override
// of store.mjs's own safe default -- see the header comment in growth-room.mjs for the full defect).
//
// TWO fetch seams, because runSweep()'s persistence step spawns a real child process:
//   - IN-PROCESS: globalThis.fetch is stubbed directly (same convention as
//     skills/xero/tests/xero-token-lock.test.mjs) to intercept growth-room's OWN AWS SSM secret
//     reads (capgo-token / posthog-personal-api-key / revenuecat-secret-key), always answering
//     ParameterNotFound so every growth-signal source degrades to "not configured" -- this file is
//     about the STORAGE call, not the Capgo/RevenueCat/PostHog pulls (covered by the pure-function
//     tests in growth-room.test.mjs).
//   - CHILD PROCESS: `execFileSync("node", [STORE_MJS, "--s3", ...])` is a genuine subprocess that
//     does NOT inherit the in-process fetch stub above. A preload module, installed via
//     NODE_OPTIONS=--import (which execFileSync's inherited env propagates to the child, since
//     growth-room.mjs passes no explicit `env` override), intercepts THAT process's fetch calls
//     instead and logs every one to a file so this test can inspect exactly which S3 host/path was
//     hit -- the same pattern skills/innd-stock/tests/innd-stock-s3.test.mjs uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSweep } from "../growth-room.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const GROWTH_ROOM_MJS = join(HERE, "..", "growth-room.mjs");
const GROWTH_ROOM_SH = join(HERE, "..", "job", "growth-room-nightly.sh");

// otchealthcommons/company-journal's verified row in skills/kb-memory/s3-blob.mjs's MIRROR table.
const S3_BUCKET = "otchealth-brain-dr-55c84f6b";
const S3_HOST = `${S3_BUCKET}.s3.us-east-1.amazonaws.com`;
const S3_KEY_PREFIX = "otchealthcommons/company-journal/";
const OFF_HOST_RE = /blob\.core\.windows\.net|storage\.googleapis\.com/i;

function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
function pathOf(u) { try { return new URL(u).pathname; } catch { return ""; } }
function isoDate(d = new Date()) { return d.toISOString().slice(0, 10); }

// ---- in-process seam: growth-room's own SSM reads for capgo/posthog/revenuecat tokens ----
function stubSsmAlwaysNotFound() {
  return async (url) => {
    const u = String(url);
    if (/^https:\/\/ssm\.[a-z0-9-]+\.amazonaws\.com\//.test(u)) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ __type: "ParameterNotFound" }) };
    }
    throw new Error(`unexpected in-process fetch during a growth-room S3 test (only SSM should be reached here): ${u}`);
  };
}

// ---- child-process seam: the S3 PUT store.mjs --s3 makes when runSweep() stages the digest ----
function preloadSource() {
  return `
import { appendFileSync } from "node:fs";
const logPath = process.env.GROWTH_ROOM_TEST_LOG;
const mode = process.env.GROWTH_ROOM_TEST_S3_MODE || "ok";
function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
globalThis.fetch = async (url, opts) => {
  const u = String(typeof url === "string" ? url : (url && url.url) || url);
  const method = ((opts && opts.method) || "GET").toUpperCase();
  appendFileSync(logPath, JSON.stringify({ method, url: u }) + "\\n");
  if (isHost(u, ${JSON.stringify(S3_HOST)})) {
    if (mode === "fail") return new Response("simulated unreachable bucket", { status: 500 });
    return new Response("", { status: 200, headers: { etag: '"fake-etag-not-real"' } });
  }
  return new Response("not found", { status: 404 });
};
`;
}

function readCalls(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Set up the fake credential + preload world, run `body({ logPath })`, then restore everything --
 *  env vars (so no test leaks a fake AWS credential or NODE_OPTIONS into another test file's process)
 *  and the in-process fetch stub. */
async function withStubbedWorld(s3Mode, body) {
  const dir = mkdtempSync(join(tmpdir(), "growth-room-s3-test-"));
  const logPath = join(dir, "s3-calls.log");
  writeFileSync(logPath, "");
  const preloadPath = join(dir, "preload.mjs");
  writeFileSync(preloadPath, preloadSource());

  const overrides = {
    AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000",
    AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
    AWS_SESSION_TOKEN: undefined,
    OTC_AWS_ACCESS_KEY_ID: undefined,
    OTC_AWS_SECRET_ACCESS_KEY: undefined,
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
    AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
    // NODE_OPTIONS only affects a process at ITS OWN startup, so setting it here on the already-
    // running test process does nothing to this process -- it only takes effect for the child
    // `node store.mjs` execFileSync spawns, which reads env fresh at its own bootstrap.
    NODE_OPTIONS: `--import ${preloadPath}`,
    GROWTH_ROOM_TEST_LOG: logPath,
    GROWTH_ROOM_TEST_S3_MODE: s3Mode,
  };
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k]; else process.env[k] = overrides[k];
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubSsmAlwaysNotFound();

  try {
    return await body({ logPath });
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test("runSweep --dry-run never touches S3 at all (the network-free preview path)", async () => {
  await withStubbedWorld("ok", async ({ logPath }) => {
    const result = await runSweep({ days: 3, dryRun: true });
    assert.equal(result.staged, false, "a dry run must never report itself as staged");
    assert.deepEqual(readCalls(logPath), [], "dry-run must make zero calls in the store.mjs child process");
  });
});

test("runSweep (not dry-run) stages the digest via store.mjs --s3, landing in the exact mapped bucket/key", async () => {
  await withStubbedWorld("ok", async ({ logPath }) => {
    const result = await runSweep({ days: 3, dryRun: false });
    assert.equal(result.staged, true, "a successful S3 put must report staged:true");

    const calls = readCalls(logPath);
    assert.equal(calls.length, 1, `expected exactly one S3 call from the store.mjs child; got ${JSON.stringify(calls)}`);
    const [call] = calls;
    assert.equal(call.method, "PUT");
    assert.ok(isHost(call.url, S3_HOST), `expected the mapped bucket host ${S3_HOST}; got ${call.url}`);
    const expectedPath = `/${S3_KEY_PREFIX}_DOCS/growth-room/${isoDate()}.md`;
    assert.equal(pathOf(call.url), expectedPath, "the object key must be the mapped keyPrefix + the documented _DOCS/growth-room/<date>.md stage path");
    assert.doesNotMatch(call.url, OFF_HOST_RE, "must never reach Azure Blob or GCS");
  });
});

test("an unreachable/misconfigured bucket fails LOUD -- runSweep throws, it never reports a silent staged:true", async () => {
  await withStubbedWorld("fail", async ({ logPath }) => {
    await assert.rejects(
      () => runSweep({ days: 3, dryRun: false }),
      (err) => {
        const combined = `${err.message || ""} ${err.stderr ? err.stderr.toString() : ""}`;
        assert.match(combined, /s3 put 500/, `expected the S3 500 to surface somewhere in the thrown error; got: ${combined.slice(0, 400)}`);
        return true;
      },
    );
    // The failure must be a REAL attempted write that was refused, not a silently skipped one.
    const calls = readCalls(logPath);
    assert.equal(calls.length, 1, "the PUT must actually have been attempted before failing");
    assert.equal(calls[0].method, "PUT");
    assert.ok(isHost(calls[0].url, S3_HOST));
  });
});

// ---- counterfactual: no --azure / Azure-only flag survives in the persistence call ----------------
test("growth-room.mjs's store.mjs invocation passes --s3, not --azure, and drops the Azure-only --key-secret flag", () => {
  const src = readFileSync(GROWTH_ROOM_MJS, "utf8");
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  assert.doesNotMatch(stripped, /execFileSync\("node", \[STORE_MJS, "--azure"/, "the store.mjs persistence call must not force --azure");
  assert.match(stripped, /execFileSync\("node", \[STORE_MJS, "--s3"/, "must explicitly select the s3 backend");
  assert.doesNotMatch(stripped, /--key-secret/, "the Azure-only --key-secret flag must be gone from the call");
  assert.doesNotMatch(stripped, /COMMONS_KEY_SECRET|azure-commons-storage-key/, "the Azure storage-account-key secret constant must be gone");
});

test("growth-room-nightly.sh's indexer.mjs invocation passes --s3, not --azure", () => {
  const src = readFileSync(GROWTH_ROOM_SH, "utf8");
  const codeOnly = src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(codeOnly, /indexer\.mjs[^\n]*--azure/, "the commons index step must not force --azure");
  assert.match(codeOnly, /indexer\.mjs"?\s*index --no-ocr --profile commons --s3\b/, "must explicitly select the s3 backend for the index step");
});

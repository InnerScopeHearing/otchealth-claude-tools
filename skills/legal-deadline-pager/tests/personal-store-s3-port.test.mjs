// Tests for the 2026-08-28 S3 port of skills/legal-deadline-pager/personal-store.mjs (Azure Blob is
// permanently dead -- subscription 55c84f6b deleted 2026-08-13). This is the SPECIFIC file the port
// task called out for its read/write asymmetry: reads should just work (the personal-legal DR
// bucket's IAM grants GetObject/ListBucket), while writes are EXPECTED to fail because that same IAM
// grant is intentionally read-only pending an explicit owner (Matt) approval. The requirement under
// test is that a write failure is never silently swallowed into a soft `false` the way the pre-port
// Azure implementation did -- it must reject loud, with a message naming the standing gate.
//
// NEVER makes a real network call: every fetch-touching test stubs globalThis.fetch (save/restore),
// mirroring skills/kb-memory/tests/s3-blob-write-path.test.mjs's own convention.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { getPersonalCooldown, putPersonalCooldown, PERSONAL_WRITE_IAM_GATE_MESSAGE } from "../personal-store.mjs";
import { s3LocationFor, _resetCredsCacheForTests } from "../../kb-memory/s3-blob.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}
async function withEnv(vars, run) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  _resetCredsCacheForTests();
  try { return await run(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    _resetCredsCacheForTests();
  }
}
const FAKE_CREDS = { AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKEFAKE", AWS_SECRET_ACCESS_KEY: "fakefakefakefakefakefakefakefakefakefake", AWS_SESSION_TOKEN: undefined, OTC_AWS_ACCESS_KEY_ID: undefined, OTC_AWS_SECRET_ACCESS_KEY: undefined, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined, AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined };

test("sanity: otchealthlegalstore/personal resolves to its OWN dedicated bucket, never the shared finance-legal one", () => {
  const loc = s3LocationFor("otchealthlegalstore", "personal");
  assert.ok(loc);
  assert.equal(loc.bucket, "otchealth-legal-personal-dr-55c84f6b");
});

// ---- (b) personal-ring READS route to the personal DR bucket + the expected object key ------------
test("getPersonalCooldown targets the personal-legal DR bucket host and the cooldown.json key", async () => {
  let captured = null;
  const map = { leg_abc123: { last_paged_at: "2026-07-15T00:00:00.000Z" } };
  const result = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async (url) => { captured = String(url); return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(map) }; },
      () => getPersonalCooldown()));
  assert.ok(captured.startsWith("https://otchealth-legal-personal-dr-55c84f6b.s3.us-east-1.amazonaws.com/"), `unexpected host in ${captured}`);
  assert.ok(
    captured.includes("otchealthlegalstore%2Fpersonal%2Fpager-state%2Fcooldown.json") ||
      captured.includes("otchealthlegalstore/personal/pager-state/cooldown.json"),
    `unexpected key in ${captured}`,
  );
  assert.deepEqual(result, map);
});

test("getPersonalCooldown returns {} on a genuine 404 (no cooldown state yet), fail-open, never throws", async () => {
  const result = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 404, headers: new Map(), text: async () => "" }),
      () => getPersonalCooldown()));
  assert.deepEqual(result, {});
});

test("getPersonalCooldown returns {} (fail-open) and does NOT throw even on an unexpected 403/5xx -- reads degrade gracefully per the module's documented convention", async () => {
  const forbidden = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 403, headers: new Map(), text: async () => "<Error><Code>AccessDenied</Code></Error>" }),
      () => getPersonalCooldown()));
  assert.deepEqual(forbidden, {});
  const serverError = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 500, headers: new Map(), text: async () => "internal error" }),
      () => getPersonalCooldown()));
  assert.deepEqual(serverError, {});
});

test("getPersonalCooldown returns {} (fail-open) when a non-object JSON body is stored (defensive parse guard)", async () => {
  const result = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: true, status: 200, headers: new Map(), text: async () => "null" }),
      () => getPersonalCooldown()));
  assert.deepEqual(result, {});
});

// ---- WRITE success path: targets the right bucket/key, resolves true ------------------------------
test("putPersonalCooldown targets the personal-legal DR bucket host and the cooldown.json key on success", async () => {
  let captured = null;
  const map = { leg_abc123: { last_paged_at: "2026-07-15T00:00:00.000Z" } };
  const result = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async (url, opts) => { captured = { url: String(url), method: opts.method, body: opts.body }; return { ok: true, status: 200, headers: new Map([["etag", '"x"']]), text: async () => "" }; },
      () => putPersonalCooldown(map)));
  assert.equal(result, true);
  assert.equal(captured.method, "PUT");
  assert.ok(captured.url.startsWith("https://otchealth-legal-personal-dr-55c84f6b.s3.us-east-1.amazonaws.com/"), `unexpected host in ${captured.url}`);
  assert.deepEqual(JSON.parse(captured.body.toString()), map);
});

// ---- (c) THE required assertion: a personal WRITE fails LOUD with the distinct IAM-gate message ----
test("putPersonalCooldown REJECTS with the distinct PERSONAL_WRITE_IAM_GATE_MESSAGE on a 403 AccessDenied -- never silently swallowed into `false`", async () => {
  let called = false;
  await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => { called = true; return { ok: false, status: 403, headers: new Map(), text: async () => "<Error><Code>AccessDenied</Code></Error>" }; },
      async () => {
        await assert.rejects(
          () => putPersonalCooldown({ leg_abc123: { last_paged_at: "2026-07-15T00:00:00.000Z" } }),
          (e) => {
            assert.equal(e.message, PERSONAL_WRITE_IAM_GATE_MESSAGE);
            assert.match(e.message, /IAM-gated/);
            assert.match(e.message, /PersonalLegalRingReadOnly/);
            return true;
          },
        );
      }));
  assert.ok(called, "the write must actually have been attempted against S3, not short-circuited before ever calling fetch");
});

test("putPersonalCooldown NEVER returns false on a write failure (the old Azure-era swallow-into-false contract is gone)", async () => {
  const outcome = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 403, headers: new Map(), text: async () => "" }), async () => {
      try { return await putPersonalCooldown({}); } catch (e) { return { threw: true, message: e.message }; }
    }));
  assert.notEqual(outcome, false, "a write failure must never resolve to the boolean false");
  assert.deepEqual(outcome, { threw: true, message: PERSONAL_WRITE_IAM_GATE_MESSAGE });
});

// ---- a write failure NOT caused by the IAM gate must still fail loud, but with its OWN honest cause,
// never mislabeled as the IAM gate (a network blip is not "pending owner approval") -----------------
test("putPersonalCooldown REJECTS on a non-403 failure too, with a distinct (non-IAM-gate) message naming the real cause", async () => {
  await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 500, headers: new Map(), text: async () => "internal error" }),
      async () => {
        await assert.rejects(
          () => putPersonalCooldown({}),
          (e) => {
            assert.notEqual(e.message, PERSONAL_WRITE_IAM_GATE_MESSAGE, "a 500 must not be mislabeled as the IAM gate");
            assert.match(e.message, /personal cooldown store write failed/);
            assert.match(e.message, /500/);
            return true;
          },
        );
      }));
});

test("putPersonalCooldown REJECTS loud when AWS credentials are entirely unavailable, rather than swallowing it", async () => {
  await withEnv(
    { AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, OTC_AWS_ACCESS_KEY_ID: undefined, OTC_AWS_SECRET_ACCESS_KEY: undefined, AWS_SESSION_TOKEN: undefined, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined, AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined },
    () => assert.rejects(() => putPersonalCooldown({}), (e) => { assert.notEqual(e.message, PERSONAL_WRITE_IAM_GATE_MESSAGE); return true; }),
  );
});

// ---- (d) no code path here can reach blob.core.windows.net -----------------------------------------
test("personal-store.mjs contains no reference to blob.core.windows.net (Azure Blob is fully retired here)", () => {
  const src = readFileSync(join(ROOT, "skills/legal-deadline-pager/personal-store.mjs"), "utf8");
  assert.doesNotMatch(src, /blob\.core\.windows\.net/);
  assert.doesNotMatch(src, /azure-secret\.mjs/, "must no longer depend on the Azure Key Vault secret resolver");
  assert.doesNotMatch(src, /AZURE_LEGAL_STORAGE_KEY/, "must no longer reference the retired Azure SharedKey secret");
});

// ---- (e) importers still import cleanly ------------------------------------------------------------
test("importing personal-store.mjs never triggers a network call or a thrown error at load time", async () => {
  const mod = await import("../personal-store.mjs");
  assert.equal(typeof mod.getPersonalCooldown, "function");
  assert.equal(typeof mod.putPersonalCooldown, "function");
  assert.equal(typeof mod.PERSONAL_WRITE_IAM_GATE_MESSAGE, "string");
});

test("pager.mjs (the sole real-world importer of personal-store.mjs) still imports cleanly against the ported module", async () => {
  const mod = await import("../pager.mjs");
  assert.equal(typeof mod.runSweep, "function");
});

test("node --check passes on personal-store.mjs and its importer pager.mjs", () => {
  for (const rel of ["skills/legal-deadline-pager/personal-store.mjs", "skills/legal-deadline-pager/pager.mjs"]) {
    assert.doesNotThrow(() => execFileSync("node", ["--check", join(ROOT, rel)], { stdio: "pipe" }), `node --check failed for ${rel}`);
  }
});

// ---- scrubErrorMessage (CodeQL post-merge hardening, 2026-08-28): no credential-shaped value may
// reach a log line or a rethrown message from this module. The concrete real path: an S3
// InvalidAccessKeyId error body echoes the caller's ACCESS KEY ID verbatim, and s3-blob.mjs embeds
// up to 200 chars of that body in its thrown Error.message. --------------------------------------
import { scrubErrorMessage } from "../personal-store.mjs";

test("scrubErrorMessage masks an AWS access key id echoed by an S3 error body", () => {
  const out = scrubErrorMessage("s3 put 403: <Error><Code>InvalidAccessKeyId</Code><AWSAccessKeyId>AKIAIOSFODNN7EXAMPLE</AWSAccessKeyId></Error>");
  assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE/);
  assert.match(out, /<aws-key-id-redacted>/);
  assert.match(out, /403/, "the status code must survive the scrub (diagnosability)");
});

test("scrubErrorMessage masks a 40-char secret-shaped token and SigV4 Credential/Signature fragments", () => {
  // 40 chars, secret-access-key SHAPE, constructed at runtime so no secret-shaped literal exists in
  // this source file (GitHub push protection rightly blocks even doc-example-derived lookalikes).
  const fakeSecret = "Fake0".repeat(8);
  const out = scrubErrorMessage(`boom Credential=AKIAIOSFODNN7EXAMPLE/20260828/us-east-1/s3/aws4_request, Signature=abc123def456 raw=${fakeSecret}`);
  assert.doesNotMatch(out, /Fake0Fake0/);
  assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE/);
  assert.match(out, /Credential=<redacted>/);
  assert.match(out, /Signature=<redacted>/);
});

test("putPersonalCooldown's non-403 rejection carries the SCRUBBED message (an echoed key id never propagates)", async () => {
  await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 500, headers: new Map(), text: async () => "<AWSAccessKeyId>AKIAIOSFODNN7EXAMPLE</AWSAccessKeyId>" }),
      async () => {
        await assert.rejects(
          () => putPersonalCooldown({}),
          (e) => {
            assert.doesNotMatch(e.message, /AKIAIOSFODNN7EXAMPLE/, "the echoed key id must be masked in the rethrown message");
            assert.match(e.message, /personal cooldown store write failed/);
            return true;
          },
        );
      }));
});

test("scrubErrorMessage leaves ordinary diagnostic text untouched (env var NAMES, status codes, prose)", () => {
  const msg = "s3-blob: AWS credentials unavailable (checked the ECS task role, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, and OTC_AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY)";
  assert.equal(scrubErrorMessage(msg), msg);
});

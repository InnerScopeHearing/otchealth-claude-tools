// Tests for skills/fleet-search/search.mjs's S3 port (2026-08-27, off dead Azure Blob) -- the
// _DOCS/ listing (listDocsPrefix) and the per-agent bulletin-seen marker (getSeenCount/setSeenCount).
// GitHub search + company-brain subprocess spawning are storage-free and untouched by this port, so
// they are not re-tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { filterDocsByQuery } from "../skills/fleet-search/search.mjs";

const SEARCH_MJS = fileURLToPath(new URL("../skills/fleet-search/search.mjs", import.meta.url));

test("filterDocsByQuery: pure function, unaffected by the storage port, still matches by filename substring", () => {
  const items = [{ name: "_DOCS/depot-runbook.md" }, { name: "_DOCS/xero-notes.md" }];
  const matched = filterDocsByQuery(items, "depot pipeline");
  assert.equal(matched.length, 1);
  assert.equal(matched[0].name, "_DOCS/depot-runbook.md");
});

test("filterDocsByQuery: an empty/short-only query returns everything (no filter applied)", () => {
  const items = [{ name: "a.md" }, { name: "b.md" }];
  assert.equal(filterDocsByQuery(items, "").length, 2);
  assert.equal(filterDocsByQuery(items, "to").length, 2); // 2-char terms are ignored (length > 2 required)
});

// ---- fetch-mock S3 tests for listDocsPrefix / getSeenCount / setSeenCount -------------------------
import { _resetCredsCacheForTests } from "../skills/kb-memory/s3-blob.mjs";

const S3_BUCKET = "otchealth-brain-dr-55c84f6b";
const S3_KEY_PREFIX = "otchealthcommons/company-journal/";
const S3_HOST = `${S3_BUCKET}.s3.us-east-1.amazonaws.com`;

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}
async function withEnv(vars, run) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  _resetCredsCacheForTests();
  try { return await run(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    _resetCredsCacheForTests();
  }
}
const FAKE_CREDS = { AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000", AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real" };

function makeStore(seed = {}) {
  const objects = new Map(Object.entries(seed));
  const calls = [];
  const stub = async (url, opts = {}) => {
    const u = String(url);
    const host = new URL(u).hostname;
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ method, url: u });
    if (!host.includes(".s3.") || !host.endsWith(".amazonaws.com")) return { ok: false, status: 404, text: async () => "not found" };
    const { pathname, searchParams } = new URL(u);
    if (searchParams.get("list-type") === "2") {
      const prefix = searchParams.get("prefix") || "";
      const contents = [...objects.keys()].filter((k) => k.startsWith("/" + prefix))
        .map((k) => `<Contents><Key>${k.slice(1)}</Key><Size>${objects.get(k).length}</Size><LastModified>2026-08-27T00:00:00.000Z</LastModified></Contents>`).join("");
      return { ok: true, status: 200, text: async () => `<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>` };
    }
    if (method === "GET") {
      if (!objects.has(pathname)) return { ok: false, status: 404, text: async () => "" };
      return { ok: true, status: 200, headers: new Map([["etag", '"e"']]), text: async () => objects.get(pathname) };
    }
    if (method === "PUT") {
      objects.set(pathname, Buffer.isBuffer(opts.body) ? opts.body.toString("utf8") : String(opts.body));
      return { ok: true, status: 200, headers: new Map([["etag", '"e"']]), text: async () => "" };
    }
    throw new Error("unexpected method " + method);
  };
  return { stub, objects, calls };
}

test("listDocsPrefix resolves via the S3 mirror at otchealthcommons/company-journal/_DOCS/, mapping lastModified -> mtime", async () => {
  const { listDocsPrefix } = await import("../skills/fleet-search/search.mjs");
  const world = makeStore({
    ["/" + S3_KEY_PREFIX + "_DOCS/runbook.md"]: "hello",
  });
  const r = await withEnv(FAKE_CREDS, () => withStubbedFetch(world.stub, () => listDocsPrefix("_DOCS/")));
  assert.equal(r.ok, true, `expected ok:true; error was ${r.error}`);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].name, "_DOCS/runbook.md");
  assert.equal(r.items[0].size, 5);
  assert.equal(r.items[0].mtime, "2026-08-27T00:00:00.000Z");
  assert.ok(world.calls.every((c) => new URL(c.url).host.endsWith(S3_HOST)), "must only ever reach the S3 host, never Azure");
});

test("listDocsPrefix fails open ({ok:false, items:[]}) on a genuine S3 failure, matching the pre-port envelope shape", async () => {
  const { listDocsPrefix } = await import("../skills/fleet-search/search.mjs");
  const throwingStub = async () => { throw new Error("network exploded"); };
  const r = await withEnv(FAKE_CREDS, () => withStubbedFetch(throwingStub, () => listDocsPrefix("_DOCS/")));
  assert.equal(r.ok, false);
  assert.deepEqual(r.items, []);
  assert.match(r.error, /network exploded/);
});

test("getSeenCount / setSeenCount round-trip through the S3 mirror at _BULLETIN_SEEN/<agent>.json", async () => {
  const { getSeenCount, setSeenCount } = await import("../skills/fleet-search/search.mjs");
  const world = makeStore();
  await withEnv(FAKE_CREDS, () => withStubbedFetch(world.stub, async () => {
    assert.equal(await getSeenCount("porttest"), 0, "no prior marker -> 0, not a thrown error");
    const wrote = await setSeenCount("porttest", 42);
    assert.equal(wrote, true);
    assert.equal(await getSeenCount("porttest"), 42, "must read back exactly what was written");
  }));
  assert.equal(world.objects.get("/" + S3_KEY_PREFIX + "_BULLETIN_SEEN/porttest.json") !== undefined, true);
});

// ---- counterfactual guard: no Azure Blob code remains in the ported file --------------------------
test("search.mjs no longer talks to Azure Blob directly (ported to S3 via commons-store, 2026-08-27)", () => {
  const src = readFileSync(SEARCH_MJS, "utf8");
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.doesNotMatch(stripped, /blob\.core\.windows\.net/, "must not construct any Azure Blob URL");
  assert.doesNotMatch(stripped, /azure-commons-storage-(account|key)/, "must not read the old Azure Blob storage creds");
  assert.doesNotMatch(stripped, /buildSas|commonsCreds\(\)/, "the old hand-rolled Azure SAS primitives must be gone");
  assert.match(src, /from "\.\.\/kb-memory\/commons-store\.mjs"/, "must route storage through the shared commons-store facade");
});

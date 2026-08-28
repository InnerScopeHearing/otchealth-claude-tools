// Tests for skills/recall-evals/mine-hard-negatives.mjs's S3 port (2026-08-28, off dead Azure Blob).
//
// THE BUG THIS FILE EXISTS TO PIN: `fetchAllSharedRows()` used to hand-roll an Azure Blob
// account-SAS directly against otchealthcommons/company-journal, the same (account, container) five
// other toolkit callers each duplicated identically before they were ported to the shared
// S3-backed `commons-store.mjs` facade (see that file's own header, and
// skills/kb-memory/memory-librarian.mjs for the exact sibling pattern this file follows). That
// storage account died with the Azure subscription deletion (2026-08-13), so `kvSecret(
// "azure-commons-storage-account"/"-key")` always resolved to null and every call threw immediately
// ("azure-commons-storage-account/key unavailable") -- this tool could never mine a single
// hard-negative case.
//
// Unlike the heartbeat/fleet-medic/fleet-search/sunset-protocol S3-port tests (which stub
// `globalThis.fetch` and run the target as a subprocess, because those files are CLI scripts with a
// top-level `if (isMain) main()` that calls `process.exit()`), `fetchAllSharedRows()` here is
// DEPENDENCY-INJECTABLE (mirrors this same file's own `isEligiblePair(..., {jaccardFn, tokenizeFn})`
// pattern), so these tests import the module directly and pass fake `cListFn`/`cGetFn`/
// `commonsConfiguredFn` stand-ins -- no live AWS credentials, no simulated S3 XML wire protocol, and
// no risk of `main()` auto-running (import.meta.url !== file://process.argv[1] when imported from a
// test file, so the module's own `isMain` guard stays false).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { fetchAllSharedRows } from "../skills/recall-evals/mine-hard-negatives.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET_MJS = join(HERE, "..", "skills", "recall-evals", "mine-hard-negatives.mjs");

// ---- populated store ---------------------------------------------------------------------------
test("fetchAllSharedRows: reads every .jsonl file returned by cList via cGet, parses each JSONL line, and skips non-.jsonl names + malformed lines", async () => {
  const listed = [];
  const gotten = [];
  const cListFn = async (prefix) => {
    listed.push(prefix);
    return [
      "_MEMORY/_exec/cto.jsonl",
      "_MEMORY/_exec/coo.jsonl",
      "_MEMORY/_exec/_readme.md", // must be filtered out BEFORE ever reaching cGetFn
    ];
  };
  const store = {
    "_MEMORY/_exec/cto.jsonl": [
      JSON.stringify({ id: "cto-1", agent: "cto", text: "fact one" }),
      "not json at all {{{", // malformed line -- must be silently skipped, not thrown
      JSON.stringify({ id: "cto-2", agent: "cto", text: "fact two", supersedes: "cto-1" }),
    ].join("\n"),
    "_MEMORY/_exec/coo.jsonl": JSON.stringify({ id: "coo-1", agent: "coo", text: "coo fact" }) + "\n",
  };
  const cGetFn = async (name) => { gotten.push(name); return store[name] ?? null; };
  const commonsConfiguredFn = async () => true;

  const rows = await fetchAllSharedRows({ cListFn, cGetFn, commonsConfiguredFn });

  assert.deepEqual(listed, ["_MEMORY/_exec/"], "must list the exact _MEMORY/_exec/ prefix -- the same corpus semantic.mjs indexes");
  assert.deepEqual(gotten.sort(), ["_MEMORY/_exec/coo.jsonl", "_MEMORY/_exec/cto.jsonl"], "must fetch only the .jsonl names, never the non-.jsonl one");
  assert.deepEqual(
    rows.map((r) => r.id).sort(),
    ["coo-1", "cto-1", "cto-2"],
    "must parse every valid JSONL line across every file, silently skipping the malformed one",
  );
});

test("fetchAllSharedRows: an empty _MEMORY/_exec/ prefix is a VALID state -> returns [] without throwing, and never calls cGet", async () => {
  let cGetCalled = false;
  const rows = await fetchAllSharedRows({
    cListFn: async () => [],
    cGetFn: async () => { cGetCalled = true; return null; },
    commonsConfiguredFn: async () => true,
  });
  assert.deepEqual(rows, [], "an empty listing must resolve to a clean empty array, not throw");
  assert.equal(cGetCalled, false, "with zero .jsonl names there is nothing to fetch");
});

test("fetchAllSharedRows: a 404 on one file mid-fetch (e.g. deleted between list and get) is skipped, not fatal -- other files still contribute rows", async () => {
  const rows = await fetchAllSharedRows({
    cListFn: async () => ["_MEMORY/_exec/gone.jsonl", "_MEMORY/_exec/cto.jsonl"],
    cGetFn: async (name) => (name.endsWith("gone.jsonl") ? null : JSON.stringify({ id: "cto-1", text: "still here" }) + "\n"),
    commonsConfiguredFn: async () => true,
  });
  assert.deepEqual(rows.map((r) => r.id), ["cto-1"]);
});

// ---- unreachable store: distinct from "empty" ---------------------------------------------------
test("fetchAllSharedRows: throws a DISTINCT credential-unavailable error when commonsConfiguredFn is false, and never calls cList/cGet (unreachable != empty)", async () => {
  let listCalled = false, getCalled = false;
  await assert.rejects(
    fetchAllSharedRows({
      cListFn: async () => { listCalled = true; return []; },
      cGetFn: async () => { getCalled = true; return null; },
      commonsConfiguredFn: async () => false,
    }),
    /AWS credentials unavailable/i,
  );
  assert.equal(listCalled, false, "must short-circuit BEFORE ever attempting to list -- an auth failure must not masquerade as an empty listing");
  assert.equal(getCalled, false);
});

test("fetchAllSharedRows: a real listing failure (cList throws, e.g. a non-2xx / non-404) propagates loudly, is never swallowed as an empty result", async () => {
  await assert.rejects(
    fetchAllSharedRows({
      cListFn: async () => { throw new Error("s3 list 403 (refusing to report a failed listing as empty)"); },
      cGetFn: async () => null,
      commonsConfiguredFn: async () => true,
    }),
    /s3 list 403/,
  );
});

test("fetchAllSharedRows: a real read failure (cGet throws on a non-404) propagates loudly, is never silently skipped like a genuine 404", async () => {
  await assert.rejects(
    fetchAllSharedRows({
      cListFn: async () => ["_MEMORY/_exec/cto.jsonl"],
      cGetFn: async () => { throw new Error("s3 get 403 (refusing to report a missing object as empty)"); },
      commonsConfiguredFn: async () => true,
    }),
    /s3 get 403/,
  );
});

test("fetchAllSharedRows: called with NO arguments defaults every dependency to the real commons-store facade (never a fake/stub), matching main()'s zero-arg call shape", async () => {
  // Deliberately NOT invoked here: calling the real facade would make a live network call against
  // production AWS (this sandbox, and presumably a real deployed seat, may have working credentials --
  // so it could even SUCCEED, which would make this an unwanted integration test masquerading as a
  // unit test, not a "throws without creds" assertion that only holds in a credential-less environment).
  // Instead, prove the WIRING statically: the function's own default-parameter expression must destructure
  // to the real cList/cGet/commonsConfigured imports, which the counterfactual guard test below confirms
  // are imported (and ONLY as read verbs) from commons-store.mjs.
  const src = readFileSync(TARGET_MJS, "utf8");
  const sig = src.match(/export async function fetchAllSharedRows\(([^)]*)\)/);
  assert.ok(sig, "fetchAllSharedRows's signature must be found in source");
  assert.match(sig[1], /cListFn\s*=\s*cList\b/, "cListFn must default to the real imported cList");
  assert.match(sig[1], /cGetFn\s*=\s*cGet\b/, "cGetFn must default to the real imported cGet");
  assert.match(sig[1], /commonsConfiguredFn\s*=\s*commonsConfigured\b/, "commonsConfiguredFn must default to the real imported commonsConfigured");
});

// ---- counterfactual guard: no Azure Blob SAS code remains in the ported file --------------------
test("mine-hard-negatives.mjs no longer hand-rolls an Azure Blob SAS (ported to the commons-store S3 facade, 2026-08-28)", () => {
  const src = readFileSync(TARGET_MJS, "utf8");
  // Strip comments before asserting absence, so this test cannot be satisfied by simply moving the
  // banned code into a comment describing what used to be here.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.doesNotMatch(stripped, /blob\.core\.windows\.net/, "must not construct any Azure Blob URL");
  assert.doesNotMatch(stripped, /buildSas|encPath\(/, "the old hand-rolled Azure SAS primitives must be gone");
  assert.doesNotMatch(stripped, /createHmac/, "must not sign its own SAS anymore");
  assert.doesNotMatch(stripped, /import crypto from "node:crypto"/, "the node:crypto import (only ever used by buildSas) must be gone");
  assert.doesNotMatch(stripped, /azure-commons-storage-(account|key)/, "must not read the old Azure Blob storage creds");
  assert.match(src, /from "\.\.\/kb-memory\/commons-store\.mjs"/, "must route storage through the shared commons-store facade");
  assert.match(stripped, /export async function fetchAllSharedRows/, "fetchAllSharedRows must be exported for direct unit testing");
});

test("mine-hard-negatives.mjs's commons-store import pulls in ONLY read verbs (cGet/cList/commonsConfigured), never a write verb", () => {
  const src = readFileSync(TARGET_MJS, "utf8");
  const importLine = src.split("\n").find((l) => l.includes('from "../kb-memory/commons-store.mjs"'));
  assert.ok(importLine, "the commons-store import line must exist");
  assert.match(importLine, /\bcGet\b/);
  assert.match(importLine, /\bcList\b/);
  assert.match(importLine, /\bcommonsConfigured\b/);
  assert.doesNotMatch(importLine, /\bcPut\b|\bcPutCond\b|\bcDel\b/, "this read-only miner must never import a commons-store write verb");
});

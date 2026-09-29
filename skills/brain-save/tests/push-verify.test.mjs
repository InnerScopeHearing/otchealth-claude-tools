import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { chunkDocsFor, rowForKey, pushObject, parentIdFor, _resetShapeCacheForTests } from "../lib/push.mjs";
import { chunkText, buildChunkDocs, countWords } from "../../doc-indexer/chunking.mjs";
import * as Indexer from "../../doc-indexer/indexer.mjs";
import { rankOf, idQueryFor, idQueriesFor, verifyInRoom, verifyViaGateway } from "../lib/verify.mjs";
import { parseGatewayToolResponse } from "../lib/backend.mjs";
import { createFakeBackend } from "./fake-backend.mjs";

const KEY = "_KNOWLEDGE/research/hey-millie/2026-09-26-hey-millie-visual-craft-research-a1b2c3d4.md";
const OBJECT = "---\nbrain_id: \"KN-RES-0123456789\"\n---\n# Title\n\n" + "Paragraph of words. ".repeat(400);

test("chunk parity: brain-save's chunk docs deep-equal what the nightly indexer builds for the same object", () => {
  const row = { path: KEY, entity: "_KNOWLEDGE", title: basename(KEY), sha256: createHash("sha256").update(Buffer.from(OBJECT, "utf8")).digest("hex") };
  const expected = buildChunkDocs(row, chunkText(OBJECT, { maxChunkSize: 2000, overlap: 200 }), { account: "otchealthcommons", container: "company-journal", wordCount: countWords(OBJECT) });
  assert.deepEqual(chunkDocsFor(KEY, OBJECT), expected);
  assert.deepEqual(rowForKey(KEY, OBJECT), row);
  assert.equal(expected[0].parent_id, createHash("sha1").update(KEY).digest("hex"));
  assert.equal(expected[0].path, `otchealthcommons/company-journal/${KEY}`);
  assert.ok(expected.length > 1);
});

test("indexer.mjs re-exports the SAME chunk helpers (no drift between tool and nightly)", () => {
  assert.equal(Indexer.chunkText, chunkText);
  assert.equal(Indexer.buildChunkDocs, buildChunkDocs);
  assert.ok(Indexer.SKIP_PREFIXES.includes("_KNOWLEDGE-META/"));
});

test("pushObject embeds ALL chunks before pushing any; a bulk failure deletes the parent's chunks", async () => {
  _resetShapeCacheForTests();
  const be = createFakeBackend();
  const { chunks } = await pushObject(be, KEY, OBJECT);
  assert.ok(chunks > 1);
  assert.equal(be.calls.embedTexts, chunks);
  assert.equal(be.room.size, chunks);
  _resetShapeCacheForTests();
  const bad = createFakeBackend({ failPush: true });
  await assert.rejects(pushObject(bad, KEY, OBJECT), /bulk push failed/);
  assert.equal(bad.calls.deleteByParent, 1);
  assert.equal(bad.room.size, 0);
});

test("pushObject refuses a room whose live mapping is not chunked (never creates or alters it)", async () => {
  _resetShapeCacheForTests();
  await assert.rejects(pushObject(createFakeBackend({ shape: "flat" }), KEY, OBJECT), /not "chunked"/);
  _resetShapeCacheForTests();
});

test("verify: brain_id+sha8 must be rank 1, title within top 10; retries; gateway proof", async () => {
  _resetShapeCacheForTests();
  const be = createFakeBackend();
  await pushObject(be, KEY, OBJECT.replace("# Title", "# KN-RES-0123456789 Hey Millie visual craft research"));
  // Version-unique token only: brain_id is shared by every version of a document and, with a best_fields
  // multi_match, made v1 outrank a freshly pushed v2 in the live room (verify round 1 defect).
  const FULL = "a1b2c3d4" + "e5f60718".repeat(7);
  const REF = createHash("sha1").update(KEY).digest("hex");
  // key_ref (sha1 of the KEY) first: unique per stored key even when two identities share a body
  // (adjudication round 2); the body's full hash is the fallback for objects saved before key_ref.
  assert.deepEqual(idQueriesFor("KN-RES-0123456789", KEY, FULL), [REF, FULL]);
  assert.equal(idQueryFor("KN-RES-0123456789", KEY, FULL), REF);
  assert.deepEqual(idQueriesFor("KN-RES-0123456789", KEY), [REF, "a1b2c3d4"]); // sha8 fallback
  assert.deepEqual(idQueriesFor("KN-RES-0123456789", "_KNOWLEDGE/x/y/nosha.md"), [createHash("sha1").update("_KNOWLEDGE/x/y/nosha.md").digest("hex"), "KN-RES-0123456789"]);
  const v = await verifyInRoom(be, { key: KEY, brainId: "KN-RES-0123456789", title: "Hey Millie visual craft research", retries: 1, delayMs: 0 });
  assert.equal(v.ok, true);
  assert.equal(v.idRank, 1);
  const g = await verifyViaGateway(be, { key: KEY, brainId: "KN-RES-0123456789", title: "Hey Millie visual craft research", retries: 1, delayMs: 0 });
  assert.equal(g.status, "ok");
  const miss = await verifyInRoom(createFakeBackend({ failSearch: true }), { key: KEY, brainId: "x", title: "y", retries: 2, delayMs: 0 });
  assert.equal(miss.ok, false);
  assert.equal((await verifyViaGateway(createFakeBackend({ gatewaySkip: true }), { key: KEY, brainId: "x", title: "y", retries: 1, delayMs: 0 })).status, "skipped");
  assert.equal((await verifyViaGateway(createFakeBackend({ gatewayMissing: true }), { key: KEY, brainId: "x", title: "y", retries: 1, delayMs: 0 })).status, "missing");
});

test("rankOf matches the room path, a bare key, or a suffix", () => {
  assert.equal(rankOf([{ path: "a" }, { path: `otchealthcommons/company-journal/${KEY}` }], KEY), 2);
  assert.equal(rankOf([{ path: KEY }], KEY), 1);
  assert.equal(rankOf([{ path: "x" }], KEY), 0);
});

test("gateway response parsing: structuredContent.result.matches, content[0].text JSON, and SSE data: lines", () => {
  const matches = [{ path: "p1" }];
  assert.deepEqual(parseGatewayToolResponse(JSON.stringify({ result: { structuredContent: { result: { matches } } } })).matches, matches);
  assert.deepEqual(parseGatewayToolResponse(JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ result: { matches } }) }] } })).matches, matches);
  const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ result: { index: "commons-company-journal", matches } }) }] } })}\n\n`;
  assert.deepEqual(parseGatewayToolResponse(sse).matches, matches);
  assert.equal(parseGatewayToolResponse("garbage"), null);
  assert.equal(parentIdFor(KEY), createHash("sha1").update(KEY).digest("hex"));
});

test("verify round 1 regressions: a letter-ending sha8 is not searchable, so the id proof uses the full content hash", async () => {
  _resetShapeCacheForTests();
  const key = "_KNOWLEDGE/research/fleet/2026-09-29-amber-kestrel-update-drill-836ff0fd.md"; // sha8 ends in a letter
  const full = "836ff0fd" + "0123abcd".repeat(7);
  const obj = `---\nbrain_id: "KN-RES-abdb65ef4e"\ncontent_sha256: "${full}"\n---\n# Amber Kestrel Update Drill\n\nFirst revision body.\n`;
  const be = createFakeBackend();
  await pushObject(be, key, obj);
  // sha8 alone finds nothing under the analyzer quirk ...
  assert.equal((await be.search({ queryText: "836ff0fd", top: 5 })).length, 0);
  // ... the full hash does, at rank 1 ...
  const v = await verifyInRoom(be, { key, brainId: "KN-RES-abdb65ef4e", contentSha: full, title: "Amber Kestrel Update Drill", retries: 1, delayMs: 0 });
  assert.equal(v.idRank, 1);
  assert.equal(v.ok, true);
});

test("verify round 1 regressions: v2 shares v1's brain_id, so the id proof must not depend on brain_id", async () => {
  _resetShapeCacheForTests();
  const k1 = "_KNOWLEDGE/research/fleet/2026-09-29-notes-64f9e1d6.md";
  const k2 = "_KNOWLEDGE/research/fleet/2026-09-29-notes-7b9125e0.md";
  const f1 = "64f9e1d6" + "0".repeat(56), f2 = "7b9125e0" + "1".repeat(56);
  const be = createFakeBackend();
  const mk = (full, extra) => `---\nbrain_id: "KN-RES-56e4263d1c"\ncontent_sha256: "${full}"\n---\n# Notes\n\nBody.${extra}\n`;
  await pushObject(be, k1, mk(f1, ""));
  _resetShapeCacheForTests();
  await pushObject(be, k2, mk(f2, " Revision two adds more words here."));
  const v2 = await verifyInRoom(be, { key: k2, brainId: "KN-RES-56e4263d1c", contentSha: f2, title: "Notes", retries: 1, delayMs: 0 });
  assert.equal(v2.idRank, 1);
  assert.equal(idQueryFor("KN-RES-56e4263d1c", k2, f2).includes("KN-RES"), false);
});

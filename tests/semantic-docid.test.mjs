// Unit tests for kb-memory semantic.mjs docId(). It must be deterministic (so reindex is idempotent:
// same entry -> same key -> mergeOrUpload, never a duplicate) and produce only Azure-AI-Search-legal
// document keys ([A-Za-z0-9_-=]). Pure function, no I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { docId } from "../skills/kb-memory/semantic.mjs";

const KEY_OK = /^[A-Za-z0-9_\-=]+$/; // Azure AI Search allowed doc-key charset

test("docId is deterministic (same inputs -> same key)", () => {
  assert.equal(docId("cto", "20260621-001"), docId("cto", "20260621-001"));
  assert.equal(docId("cto", "20260621-001"), "cto__20260621-001");
});

test("docId joins agent and id with __ and preserves dash/equals", () => {
  assert.equal(docId("clo", "20260621-042"), "clo__20260621-042");
  assert.match(docId("cfo", "2026=1"), KEY_OK);
});

test("docId sanitizes any char outside the Azure key charset", () => {
  const id = docId("clo-personal", "matter/2026:note 7");
  assert.match(id, KEY_OK, "result must be a valid Azure document key");
  assert.ok(!/[/:\s]/.test(id), "slash, colon, and space must be replaced");
});

test("distinct realistic (agent,id) pairs produce distinct keys (collision-safe)", () => {
  const ids = [
    docId("cto", "20260621-001"),
    docId("cfo", "20260621-001"), // same id, different agent
    docId("cto", "20260621-002"), // same agent, different id
    docId("clo", "20260621-001"),
  ];
  assert.equal(new Set(ids).size, ids.length, "no collisions across realistic agents/ids");
});

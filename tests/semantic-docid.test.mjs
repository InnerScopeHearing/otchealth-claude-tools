// Unit tests for kb-memory semantic.mjs docId(). It must be deterministic (so reindex is idempotent:
// same entry -> same key -> mergeOrUpload, never a duplicate) and produce only Azure-AI-Search-legal
// document keys ([A-Za-z0-9_-=]). Pure function, no I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { docId, assignDocIds } from "../skills/kb-memory/semantic.mjs";

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

// ── assignDocIds(): the gs-10 id-collision fix (injective, minimal-churn, idempotent) ──────────────
const E = (agent, id, text, type = "fact") => ({ _agent: agent, id, text, type });

test("assignDocIds: unique entries KEEP the bare agent__id key (zero churn on healthy docs)", () => {
  const es = [E("cto", "20260717-001-ab", "alpha"), E("cto", "20260717-002-cd", "beta"), E("cfo", "20260717-001-ef", "gamma")];
  const collided = assignDocIds(es);
  assert.equal(collided.size, 0, "no collisions");
  assert.equal(es[0]._docId, "cto__20260717-001-ab");
  assert.equal(es[1]._docId, "cto__20260717-002-cd");
  assert.equal(es[2]._docId, "cfo__20260717-001-ef");
});

test("assignDocIds: a genuine collision (same agent+id, DIFFERENT text) yields TWO distinct keys (gs-10)", () => {
  // The exact gs-10 shape: cto id 20260701-044 held BOTH a GitHub pitfall AND an AWS decision.
  const es = [
    E("cto", "20260701-044", "Using GitHub as the agent team's memory is the wrong substrate", "pitfall"),
    E("cto", "20260701-044", "AWS access upgraded: cto-hyperagent IAM user", "decision"),
  ];
  const collided = assignDocIds(es);
  assert.ok(collided.has("cto__20260701-044"), "the base key is reported as collided so reindex prunes it");
  assert.notEqual(es[0]._docId, es[1]._docId, "the two distinct facts must get distinct index keys");
  assert.ok(es[0]._docId.startsWith("cto__20260701-044__"), "keeps the base key as a prefix");
  assert.ok(es[1]._docId.startsWith("cto__20260701-044__"));
  assert.match(es[0]._docId, /^[A-Za-z0-9_\-=]+$/, "still a valid Azure key");
  assert.match(es[1]._docId, /^[A-Za-z0-9_\-=]+$/);
});

test("assignDocIds: same-text entries under one base key COLLAPSE (correctly the same fact, not a collision)", () => {
  const es = [E("cto", "20260701-050", "identical text"), E("cto", "20260701-050", "identical text")];
  const collided = assignDocIds(es);
  assert.equal(collided.size, 0, "identical text is a true duplicate, not a suppressed distinct fact");
  assert.equal(es[0]._docId, es[1]._docId, "they share one key (mergeOrUpload dedups them)");
  assert.equal(es[0]._docId, "cto__20260701-050");
});

test("assignDocIds: injective over distinct facts + stable across runs", () => {
  const mk = () => [
    E("cto", "20260701-044", "github pitfall", "pitfall"),
    E("cto", "20260701-044", "aws decision", "decision"),
    E("cto", "20260701-045-xy", "unrelated"),
    E("coo", "20260627-014", "iheartest build", "fact"),
    E("coo", "20260627-014", "datadog launched", "fact"),
  ];
  const a = mk(); assignDocIds(a);
  assert.equal(new Set(a.map((e) => e._docId)).size, a.length, "every distinct fact gets a distinct key");
  const b = mk(); assignDocIds(b);
  assert.deepEqual(a.map((e) => e._docId), b.map((e) => e._docId), "deterministic: same input -> same keys");
});

test("assignDocIds: entries without an id are skipped (no _docId, no throw)", () => {
  const es = [E("cto", "", "no id"), { _agent: "cto", text: "missing id field" }];
  assert.doesNotThrow(() => assignDocIds(es));
  assert.equal(es[0]._docId, undefined);
});

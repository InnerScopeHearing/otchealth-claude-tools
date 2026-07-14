import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSchemaAdditive } from "../skills/doc-indexer/schema-merge.mjs";

// The exact daily-digest failure (2026-07-13): a pre-indexed_at code schema PUT against a live index
// that already has indexed_at => Azure 400 "Existing field(s) 'indexed_at' cannot be deleted".
test("preserves a live-only field the code schema lacks (the daily-digest indexed_at bug)", () => {
  const desired = { name: "commons", fields: [{ name: "id", type: "Edm.String", key: true }, { name: "content", type: "Edm.String" }] };
  const live = { fields: [{ name: "id", type: "Edm.String", key: true }, { name: "content", type: "Edm.String" }, { name: "indexed_at", type: "Edm.DateTimeOffset", sortable: true }] };
  const out = mergeSchemaAdditive(desired, live);
  const names = out.fields.map((f) => f.name);
  assert.ok(names.includes("indexed_at"), "indexed_at must be preserved so the PUT is not a field deletion");
  assert.equal(names.length, 3);
});

test("adds a code-only new field the live index lacks", () => {
  const desired = { name: "x", fields: [{ name: "id" }, { name: "brandnew" }] };
  const live = { fields: [{ name: "id" }] };
  const out = mergeSchemaAdditive(desired, live);
  assert.deepEqual(out.fields.map((f) => f.name).sort(), ["brandnew", "id"]);
});

test("shared fields keep the LIVE definition (never triggers a 'cannot change field' 400)", () => {
  const desired = { name: "x", fields: [{ name: "title", type: "Edm.String", searchable: true, sortable: true }] };
  const live = { fields: [{ name: "title", type: "Edm.String", searchable: true /* not sortable on the live index */ }] };
  const out = mergeSchemaAdditive(desired, live);
  assert.equal(out.fields[0].sortable, undefined, "live def wins for shared fields");
});

test("no live index (first-ever create) returns the desired schema unchanged", () => {
  const desired = { name: "x", fields: [{ name: "id" }, { name: "indexed_at" }] };
  assert.equal(mergeSchemaAdditive(desired, null), desired);
  assert.equal(mergeSchemaAdditive(desired, { fields: [] }), desired);
  assert.equal(mergeSchemaAdditive(desired, {}), desired);
});

test("top-level schema (vectorSearch/semantic/name) is carried through the merge", () => {
  const desired = { name: "x", fields: [{ name: "id" }], vectorSearch: { k: 1 }, semantic: { s: 2 } };
  const live = { fields: [{ name: "id" }, { name: "extra" }] };
  const out = mergeSchemaAdditive(desired, live);
  assert.equal(out.name, "x");
  assert.deepEqual(out.vectorSearch, { k: 1 });
  assert.deepEqual(out.semantic, { s: 2 });
});

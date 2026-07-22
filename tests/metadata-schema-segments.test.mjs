// Unit tests for the field/passage-level confidentiality classification pack (Wave 7 item 7.4,
// 2026-07-22): metadata-schema.mjs's SEGMENT_CONFIDENTIALITY_* section. Pure logic only (no I/O, no
// network, no live Azure OpenAI creds needed) -- covers schema shape, field wiring into the right
// domains, and the sanitize/encode/merge functions that enrich.mjs's enrichOne() calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as MS from "../skills/doc-indexer/metadata-schema.mjs";

// ============================ enum + domain wiring ============================
test("SEGMENT_LABEL enum covers the task's example labels plus a routine/other catch-all", () => {
  const labels = MS.ENUMS.SEGMENT_LABEL;
  assert.ok(Array.isArray(labels) && labels.length > 0);
  for (const expect of ["unreleased_financials", "attorney_work_product", "routine_operational"]) {
    assert.ok(labels.includes(expect), `expected ${expect} in SEGMENT_LABEL`);
  }
  assert.equal(new Set(labels).size, labels.length, "no duplicate labels");
});

test("SEGMENT_CONFIDENTIALITY_DOMAINS is exactly finance + legal", () => {
  assert.equal(MS.SEGMENT_CONFIDENTIALITY_DOMAINS.has("finance"), true);
  assert.equal(MS.SEGMENT_CONFIDENTIALITY_DOMAINS.has("legal"), true);
  assert.equal(MS.SEGMENT_CONFIDENTIALITY_DOMAINS.has("commerce"), false);
  assert.equal(MS.SEGMENT_CONFIDENTIALITY_DOMAINS.has("commons"), false);
  assert.equal(MS.SEGMENT_CONFIDENTIALITY_DOMAINS.size, 2);
});

test("fieldsForDomain('finance') and ('legal') include exactly the 3 new fields with correct kinds", () => {
  for (const domain of ["finance", "legal"]) {
    const names = MS.fieldsForDomain(domain).map((f) => f.name);
    assert.ok(names.includes("sensitive_segments"), `${domain} missing sensitive_segments`);
    assert.ok(names.includes("sensitive_labels"), `${domain} missing sensitive_labels`);
    assert.ok(names.includes("mixed_confidentiality"), `${domain} missing mixed_confidentiality`);
  }
  const financeFields = MS.fieldsForDomain("finance");
  const bySegName = Object.fromEntries(financeFields.map((f) => [f.name, f]));
  assert.equal(bySegName.sensitive_segments.kind, "list");
  assert.equal(bySegName.sensitive_labels.kind, "list");
  assert.equal(bySegName.sensitive_labels.enumKey, "SEGMENT_LABEL");
  assert.equal(bySegName.mixed_confidentiality.kind, "bool");
  // legal shares the exact same pack object today (both point at SEGMENT_CONFIDENTIALITY_FIELDS)
  assert.deepEqual(
    MS.fieldsForDomain("legal").map((f) => f.name),
    MS.fieldsForDomain("finance").map((f) => f.name),
  );
});

test("commerce and commons never carry the segment-confidentiality fields (not privileged-ring content)", () => {
  for (const domain of ["commerce", "commons", "some-unregistered-domain"]) {
    const names = MS.fieldsForDomain(domain).map((f) => f.name);
    assert.ok(!names.includes("sensitive_segments"), `${domain} should not carry sensitive_segments`);
    assert.ok(!names.includes("sensitive_labels"), `${domain} should not carry sensitive_labels`);
    assert.ok(!names.includes("mixed_confidentiality"), `${domain} should not carry mixed_confidentiality`);
  }
});

// ============================ Azure field-definition shape ============================
test("azureFieldDef: sensitive_segments is retrievable-only (audit trail, not a search/filter surface)", () => {
  const f = MS.SEGMENT_CONFIDENTIALITY_FIELDS.find((x) => x.name === "sensitive_segments");
  const def = MS.azureFieldDef(f);
  assert.equal(def.searchable, false);
  assert.equal(def.filterable, false);
  assert.equal(def.facetable, false);
  assert.equal(def.retrievable, true);
});

test("azureFieldDef: sensitive_labels is searchable + filterable + facetable (the human/agent query surface)", () => {
  const f = MS.SEGMENT_CONFIDENTIALITY_FIELDS.find((x) => x.name === "sensitive_labels");
  const def = MS.azureFieldDef(f);
  assert.equal(def.searchable, true);
  assert.equal(def.filterable, true);
  assert.equal(def.facetable, true);
});

test("azureFieldDef: mixed_confidentiality is a filterable/facetable boolean", () => {
  const f = MS.SEGMENT_CONFIDENTIALITY_FIELDS.find((x) => x.name === "mixed_confidentiality");
  const def = MS.azureFieldDef(f);
  assert.equal(f.type, "Edm.Boolean");
  assert.equal(def.filterable, true);
  assert.equal(def.facetable, true);
});

test("indexerFieldMapping: the two list fields get jsonArrayToStringCollection, the boolean does not", () => {
  const segs = MS.SEGMENT_CONFIDENTIALITY_FIELDS.find((x) => x.name === "sensitive_segments");
  const labels = MS.SEGMENT_CONFIDENTIALITY_FIELDS.find((x) => x.name === "sensitive_labels");
  const mixed = MS.SEGMENT_CONFIDENTIALITY_FIELDS.find((x) => x.name === "mixed_confidentiality");
  assert.equal(MS.indexerFieldMapping(segs).mappingFunction?.name, "jsonArrayToStringCollection");
  assert.equal(MS.indexerFieldMapping(labels).mappingFunction?.name, "jsonArrayToStringCollection");
  assert.equal(MS.indexerFieldMapping(mixed).mappingFunction, undefined);
});

test("projectionMapping: each new field projects from /document/<name> onto every chunk row", () => {
  for (const f of MS.SEGMENT_CONFIDENTIALITY_FIELDS) {
    const m = MS.projectionMapping(f);
    assert.equal(m.name, f.name);
    assert.equal(m.source, `/document/${f.name}`);
  }
});

// ============================ sanitizeSegments ============================
test("sanitizeSegments: non-array input returns []", () => {
  assert.deepEqual(MS.sanitizeSegments(undefined), []);
  assert.deepEqual(MS.sanitizeSegments(null), []);
  assert.deepEqual(MS.sanitizeSegments("not an array"), []);
  assert.deepEqual(MS.sanitizeSegments({ label: "x" }), []);
});

test("sanitizeSegments: drops items with an unrecognized or missing label", () => {
  const out = MS.sanitizeSegments([
    { label: "not_a_real_label", locator_excerpt: "some verbatim text here" },
    { locator_excerpt: "no label at all here" },
    { label: "", locator_excerpt: "empty label string" },
  ]);
  assert.deepEqual(out, []);
});

test("sanitizeSegments: drops items with no locatable excerpt (label alone is not actionable)", () => {
  const out = MS.sanitizeSegments([
    { label: "attorney_work_product", locator_excerpt: "" },
    { label: "attorney_work_product" },
    { label: "attorney_work_product", locator_excerpt: "   " },
  ]);
  assert.deepEqual(out, []);
});

test("sanitizeSegments: accepts a valid item, normalizes label case, accepts the `locator` alias key", () => {
  const out = MS.sanitizeSegments([
    { label: "Unreleased_Financials", locator_excerpt: "revenue is expected to be approximately 4.2 million dollars", rationale: "specific unreleased figure" },
    { label: "personal_pii", locator: "SSN 123-45-6789 belongs to the borrower" }, // no locator_excerpt key, has locator instead
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].label, "unreleased_financials"); // coerced to the canonical lowercase form
  assert.equal(out[0].rationale, "specific unreleased figure");
  assert.equal(out[1].label, "personal_pii");
  assert.equal(out[1].locator_excerpt, "SSN 123-45-6789 belongs to the borrower");
  assert.equal(out[1].rationale, ""); // rationale is optional, defaults to ""
});

test("sanitizeSegments: caps to maxItems (default 6)", () => {
  const raw = Array.from({ length: 20 }, (_, i) => ({ label: "other_sensitive", locator_excerpt: `excerpt number ${i} of the passage text` }));
  assert.equal(MS.sanitizeSegments(raw).length, 6);
  assert.equal(MS.sanitizeSegments(raw, 3).length, 3);
  assert.equal(MS.sanitizeSegments(raw, 20).length, 20);
});

test("sanitizeSegments: caps locator_excerpt and rationale to safe lengths (never unbounded LLM text)", () => {
  const longExcerpt = "x".repeat(1000);
  const longRationale = "y".repeat(1000);
  const [seg] = MS.sanitizeSegments([{ label: "strategic_plan", locator_excerpt: longExcerpt, rationale: longRationale }]);
  assert.ok(seg.locator_excerpt.length <= 220, `locator_excerpt too long: ${seg.locator_excerpt.length}`);
  assert.ok(seg.rationale.length <= 140, `rationale too long: ${seg.rationale.length}`);
});

test("sanitizeSegments: never invents or fabricates a label the model did not supply", () => {
  // A missing/garbage label must never silently become e.g. "other_sensitive" -- the item is DROPPED,
  // not guessed at (mirrors coerceEnum's "fallback, never fabricate" discipline used elsewhere).
  const out = MS.sanitizeSegments([{ label: "totally_made_up", locator_excerpt: "some text" }]);
  assert.deepEqual(out, []);
});

// ============================ encodeSegments ============================
test("encodeSegments: each element is a JSON string that round-trips to the original object", () => {
  const segments = [
    { label: "unreleased_financials", locator_excerpt: "abc", rationale: "r1" },
    { label: "personal_pii", locator_excerpt: "def", rationale: "r2" },
  ];
  const encoded = MS.encodeSegments(segments);
  assert.equal(encoded.length, 2);
  for (const s of encoded) assert.equal(typeof s, "string");
  assert.deepEqual(encoded.map((s) => JSON.parse(s)), segments);
});

test("encodeSegments: non-array input returns []", () => {
  assert.deepEqual(MS.encodeSegments(undefined), []);
  assert.deepEqual(MS.encodeSegments(null), []);
});

// ============================ buildSegmentFields (the full merge, what enrich.mjs actually calls) ============================
test("buildSegmentFields: no segments -> mixed_confidentiality false, both lists empty", () => {
  for (const input of [[], undefined, null, "garbage"]) {
    const out = MS.buildSegmentFields(input);
    assert.deepEqual(out, { sensitive_segments: [], sensitive_labels: [], mixed_confidentiality: false });
  }
});

test("buildSegmentFields: valid segments -> mixed_confidentiality true, sensitive_labels deduped", () => {
  const raw = [
    { label: "unreleased_financials", locator_excerpt: "figure one appears in paragraph three of the memo" },
    { label: "unreleased_financials", locator_excerpt: "a second, different unreleased figure appears later on" },
    { label: "attorney_work_product", locator_excerpt: "counsel's draft analysis of litigation exposure follows" },
  ];
  const out = MS.buildSegmentFields(raw);
  assert.equal(out.mixed_confidentiality, true);
  assert.equal(out.sensitive_segments.length, 3, "one encoded entry per surviving segment, duplicates included");
  assert.deepEqual(out.sensitive_labels.sort(), ["attorney_work_product", "unreleased_financials"], "labels deduped");
  for (const s of out.sensitive_segments) JSON.parse(s); // must not throw
});

test("buildSegmentFields: an unusable raw array (all items invalid) still resolves to the empty/false shape", () => {
  const out = MS.buildSegmentFields([{ label: "bogus" }, { locator_excerpt: "no label" }]);
  assert.deepEqual(out, { sensitive_segments: [], sensitive_labels: [], mixed_confidentiality: false });
});

test("buildSegmentFields: respects a maxItems override", () => {
  const raw = Array.from({ length: 10 }, (_, i) => ({ label: "other_sensitive", locator_excerpt: `passage excerpt number ${i} of the doc` }));
  const out = MS.buildSegmentFields(raw, 2);
  assert.equal(out.sensitive_segments.length, 2);
});

// ============================ segmentClassificationPromptBlock ============================
test("segmentClassificationPromptBlock: mentions the field name and every SEGMENT_LABEL value", () => {
  const block = MS.segmentClassificationPromptBlock();
  assert.ok(block.includes('"sensitive_segments"'));
  for (const label of MS.ENUMS.SEGMENT_LABEL) {
    assert.ok(block.includes(label), `prompt block missing label ${label}`);
  }
});

test("segmentClassificationPromptBlock: has no trailing comma (splices in as the LAST schema field)", () => {
  const block = MS.segmentClassificationPromptBlock().trimEnd();
  assert.ok(!block.endsWith(","), "block must not end with a comma so `schema.replace(/\\}$/, ...)` stays valid-looking");
  assert.ok(block.endsWith(")"), "block should close its parenthetical guidance");
});

test("segmentClassificationPromptBlock: splices cleanly into a trailing-brace schema with balanced braces", () => {
  let schema = `{\n "doc_title": "x"\n}`;
  schema = schema.replace(/\}$/, `,\n ${MS.segmentClassificationPromptBlock()}\n}`);
  const opens = (schema.match(/\{/g) || []).length;
  const closes = (schema.match(/\}/g) || []).length;
  assert.equal(opens, closes, "brace count must stay balanced after the splice");
  assert.ok(schema.trim().endsWith("}"));
});

// ============================ metadata byte-budget guard ============================
test("fitMetadataBudget: an oversized sensitive_segments payload is shrunk before other fields when over budget", () => {
  const pairs = {
    sensitive_segments: JSON.stringify(Array.from({ length: 6 }, (_, i) => `{"label":"other_sensitive","locator_excerpt":"${"z".repeat(1400)}${i}","rationale":"r"}`)),
    doc_title: "a short title",
  };
  const before = pairs.sensitive_segments.length;
  assert.ok(before > 7200, "test fixture must itself exceed the 7200B budget to exercise the shrink path");
  const { pairs: after, overBudget } = MS.fitMetadataBudget({ ...pairs });
  assert.ok(after.sensitive_segments.length < before, "sensitive_segments should have been shrunk under budget pressure");
  assert.equal(overBudget, false);
});

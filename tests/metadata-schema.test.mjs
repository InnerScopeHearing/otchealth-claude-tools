// Pure-logic coverage for skills/doc-indexer/metadata-schema.mjs, the field-definition layer behind
// the S1 brain metadata-enrichment pipeline (enrich.mjs). Had ZERO dedicated tests before this file,
// despite backing the exact rollout decision in this workstream: "commerce is fully built out; is it
// SAFE to flip ENRICH=1 for finance/legal/commons before their domain packs exist." These tests prove
// the graceful-degradation contract that makes that safe (fieldsForDomain/enumFor fall back cleanly
// for a domain with no DOMAIN_PACKS entry) and spot-check the value-safety helpers the enrichment
// pipeline leans on (never a fabricated date, never an over-budget blob-metadata write).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as MS from "../skills/doc-indexer/metadata-schema.mjs";

test("UNIVERSAL_FIELDS has exactly the 22 fields the design + enrich.mjs both assume", () => {
  assert.equal(MS.UNIVERSAL_FIELDS.length, 22);
});

test("fieldsForDomain falls back to universal-core ONLY for a domain with no DOMAIN_PACKS entry", () => {
  // commons is still an explicitly-commented-out TODO in DOMAIN_PACKS today -- this is the exact
  // behavior that makes rolling ENRICH=1 out to it safe before its pack is built. finance/legal now
  // carry the field/passage-level confidentiality-classification pack (Wave 7 item 7.4), see the
  // dedicated test below; their FULL domain packs (materiality/counterparty/etc) remain a separate
  // future TODO.
  for (const domain of ["commons", "some-domain-that-will-never-exist"]) {
    const fields = MS.fieldsForDomain(domain);
    assert.equal(fields.length, MS.UNIVERSAL_FIELDS.length, `fieldsForDomain(${domain}) must be universal-core only`);
    assert.deepEqual(fields.map((f) => f.name), MS.UNIVERSAL_FIELDS.map((f) => f.name));
  }
});

test("fieldsForDomain adds the field/passage-level confidentiality pack ON TOP of universal-core for finance/legal (Wave 7 item 7.4)", () => {
  for (const domain of ["finance", "legal"]) {
    const fields = MS.fieldsForDomain(domain);
    assert.equal(fields.length, MS.UNIVERSAL_FIELDS.length + MS.SEGMENT_CONFIDENTIALITY_FIELDS.length, `fieldsForDomain(${domain}) must be universal-core plus the segment-confidentiality pack`);
    for (const f of MS.SEGMENT_CONFIDENTIALITY_FIELDS) assert.ok(fields.some((x) => x.name === f.name), `missing segment-confidentiality field ${f.name} for domain ${domain}`);
  }
});

test("fieldsForDomain adds the commerce pack ON TOP of universal-core for commerce", () => {
  const fields = MS.fieldsForDomain("commerce");
  assert.equal(fields.length, MS.UNIVERSAL_FIELDS.length + MS.COMMERCE_FIELDS.length);
  for (const f of MS.COMMERCE_FIELDS) assert.ok(fields.some((x) => x.name === f.name), `missing commerce field ${f.name}`);
});

test("enumFor(DOC_TYPE) falls back to the commerce enum for a domain with no DOC_TYPE array of its own", () => {
  // docTypeEnumFor()'s fallback is what stops enrich.mjs's coerceEnum() from silently forcing every
  // finance/legal/commons doc_type to "other" the moment ENRICH=1 is set on those rooms.
  const docTypeField = { enumKey: "DOC_TYPE" };
  assert.deepEqual(MS.enumFor(docTypeField, "finance"), MS.ENUMS.DOC_TYPE.commerce);
  assert.deepEqual(MS.enumFor(docTypeField, "commons"), MS.ENUMS.DOC_TYPE.commerce);
  assert.deepEqual(MS.enumFor(docTypeField, "commerce"), MS.ENUMS.DOC_TYPE.commerce);
});

test("enumFor returns null for a field with no enumKey or a falsy field", () => {
  assert.equal(MS.enumFor({ name: "summary" }, "commerce"), null);
  assert.equal(MS.enumFor(null, "commerce"), null);
});

test("enumFor resolves a global (non-DOC_TYPE) enum the same for every domain", () => {
  const confidentialityField = { enumKey: "CONFIDENTIALITY" };
  assert.deepEqual(MS.enumFor(confidentialityField, "finance"), MS.ENUMS.CONFIDENTIALITY);
  assert.deepEqual(MS.enumFor(confidentialityField, "legal"), MS.ENUMS.CONFIDENTIALITY);
});

test("azureFieldDef marks a list field searchable/filterable/facetable per its descriptor, never sortable", () => {
  const def = MS.azureFieldDef({ name: "keywords", type: "Collection(Edm.String)", kind: "list", searchable: true, filterable: true, facetable: true });
  assert.equal(def.type, "Collection(Edm.String)");
  assert.equal(def.searchable, true);
  assert.equal(def.filterable, true);
  assert.equal(def.facetable, true);
  assert.equal("sortable" in def, false);
});

test("indexerFieldMapping adds jsonArrayToStringCollection ONLY for list-kind fields", () => {
  const listMap = MS.indexerFieldMapping({ name: "keywords", kind: "list" });
  assert.equal(listMap.sourceFieldName, "keywords");
  assert.equal(listMap.targetFieldName, "keywords");
  assert.deepEqual(listMap.mappingFunction, { name: "jsonArrayToStringCollection" });

  const scalarMap = MS.indexerFieldMapping({ name: "doc_title", kind: "scalar" });
  assert.equal("mappingFunction" in scalarMap, false);
});

test("projectionMapping points at /document/<name>", () => {
  assert.deepEqual(MS.projectionMapping({ name: "doc_title" }), { name: "doc_title", source: "/document/doc_title" });
});

test("coerceEnum matches case-insensitively and falls back for an unrecognized value", () => {
  assert.equal(MS.coerceEnum("HIGH", ["high", "medium", "low"], "medium"), "high");
  assert.equal(MS.coerceEnum("nonsense", ["high", "medium", "low"], "medium"), "medium");
  assert.equal(MS.coerceEnum(null, ["high", "medium", "low"], "medium"), "medium");
});

test("validDateOrEmpty NEVER trusts a calendar-invalid date (the design's 'never a fabricated date' rule)", () => {
  assert.equal(MS.validDateOrEmpty("2026-02-30"), "");
  assert.equal(MS.validDateOrEmpty("not a date"), "");
  assert.equal(MS.validDateOrEmpty(""), "");
  assert.equal(MS.validDateOrEmpty(null), "");
});

test("validDateOrEmpty accepts a real calendar date and returns ISO 8601", () => {
  const iso = MS.validDateOrEmpty("2026-07-21");
  assert.match(iso, /^2026-07-21T/);
});

test("parseAmount reads currency + numeric value from free text without trusting LLM arithmetic", () => {
  assert.deepEqual(MS.parseAmount("$1,234.50"), { amount: 1234.5, currency: "USD" });
  assert.deepEqual(MS.parseAmount("100k EUR"), { amount: 100, currency: "EUR" });
  assert.deepEqual(MS.parseAmount(""), { amount: null, currency: "" });
});

test("fitMetadataBudget leaves small payloads untouched", () => {
  const pairs = { doc_title: "A Short Title", word_count: "500" };
  const { pairs: out, overBudget } = MS.fitMetadataBudget({ ...pairs });
  assert.deepEqual(out, pairs);
  assert.equal(overBudget, false);
});

test("fitMetadataBudget shrinks the largest free-text field first to stay under Azure's 8KB blob-metadata cap", () => {
  const bigPrefix = "x".repeat(9000);
  const { pairs, bytes, overBudget } = MS.fitMetadataBudget({ contextual_prefix: bigPrefix, doc_type: "vendor_contract" });
  assert.ok(pairs.contextual_prefix.length < bigPrefix.length, "contextual_prefix must be shrunk");
  assert.ok(bytes <= 7200 || !overBudget, "must end at or under the budget when shrinkable");
  assert.equal(pairs.doc_type, "vendor_contract", "non-shrinkable enum field must be left alone");
});

test("applyContextualPrefix is idempotent (never double-prepends on a re-run)", () => {
  const once = MS.applyContextualPrefix("Original body text.", "This is a contract with Acme.");
  assert.match(once, /^<!-- CTX-PREFIX v1 -->/);
  const twice = MS.applyContextualPrefix(once, "A different prefix that must NOT be applied again.");
  assert.equal(twice, once);
});

// ============================ openSearchDocFields ============================
// The OpenSearch-backed counterpart to enrich.mjs's Azure metaPairs loop: same omit-empty rules,
// but native JS types (real arrays/booleans), never the Azure blob-metadata string encoding.

test("openSearchDocFields: list fields become real arrays, never a JSON-stringified string", () => {
  const doc = MS.openSearchDocFields({ keywords: ["shopify", "theme"], entities: [] }, "commerce");
  assert.deepEqual(doc.keywords, ["shopify", "theme"]);
  assert.equal("entities" in doc, false, "an empty list must be omitted, not written as []");
});

test("openSearchDocFields: boolean fields are ALWAYS included, even when false (mirrors Azure's metaPairs asymmetry)", () => {
  const doc = MS.openSearchDocFields({ mnpi_flag: false, signed: true }, "commerce");
  assert.equal(doc.mnpi_flag, false);
  assert.equal(typeof doc.mnpi_flag, "boolean", "must be a real boolean, not the string \"false\"");
  assert.equal(doc.signed, true);
});

test("openSearchDocFields: numeric fields are omitted when not finite, included (even 0) when they are", () => {
  const doc = MS.openSearchDocFields({ price_amount: 0, word_count: NaN }, "commerce");
  assert.equal(doc.price_amount, 0);
  assert.equal("word_count" in doc, false);
});

test("openSearchDocFields: date fields pass through the ISO string unchanged, empty string omitted", () => {
  const doc = MS.openSearchDocFields({ doc_date: "2026-07-21T00:00:00.000Z", last_verified_date: "" }, "commerce");
  assert.equal(doc.doc_date, "2026-07-21T00:00:00.000Z");
  assert.equal("last_verified_date" in doc, false);
});

test("openSearchDocFields: scalar strings included when non-empty, omitted when empty/missing", () => {
  const doc = MS.openSearchDocFields({ doc_title: "Index", summary: "" }, "commerce");
  assert.equal(doc.doc_title, "Index");
  assert.equal("summary" in doc, false);
});

test("openSearchDocFields: only projects fields that belong to the given domain (commerce-only fields absent for a domain without that pack)", () => {
  const doc = MS.openSearchDocFields({ doc_title: "X", channel: "shopify" }, "commons");
  assert.equal(doc.doc_title, "X");
  assert.equal("channel" in doc, false, "commons has no commerce pack, so 'channel' is not a field of that domain");
});

test("openSearchDocFields: a null/undefined fields object yields an empty doc rather than throwing", () => {
  assert.deepEqual(MS.openSearchDocFields(null, "commerce"), {});
  assert.deepEqual(MS.openSearchDocFields(undefined, "commerce"), {});
});

test("openSearchDocFields: round-trips a realistic full commerce fields object with every kind represented", () => {
  const fields = {
    doc_title: "Master Shopify Library - Index", doc_type: "other", summary: "An index.",
    keywords: ["shopify", "theme"], entity: "Company", entities: ["OTCHealthMart"],
    doc_date: "2026-07-13T00:00:00.000Z", mnpi_flag: false, signed: false,
    word_count: 486, price_amount: null, currency: "", channel: "shopify", brand: "n_a",
  };
  const doc = MS.openSearchDocFields(fields, "commerce");
  assert.equal(doc.doc_title, "Master Shopify Library - Index");
  assert.deepEqual(doc.keywords, ["shopify", "theme"]);
  assert.equal(doc.mnpi_flag, false);
  assert.equal(doc.signed, false);
  assert.equal(doc.word_count, 486);
  assert.equal("price_amount" in doc, false);
  assert.equal("currency" in doc, false);
  assert.equal(doc.channel, "shopify");
  assert.equal(doc.brand, "n_a");
});

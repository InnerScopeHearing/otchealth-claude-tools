// metadata-schema.mjs — pure, dependency-free field-definition layer for the S1 brain ENRICHMENT
// pipeline (2026-07-21, see runbooks/metadata-schema-research-2026-07-20/00-METADATA-SCHEMA-DESIGN.md
// in otchealth-cto for the full design). Defines the 22-field universal core + per-domain packs
// (commerce implemented; finance/legal/commons are stubs -- add their field arrays here when that
// room's wide rollout is scoped, same shape as COMMERCE_FIELDS) and every helper needed to:
//   - build an Azure AI Search field definition from a field descriptor (azureFieldDef)
//   - build the S1 blob INDEXER's fieldMappings entry that projects a blob-metadata key onto the
//     enriched document tree (indexerFieldMapping) -- verified live 2026-07-21 that Azure Blob
//     indexers surface CUSTOM blob metadata under the BARE key name (no "metadata_" prefix; that
//     prefix is reserved for the fixed set of auto-extracted content properties like
//     metadata_storage_name). Collections are metadata-encoded as a JSON array STRING and converted
//     back to Collection(Edm.String) via the built-in `jsonArrayToStringCollection` mapping function
//     -- also verified live against a disposable throwaway index before this file was written.
//   - build the skillset's index-projection mapping that copies an enriched-document field onto every
//     CHUNK row (projectionMapping) -- the same mechanism the live skillset already uses for
//     title/path (metadata_storage_name -> /document/title -> projected "title" on every chunk).
//   - validate/coerce/cap every value before it becomes a blob-metadata header (Azure caps TOTAL
//     custom metadata at 8KB per blob; header values must be safe ASCII) and before it becomes a
//     Collection(Edm.String) index field.
//
// Pure: no I/O, no network, no imports beyond nothing. Fully unit-testable in isolation.

// ============================ controlled vocabularies ============================
export const ENUMS = {
  DOC_TYPE: {
    commerce: [
      "product_listing", "engineering_reference", "compliance_audit", "pricing_sheet",
      "order_record", "crm_export", "analytics_report", "marketplace_doc",
      "session_checkpoint", "marketing_asset", "vendor_contract", "warranty_policy",
      "supplier_agreement", "other",
    ],
  },
  CONFIDENTIALITY: ["public", "internal", "confidential", "mnpi_restricted", "attorney_privileged", "personal_pii"],
  MATERIALITY: ["low", "medium", "high"],
  EXECUTION_STATUS: ["FULLY_EXECUTED", "PARTIALLY_EXECUTED", "UNSIGNED_DRAFT", "NOT_APPLICABLE", "CANNOT_DETERMINE"],
  CONFIDENCE: ["high", "medium", "low"],
  CHANNEL: ["amazon", "shopify", "retail", "direct", "internal", "unknown"],
  BRAND: ["treo", "ihear_matrix", "n_a", "unknown"],
  CURRENCY: ["USD", "EUR", "GBP", "CAD", "OTHER"],
  SOURCE_TYPE: ["primary_source", "ai_memo", "machine_generated"],
  // Passage/segment-level confidentiality label (Wave 7 item 7.4, 2026-07-22): WHAT a specific
  // passage inside a document contains, distinct from CONFIDENTIALITY above (the whole-document
  // access-control level). A document's overall confidentiality might be "internal" while one
  // paragraph inside it still deserves one of these finer-grained labels -- see the
  // SEGMENT_CONFIDENTIALITY_* section below for the full design note.
  SEGMENT_LABEL: [
    "unreleased_financials", "attorney_work_product", "attorney_client_privileged",
    "personal_pii", "strategic_plan", "regulatory_sensitive", "routine_operational", "other_sensitive",
  ],
};

/** Resolve the doc_type enum for a domain (falls back to the commerce list, which is the only fully
 *  built-out enum today; finance/legal add their own DOC_TYPE.<domain> array when built). */
function docTypeEnumFor(domain) {
  return ENUMS.DOC_TYPE[domain] || ENUMS.DOC_TYPE.commerce;
}

// ============================ universal core (22 fields) ============================
// kind: 'scalar' (Edm.String) | 'list' (Collection(Edm.String)) | 'bool' | 'int' | 'double' | 'date'
// source: 'llm' (the one gpt-4.1-mini generate/classify call) | 'code' (deterministic) | 'rewire'
//         (already computed by CU `understand` or deep-pass.mjs; enrich.mjs pulls it off the catalog
//         row instead of asking the model again -- this is the "plumbing, not new LLM calls" saving).
export const UNIVERSAL_FIELDS = [
  { name: "doc_title", type: "Edm.String", kind: "scalar", source: "llm", searchable: true, sortable: true, maxLen: 160 },
  { name: "doc_type", type: "Edm.String", kind: "scalar", source: "llm", searchable: true, filterable: true, facetable: true, maxLen: 64, enumKey: "DOC_TYPE" },
  { name: "summary", type: "Edm.String", kind: "scalar", source: "llm", searchable: true, maxLen: 1200 },
  { name: "keywords", type: "Collection(Edm.String)", kind: "list", source: "llm", searchable: true, filterable: true, facetable: true, maxItems: 12, maxItemLen: 40 },
  { name: "hypothetical_questions", type: "Collection(Edm.String)", kind: "list", source: "llm", searchable: true, maxItems: 5, maxItemLen: 140 },
  { name: "entity", type: "Edm.String", kind: "scalar", source: "rewire", searchable: true, filterable: true, facetable: true, maxLen: 64 },
  { name: "entities", type: "Collection(Edm.String)", kind: "list", source: "llm", searchable: true, filterable: true, facetable: true, maxItems: 8, maxItemLen: 64 },
  { name: "named_entities_orgs", type: "Collection(Edm.String)", kind: "list", source: "llm", searchable: true, filterable: true, facetable: true, maxItems: 8, maxItemLen: 64 },
  { name: "named_entities_people", type: "Collection(Edm.String)", kind: "list", source: "llm", searchable: true, filterable: true, facetable: true, maxItems: 8, maxItemLen: 64 },
  { name: "doc_date", type: "Edm.DateTimeOffset", kind: "date", source: "code", filterable: true, sortable: true },
  { name: "source_type", type: "Edm.String", kind: "scalar", source: "code", filterable: true, facetable: true, maxLen: 32, enumKey: "SOURCE_TYPE" },
  { name: "source_path", type: "Edm.String", kind: "scalar", source: "code", searchable: true, filterable: true, maxLen: 220 },
  { name: "content_hash", type: "Edm.String", kind: "scalar", source: "rewire", filterable: true, facetable: false, maxLen: 64 }, // high-cardinality: filterable, deliberately NOT facetable
  { name: "confidentiality", type: "Edm.String", kind: "scalar", source: "llm", filterable: true, facetable: true, maxLen: 32, enumKey: "CONFIDENTIALITY" },
  { name: "mnpi_flag", type: "Edm.Boolean", kind: "bool", source: "llm", filterable: true, facetable: true },
  { name: "materiality_level", type: "Edm.String", kind: "scalar", source: "rewire", filterable: true, facetable: true, maxLen: 16, enumKey: "MATERIALITY" },
  { name: "execution_status", type: "Edm.String", kind: "scalar", source: "rewire", filterable: true, facetable: true, maxLen: 32, enumKey: "EXECUTION_STATUS" },
  { name: "signed", type: "Edm.Boolean", kind: "bool", source: "rewire", filterable: true, facetable: true },
  { name: "signatories", type: "Collection(Edm.String)", kind: "list", source: "rewire", searchable: true, filterable: true, facetable: false, maxItems: 10, maxItemLen: 80 },
  { name: "extraction_confidence", type: "Edm.String", kind: "scalar", source: "rewire", filterable: true, facetable: true, maxLen: 16, enumKey: "CONFIDENCE" },
  { name: "contextual_prefix", type: "Edm.String", kind: "scalar", source: "llm", searchable: false, retrievable: true, maxLen: 700 }, // retrievable-only audit copy; its real job is being prepended to the chunk text before embed/BM25
  { name: "word_count", type: "Edm.Int64", kind: "int", source: "code", filterable: true, sortable: true },
];

// ============================ domain packs ============================
// Commerce (proving ground, 2026-07-21) is fully implemented. Finance/legal/commons packs are the
// CTO's separate gated wide-rollout: add a `<DOMAIN>_FIELDS` array in this exact shape (see the design
// doc Sections 4A/4B/4D for the field lists + rationale) and register it in DOMAIN_PACKS below --
// nothing else in enrich.mjs needs to change, the CLI's --domain-pack flag picks it up automatically.
export const COMMERCE_FIELDS = [
  { name: "channel", type: "Edm.String", kind: "scalar", source: "llm", filterable: true, facetable: true, maxLen: 24, enumKey: "CHANNEL" },
  { name: "brand", type: "Edm.String", kind: "scalar", source: "llm", filterable: true, facetable: true, maxLen: 24, enumKey: "BRAND" },
  { name: "related_systems", type: "Collection(Edm.String)", kind: "list", source: "llm", searchable: true, filterable: true, facetable: true, maxItems: 6, maxItemLen: 40 },
  { name: "product_names", type: "Collection(Edm.String)", kind: "list", source: "llm", searchable: true, filterable: true, facetable: true, maxItems: 6, maxItemLen: 60 },
  { name: "sku_asin_codes", type: "Collection(Edm.String)", kind: "list", source: "llm", searchable: true, filterable: true, facetable: false, maxItems: 10, maxItemLen: 24 }, // high-cardinality identifiers: filterable, NOT facetable
  { name: "price_amount", type: "Edm.Double", kind: "double", source: "code", filterable: true, sortable: true },
  { name: "currency", type: "Edm.String", kind: "scalar", source: "code", filterable: true, facetable: true, maxLen: 8, enumKey: "CURRENCY" },
  { name: "transaction_or_listing_date", type: "Edm.DateTimeOffset", kind: "date", source: "code", filterable: true, sortable: true },
  { name: "compliance_flags", type: "Collection(Edm.String)", kind: "list", source: "llm", searchable: true, filterable: true, facetable: true, maxItems: 5, maxItemLen: 40 },
  { name: "medical_claims_present", type: "Edm.Boolean", kind: "bool", source: "llm+rule", filterable: true, facetable: true }, // hard TReO (PSAP-not-hearing-aid) compliance gate; rule-first OR llm, never rule-only
  { name: "author_agent", type: "Edm.String", kind: "scalar", source: "code", filterable: true, facetable: true, maxLen: 24 },
  { name: "page_url", type: "Edm.String", kind: "scalar", source: "code", maxLen: 300 },
  { name: "last_verified_date", type: "Edm.DateTimeOffset", kind: "date", source: "code", filterable: true, sortable: true },
  { name: "signed_off_by", type: "Edm.String", kind: "scalar", source: "code", searchable: true, filterable: true, maxLen: 80 },
  { name: "notion_source_page_id", type: "Edm.String", kind: "scalar", source: "code", filterable: true, facetable: false, maxLen: 40 },
];

// ============================ field/passage-level confidentiality classification (Wave 7 item 7.4) ============================
// FOUNDATION ONLY, not enforcement (2026-07-22). Today, confidentiality/privilege is enforced at the
// ROOM level: an entire index (finance-cfo-source-docs, legal-company, legal-personal, ...) is gated
// wholesale to the executive ring (see otchealth-mcp-server src/tools/kb/search-privileged.ts,
// INDEX_LANES / EXEC_RING / PERSONAL_LEGAL_RING). That is coarse: within ONE document that is
// otherwise fine to share inside the room, a specific paragraph can carry materially more sensitive
// content (an unreleased earnings figure buried in an otherwise routine board-minutes document), and
// room-level gating has no way to express "withhold just this passage."
//
// This pack adds a THIRD classification layer, alongside the whole-document `confidentiality` field
// above and CU/deep-pass's per-document fields: it asks the SAME enrichment LLM call (no new call, no
// new cost line -- see COST CONTROLS in enrich.mjs) to name up to 6 passages whose sensitivity DIFFERS
// from the rest of the document, tag each with a controlled-vocabulary SEGMENT_LABEL, and quote a
// short verbatim locator so a later pass can find the passage again. It is scoped to the
// executive-ring rooms named in the task that motivated it: finance and legal (both the `company` and
// `personal` legal containers -- they share the `legal` doc-indexer profile/domain, differentiated
// only by --container, so this pack applies to both automatically). Commerce/commons documents are
// not privileged-ring content, so they never carry this pack (see DOMAIN_PACKS below).
//
// EXPLICITLY NOT BUILT HERE: nothing downstream reads these fields yet. No retrieval/synthesis path in
// the gateway redacts a flagged passage, withholds it from a response, or treats a doc differently
// because `mixed_confidentiality` is true -- that consumption is a separate, larger, future change (it
// would need to map `locator_excerpt` back onto the CHUNK row(s) it falls in, e.g. a substring/fuzzy
// match against each chunk's `chunk` text, and then teach the gateway's retrieval or synthesis path to
// drop or mask that specific chunk even when the caller is otherwise allowed to read the room). This
// pack only computes and stores the metadata so that future pass has something to consume.
export const SEGMENT_CONFIDENTIALITY_DOMAINS = new Set(["finance", "legal"]);

export const SEGMENT_CONFIDENTIALITY_FIELDS = [
  // The audit trail: one JSON-encoded {label, locator_excerpt, rationale} object per flagged passage,
  // as a Collection(Edm.String) (mirrors how every other list field in this schema is metadata-encoded
  // -- see indexerFieldMapping's jsonArrayToStringCollection). Not searchable/filterable itself (the
  // payload is structured JSON, not prose or a controlled vocabulary); sensitive_labels below is the
  // filterable/facetable surface a future consumer or a human query would actually use.
  { name: "sensitive_segments", type: "Collection(Edm.String)", kind: "list", source: "llm", searchable: false, filterable: false, facetable: false, maxItems: 6, maxItemLen: 500 },
  // Deduped SEGMENT_LABEL values found anywhere in sensitive_segments, so "find every finance doc with
  // an unreleased_financials passage" is a plain facet/filter, no JSON parsing required.
  { name: "sensitive_labels", type: "Collection(Edm.String)", kind: "list", source: "llm", searchable: true, filterable: true, facetable: true, maxItems: 8, maxItemLen: 40, enumKey: "SEGMENT_LABEL" },
  // Cheap, well-defined signal: does this document need passage-level attention at all, or is its
  // whole-document confidentiality classification already the whole story. Deliberately NOT a
  // "highest sensitivity" ranking across labels -- ranking severity across (say) attorney-privilege vs
  // MNPI vs PII is a legal judgment call this pipeline should not fabricate.
  { name: "mixed_confidentiality", type: "Edm.Boolean", kind: "bool", source: "llm", filterable: true, facetable: true },
];

export const DOMAIN_PACKS = {
  commerce: COMMERCE_FIELDS,
  // finance/legal: ONLY the field/passage-level confidentiality-classification pack above is wired so
  // far (Wave 7 item 7.4). The FULL finance/legal domain packs (materiality/counterparty/entities/etc,
  // ~18-20 fields each, design doc Sections 4A/4B) remain the CTO's separate gated wide rollout; when
  // that lands, change these two lines to `[...FINANCE_FIELDS, ...SEGMENT_CONFIDENTIALITY_FIELDS]` and
  // `[...LEGAL_FIELDS, ...SEGMENT_CONFIDENTIALITY_FIELDS]`.
  finance: SEGMENT_CONFIDENTIALITY_FIELDS,
  legal: SEGMENT_CONFIDENTIALITY_FIELDS,
  // commons: COMMONS_FIELDS,   // TODO (wide rollout): design doc Section 4D, ~15 fields
};

/** The full field list for a domain: universal core + that domain's pack (empty pack = universal only,
 *  so an as-yet-unbuilt domain like finance/legal/commons still runs safely, just without its extras). */
export function fieldsForDomain(domain) {
  return [...UNIVERSAL_FIELDS, ...(DOMAIN_PACKS[domain] || [])];
}

/** Resolve the controlled vocabulary for a field in a given domain (doc_type is domain-specific; every
 *  other enum is global). Returns null for a field with no enumKey (free text, not enum-constrained). */
export function enumFor(field, domain) {
  if (!field || !field.enumKey) return null;
  if (field.enumKey === "DOC_TYPE") return docTypeEnumFor(domain);
  return ENUMS[field.enumKey] || null;
}

// ============================ Azure AI Search field-definition builder ============================
/** Build the Azure AI Search field JSON for a field descriptor, honoring the design's attribute
 *  discipline: high-cardinality fields (content_hash, sku_asin_codes, notion_source_page_id) are
 *  filterable but explicitly NOT facetable; hypothetical_questions/signatories are searchable but
 *  never facet (unique per-doc text, faceting them would be useless + wasteful); dates are
 *  filterable+sortable, never facetable (freshness drives scoring, not a filter chip); booleans and
 *  scalars get filterable+facetable where that is a genuinely useful narrow-cardinality facet. */
export function azureFieldDef(f) {
  const def = { name: f.name, type: f.type, retrievable: f.retrievable !== false };
  if (f.kind === "list") {
    def.searchable = !!f.searchable;
    def.filterable = !!f.filterable;
    def.facetable = !!f.facetable;
  } else if (f.type === "Edm.Boolean") {
    def.filterable = !!f.filterable;
    def.facetable = !!f.facetable;
  } else if (f.type === "Edm.DateTimeOffset" || f.type === "Edm.Int64" || f.type === "Edm.Double") {
    def.filterable = !!f.filterable;
    def.sortable = !!f.sortable;
    def.facetable = !!f.facetable;
  } else {
    // Edm.String scalar
    def.searchable = !!f.searchable;
    def.filterable = !!f.filterable;
    def.facetable = !!f.facetable;
    def.sortable = !!f.sortable;
  }
  return def;
}

/** The indexer-level fieldMapping that surfaces a blob's custom metadata key onto the enriched
 *  document tree at /document/<name>. VERIFIED LIVE (2026-07-21, disposable probe index against the
 *  real commerce storage account): custom blob metadata surfaces under its BARE key name as the
 *  indexer's sourceFieldName -- NOT "metadata_<key>" (that prefix is reserved for the small fixed set
 *  of auto-extracted content properties, e.g. metadata_storage_name / metadata_author). Collections
 *  are metadata-encoded as a JSON array string and converted with the built-in
 *  `jsonArrayToStringCollection` mapping function (also verified live). */
export function indexerFieldMapping(f) {
  const m = { sourceFieldName: f.name, targetFieldName: f.name };
  if (f.kind === "list") m.mappingFunction = { name: "jsonArrayToStringCollection" };
  return m;
}

/** The skillset index-projection mapping that copies an already-enriched /document/<name> field onto
 *  every chunk row for that parent -- the exact mechanism the live skillset already uses for
 *  title/path (see ss-<room> in Azure AI Search: title <- /document/title, populated by the indexer's
 *  metadata_storage_name -> title field mapping). */
export function projectionMapping(f) {
  return { name: f.name, source: `/document/${f.name}` };
}

/** The semantic-ranker configuration this design implies once doc_title/summary/keywords exist:
 *  ONE title field (semantic config allows exactly one), content fields in priority order (summary
 *  before the raw chunk text, since summary is the higher-signal distillation), keyword fields for
 *  the named-entity signal. Safe to apply even before every doc is enriched -- the ranker just has no
 *  extra signal for a not-yet-enriched doc, it does not error. */
export function semanticConfig() {
  return {
    name: "sem",
    prioritizedFields: {
      titleField: { fieldName: "doc_title" },
      prioritizedContentFields: [{ fieldName: "summary" }, { fieldName: "chunk" }],
      prioritizedKeywordsFields: [{ fieldName: "keywords" }, { fieldName: "named_entities_orgs" }, { fieldName: "named_entities_people" }],
    },
  };
}

// ============================ value validation / coercion / capping ============================
/** Strip a value to safe, printable ASCII (0x20-0x7E) so it is always a legal HTTP header value AND a
 *  legal Azure Blob custom-metadata value, at the cost of losing exotic Unicode in the METADATA COPY
 *  only (the document's actual content/chunk text keeps full Unicode -- this only touches the small
 *  index-signal copy). Normalizes the common smart-punctuation cases first so English prose degrades
 *  gracefully instead of turning into a wall of '?'. */
export function asciiSafe(s) {
  return String(s == null ? "" : s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/\r?\n/g, " ")
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\s+/g, " ")
    .trim();
}

export function capStr(s, n) {
  const str = asciiSafe(s);
  if (!n || str.length <= n) return str;
  return str.slice(0, Math.max(0, n - 3)) + "...";
}

export function capList(arr, maxItems, maxItemLen) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x != null && String(x).trim())
    .slice(0, maxItems || 20)
    .map((x) => capStr(x, maxItemLen || 60));
}

export function toJsonArrayMeta(list) {
  return JSON.stringify(Array.isArray(list) ? list : []);
}

/** Coerce a free-text value onto a controlled vocabulary (case-insensitive exact match); anything that
 *  doesn't match falls back to the given default rather than polluting a facetable field with
 *  unbounded LLM free text. This is the code-side safety net behind the "controlled vocabulary via
 *  classify" design principle -- the prompt also states the enum, but the model is not trusted to
 *  honor it unassisted. */
export function coerceEnum(v, allowed, fallback = "") {
  if (v == null || !Array.isArray(allowed) || !allowed.length) return fallback;
  const s = String(v).trim().toLowerCase();
  const hit = allowed.find((a) => a.toLowerCase() === s);
  return hit || fallback;
}

// ============================ field/passage-level confidentiality classification: pure logic ============================
// sanitizeSegments / encodeSegments / buildSegmentFields together are the "how the new classification
// merges into existing enrichment output" layer: given the raw sensitive_segments the LLM returned
// (untrusted -- may be missing, malformed, or off-vocabulary), produce the exact three field values
// enrich.mjs writes as blob metadata. Pure (no I/O, no network), so this is fully unit-testable without
// a live LLM call -- see enrichOne() in enrich.mjs for where buildSegmentFields is actually invoked.

/** Validate + coerce the LLM's raw sensitive_segments array into a bounded list of clean
 *  {label, locator_excerpt, rationale} records. An item with no recognizable SEGMENT_LABEL, or no
 *  locatable text, is DROPPED rather than guessed at (same "never invent, flag or drop" discipline as
 *  coerceEnum/validDateOrEmpty above). */
export function sanitizeSegments(raw, maxItems = 6) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const label = coerceEnum(item.label, ENUMS.SEGMENT_LABEL, "");
    if (!label) continue; // unrecognized/missing label: not usable by a future consumer, drop rather than guess
    const locator_excerpt = capStr(item.locator_excerpt ?? item.locator ?? "", 220);
    if (!locator_excerpt) continue; // a label with nothing to locate is not actionable, drop
    const rationale = capStr(item.rationale ?? "", 140);
    out.push({ label, locator_excerpt, rationale });
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Each validated segment becomes its own compact JSON string (one Collection(Edm.String) element),
 *  mirroring how every other list field in this schema becomes a JSON-array-of-strings blob-metadata
 *  value (see indexerFieldMapping's jsonArrayToStringCollection). */
export function encodeSegments(segments) {
  return (Array.isArray(segments) ? segments : []).map((s) => JSON.stringify(s));
}

/** The full merge: raw LLM output -> the three field values enrich.mjs assigns onto its `fields`
 *  object for a finance/legal doc. mixed_confidentiality is true exactly when at least one segment
 *  survived sanitation, i.e. this document has passage-level content that diverges from its
 *  whole-document confidentiality classification and deserves a closer look before a future
 *  enforcement pass trusts the room-level gate alone. */
export function buildSegmentFields(rawSegments, maxItems = 6) {
  const segments = sanitizeSegments(rawSegments, maxItems);
  return {
    sensitive_segments: encodeSegments(segments),
    sensitive_labels: capList(Array.from(new Set(segments.map((s) => s.label))), 8, 40),
    mixed_confidentiality: segments.length > 0,
  };
}

/** The JSON-schema-shaped prompt snippet enrich.mjs splices into enrichSystemPrompt() for
 *  SEGMENT_CONFIDENTIALITY_DOMAINS only (mirrors how the commerce-only fields are spliced in there).
 *  Kept here, not in enrich.mjs, so the exact prompt text is unit-testable without importing enrich.mjs
 *  (a CLI script, not a module). Returns text with no trailing comma, meant to be spliced in as the
 *  last schema field (see enrich.mjs's `schema.replace(/\}$/, ...)` pattern). */
export function segmentClassificationPromptBlock() {
  return `"sensitive_segments": [{"label": "one of: ${ENUMS.SEGMENT_LABEL.join("|")}", "locator_excerpt": "8 to 20 words copied VERBATIM from the document text so this exact passage can be found again later, never paraphrase", "rationale": "one short clause: why this specific passage carries that label"}] (0 to 6 items, most sensitive first; ONLY passages whose sensitivity genuinely DIFFERS from the rest of this document, e.g. one paragraph with a specific unreleased number inside an otherwise routine memo, or one attorney-work-product paragraph inside an otherwise shareable letter; if the WHOLE document reads as uniformly one sensitivity level, return an empty array, the whole-document confidentiality field above already covers that case)`;
}

/** A date is NEVER trusted from raw LLM output (design principle #3: "the one failure a CLO/CFO cannot
 *  absorb"). This only accepts a string that already looks like YYYY-MM-DD (from deterministic
 *  extraction: a path-embedded date, a CU/deep-pass field that itself came from regex/calendar logic,
 *  or an LLM field whose ONLY job was to point at a date substring already present in the text) and
 *  round-trips it through Date.UTC to reject calendar-invalid values (e.g. 2026-02-30). Anything else
 *  -> empty string (never a fabricated date). Returns full ISO 8601 (Edm.DateTimeOffset requires it). */
export function validDateOrEmpty(s) {
  if (!s) return "";
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return "";
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return "";
  return dt.toISOString();
}

/** Parse a free-text amount ("$99", "1,234.50 EUR") into a numeric Edm.Double + an ISO currency code.
 *  Never trusts LLM arithmetic (design principle: "code parses to Edm.Double"); this is a regex parse
 *  of a string the LLM/CU already extracted, not a computation. */
export function parseAmount(s) {
  if (!s) return { amount: null, currency: "" };
  const str = String(s);
  let currency = "";
  if (/€/.test(str) || /\bEUR\b/i.test(str)) currency = "EUR";
  else if (/£/.test(str) || /\bGBP\b/i.test(str)) currency = "GBP";
  else if (/\$|\bUSD\b/i.test(str)) currency = "USD";
  const m = str.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  const amount = m ? parseFloat(m[0]) : null;
  return { amount: Number.isFinite(amount) ? amount : null, currency };
}

// ============================ blob-metadata budget guard ============================
// Azure Blob Storage caps TOTAL custom metadata (all x-ms-meta-* name+value pairs combined) at 8KB
// per blob. Stay well under it: shrink the largest, least filter-critical fields first (free text
// before enums/dates/ids) rather than erroring or silently letting Azure reject the write.
const METADATA_BYTE_BUDGET = 7200;
const SHRINK_PRIORITY = [
  // sensitive_segments first: it is retrievable-only (searchable/filterable/facetable all false, see
  // SEGMENT_CONFIDENTIALITY_FIELDS), so it is the least valuable field to keep at full size under
  // budget pressure -- shrink it before touching anything that actually drives search quality.
  "sensitive_segments",
  "contextual_prefix", "summary", "hypothetical_questions", "keywords",
  "entities", "named_entities_orgs", "named_entities_people",
  "related_systems", "product_names", "compliance_flags",
];
export function fitMetadataBudget(pairs) {
  const size = () => Object.entries(pairs).reduce((n, [k, v]) => n + k.length + (v ? String(v).length : 0), 0);
  let guard = 0;
  while (size() > METADATA_BYTE_BUDGET && guard++ < 40) {
    let shrunkAny = false;
    for (const k of SHRINK_PRIORITY) {
      if (pairs[k] && pairs[k].length > 40) {
        pairs[k] = pairs[k].slice(0, Math.floor(pairs[k].length * 0.7));
        shrunkAny = true;
        if (size() <= METADATA_BYTE_BUDGET) break;
      }
    }
    if (!shrunkAny) break;
  }
  return { pairs, bytes: size(), overBudget: size() > METADATA_BYTE_BUDGET };
}

// ============================ contextual retrieval (Anthropic pattern) ============================
// The design's single biggest measured recall win: prepend a short doc-specific context string to the
// chunk text BEFORE it is embedded/BM25-indexed (the one deliberate exception to "metadata never folds
// into embedded text"). Applied to the _TEXT sidecar content itself (which is exactly what the S1
// SplitSkill/EmbeddingSkill read), marker-guarded so re-running enrichment never compounds the prefix.
export const CTX_PREFIX_MARKER = "<!-- CTX-PREFIX v1 -->";
export function applyContextualPrefix(existingText, prefix) {
  const text = existingText || "";
  if (!prefix) return text;
  if (text.startsWith(CTX_PREFIX_MARKER)) return text; // already applied -- idempotent no-op
  return `${CTX_PREFIX_MARKER}\n${prefix}\n\n${text}`;
}

// ============================ OpenSearch partial-update doc builder ============================
// The OpenSearch-backed counterpart to the metaPairs loop in enrich.mjs's enrichOne(): given the SAME
// `fields` object enrichOne() already computed (or, for a doc that was already enriched on a PRIOR
// run, the same field values read back off its catalog row -- see enrich.mjs's cmdRun, which skips a
// redundant LLM call in exactly that case), produce the plain-object body for an OpenSearch bulk
// "update" action's `doc`.
//
// Deliberately NOT a reuse of the Azure metaPairs encoding: Azure Blob custom metadata values must be
// single ASCII strings (8KB total budget), so lists are JSON-stringified (toJsonArrayMeta) and
// booleans become "true"/"false" strings, decoded back into real types only later by the indexer's
// jsonArrayToStringCollection field mapping. OpenSearch has no such constraint -- a partial-update
// `doc` is just JSON, so a list field belongs in the document as a REAL array and a bool field as a
// REAL boolean; running them through the Azure string-encoding here would be wrong, not just
// redundant (a `keyword`-mapped array field sent as one JSON-stringified string indexes as a single
// unsearchable token, not the list it looks like).
//
// Omit-empty semantics mirror the Azure metaPairs loop's per-kind rules exactly (list: skip if empty;
// int/double: skip if not finite; date: skip if falsy; scalar: skip if empty string) with ONE
// deliberate asymmetry carried over unchanged from Azure: boolean fields are ALWAYS included (a
// `false` mnpi_flag is a meaningful, already-computed fact, not "nothing to say" -- the metaPairs loop
// makes the identical choice). Because this is a PARTIAL update (see opensearch-client.mjs's
// osBulkUpdate doc comment), an omitted field is simply left untouched on the existing document, never
// cleared -- so under-including here can only mean "stale", never "wrong", and the function is safe to
// call repeatedly across enrichment re-runs.
//
// A missing `fields` object short-circuits to {} BEFORE the per-field loop, deliberately: the loop's
// own "always include booleans" rule would otherwise write mnpi_flag/signed/medical_claims_present as
// false from a caller that supplied no data at all -- that is "we affirmatively know this is false",
// not "we know nothing", and this function must never manufacture the former from the latter.
export function openSearchDocFields(fields, domain) {
  if (!fields) return {};
  const doc = {};
  for (const f of fieldsForDomain(domain)) {
    const v = fields[f.name];
    if (f.kind === "list") {
      if (!Array.isArray(v) || !v.length) continue;
      doc[f.name] = v.slice(0, f.maxItems || v.length);
    } else if (f.kind === "bool") {
      doc[f.name] = !!v;
    } else if (f.kind === "int" || f.kind === "double") {
      if (!Number.isFinite(v)) continue;
      doc[f.name] = v;
    } else if (f.kind === "date") {
      if (!v) continue;
      doc[f.name] = v;
    } else {
      if (v == null || v === "") continue;
      doc[f.name] = String(v);
    }
  }
  return doc;
}

/** Recursively replace any string value exactly equal to "<redacted>" with the real secret. Azure AI
 *  Search GET responses redact embedded API keys (skillset AzureOpenAIEmbeddingSkill.apiKey, an
 *  index's vectorSearch.vectorizers[].azureOpenAIParameters.apiKey) to "<redacted>"; PUTting that
 *  placeholder back verbatim would either be rejected or silently break the resource's own auth, so
 *  any code that GETs-clones-PUTs one of these resources must deredact before the PUT. */
export function deredact(obj, realKey) {
  if (!obj || typeof obj !== "object") return obj;
  for (const k of Object.keys(obj)) {
    if (obj[k] === "<redacted>") obj[k] = realKey;
    else if (obj[k] && typeof obj[k] === "object") deredact(obj[k], realKey);
  }
  return obj;
}

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

export const DOMAIN_PACKS = {
  commerce: COMMERCE_FIELDS,
  // finance: FINANCE_FIELDS,   // TODO (wide rollout): design doc Section 4A, ~18 fields
  // legal:   LEGAL_FIELDS,     // TODO (wide rollout): design doc Section 4B, ~20 fields
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

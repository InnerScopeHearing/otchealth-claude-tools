#!/usr/bin/env node
// enrich.mjs — S1 brain METADATA ENRICHMENT pipeline (2026-07-21). The layer that takes the doc-indexer
// pipeline's existing CU `understand` output (indexer.mjs) and deep-pass.mjs's rich vision/summary pass
// and turns them (PLUS a handful of new, deliberately cheap fields) into the universal-core + per-domain
// metadata described in otchealth-cto/runbooks/metadata-schema-research-2026-07-20/
// 00-METADATA-SCHEMA-DESIGN.md, then wires it onto the live S1 CHUNKED brain so every chunk of a
// document carries its parent's full metadata.
//
// THE GROUNDING FACT (verified live, 2026-07-21): the S1 doc rooms carry only 6 structural fields
// today (chunk_id, parent_id, title, path, chunk, text_vector) fed by native Azure blob PULL-indexers
// (ixr-<room>) reading the `_TEXT/` sidecar prefix, with a skillset that chunks + embeds and uses INDEX
// PROJECTIONS (skipIndexingParentDocuments) to copy a handful of parent-level fields (title, path) onto
// every chunk row. This script adds MORE parent-level fields to that same projection mechanism:
//
//   _TEXT/<path>.txt sidecar (blob)
//     -> enrich.mjs writes the new fields as BLOB CUSTOM METADATA on that sidecar (verified live:
//        custom metadata surfaces to the indexer under its BARE key name, e.g. a blob's
//        x-ms-meta-doc_type becomes /document/doc_type in the enriched document tree -- NOT
//        "metadata_doc_type", that prefix is reserved for the fixed set of auto-extracted content
//        properties like metadata_storage_name)
//     -> the S1 blob indexer's fieldMappings project /document/<field> for each new field (arrays are
//        metadata-encoded as a JSON string and converted with the built-in jsonArrayToStringCollection
//        mapping function, also verified live)
//     -> the skillset's index projection copies each /document/<field> onto EVERY chunk row for that
//        parent (the exact mechanism already proven live for title/path)
//
// Three commands:
//   ensure-schema  - additively extend the room's index fields + skillset projections + indexer
//                    fieldMappings (idempotent; never touches the 6 structural fields or the existing
//                    chunking/embedding skills; uses schema-merge.mjs's mergeSchemaAdditive for the
//                    index PUT, matching the rest of the doc-indexer pipeline's skew-proofing).
//   run            - the enrichment pass itself: one gpt-4.1-mini generate+classify call per NEW/CHANGED
//                    parent doc (keyed on the catalog's sha256 -- already-enriched docs at the same
//                    sha256 are skipped, so re-runs are cheap) plus deterministic/code fields plus
//                    REWIRE of whatever CU `understand` + deep-pass.mjs already computed (counterparty,
//                    materiality, execution_status, signatories, ... -- zero extra LLM cost for those).
//                    Writes the blob metadata, prepends the Anthropic-style contextual-retrieval prefix
//                    to the sidecar content (idempotent, marker-guarded), and patches catalog.jsonl for
//                    audit. Low-confidence rows are flagged into _REVIEW/metadata-review-queue.csv
//                    instead of being silently re-run forever (deep-pass.mjs's same "resolution is
//                    terminal" pattern).
//   reindex-room   - POST the room's pull-indexer run (optionally --full-reset first) so newly-written
//                    blob metadata is picked up immediately instead of waiting for the next scheduled
//                    cycle (a Set-Blob-Metadata call bumps Last-Modified, so the normal incremental
//                    schedule would eventually pick it up on its own regardless).
//   verify         - query the live index for one parent doc's chunk rows and print every new field, so
//                    a before/after can be shown on a real document.
//
// COST CONTROLS (Matt directive, 2026-07-21): (1) INCREMENTAL -- a doc already enriched at its current
// sha256 is skipped entirely (no LLM call, no blob-metadata write) unless --reindex forces a full
// regen. (2) CHEAPEST ADEQUATE MODEL -- this script is gpt-4.1-mini ONLY, always; it never invokes a
// vision model (that stays deep-pass.mjs's job, already gated to `requires_signature && pdf`) and never
// escalates to gpt-4.1. (3) MAXIMUM REWIRE, MINIMUM NEW CALLS -- one combined JSON-schema call per doc
// covers every field CU/deep-pass did not already compute; everything they DID compute (summary,
// counterparty, materiality, execution_status, signed, signatories, sig_confidence, doc_date) is pulled
// off the catalog row, not re-asked of the model. (4) CONFIDENCE GATE -- a low-confidence row is marked
// enriched (so it is not silently retried every run at the same cost) AND flagged into the review queue
// instead of being trusted blind.
//
// FIELD/PASSAGE-LEVEL CONFIDENTIALITY CLASSIFICATION (Wave 7 item 7.4, 2026-07-22, foundation only):
// for the executive-ring domains (finance, legal -- covers legal-company AND legal-personal, they
// share the "legal" doc-indexer domain, see MS.SEGMENT_CONFIDENTIALITY_DOMAINS), the SAME LLM call
// above is asked to name up to 6 passages inside the document whose sensitivity DIFFERS from the rest
// of it (an unreleased financial figure inside an otherwise routine memo, an attorney-work-product
// paragraph inside an otherwise shareable letter), each with a controlled-vocabulary label + a short
// verbatim locator. Stored as `sensitive_segments` / `sensitive_labels` / `mixed_confidentiality`
// (metadata-schema.mjs's SEGMENT_CONFIDENTIALITY_FIELDS). This is groundwork ONLY: nothing downstream
// reads these fields yet -- no retrieval/synthesis path redacts a flagged passage or treats a doc
// differently. A future consumer would map `locator_excerpt` onto the CHUNK row(s) it falls in (e.g. a
// substring/fuzzy match against each chunk's `chunk` text) and teach the gateway to drop/mask that
// chunk even when the room is otherwise readable. See metadata-schema.mjs for the full design note and
// the pure, unit-tested merge logic (sanitizeSegments/encodeSegments/buildSegmentFields).
//
// Credentials: Azure Key Vault only (managed identity -> AZURE_SP_* -> az-CLI/OIDC via fleetSecret()).
// Non-PHI ring; INND content is MNPI (confidentiality/mnpi_flag exist precisely so a room that carries
// MNPI can be gated on it); the legal `personal` container is privileged/confidential.
//
// Usage:
//   node enrich.mjs ensure-schema --profile commerce [--domain-pack commerce]
//   node enrich.mjs run           --profile commerce [--limit n] [--concurrency 4] [--reindex]
//   node enrich.mjs reindex-room  --profile commerce [--full-reset] [--wait-minutes 3]
//   node enrich.mjs verify        --profile commerce --path "shopify-library/00-index.md"
//
// ============================================================================================
// TWO INDEPENDENT BACKEND AXES. Do not confuse them -- they were conflated once already and it
// cost a wrong diagnosis ("the backfill just needs a flag flip", 2026-08-19).
//
//   --storage-backend  WHERE THE SOURCE BYTES LIVE   (s3 | azure)   -- the catalog, the _TEXT/
//                      sidecars this file reads to enrich, the lock, the review queue.
//   --search-backend   WHERE THE ENRICHED FIELDS GO  (opensearch | azure)
//
// A room can be read from S3 and written to OpenSearch, which is in fact the only combination
// that works today, and is why both defaults are what they are.
//
// STORAGE_BACKEND (2026-08-19, default `s3`): every Azure Blob storage account this file can
// target became unreachable when the Azure estate locked down (2026-08-18 ~00:55Z). This file
// still resolved its source text exclusively from `https://<acct>.blob.core.windows.net/...`,
// so `--search-backend opensearch` -- added 2026-08-16 to fix 0% entity coverage -- could not
// actually run: it would authenticate to OpenSearch correctly and then fail to read a single
// source document. That is the real blocker behind "the entity/graph backfill is not a flag
// flip, it needs a source-text port". This is that port.
//
// It deliberately reuses skills/kb-memory/s3-blob.mjs, the SAME mirror layer indexer.mjs uses,
// rather than introducing a second S3 path: a room targeted by indexer.mjs and the same room
// targeted here resolve to the same physical objects. That module fails CLOSED on an unmapped
// (account, container) pair rather than guessing a bucket -- buckets come from an observed
// listing, never inferred from IAM, because one IAM statement covers several buckets at once and
// so can only ever say a write is permitted, never where the data is.
//
// `--storage-backend azure` remains selectable for read-only inspection of pre-lockdown history;
// writes on it still throw loud rather than being silently swallowed. Also settable via the
// STORAGE_BACKEND env var. NOTE the flag-vs-env precedence trap: an explicit flag always wins
// over the env var, so a job spec that sets STORAGE_BACKEND=s3 while still passing --azure on the
// command line stays on Azure. Check the argv, not just the environment.
// ============================================================================================
//
// SEARCH_BACKEND (2026-08-16, closes a real gap: 0% entity-field coverage across all 66,668 documents
// on the live OpenSearch brain, because this file only ever resolved AZURE_SEARCH_ENDPOINT /
// azure-search-admin-key and hard-exited without them -- verified live before this was added):
//   --search-backend azure       (default, byte-for-byte the pre-existing behavior above: blob custom
//                                 metadata + the Azure native pull-indexer/skillset projection chain)
//   --search-backend opensearch  (run ONLY: a DIRECT partial-update of every existing chunk document
//                                 for a parent, via the bulk API's "update" action -- NEVER index/PUT
//                                 _doc, which would replace the whole document and destroy its
//                                 text_vector; see opensearch-client.mjs's osBulkUpdate). ensure-schema
//                                 and reindex-room stay Azure-only by design: OpenSearch's mapping
//                                 already carries the universal-core fields (provisioned when the room
//                                 was created) and accepts new domain-pack fields via ordinary dynamic
//                                 mapping (verified live, no `dynamic:strict` on any doc room), and
//                                 there is no pull-indexer to "run" -- `run` IS the write, directly.
// Also settable via the SEARCH_BACKEND env var (mirrors otchealth-mcp-server's own env var of the
// same name/values, though this script and the gateway resolve it completely independently).
// AWS credentials: env AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, else Key Vault
// aws-cto-access-key-id/aws-cto-secret-access-key. Endpoint: env OPENSEARCH_ENDPOINT, else Key Vault
// opensearch-endpoint (not present in the vault as of 2026-08-16), else the live otchealth-brain
// domain's known host (see OS_DEFAULT_HOST below).

import crypto from "node:crypto";
// fleetSecret = AWS SSM -> Key Vault. enrich.mjs called fleetSecret() directly, so on Fargate
// (no Azure managed identity) every one of these resolved null. See fleet-secret.mjs.
import { fleetSecret } from "./fleet-secret.mjs";
import { mergeSchemaAdditive } from "./schema-merge.mjs";
import * as MS from "./metadata-schema.mjs";
import { osSearch, osBulkUpdate, osRefresh } from "./opensearch-client.mjs";
// STORAGE_BACKEND (2026-08-19): the same S3 mirror layer indexer.mjs already uses. See the
// STORAGE_BACKEND note in this file's header for why this exists and why the default flipped.
import { getBufferFromS3, putObjectToS3, deleteObjectFromS3, s3LocationFor } from "../kb-memory/s3-blob.mjs";

// ============================ CLI ============================
const argv = process.argv.slice(2);
function takeVal(name, def = null) { const i = argv.indexOf(name); if (i >= 0) { const v = argv[i + 1]; argv.splice(i, 2); return v; } return def; }
const PROFILE = (takeVal("--profile", "commerce") || "commerce").toLowerCase();
const DOMAIN = (takeVal("--domain-pack", null) || PROFILE).toLowerCase();
const containerOverride = takeVal("--container");
const ACCT_OV = takeVal("--azure-account");
const KEYSECRET_OV = takeVal("--key-secret");
const LIMIT = parseInt(takeVal("--limit", "0"), 10) || 0;
const CONCURRENCY = Math.max(1, parseInt(takeVal("--concurrency", process.env.ENRICH_CONCURRENCY || "4"), 10) || 4);
const MAX_MIN = parseInt(takeVal("--max-minutes", process.env.ENRICH_MAX_MINUTES || "0"), 10) || 0;
// LLM provider + model. The default model follows the provider, because a deployment name that is
// valid on one is meaningless on the other ("gpt-4.1-mini" is an Azure DEPLOYMENT name; OpenAI wants
// a real model id). An explicit --model still wins over both.
const LLM_PROVIDER = (takeVal("--llm-provider", process.env.ENRICH_LLM_PROVIDER || "openai") || "openai").toLowerCase();
if (LLM_PROVIDER !== "openai" && LLM_PROVIDER !== "azure") {
  console.error(`--llm-provider must be "openai" or "azure" (got "${LLM_PROVIDER}").`);
  process.exit(2);
}
const MODEL = takeVal("--model", process.env.ENRICH_MODEL || (LLM_PROVIDER === "openai" ? "gpt-4o-mini" : "gpt-4.1-mini"));
const VERIFY_PATH = takeVal("--path");
const WAIT_MIN = parseInt(takeVal("--wait-minutes", "0"), 10) || 0;
const BACKEND = (takeVal("--search-backend", process.env.SEARCH_BACKEND || "azure") || "azure").toLowerCase();
if (BACKEND !== "azure" && BACKEND !== "opensearch") {
  console.error(`--search-backend must be "azure" or "opensearch" (got "${BACKEND}").`);
  process.exit(2);
}
const flags = new Set(argv.filter((a) => a.startsWith("--")));
// STORAGE backend (see the header). Bare `--s3` / `--azure` are accepted as aliases so this file
// takes the SAME flags indexer.mjs does and job/librarian.sh can pass one spelling to both.
const STORAGE = (
  takeVal("--storage-backend", null) ||
  (flags.has("--s3") ? "s3" : flags.has("--azure") ? "azure" : null) ||
  process.env.STORAGE_BACKEND || "s3"
).toLowerCase();
if (STORAGE !== "azure" && STORAGE !== "s3") {
  console.error(`--storage-backend must be "s3" or "azure" (got "${STORAGE}").`);
  process.exit(2);
}
const pos = argv.filter((a) => !a.startsWith("--"));
const cmd = pos[0] || "help";
const REINDEX = flags.has("--reindex");
const FULL_RESET = flags.has("--full-reset");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TEXT_PREFIX = "_TEXT/";
const CATALOG = "_CATALOG/catalog.jsonl";
const AIS_API = "2024-07-01";

// ============================ storage profile (mirrors indexer.mjs's PROFILES; storage only) ============================
const STORAGE_PROFILES = {
  finance: { azAccountSecret: "azure-cfo-storage-account", azAccount: "otchealthcfodata", azKeySecret: "azure-cfo-storage-key", azContainer: "cfo-source-docs" },
  legal: { azAccountSecret: "azure-legal-storage-account", azAccount: "otchealthlegalstore", azKeySecret: "azure-legal-storage-key", azContainer: "company" },
  commerce: { azAccountSecret: "azure-commerce-storage-account", azAccount: "otchealthcommerce", azKeySecret: "azure-commerce-storage-key", azContainer: "commerce-source-docs" },
  commons: { azAccountSecret: "azure-commons-storage-account", azAccount: "otchealthcommons", azKeySecret: "azure-commons-storage-key", azContainer: "company-journal" },
};

let ACCT, CONTAINER, AKEY, SAS;
async function resolveStorage() {
  const P = STORAGE_PROFILES[PROFILE] || STORAGE_PROFILES.commerce;
  // ACCT/CONTAINER resolve IDENTICALLY for both backends, so `--storage-backend s3` and
  // `--storage-backend azure` name the SAME logical room; only the wire protocol differs.
  ACCT = ACCT_OV || process.env.AZURE_STORAGE_ACCOUNT || P.azAccount || (await fleetSecret(P.azAccountSecret));
  CONTAINER = containerOverride || P.azContainer;
  if (STORAGE === "s3") {
    // Fail CLOSED, before any network call, on a room with no audited mirror row. The alternative
    // -- guessing a bucket -- is the specific mistake that has already been made twice in this
    // fleet (mcp-server #248, and an earlier version of s3-blob.mjs's own commons row), because
    // IAM grants cover several buckets in one statement and cannot discriminate between them.
    if (!s3LocationFor(ACCT, CONTAINER)) {
      console.error(`no S3 mirror mapping for ${ACCT}/${CONTAINER} (refusing to guess a bucket). ` +
        `Add a verified row to skills/kb-memory/s3-blob.mjs's MIRROR table, with the bucket taken ` +
        `from an OBSERVED S3 listing rather than inferred from IAM, before targeting this room on ` +
        `S3. --storage-backend azure is read-only-inspection of pre-lockdown history in the meantime.`);
      process.exit(2);
    }
    return; // no storage key and no SAS on the S3 path: credentials resolve inside s3-blob.mjs
  }
  AKEY = (KEYSECRET_OV ? await fleetSecret(KEYSECRET_OV) : null) || process.env.AZURE_STORAGE_KEY || (await fleetSecret(P.azKeySecret));
  if (!AKEY) { console.error(`Missing storage key for profile ${PROFILE} (secret ${KEYSECRET_OV || P.azKeySecret}).`); process.exit(2); }
  SAS = buildSas();
}
function buildSas() {
  // sp includes 'd' (delete): releaseLock() issues a plain blob DELETE to clear the lock file on a
  // clean exit; without 'd' that 403s silently (caught by releaseLock's empty catch) and the lock only
  // ever clears via LOCK_TTL. Found live 2026-07-21 (the same pre-existing gap in deep-pass.mjs's
  // identical buildSas(), fixed there too) while proving out the commerce enrichment run.
  const sv = "2021-12-02", sp = "rwdlc", ss = "b", srt = "co";
  const st = new Date(Date.now() - 300000).toISOString().slice(0, 19) + "Z";
  const se = new Date(Date.now() + 12 * 3600 * 1000).toISOString().slice(0, 19) + "Z";
  const sts = [ACCT, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(AKEY, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
}
const enc = (n) => n.split("/").map(encodeURIComponent).join("/");
// Single-pass entity decode: each entity is consumed exactly once (a chained .replace() could
// double-unescape e.g. `&amp;lt;` -> `<`). Best-effort fallback for HTML-entity-encoded blob names only.
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" };
const htmlEnt = (s) => s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e) => ENT[e]);
// ---- storage dispatch -------------------------------------------------------------------
// getBuf/putBuf/delBuf keep their original names and signatures so every call site below is
// backend-agnostic and unchanged. Only these three functions know which backend is in play.
//
// The null-vs-throw contract is IDENTICAL on both paths and is load-bearing: null means 404 and
// ONLY 404. A 403 (which is exactly what the locked-down Azure estate now returns, and what a
// missing S3 grant would return) must throw, never read as "this document is empty" -- that is
// the silent-success shape that made the 2026-08-18 job-fleet failure invisible for a day.
// s3-blob.mjs guarantees the same contract on its side, which is why it is a drop-in here.
async function getBufAzure(n) {
  let r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(n)}?${SAS}`);
  if (r.status === 404 && /&(amp|lt|gt|quot|#39|apos);/.test(n)) { const d = htmlEnt(n); if (d !== n) r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(d)}?${SAS}`); }
  if (r.status === 404) return null; if (!r.ok) throw new Error("get " + r.status); return Buffer.from(await r.arrayBuffer());
}
async function getBuf(n) {
  if (STORAGE === "azure") return getBufAzure(n);
  let b = await getBufferFromS3(ACCT, CONTAINER, n);
  // Same HTML-entity fallback the Azure path has. Catalog rows can carry entity-encoded names
  // from the original crawl, and those objects were mirrored to S3 under the decoded name.
  if (b == null && /&(amp|lt|gt|quot|#39|apos);/.test(n)) {
    const d = htmlEnt(n);
    if (d !== n) b = await getBufferFromS3(ACCT, CONTAINER, d);
  }
  return b;
}
async function putBuf(n, buf, ct) {
  if (STORAGE === "s3") {
    await putObjectToS3(ACCT, CONTAINER, n, buf, ct || "application/octet-stream");
    return;
  }
  const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(n)}?${SAS}`, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": ct || "application/octet-stream" }, body: buf });
  if (!r.ok) throw new Error("put " + r.status + " " + (await r.text()).slice(0, 160));
}
async function delBuf(n) {
  if (STORAGE === "s3") { await deleteObjectFromS3(ACCT, CONTAINER, n); return; }
  const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(n)}?${SAS}`, { method: "DELETE" });
  if (!r.ok && r.status !== 404) throw new Error("delete " + r.status);
}
// Azure blob CUSTOM METADATA. Reachable only on the `--search-backend azure` path, which is also
// the only path that writes back to storage at all (the OpenSearch path reads source text and
// writes enriched fields straight to the search index, never back onto the document).
//
// It is NOT ported to S3, deliberately. Azure sets metadata with a cheap `?comp=metadata` PUT;
// S3 has no equivalent, and changing metadata on an existing object requires a full CopyObject
// with MetadataDirective=REPLACE -- a different operation with different failure and cost
// characteristics. Rather than write an untested emulation of it that no live path exercises,
// this throws loud if the combination is ever requested. If Azure-search-on-S3-storage ever
// becomes real, implement it here properly instead of discovering a silent no-op later.
async function setBlobMetadata(n, metaObj) {
  if (STORAGE !== "azure") {
    throw new Error(
      `setBlobMetadata is Azure-storage-only (asked for storage=${STORAGE}). It is only reached ` +
      `by --search-backend azure; use --search-backend opensearch, which writes enriched fields ` +
      `to the search index and never writes back to the document.`);
  }
  const headers = {};
  for (const [k, v] of Object.entries(metaObj)) { if (v == null || v === "") continue; headers["x-ms-meta-" + k] = v; }
  let r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(n)}?comp=metadata&${SAS}`, { method: "PUT", headers });
  if (r.status === 404 && /&(amp|lt|gt|quot|#39|apos);/.test(n)) { const d = htmlEnt(n); if (d !== n) r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(d)}?comp=metadata&${SAS}`, { method: "PUT", headers }); }
  if (!r.ok) throw new Error("set-metadata " + r.status + " " + (await r.text()).slice(0, 160));
}

// ============================ catalog io + cron-safe lock (mirrors deep-pass.mjs's own lock) ============================
async function loadCatalog() {
  const b = await getBuf(CATALOG);
  if (!b) throw new Error(`no catalog at ${CONTAINER}/${CATALOG} -- run indexer.mjs index (and ideally understand) first`);
  return b.toString("utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
let flushing = false;
async function flushCatalog(rows) { if (flushing) return; flushing = true; try { await putBuf(CATALOG, Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8"), "application/x-ndjson"); } finally { flushing = false; } }

const LOCK = "_CATALOG/.enrich.lock";
const LOCK_TTL = 15 * 60 * 1000;
const LOCK_ID = crypto.randomBytes(6).toString("hex");
async function acquireLock() { try { const b = await getBuf(LOCK); if (b) { const j = JSON.parse(b.toString("utf8")); if (Date.now() - (j.ts || 0) < LOCK_TTL) return false; } } catch {} try { await putBuf(LOCK, Buffer.from(JSON.stringify({ ts: Date.now(), id: LOCK_ID })), "application/json"); } catch {} return true; }
async function refreshLock() { try { await putBuf(LOCK, Buffer.from(JSON.stringify({ ts: Date.now(), id: LOCK_ID })), "application/json"); } catch {} }
async function releaseLock() { try { await delBuf(LOCK); } catch {} }

// ============================ Azure OpenAI (Foundry) chat, gpt-4.1-mini only ============================
let FEP, FKEY;
// LLM PROVIDER (2026-08-19). The Azure Foundry deployment this file used exclusively now returns
// HTTP 401 ("invalid subscription key or wrong API endpoint") -- verified by direct probe, the same
// Azure-estate lockdown that killed blob storage. So the source-text port alone does NOT unblock a
// backfill: enrichment needs a MODEL as well as its documents, and both lived on Azure.
//
// `openai` is the default because it is the one that answers. Probed live before this was written:
// OpenAI direct HTTP 200, and AWS Bedrock reachable too (44 models). OpenAI was chosen over Bedrock
// because Azure OpenAI and OpenAI share the request/response schema, including
// `response_format: {type:"json_object"}`, which this prompt depends on -- so this is a genuine
// drop-in rather than a rewrite. Bedrock's Converse API would need its own request shaping and a
// separate JSON-mode strategy; it stays the documented fallback if OpenAI is ever the dead one.
//
// `azure` remains selectable so the old path is one flag away if the estate ever returns.
async function resolveLlm() {
  if (LLM_PROVIDER === "azure") {
    FEP = (process.env.AZURE_FOUNDRY_OPENAI_ENDPOINT || (await fleetSecret("azure-foundry-openai-endpoint")) || "").replace(/\/$/, "");
    FKEY = process.env.AZURE_FOUNDRY_KEY || (await fleetSecret("azure-foundry-key"));
    if (!FKEY) { console.error("Missing azure-foundry-key"); process.exit(2); }
    return;
  }
  FKEY = process.env.OPENAI_API_KEY || (await fleetSecret("openai-api-key"));
  if (!FKEY) { console.error("Missing openai-api-key (env OPENAI_API_KEY or the fleet secret)."); process.exit(2); }
}
async function chatJson(messages, max_tokens) {
  const body = { messages, max_tokens, temperature: 0, response_format: { type: "json_object" } };
  if (LLM_PROVIDER === "openai") {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${FKEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, model: MODEL }),
    });
    if (r.status === 429) { const ra = parseInt(r.headers.get("retry-after") || "0", 10); await sleep((ra > 0 ? ra * 1000 : 4000) + Math.floor(Math.random() * 1200)); return chatJson(messages, max_tokens); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("chat " + r.status + " " + JSON.stringify(j).slice(0, 160));
    return { text: j.choices?.[0]?.message?.content || "", usage: j.usage || {} };
  }
  for (const host of [FEP, "https://otchealth-foundry.cognitiveservices.azure.com"]) {
    if (!host) continue;
    try {
      const r = await fetch(`${host}/openai/deployments/${MODEL}/chat/completions?api-version=2024-10-21`, { method: "POST", headers: { "api-key": FKEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.status === 429) { const ra = parseInt(r.headers.get("retry-after") || "0", 10); await sleep((ra > 0 ? ra * 1000 : 4000) + Math.floor(Math.random() * 1200)); return chatJson(messages, max_tokens); }
      const j = await r.json();
      if (r.ok) return { text: j.choices?.[0]?.message?.content || "", usage: j.usage || {} };
      if (r.status !== 404) throw new Error("chat " + r.status + " " + JSON.stringify(j).slice(0, 160));
    } catch (e) { if (!String(e).includes("404")) throw e; }
  }
  throw new Error("enrich chat: no working Foundry endpoint");
}
const J = (t) => { try { return JSON.parse(t); } catch { try { return JSON.parse(String(t).slice(String(t).indexOf("{"), String(t).lastIndexOf("}") + 1)); } catch { return null; } } };
// Rates follow the PROVIDER, because the default model now does too. Reporting Azure gpt-4.1-mini
// prices ($0.40/$1.60 per 1M) for an OpenAI gpt-4o-mini run ($0.15/$0.60) would overstate a backfill
// by ~2.6x, and a cost line that quietly prices a different model than the one that ran is its own
// small version of reporting something untrue. Illustrative either way -- confirm against live
// pricing before committing real budget to a large backfill.
function estCost(tin, tout) {
  const [rin, rout] = LLM_PROVIDER === "openai" ? [0.15, 0.60] : [0.4, 1.6];
  return (tin / 1e6) * rin + (tout / 1e6) * rout;
}

// ============================ room name (shared by every Azure AI Search AND OpenSearch call) ============================
// Both backends use the IDENTICAL room/index-name convention (verified live on OpenSearch 2026-08-16:
// same names as the Azure rooms, e.g. "commerce-commerce-source-docs" -- see
// otchealth-mcp-server/src/search/opensearch.ts's own file header, "ROOM/INDEX NAMES: identical to the
// Azure rooms by design"). Factored out of what was three copy-pasted inline computations
// (cmdEnsureSchema/cmdReindexRoom/cmdVerify) so the new OpenSearch call sites share it too rather than
// becoming a fourth copy.
function roomName() {
  return `${PROFILE}-${CONTAINER}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 128);
}

// ============================ OpenSearch (AWS) write path ============================
// THE GAP THIS CLOSES (verified live 2026-08-16 before writing any of this): every chunked doc room on
// the live OpenSearch brain (otchealth-brain domain) has 0% coverage on every entity/enrichment field
// -- confirmed via `exists` queries returning 0 across legal-company, legal-personal,
// finance-cfo-source-docs, commons-company-journal, and commerce-commerce-source-docs -- because this
// file, until now, only ever resolved AZURE_SEARCH_ENDPOINT / azure-search-admin-key.
//
// The OpenSearch doc rooms' mapping ALREADY carries the 20-of-22 universal-core fields (provisioned
// when the room's index was created; missing only contextual_prefix/word_count) and ZERO domain-pack
// fields (commerce's 15 extras) -- verified live via osGetMapping before this was written. No
// `dynamic:strict` is set on any doc room (verified via GET .../_settings), so writing the remaining
// fields is safe: OpenSearch's default dynamic mapping creates them from the first document that
// carries them, and because every write always goes through openSearchDocFields (the same
// domain-driven field list, same types, every time), the inferred mapping stays consistent from the
// first write onward -- there is no scenario where two different writers disagree on a new field's
// type.
const OS_DEFAULT_HOST = "search-otchealth-brain-uqmq2jw23cv4yjnnxblxzb7nny.us-east-1.es.amazonaws.com";
let OS_CFG = null;
async function resolveOpenSearch() {
  const host = (process.env.OPENSEARCH_ENDPOINT || (await fleetSecret("opensearch-endpoint")) || OS_DEFAULT_HOST)
    .replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const region = process.env.OPENSEARCH_REGION || (await fleetSecret("opensearch-region")) || "us-east-1";
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID || (await fleetSecret("aws-cto-access-key-id"));
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || (await fleetSecret("aws-cto-secret-access-key"));
  if (!accessKeyId || !secretAccessKey) {
    console.error("Missing AWS credentials for OpenSearch (env AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or Key Vault aws-cto-access-key-id/aws-cto-secret-access-key).");
    process.exit(2);
  }
  OS_CFG = { host, region, accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN || undefined };
}

/**
 * A catalog row needs a fresh LLM enrichment pass when it has never been enriched, or its content
 * changed since the last enrichment (sha256 mismatch), or --reindex forces a full regen. Identical
 * gate to the pre-existing inline `cmdRun` filter, factored out so both the "which rows need an LLM
 * call" decision and the (backend-specific) "which rows need a write" decision can be asked
 * independently of each other -- see needsOsSync below for why they are no longer the same question.
 */
function needsEnrich(r) {
  return REINDEX || !r.enriched || r.enriched_sha256 !== r.sha256;
}

/**
 * A row needs an OpenSearch sync when its CURRENT sha256 has not yet been pushed to OpenSearch. This
 * is DELIBERATELY independent of needsEnrich: most catalog rows in a room that was already enriched
 * for Azure (enriched_sha256 already matches sha256) still need their existing, already-computed
 * fields projected to OpenSearch for the first time -- that projection costs zero LLM tokens (the
 * fields already sit on the catalog row from the prior Azure run; see buildFieldsFromRow below), so
 * gating it on the SAME enriched_sha256 flag Azure uses would silently skip the exact rows this
 * write path exists to fix. enrich_os_sha256 is a new, purely additive catalog field for this.
 */
function needsOsSync(r) {
  return BACKEND === "opensearch" && (REINDEX || !r.enrich_os_sha256 || r.enrich_os_sha256 !== r.sha256);
}

/** Reconstruct the exact `fields` shape enrichOne() would have returned, by reading the domain's field
 *  names directly off an ALREADY-enriched catalog row. Used for the (common) case where a row was
 *  enriched for Azure on a prior run and now only needs projecting to OpenSearch -- no LLM call. */
function buildFieldsFromRow(r) {
  const out = {};
  for (const f of MS.fieldsForDomain(DOMAIN)) out[f.name] = r[f.name];
  return out;
}

/** Find every existing OpenSearch chunk document for one catalog row, by exact match on its `path`
 *  field. Verified live (2026-08-16): the bulk loader that populated OpenSearch wrote `path` as
 *  "<account>/<container>/<catalog-row-path>" (no https://.../_TEXT/ prefix or .txt suffix the way
 *  Azure's blob-URL `path` field carries it -- a genuinely different convention from Azure, not a
 *  typo), identical across every chunk of the same parent, so one query returns every chunk's real
 *  `_id` (== its chunk_id) directly with no separate parent_id lookup needed. `path` is a `text` field
 *  with a `.keyword` sub-field (see the live mapping), so the exact-match query MUST target
 *  `path.keyword`, not the analyzed `path` field itself, or a `term` query would rarely match. Bounded
 *  at 500 (comfortably above the largest observed parent in commerce, 47 chunks) -- never unbounded. */
async function osFindChunkIds(r) {
  const pathValue = `${ACCT}/${CONTAINER}/${r.path}`;
  const res = await osSearch(OS_CFG, roomName(), {
    size: 500,
    _source: false,
    query: { term: { "path.keyword": pathValue } },
  });
  if (!res.ok || !res.json) throw new Error(`opensearch chunk lookup failed: http ${res.status} ${res.text.slice(0, 200)}`);
  return (res.json.hits?.hits || []).map((h) => h._id).filter(Boolean);
}

function enrichSystemPrompt(domain, needSummary) {
  const docTypes = MS.enumFor({ enumKey: "DOC_TYPE" }, domain).join("|");
  let schema = `{
 "doc_title": "concise real title from the document's own content, never the filename",
 "doc_type": "best-fit type from: ${docTypes}",
 ${needSummary ? '"summary": "4-9 sentence decision-grade summary quoting exact figures/parties/dates if present",' : ""}
 "keywords": ["5 to 12 short exact terms a person would search for"],
 "hypothetical_questions": ["3 to 5 short natural-language questions this document actually answers"],
 "entities": ["every company/organization/product entity this document is ABOUT, max 8"],
 "named_entities_orgs": ["organizations mentioned anywhere in the text, max 8"],
 "named_entities_people": ["people's full names mentioned anywhere in the text, max 8"],
 "confidentiality": "one of: ${MS.ENUMS.CONFIDENTIALITY.join("|")}",
 "mnpi_flag": true or false (true ONLY if this discusses material non-public information about the public company InnerScope/INND),
 "materiality_level": "one of: ${MS.ENUMS.MATERIALITY.join("|")}",
 "contextual_prefix": "1 to 3 short sentences (about 50 to 100 words) that situate this document for search: what it is, which company/system, roughly when",
 "confidence": "one of: high|medium|low -- your honest confidence in this extraction"
}`;
  if (domain === "commerce") {
    schema = schema.replace(/\}$/, `,
 "channel": "one of: ${MS.ENUMS.CHANNEL.join("|")}",
 "brand": "one of: ${MS.ENUMS.BRAND.join("|")}",
 "related_systems": ["systems/APIs/platforms this document touches, e.g. Shopify GraphQL, SP-API, RevenueCat, max 6"],
 "product_names": ["specific product names mentioned, max 6"],
 "sku_asin_codes": ["any SKU or ASIN-looking codes found verbatim in the text, max 10"],
 "compliance_flags": ["zero or more of: medical-claims-free, securities-risk-flagged, guarantee-language-stale -- ONLY if genuinely applicable, else []"],
 "medical_claims_present": true or false (true if the text makes or discusses a medical/hearing-aid/FDA claim -- TReO is a PSAP, NOT a hearing aid, so hearing-aid language anywhere is a compliance risk to flag)
}`);
  }
  // Field/passage-level confidentiality classification (Wave 7 item 7.4, 2026-07-22): only asked of
  // the executive-ring domains (finance, legal -- covers both legal-company and legal-personal, they
  // share the "legal" domain, see MS.SEGMENT_CONFIDENTIALITY_DOMAINS). Splices one more field into the
  // SAME call, zero extra LLM calls. See metadata-schema.mjs's SEGMENT_CONFIDENTIALITY_* section for
  // the full design note (what this is, what it is explicitly NOT: no enforcement/consumption here).
  if (MS.SEGMENT_CONFIDENTIALITY_DOMAINS.has(domain)) {
    schema = schema.replace(/\}$/, `,
 ${MS.segmentClassificationPromptBlock()}
}`);
  }
  return `You are a meticulous document cataloguing analyst for OTCHealth Inc./InnerScope. Output ONLY a JSON object, no prose, matching exactly this schema (use "" or [] for anything not present or not applicable; NEVER invent a fact not supported by the text; if genuinely unsure, say so via a lower "confidence" rather than guessing):
${schema}`;
}
async function callEnrichLLM(r, text, opts) {
  const context = `Path: ${r.path}
Existing category: ${r.category || ""}
Existing doc type (from an earlier pass): ${r.doc_type || ""}
Existing summary (from an earlier pass, may be thin): ${(r.summary || "").slice(0, 800)}
Existing counterparty/amount (from an earlier pass): ${r.counterparty || ""} ${r.amount || ""}

Document text (may be truncated):
${text.slice(0, 7000)}`;
  try {
    const res = await chatJson([{ role: "system", content: enrichSystemPrompt(DOMAIN, opts.needSummary) }, { role: "user", content: context }], 1200);
    const parsed = J(res.text) || { _parseFailed: true };
    parsed._usage = { tin: res.usage.prompt_tokens || 0, tout: res.usage.completion_tokens || 0 };
    return parsed;
  } catch (e) {
    // A THROW here is the model being UNREACHABLE (dead endpoint, 401, network), which is a
    // categorically different thing from the model answering with unparseable text. Both used to
    // collapse into `_parseFailed`, and the run then reported "flagged low-confidence" with exit 0
    // and ~$0.000 -- so a totally dead LLM looked like a mild quality problem. That is how a
    // backfill can appear to run to completion having enriched nothing. Keep them distinct: this
    // sets _callFailed (with the real error preserved), and the caller counts and reports it.
    return { _callFailed: true, _usage: { tin: 0, tout: 0 }, _err: String(e.message).slice(0, 200) };
  }
}

// ============================ deterministic / rule-first helpers ============================
function classifySourceType(path) {
  const p = path.toLowerCase();
  if (/session-checkpoint|digest|_recovery\//.test(p)) return "ai_memo";
  if (/\.(json|csv)$/.test(p)) return "machine_generated";
  return "primary_source";
}
function dirnameBelowRoot(path) { const parts = path.split("/"); parts.pop(); return parts.join("/"); }
function pathDateGuess(path) { const m = path.match(/(\d{4})-(\d{2})-(\d{2})/); return m ? m[0] : ""; }
function extractNotionId(hay) {
  const m = hay.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || hay.match(/\b[0-9a-f]{32}\b/i);
  return m ? m[0] : "";
}
function extractUrl(text) { const m = text.slice(0, 20000).match(/https?:\/\/[^\s")\]]+/); return m ? m[0].replace(/[.,;]+$/, "") : ""; }
function extractVerifiedDate(text) {
  const m = text.slice(0, 20000).match(/(?:last )?verified(?: as of)?[:\s]+(\d{4}-\d{2}-\d{2})/i) || text.slice(0, 20000).match(/confirmed as of[:\s]+(\d{4}-\d{2}-\d{2})/i);
  return m ? MS.validDateOrEmpty(m[1]) : "";
}
function extractSignedOffBy(text) {
  const m = text.slice(0, 20000).match(/(?:signed off by|approved by|reviewed by)[:\s]+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})/);
  return m ? m[1].trim() : "";
}
function classifyAuthorAgent(path) {
  const p = path.toLowerCase();
  if (/^shopify\/|^shopify-library\//.test(p)) return "cro";
  if (/^video-production\//.test(p)) return "creative";
  if (/^checkpoints\//.test(p)) return "commerce";
  return "unknown";
}
function ruleFirstConfidentiality(path, text) {
  const hay = (path + " " + text.slice(0, 2000)).toLowerCase();
  if (/_notion\/innd-mnpi\/|ring mnpi-innd/.test(hay)) return "mnpi_restricted";
  if (/attorney[- ]client|attorney[- ]privileged/.test(hay)) return "attorney_privileged";
  if (/\bssn\b|social security number/.test(hay)) return "personal_pii";
  if (/\bpublished\b|\bpublic[_-]site\b/.test(path.toLowerCase())) return "public";
  return "";
}
function ruleFirstMnpi(path, text) {
  const hay = (path + " " + text.slice(0, 2000)).toLowerCase();
  return /\bmnpi\b|material non-?public|reg[- ]fd|insider trading/.test(hay);
}
function ruleFirstMedicalClaims(text) {
  return /\bhearing aid\b|\bfda[- ]clear(ed|ance)\b|\btreats? hearing loss\b|medical device claim/i.test(text.slice(0, 20000));
}

// ============================ one document ============================
async function applyPrefixToSidecar(path, prefix) {
  const key = TEXT_PREFIX + path + ".txt";
  const buf = await getBuf(key);
  if (!buf) return;
  const existing = buf.toString("utf8");
  const updated = MS.applyContextualPrefix(existing, prefix);
  if (updated === existing) return;
  await putBuf(key, Buffer.from(updated, "utf8"), "text/plain; charset=utf-8");
}

async function enrichOne(r) {
  const sidecarBuf = await getBuf(TEXT_PREFIX + r.path + ".txt");
  const text = sidecarBuf ? sidecarBuf.toString("utf8") : "";

  // ---- deterministic / code fields (zero LLM cost) ----
  const word_count = (text.match(/\S+/g) || []).length;
  const content_hash = r.sha256 || "";
  const source_path = dirnameBelowRoot(r.path);
  const source_type = classifySourceType(r.path);
  const doc_date = MS.validDateOrEmpty(r.execution_date || r.doc_date || pathDateGuess(r.path));
  const notion_source_page_id = extractNotionId(r.path + " " + text.slice(0, 4000));
  const page_url = extractUrl(text);
  const last_verified_date = extractVerifiedDate(text);
  const signed_off_by = extractSignedOffBy(text);
  const { amount: price_amount, currency: priceCurrency } = MS.parseAmount(r.amount || r.principal || "");

  // ---- rewire fields (already computed by CU `understand` + deep-pass.mjs -- zero extra LLM cost) ----
  const entity = r.entity || "";
  const materialityRewired = r.materiality || (r.material ? "high" : "");
  const executionStatusRewired = r.execution_status || "";
  const signed = !!r.has_signature;
  const signatories = Array.isArray(r.signatories) ? r.signatories : [];
  const extractionConfidenceRewired = r.sig_confidence || r.confidence || "";
  const richSummaryAvailable = !!(r.deep && r.summary && r.summary.length > 120);

  // ---- ONE cheap gpt-4.1-mini call for everything CU/deep-pass did not already compute ----
  const llm = await callEnrichLLM(r, text, { needSummary: !richSummaryAvailable });

  const doc_type = MS.coerceEnum(llm.doc_type, MS.enumFor({ enumKey: "DOC_TYPE" }, DOMAIN), "other");
  const confidentiality = ruleFirstConfidentiality(r.path, text) || MS.coerceEnum(llm.confidentiality, MS.ENUMS.CONFIDENTIALITY, "internal");
  const mnpi_flag = ruleFirstMnpi(r.path, text) || !!llm.mnpi_flag;
  const materiality_level = MS.coerceEnum(materialityRewired || llm.materiality_level, MS.ENUMS.MATERIALITY, "low");
  const execution_status = MS.coerceEnum(executionStatusRewired || llm.execution_status, MS.ENUMS.EXECUTION_STATUS, r.requires_signature === false || r.requires_signature == null ? "NOT_APPLICABLE" : "CANNOT_DETERMINE");
  const extraction_confidence = MS.coerceEnum(extractionConfidenceRewired || llm.confidence, MS.ENUMS.CONFIDENCE, "medium");
  const summary = richSummaryAvailable ? r.summary : (llm.summary || r.summary || "");
  const medical_claims_present = ruleFirstMedicalClaims(text) || !!llm.medical_claims_present;

  const fields = {
    doc_title: MS.capStr(llm.doc_title || r.title_deep || r.title || "", 160),
    doc_type,
    summary: MS.capStr(summary, 1200),
    keywords: MS.capList(llm.keywords, 12, 40),
    hypothetical_questions: MS.capList(llm.hypothetical_questions, 5, 140),
    entity: MS.capStr(entity, 64),
    entities: MS.capList(llm.entities, 8, 64),
    named_entities_orgs: MS.capList(llm.named_entities_orgs, 8, 64),
    named_entities_people: MS.capList(llm.named_entities_people, 8, 64),
    doc_date, source_type, source_path: MS.capStr(source_path, 220),
    content_hash, confidentiality, mnpi_flag, materiality_level, execution_status, signed,
    signatories: MS.capList(signatories, 10, 80),
    extraction_confidence,
    contextual_prefix: MS.capStr(llm.contextual_prefix || "", 700),
    word_count,
  };
  if (DOMAIN === "commerce") {
    const currency = MS.coerceEnum(priceCurrency || llm.currency, MS.ENUMS.CURRENCY, priceCurrency || "");
    Object.assign(fields, {
      channel: MS.coerceEnum(llm.channel, MS.ENUMS.CHANNEL, "unknown"),
      brand: MS.coerceEnum(llm.brand, MS.ENUMS.BRAND, "unknown"),
      related_systems: MS.capList(llm.related_systems, 6, 40),
      product_names: MS.capList(llm.product_names, 6, 60),
      sku_asin_codes: MS.capList(llm.sku_asin_codes, 10, 24),
      price_amount: Number.isFinite(price_amount) ? price_amount : null,
      currency,
      transaction_or_listing_date: doc_date, // commerce has no separate transaction-date signal today; aliases doc_date
      compliance_flags: MS.capList(llm.compliance_flags, 5, 40),
      medical_claims_present,
      author_agent: MS.capStr(classifyAuthorAgent(r.path), 24),
      page_url: MS.capStr(page_url, 300),
      last_verified_date,
      signed_off_by: MS.capStr(signed_off_by, 80),
      notion_source_page_id: MS.capStr(notion_source_page_id, 40),
    });
  }
  // Field/passage-level confidentiality classification (Wave 7 item 7.4): only computed for the
  // executive-ring domains. buildSegmentFields is the whole merge (validate the LLM's raw
  // sensitive_segments -> the three field values below); see metadata-schema.mjs for the pure,
  // unit-tested logic. Groundwork only -- nothing downstream consumes these fields yet.
  if (MS.SEGMENT_CONFIDENTIALITY_DOMAINS.has(DOMAIN)) {
    Object.assign(fields, MS.buildSegmentFields(llm.sensitive_segments));
  }

  const lowConf = extraction_confidence === "low" || !!llm._parseFailed || !!llm._callFailed;
  // A doc whose LLM call never completed is NOT enriched, and must not be recorded as if it were.
  // Setting `enriched: true` with a matching sha256 makes needsEnrich() skip it forever, so a
  // transient outage would permanently poison those rows: they would be "done" having learned
  // nothing, and no future run would revisit them. Leave the enriched marker OFF on that path so
  // the work is simply retried once the model is reachable again.
  const patch = {
    enriched: !llm._callFailed,
    enriched_sha256: llm._callFailed ? "" : (r.sha256 || ""),
    enriched_at: new Date().toISOString(),
    enrich_engine: MODEL,
    enrich_review: lowConf,
    enrich_reasons: lowConf
      ? [llm._callFailed
          ? `LLM call failed (model unreachable, not a parse problem): ${llm._err || "unknown error"}`
          : llm._parseFailed ? "LLM JSON parse failed" : "low extraction confidence"]
      : [],
    ...fields,
  };

  // Build the blob-metadata payload: strings pass through capped; lists -> JSON array string (+
  // jsonArrayToStringCollection on the indexer side); booleans/numbers -> their string form; empty
  // values are OMITTED (an absent metadata key just leaves that index field null, which is correct).
  const metaPairs = {};
  for (const f of MS.fieldsForDomain(DOMAIN)) {
    const v = fields[f.name];
    if (v == null) continue;
    if (f.kind === "list") { if (!v.length) continue; metaPairs[f.name] = MS.toJsonArrayMeta(v); }
    else if (f.kind === "bool") metaPairs[f.name] = v ? "true" : "false";
    else if (f.kind === "int" || f.kind === "double") { if (!Number.isFinite(v)) continue; metaPairs[f.name] = String(v); }
    else if (f.kind === "date") { if (!v) continue; metaPairs[f.name] = v; }
    else { if (v === "") continue; metaPairs[f.name] = MS.capStr(v, f.maxLen || 200); }
  }
  const { pairs: metaTrimmed, bytes, overBudget } = MS.fitMetadataBudget(metaPairs);
  if (overBudget) console.error(`  [enrich] WARN ${r.path.slice(-60)}: metadata still ~${bytes}B after trim (Azure caps at 8000B) -- Azure may reject or truncate.`);

  return { patch, usage: llm._usage || { tin: 0, tout: 0 }, meta: metaTrimmed, callFailed: !!llm._callFailed, callErr: llm._err || "" };
}

// ============================ run command ============================
async function cmdRun() {
  await resolveStorage();
  await resolveLlm();
  if (BACKEND === "opensearch") await resolveOpenSearch();
  if (!(await acquireLock())) { console.error("[enrich] another execution holds a fresh lock for this room; exiting 0 (cron-safe, no double-run)."); return; }
  let n = 0, flagged = 0, tin = 0, tout = 0, budgetHit = false;
  let osSynced = 0, osChunks = 0, osErrors = 0;
  // Counted separately from `flagged` so a dead model can never hide inside a quality statistic.
  let llmCalls = 0, llmFailed = 0, firstLlmErr = "";
  try {
    const rows = await loadCatalog();
    let todo = rows.filter((r) => r.path && !r.path.startsWith("_") && r.sidecar && !r.err && (needsEnrich(r) || needsOsSync(r)));
    if (LIMIT) todo = todo.slice(0, LIMIT);
    console.error(`[enrich] domain=${DOMAIN} | search-backend=${BACKEND} | ${rows.length} catalog rows | ${todo.length} to (re)enrich/sync | model=${MODEL} conc=${CONCURRENCY}${MAX_MIN ? ` budget=${MAX_MIN}m` : ""}`);
    if (!todo.length) { console.log("[enrich] nothing to enrich (all caught up)."); return; }
    let next = 0, since = 0;
    const start = Date.now();
    async function worker() {
      for (;;) {
        if (MAX_MIN && Date.now() - start > MAX_MIN * 60000) { budgetHit = true; return; }
        const i = next++; if (i >= todo.length) return;
        const r = todo[i];
        try {
          // A row already enriched for its CURRENT sha256 (needsEnrich false) that only needsOsSync
          // skips the LLM call entirely -- its fields already sit on the catalog row from a prior run
          // (Azure or otherwise); reconstruct them instead of re-asking the model (zero extra cost,
          // see buildFieldsFromRow's doc comment).
          let fieldsForWrite;
          if (needsEnrich(r)) {
            const { patch, usage, meta: azureMeta, callFailed, callErr } = await enrichOne(r);
            tin += usage.tin || 0; tout += usage.tout || 0;
            llmCalls++;
            if (callFailed) { llmFailed++; if (!firstLlmErr) firstLlmErr = callErr || "unknown"; }
            Object.assign(r, patch);
            if (patch.enrich_review) flagged++;
            fieldsForWrite = buildFieldsFromRow(r);
            if (BACKEND === "azure") {
              // ORDER MATTERS: Put Blob (used below to prepend the contextual-retrieval prefix)
              // overwrites the WHOLE blob resource, including clearing any custom metadata that was
              // not part of that same PUT (Azure Blob semantics, not an enrich.mjs choice).
              // Content-edit FIRST, metadata-set LAST, so the metadata write is always the final word
              // and actually sticks.
              if (patch.contextual_prefix) await applyPrefixToSidecar(r.path, patch.contextual_prefix);
              await setBlobMetadata(TEXT_PREFIX + r.path + ".txt", azureMeta);
            }
          } else {
            fieldsForWrite = buildFieldsFromRow(r);
          }
          if (BACKEND === "opensearch" && needsOsSync(r)) {
            const chunkIds = await osFindChunkIds(r);
            if (!chunkIds.length) {
              r.enrich_os_err = "no OpenSearch chunks found for this path (not yet loaded into the room, or path convention mismatch)";
              osErrors++;
            } else {
              const osDoc = MS.openSearchDocFields(fieldsForWrite, DOMAIN);
              const bulkRes = await osBulkUpdate(OS_CFG, roomName(), chunkIds, osDoc);
              if (bulkRes.ok) {
                r.enrich_os_sha256 = r.sha256 || "";
                r.enrich_os_synced_at = new Date().toISOString();
                r.enrich_os_chunks = chunkIds.length;
                delete r.enrich_os_err;
                osSynced++; osChunks += chunkIds.length;
              } else {
                r.enrich_os_err = bulkRes.errors.map((e) => e.error).slice(0, 3).join(" | ").slice(0, 300);
                osErrors++;
              }
            }
          }
        } catch (e) { r.enrich_err = String(e.message).slice(0, 140); }
        n++; since++;
        if (since >= 20) {
          since = 0; await flushCatalog(rows); await refreshLock();
          console.error(`  ...${n}/${todo.length} (flagged ${flagged}; ~$${estCost(tin, tout).toFixed(3)})${BACKEND === "opensearch" ? ` | os synced=${osSynced} chunks=${osChunks} errors=${osErrors}` : ""}`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length || 1) }, worker));
    await flushCatalog(rows);
    // Force visibility of everything just written rather than waiting for the default ~1s refresh
    // interval -- called ONCE at the end (not per-write, which would add real latency at scale for no
    // benefit once the caller is done batching; see osRefresh's own doc comment).
    if (BACKEND === "opensearch" && osSynced > 0) { try { await osRefresh(OS_CFG, roomName()); } catch (e) { console.error(`  [enrich] WARN: post-sync refresh failed (results will still become visible on the next automatic refresh): ${e.message}`); } }
    const flaggedRows = rows.filter((r) => r.enrich_review);
    const csv = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""').replace(/\r?\n/g, " ") + '"';
    const out = ["path,doc_type,extraction_confidence,reasons", ...flaggedRows.map((r) => [csv(r.path), csv(r.doc_type), csv(r.extraction_confidence), csv((r.enrich_reasons || []).join("; "))].join(","))].join("\n");
    await putBuf("_REVIEW/metadata-review-queue.csv", Buffer.from(out, "utf8"), "text/csv");
    const osSummary = BACKEND === "opensearch" ? `, opensearch: ${osSynced} doc(s) synced (${osChunks} chunk writes), ${osErrors} error(s)` : "";
    const llmSummary = llmCalls ? `, llm: ${llmCalls - llmFailed}/${llmCalls} calls ok` : "";
    console.log(`[enrich] +${n} docs processed (${flagged} flagged low-confidence -> _REVIEW/metadata-review-queue.csv), ~$${estCost(tin, tout).toFixed(3)}${llmSummary}${osSummary}${budgetHit ? " (time budget hit -- resumable, rerun for the tail)" : ""}.`);

    // EXIT NON-ZERO WHEN EVERY LLM CALL FAILED. Without this the run reports "+N docs processed"
    // and exits 0 having enriched nothing, because each failure is caught per-document to stop one
    // bad doc from killing a long batch. That per-doc tolerance is correct; what was missing is the
    // AGGREGATE check. A scheduled job that cannot reach its model must go RED -- a green tick on a
    // job that did nothing is exactly how the 2026-08-18 fleet outage stayed invisible for a day.
    //
    // Deliberately "all failed", not "any failed": one unreachable document in a 36,000-doc room is
    // worth a warning but not worth failing the batch, whereas a 0% success rate is never anything
    // but a broken dependency.
    if (llmCalls > 0 && llmFailed === llmCalls) {
      console.error(`[enrich] FATAL: all ${llmCalls} LLM call(s) failed -- the model is unreachable, ` +
        `so nothing was actually enriched. provider=${LLM_PROVIDER} model=${MODEL}. First error: ${firstLlmErr}`);
      process.exitCode = 1;
    } else if (llmFailed > 0) {
      console.error(`[enrich] WARN: ${llmFailed}/${llmCalls} LLM call(s) failed; those rows were NOT ` +
        `marked enriched and will be retried on the next run. First error: ${firstLlmErr}`);
    }
  } finally {
    await releaseLock();
  }
}

// ============================ ensure-schema command ============================
async function aisGet(ep, key, path) { const r = await fetch(`${ep}${path}?api-version=${AIS_API}`, { headers: { "api-key": key } }); if (!r.ok) return { status: r.status, body: null }; return { status: r.status, body: await r.json() }; }
async function aisPut(ep, key, path, body) { const r = await fetch(`${ep}${path}?api-version=${AIS_API}`, { method: "PUT", headers: { "api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`PUT ${path} ${r.status} ${(await r.text()).slice(0, 320)}`); return r.status; }

async function cmdEnsureSchema() {
  await resolveStorage();
  const AIS_EP = (process.env.AZURE_SEARCH_ENDPOINT || (await fleetSecret("azure-search-endpoint")) || "").replace(/\/$/, "");
  const AIS_KEY = process.env.AZURE_SEARCH_KEY || (await fleetSecret("azure-search-admin-key"));
  const FOUNDRY_KEY = process.env.AZURE_FOUNDRY_KEY || (await fleetSecret("azure-foundry-key"));
  if (!AIS_EP || !AIS_KEY) { console.error("Missing azure-search-endpoint / azure-search-admin-key."); process.exit(2); }
  if (!FOUNDRY_KEY) { console.error("Missing azure-foundry-key (needed to re-supply the redacted vectorizer/skill key on PUT)."); process.exit(2); }
  const ROOM = roomName();
  const fieldDefs = MS.fieldsForDomain(DOMAIN);

  // 1) INDEX: additive field add + refreshed semantic config. GET-clone-append-PUT, deredacting the
  // vectorizer's apiKey (Azure GETs always return "<redacted>" for it) so the PUT does not brick vector
  // search. mergeSchemaAdditive is still applied as defense-in-depth against a concurrent racing writer.
  const liveIdxRes = await aisGet(AIS_EP, AIS_KEY, `/indexes/${ROOM}`);
  if (!liveIdxRes.body) throw new Error(`index ${ROOM} not found -- run indexer.mjs index/understand for this room first so the S1 pull-indexer + index already exist.`);
  const liveIdx = liveIdxRes.body;
  const desired = JSON.parse(JSON.stringify(liveIdx));
  delete desired["@odata.context"]; delete desired["@odata.etag"];
  const liveFieldNames = new Set(desired.fields.map((f) => f.name));
  const newFields = fieldDefs.filter((f) => !liveFieldNames.has(f.name));
  for (const f of newFields) desired.fields.push(MS.azureFieldDef(f));
  if (desired.semantic?.configurations?.[0]) desired.semantic.configurations[0].prioritizedFields = MS.semanticConfig().prioritizedFields;
  MS.deredact(desired, FOUNDRY_KEY);
  const putSchema = mergeSchemaAdditive(desired, liveIdx);
  await aisPut(AIS_EP, AIS_KEY, `/indexes/${ROOM}`, putSchema);
  console.log(`[enrich] index ${ROOM}: +${newFields.length} new field(s) (${desired.fields.length} total)`);

  // 2) SKILLSET: additive index-projection mapping add (parent field -> every chunk row).
  const ssName = `ss-${ROOM}`;
  const liveSsRes = await aisGet(AIS_EP, AIS_KEY, `/skillsets/${ssName}`);
  if (!liveSsRes.body) throw new Error(`skillset ${ssName} not found.`);
  const ss = JSON.parse(JSON.stringify(liveSsRes.body));
  delete ss["@odata.context"]; delete ss["@odata.etag"];
  const sel = ss.indexProjections?.selectors?.[0];
  if (!sel) throw new Error(`skillset ${ssName} has no indexProjections.selectors[0] -- unexpected live shape, refusing to guess at a fix.`);
  const haveProj = new Set(sel.mappings.map((m) => m.name));
  const newProj = fieldDefs.filter((f) => !haveProj.has(f.name));
  for (const f of newProj) sel.mappings.push(MS.projectionMapping(f));
  MS.deredact(ss, FOUNDRY_KEY);
  await aisPut(AIS_EP, AIS_KEY, `/skillsets/${ssName}`, ss);
  console.log(`[enrich] skillset ${ssName}: +${newProj.length} new projection mapping(s)`);

  // 3) INDEXER: additive fieldMappings add (blob custom metadata -> /document/<field>).
  const ixrName = `ixr-${ROOM}`;
  const liveIxrRes = await aisGet(AIS_EP, AIS_KEY, `/indexers/${ixrName}`);
  if (!liveIxrRes.body) throw new Error(`indexer ${ixrName} not found.`);
  const ixr = JSON.parse(JSON.stringify(liveIxrRes.body));
  delete ixr["@odata.context"]; delete ixr["@odata.etag"];
  ixr.fieldMappings = ixr.fieldMappings || [];
  const haveMap = new Set(ixr.fieldMappings.map((m) => m.targetFieldName));
  const newMap = fieldDefs.filter((f) => !haveMap.has(f.name));
  for (const f of newMap) ixr.fieldMappings.push(MS.indexerFieldMapping(f));
  await aisPut(AIS_EP, AIS_KEY, `/indexers/${ixrName}`, ixr);
  console.log(`[enrich] indexer ${ixrName}: +${newMap.length} new fieldMapping(s) (${ixr.fieldMappings.length} total)`);

  console.log(`[enrich] schema ensured for ${ROOM} (domain pack: ${DOMAIN}, ${fieldDefs.length} total fields defined). Run 'reindex-room' to apply to existing docs now, or let the next scheduled indexer cycle pick it up (blob metadata writes bump Last-Modified).`);
}

// ============================ reindex-room command ============================
async function cmdReindexRoom() {
  await resolveStorage();
  const AIS_EP = (process.env.AZURE_SEARCH_ENDPOINT || (await fleetSecret("azure-search-endpoint")) || "").replace(/\/$/, "");
  const AIS_KEY = process.env.AZURE_SEARCH_KEY || (await fleetSecret("azure-search-admin-key"));
  if (!AIS_EP || !AIS_KEY) { console.error("Missing azure-search-endpoint / azure-search-admin-key."); process.exit(2); }
  const ROOM = roomName();
  const ixrName = `ixr-${ROOM}`;
  async function post(path) { const r = await fetch(`${AIS_EP}${path}?api-version=${AIS_API}`, { method: "POST", headers: { "api-key": AIS_KEY } }); return r.status; }
  if (FULL_RESET) console.log("reset ->", await post(`/indexers/${ixrName}/reset`));
  console.log("run ->", await post(`/indexers/${ixrName}/run`));
  if (WAIT_MIN) {
    // NOTE: the indexer resource's top-level `status` reflects its SCHEDULE state ("running" = the
    // PT2H cron is active), not whether a run is currently executing -- it stays "running" even at
    // rest, so it is not a usable poll-until-done signal. `lastResult.status` (reset/inProgress vs
    // success/transientFailure/error) is the one that actually changes when THIS run finishes.
    const deadline = Date.now() + WAIT_MIN * 60000;
    while (Date.now() < deadline) {
      await sleep(4000);
      const st = (await aisGet(AIS_EP, AIS_KEY, `/indexers/${ixrName}/status`)).body;
      const lr = st.lastResult?.status;
      console.log(`  schedule=${st.status} / lastResult=${lr} itemsProcessed=${st.lastResult?.itemsProcessed} errors=${(st.lastResult?.errors || []).length}`);
      if (lr && lr !== "inProgress" && lr !== "reset") break;
    }
  }
}

// ============================ verify command ============================
async function cmdVerify() {
  await resolveStorage();
  if (!VERIFY_PATH) { console.error(`usage: verify --profile <p> --${BACKEND === "opensearch" ? "search-backend opensearch" : "azure"} --path "<catalog path, e.g. shopify-library/00-index.md>"`); process.exit(2); }
  const ROOM = roomName();
  const fieldDefs = MS.fieldsForDomain(DOMAIN);

  if (BACKEND === "opensearch") {
    await resolveOpenSearch();
    const pathValue = `${ACCT}/${CONTAINER}/${VERIFY_PATH}`;
    const select = ["chunk_id", "parent_id", "title", "path", ...fieldDefs.map((f) => f.name)];
    const res = await osSearch(OS_CFG, ROOM, {
      size: 10,
      _source: { includes: select },
      query: { term: { "path.keyword": pathValue } },
    });
    if (!res.ok) { console.error("verify search failed", res.status, res.text.slice(0, 300)); process.exit(1); }
    const hits = res.json.hits?.hits || [];
    console.log(JSON.stringify(hits.map((h) => ({ _id: h._id, ...h._source })), null, 2));
    console.log(`(${hits.length} chunk row(s) for ${VERIFY_PATH} in ${ROOM}, OpenSearch)`);
    return;
  }

  const AIS_EP = (process.env.AZURE_SEARCH_ENDPOINT || (await fleetSecret("azure-search-endpoint")) || "").replace(/\/$/, "");
  const AIS_KEY = process.env.AZURE_SEARCH_KEY || (await fleetSecret("azure-search-admin-key"));
  if (!AIS_EP || !AIS_KEY) { console.error("Missing azure-search-endpoint / azure-search-admin-key."); process.exit(2); }
  const exactUrl = `https://${ACCT}.blob.core.windows.net/${CONTAINER}/_TEXT/${VERIFY_PATH}.txt`;
  const select = ["chunk_id", "parent_id", "title", "path", ...fieldDefs.map((f) => f.name)].join(",");
  const r = await fetch(`${AIS_EP}/indexes/${ROOM}/docs/search?api-version=${AIS_API}`, { method: "POST", headers: { "api-key": AIS_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ search: "*", filter: `path eq '${exactUrl.replace(/'/g, "''")}'`, top: 3, select }) });
  const body = await r.json();
  if (!r.ok) { console.error("verify search failed", r.status, JSON.stringify(body).slice(0, 300)); process.exit(1); }
  console.log(JSON.stringify(body.value, null, 2));
  console.log(`(${(body.value || []).length} chunk row(s) for ${VERIFY_PATH} in ${ROOM}, Azure)`);
}

// ============================ dispatch ============================
try {
  if (cmd === "run") await cmdRun();
  else if (cmd === "ensure-schema") await cmdEnsureSchema();
  else if (cmd === "reindex-room") await cmdReindexRoom();
  else if (cmd === "verify") await cmdVerify();
  else {
    console.error(`commands: run | ensure-schema | reindex-room [--full-reset] [--wait-minutes n] | verify --path "<catalog path>"
flags: --profile finance|legal|commerce|commons --domain-pack <name> --azure-account a --container c --key-secret s
       --limit n --concurrency n --max-minutes n --model gpt-4.1-mini --reindex
       --search-backend azure|opensearch (default azure; opensearch supported by 'run' and 'verify' only)`);
    process.exit(2);
  }
} catch (e) {
  console.error("ERROR: " + e.message);
  process.exit(1);
}

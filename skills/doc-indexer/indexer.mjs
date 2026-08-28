#!/usr/bin/env node
// doc-indexer — fleet document data-room engine: READ + CATALOG + INDEX + RETRIEVE a whole
// document store. Used by the CFO (financial audit room), the CLO (legal files), and any agent
// with a document store. Resumable, idempotent, profile-driven.
//
// For every object in the target store/container: download -> sha256 -> extract text (free PDF
// text-layer; Azure Document Intelligence OCR for the image-only/mangled tier; LibreOffice for
// office docs incl. legacy .doc/.xls/.ppt; tesseract fallback) -> persist the text as a
// _TEXT/<path>.txt SIDECAR (content permanently readable + greppable without re-OCR) ->
// classify by the PROFILE's taxonomy (entity/matter + category + materiality) -> append a catalog
// row -> insert into a node:sqlite FTS5 full-text index.
//
// RETRIEVAL: `search "<query>"` runs ranked FTS5 full-text search over the corpus (path + category
// + snippet). _TEXT sidecars are also directly readable/greppable (rg).
//
// OUTPUT CO-LOCATION: all artifacts (_CATALOG/catalog.jsonl, _CATALOG/index.sqlite, _CATALOG/*.csv,
// _TEXT/*) are written INTO THE SAME store/container being indexed, so they inherit that store's
// access control. Point it at the legal `personal` container and its catalog/index/sidecars stay
// confidential in that same container, never co-mingled with company or other agents.
//
// PROFILES (--profile): finance (CFO audit room) | legal (CLO legal store) | generic.
//   Each profile sets default storage (account/container/bucket + which key secret) AND the
//   classification taxonomy. Override storage with --azure-account / --container / --bucket /
//   --key-secret. Override backend with --s3 / --azure / --gcs (or STORAGE_BACKEND); DEFAULT is
//   s3 (2026-08-18) -- see the S3-backend note below.
//
// STORAGE BACKEND (2026-08-18): every Azure Blob storage account this file can target
// (otchealthcommons, otchealthcfodata, otchealthlegalstore) was placed into a WRITE-BLOCKED state
// as part of the fleet's Azure-exit -- every PUT returns 403 AuthorizationPermissionMismatch, GET/
// LIST still work (see skills/kb-memory/s3-blob.mjs's header for the full evidence). The S3
// backend (reusing that same shared, dependency-free SigV4 client, not a second implementation) is
// therefore the DEFAULT. --azure remains selectable for read-only inspection of pre-lock history;
// a write attempted on --azure still throws loud (never silently swallowed), it just cannot
// succeed anymore. S3 writes are only possible for a room with a verified row in s3-blob.mjs's
// (account,container)->(bucket,keyPrefix) MIRROR table -- an unmapped room (e.g. the commerce
// profile's otchealthcommerce/commerce-source-docs, out of scope of the 2026-08-18 completeness
// audit) fails loud with "no S3 mirror mapping" rather than guessing a bucket; that room stays on
// --azure (still broken) until it gets its own audited row. See job/librarian.sh for the per-
// profile backend selection this drives.
//
// Creds (env, else self-resolved from Secret Manager via the claude-driver SA):
//   GCP_CLAUDE_DRIVER_SA_JSON (always); per-profile storage account + key secret (below);
//   S3: resolved by s3-blob.mjs's awsCreds() (ECS task role -> AWS_ACCESS_KEY_ID/SECRET ->
//       OTC_AWS_ACCESS_KEY_ID/SECRET). No new credential path added here.
//   OCR: AZURE_DOCINTEL_ENDPOINT / AZURE_DOCINTEL_KEY (azure-docintel-endpoint / -key).
//
// Commands: index | search "<q>" | build-index | status | build-csv | propose-mapping
// index flags: --profile p --s3|--azure|--gcs --container c --azure-account a --bucket b --key-secret s
//              --prefix p --limit n --reindex --no-ocr --no-text --ocr-model prebuilt-read|prebuilt-layout --flush n
//
// Non-PHI ring only. INND content is MNPI. Legal `personal` container is privileged/confidential.

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, extname } from "node:path";
import { fleetSecret } from "./fleet-secret.mjs";
import { mergeSchemaAdditive } from "./schema-merge.mjs";
import { getBufferFromS3, putObjectToS3, listBlobsMetaFromS3, s3LocationFor } from "../kb-memory/s3-blob.mjs";
import { osFetch, osGetMapping, osSearch } from "./opensearch-client.mjs";
// The proven Amazon OpenSearch writer (Wave-2b port): SigV4 signing, credential resolution
// (ECS task role -> env -> Key Vault), the OpenAI-direct embedding call, and the bulk
// update+doc_as_upsert primitive. Reused verbatim rather than reimplemented -- see this file's own
// SEARCH_BACKEND section below for why push-search now targets it by default.
import * as OS from "../kb-memory/opensearch-write.mjs";

const argv = process.argv.slice(2);
function takeVal(name, def = null) { const i = argv.indexOf(name); if (i >= 0) { const v = argv[i + 1]; argv.splice(i, 2); return v; } return def; }
const PROFILE = (takeVal("--profile", "generic") || "generic").toLowerCase();
const containerOverride = takeVal("--container");
const BUCKET_OV = takeVal("--bucket");
const ACCT_OV = takeVal("--azure-account");
const KEYSECRET_OV = takeVal("--key-secret");
const idxOverride = takeVal("--index");
const PREFIX = takeVal("--prefix", "");
const LIMIT = parseInt(takeVal("--limit", "0"), 10) || 0;
const SKIP = parseInt(takeVal("--skip", "0"), 10) || 0; // push-search: skip the first N filtered docs (targeted tail re-push after an interrupted reindex)
const OCR_MODEL = takeVal("--ocr-model", "prebuilt-read");
const FLUSH_EVERY = parseInt(takeVal("--flush", "150"), 10) || 150;
const CONCURRENCY = Math.max(1, parseInt(takeVal("--concurrency", process.env.CU_CONCURRENCY || "8"), 10) || 8);
const MAX_MIN = parseInt(takeVal("--max-minutes", process.env.CU_MAX_MINUTES || "0"), 10) || 0; // soft time budget for understand; 0 = no budget
// SEARCH_BACKEND / EMBEDDINGS_PROVIDER (2026-08-27): governs search-init / push-search / cloud-search
// ONLY -- a completely separate axis from BACKEND (STORAGE_BACKEND) above, exactly like enrich.mjs's
// header distinguishes "where the source bytes live" from "where the enriched/searchable fields go".
// SEARCH_BACKEND default is now "opensearch" (Azure AI Search died with subscription 55c84f6b on
// 2026-08-13; every azure-search-* secret in SSM/Key Vault now points at dead infrastructure, so an
// invocation that forgets to pick a search backend must land on the one that actually works, not the
// one that fails loud at PUT time after a full room's worth of embedding cost is already spent).
// --search-backend azure remains fully selectable (e.g. for a genuinely still-Azure room) and still
// fails LOUD (aisInit()'s pre-existing "Missing azure-search-endpoint" guard) when unconfigured --
// this flag never silently falls through to OpenSearch instead. EMBEDDINGS_PROVIDER mirrors
// semantic.mjs/index-one.mjs's own independent switch (a genuine Azure outage takes Foundry down too,
// so SEARCH_BACKEND=opensearch alone is not sufficient for an Azure-free embed step).
const SEARCH_BACKEND = (takeVal("--search-backend", process.env.SEARCH_BACKEND || "opensearch") || "opensearch").toLowerCase();
if (SEARCH_BACKEND !== "opensearch" && SEARCH_BACKEND !== "azure") {
  console.error(`--search-backend must be "opensearch" or "azure" (got "${SEARCH_BACKEND}").`);
  process.exit(2);
}
const EMBEDDINGS_PROVIDER = (takeVal("--embeddings-provider", process.env.EMBEDDINGS_PROVIDER || "openai") || "openai").toLowerCase();
if (EMBEDDINGS_PROVIDER !== "openai" && EMBEDDINGS_PROVIDER !== "foundry") {
  console.error(`--embeddings-provider must be "openai" or "foundry" (got "${EMBEDDINGS_PROVIDER}").`);
  process.exit(2);
}
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const pos = argv.filter((a) => !a.startsWith("--"));
const cmd = pos[0] || "help"; // require an explicit command; no-arg must NOT silently start a run
// DEFAULT IS s3 (2026-08-18, see the header note above). --azure remains selectable but is never
// the default -- an invocation that forgets to pick a backend must land on the one that actually
// works today, not the write-blocked one.
const BACKEND = flags.has("--s3") ? "s3" : flags.has("--azure") ? "azure" : flags.has("--gcs") ? "gcs" : (process.env.STORAGE_BACKEND || "s3").toLowerCase();
const REINDEX = flags.has("--reindex");
const NO_OCR = flags.has("--no-ocr");
const NO_TEXT = flags.has("--no-text");

const SM = "otchealth-shared-prod";
const CATALOG_KEY = "_CATALOG/catalog.jsonl";
const INDEX_KEY = "_CATALOG/index.sqlite";
const TEXT_PREFIX = "_TEXT/";
// Oversize guard: getBuf() loads each file fully into memory, so a multi-hundred-MB file
// (videos, installers, archives, image-only decks) OOM-kills the indexer container and, under
// `set -e`, kills the whole librarian run BEFORE understand/push-search. Such files carry no
// document text anyway. Catalog them but skip extraction. Override with MAX_INDEX_MB.
const MAX_INDEX_MB = parseInt(process.env.MAX_INDEX_MB || "200", 10);
const MAX_INDEX_BYTES = MAX_INDEX_MB * 1024 * 1024;
const SKIP_PREFIXES = ["_CATALOG/", "_TEXT/", "_SUMMARY/", "_TRASH/", "_NON-ACCOUNTING/", "_DUPLICATES/", "_ARCHIVE/", "_MEMORY/", "_HANDOFF/", "_DISPATCH/"]; // our own artifacts, PLUS (2026-07-12, ring-safety fix) the kb-memory/sunset-protocol ledger prefixes in the commons container -- _MEMORY/ holds the CFO/CLO exec-feed ledgers (MNPI/privileged), already indexed ring-aware into memory-exec by semantic.mjs. If a commons index/push-search run ever crawled the WHOLE container instead of a --prefix-scoped slice, these prefixes would otherwise get their raw ledger text embedded into the UNRESTRICTED commons-company-journal index (the "journal" room every agent can query, no ring wall) -- a real MNPI/privileged leak. Never remove this without adding an equivalent ring wall to the commons profile itself.
// 2026-08-04 (CLO brief §2): the reported "indexer indexes its own output" artifacts
// (_TEXT/_TEXT/...txt.txt, _TEXT/_SUMMARY/.../_TEXT/...txt.md.txt) all live UNDER _TEXT/, which was
// already excluded -- this codebase never had, and still does not have, any code path that writes or
// reads a "_SUMMARY/" concept (grep confirms zero references outside this comment), so those
// artifacts are legacy debris from something other than this pipeline, not a live bug in it. Added
// "_SUMMARY/" and "_TRASH/" (the new legal_blob_delete soft-delete destination, otchealth-mcp-server
// PR #190) here anyway, defensively, as top-level entries: belt-and-suspenders in case either ever
// exists OUTSIDE a _TEXT/ nesting in some other profile/container, and to guarantee a document a
// caller just soft-deleted never gets re-indexed as if it were still live content.
const MAXTEXT = 400000; // chars persisted per doc
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (ext) => join(tmpdir(), `idx_${Date.now()}_${Math.random().toString(36).slice(2)}${ext || ""}`);

// ============================ PROFILES (storage + taxonomy) ============================
const FINANCE_CATS = [
  ["00_Financial-Statements", /balance sheet|income statement|profit (and|&) loss|\bp&l\b|cash flow statement|statement of operations|financial statement|trial balance|general ledger|\bgl\b/i],
  ["01_Bank-Statements", /bank statement|account statement|\bstmt\b|wells ?fargo|chase|mercury|schwab|brex|checking|savings|e?statement/i],
  ["02_Credit-Cards", /credit card|amex|american express|visa|mastercard|card statement|cc statement/i],
  ["05_Payroll", /payroll|pay ?stub|paystub|\bw-?2\b|\b941\b|\b940\b|gusto|adp|wages|withholding/i],
  ["11_Tax", /\b1099\b|\b1120\b|\b1065\b|\bk-?1\b|tax return|form 941|irs|franchise tax|sales tax|\bw-?9\b|depreciation schedule/i],
  ["06_Equity-and-Cap-Table", /cap ?table|capitalization table|stock (purchase|certificate|ledger)|share(holder)?|warrant|option grant|equity incentive|83\(b\)|restricted stock/i],
  ["07_Debt-and-Convertibles", /promissory note|convertible note|\bsafe\b|loan agreement|line of credit|\bdebt\b|term loan|note payable/i],
  ["08_Reg-A-and-Capital-Raises", /reg(ulation)? a\b|reg(ulation)? d\b|reg(ulation)? cf\b|offering|subscription agreement|\bppm\b|private placement|capital raise|form c\b|form 1-a|wefunder/i],
  ["09_Acquisitions", /asset purchase|stock purchase agreement|\bmerger\b|acquisition|letter of intent|\bloi\b|term sheet|\bm&a\b|ainnova/i],
  ["10_Audit-Workpapers", /work ?paper|\bpbc\b|tie-?out|audit (schedule|adjustment)|reconciliation|\brecon\b|lead schedule/i],
  ["12_Legal-and-Contingencies", /complaint|lawsuit|settlement|demand letter|litigation|subpoena|superior court|cease and desist|contingency|legal reserve|\bnda\b/i],
  ["13_Corporate-and-Board", /board (minutes|resolution|meeting)|bylaws|operating agreement|articles of (incorporation|organization)|written consent|certificate of (incorporation|good standing)|\bein\b|corporate resolution/i],
  ["14_Related-Party-Intercompany", /intercompany|inter-company|due (to|from)|related party|officer loan|shareholder loan|advance to/i],
  ["04_Accounts-Receivable", /accounts receivable|\bar aging\b|customer invoice|sales invoice|remittance/i],
  ["03_Accounts-Payable", /\binvoice\b|\bbill\b|vendor|accounts payable|\bap aging\b|purchase order|\bpo\b|receipt|expense/i],
];
const FINANCE_MATERIAL = new Set(["00_Financial-Statements", "06_Equity-and-Cap-Table", "07_Debt-and-Convertibles", "08_Reg-A-and-Capital-Raises", "09_Acquisitions", "10_Audit-Workpapers", "12_Legal-and-Contingencies", "13_Corporate-and-Board", "14_Related-Party-Intercompany"]);
const LEGAL_CATS = [
  ["00_Pleadings", /\bcomplaint\b|answer to|cross-?complaint|\bpetition\b|complaint for|verified complaint/i],
  ["01_Motions", /motion to|notice of motion|memorandum of points|points and authorities|\bdemurrer\b|motion for summary|\bmsj\b|ex parte|opposition to|reply (brief|in support)/i],
  ["02_Discovery", /interrogator|request(s)? for production|requests for admission|\brfa\b|\brfp\b|deposition|subpoena|discovery|privilege log|meet and confer/i],
  ["03_Orders-and-Rulings", /\border\b|ruling|judgment|minute order|tentative ruling|\bwrit\b|stipulation and order/i],
  ["06_Family-Law-Disclosures", /\bfl-1\d\d\b|income and expense|declaration of disclosure|schedule of assets|community property|child support|spousal support|custody|marital settlement/i],
  ["05_Contracts-and-Agreements", /\bagreement\b|\bcontract\b|\bnda\b|amendment|engagement letter|retainer|settlement agreement|release/i],
  ["07_Evidence-and-Exhibits", /\bexhibit\b|\bevidence\b|declaration of|\baffidavit\b/i],
  ["08_Filings-and-Service", /proof of service|certificate of service|notice of (hearing|filing|appeal)|\bpos\b|case management/i],
  ["09_Research-and-Memos", /legal (memo|research)|memorandum re|case law|\bauthorities\b|research note/i],
  ["10_Corporate-Governance", /bylaws|operating agreement|board (minutes|resolution)|articles of (incorporation|organization)|written consent|certificate of good standing/i],
  ["11_Securities-Regulatory", /\bsec\b|securities|reg(ulation)? [acd]\b|8-k|10-k|10-q|prospectus|offering|edgar|form (c|1-a)/i],
  ["12_IP-and-Trademark", /trademark|copyright|\bpatent\b|\buspto\b|intellectual property|\btm\b/i],
  ["04_Correspondence", /\bletter\b|correspondence|\bemail\b|via email|dear (mr|ms|counsel)/i],
];
const LEGAL_MATERIAL = new Set(["00_Pleadings", "01_Motions", "02_Discovery", "03_Orders-and-Rulings", "06_Family-Law-Disclosures", "05_Contracts-and-Agreements", "11_Securities-Regulatory"]);
const FINANCE_NONACCT = /\b(brochure|press release|logo|banner|screenshot|product (spec|sheet)|510\(k\)|fda|marketing|website|social media|advertis|packaging|user manual|datasheet)\b/i;
// Commerce (CRO): Shopify + Amazon SP-API + the owned PSAP/TReO inventory liquidation. Non-PHI.
const COMMERCE_CATS = [
  ["01_Supplier-and-Vendor-Contracts", /supplier|vendor agreement|purchase order|\bpo\b|manufacturing agreement|distribution agreement|wholesale|\bmsa\b|terms of supply/i],
  ["06_Compliance-and-Claims", /\bpsap\b|personal sound amplif|hearing aid|\bfda\b|\bftc\b|listing compliance|warning letter|prop 65|labeling|claim substantiation/i],
  ["00_Product-Listings", /listing|product (title|description|detail|page)|\basin\b|\bsku\b|bullet points|a\+ content/i],
  ["02_Inventory-and-Catalog", /inventory|stock count|catalog|\btreo\b|\bfba\b|warehouse|lot |serial number/i],
  ["03_Orders-and-Fulfillment", /\border\b|fulfillment|shipment|tracking number|packing slip|carrier|\brma\b/i],
  ["04_Pricing-and-Offers", /pricing|price list|discount|coupon|promotion|bundle|\bmap policy\b|margin/i],
  ["07_Payments-and-HSA-FSA", /\bhsa\b|\bfsa\b|stripe|payout|chargeback|merchant account|payment processor/i],
  ["09_Returns-and-Warranty", /return|warranty|refund policy|defect|replacement/i],
  ["08_Customer-and-CRM", /customer (list|database)|\bcrm\b|subscriber|email list|segment/i],
  ["10_Reports-and-Analytics", /sales report|analytics|conversion rate|\bgmv\b|revenue report|shopifyql|seller report/i],
  ["05_Channel-and-Marketplace", /amazon|shopify|seller central|marketplace|retail channel|walmart|\bcvs\b|walgreens/i],
];
const COMMERCE_MATERIAL = new Set(["01_Supplier-and-Vendor-Contracts", "06_Compliance-and-Claims", "04_Pricing-and-Offers"]);
const COMMERCE_NONACCT = /\b(logo|banner|lifestyle photo|hero image|video|social media|ad creative)\b/i;
const PROFILES = {
  finance: { azAccountEnv: "AZURE_STORAGE_ACCOUNT", azAccountSecret: "azure-cfo-storage-account", azAccount: "otchealthcfodata", azKeyEnv: "AZURE_STORAGE_KEY", azKeySecret: "azure-cfo-storage-key", azContainer: "cfo-source-docs", gcsBucket: "otchealth-cfo-source-docs", cats: FINANCE_CATS, material: FINANCE_MATERIAL, nonacct: FINANCE_NONACCT, pathCat: (p) => (p.toLowerCase().startsWith("qbo-export/") ? "15_Source-Accounting-Exports(QBO)" : null) },
  legal: { azAccountEnv: "AZURE_LEGAL_STORAGE_ACCOUNT", azAccountSecret: "azure-legal-storage-account", azAccount: "otchealthlegalstore", azKeyEnv: "AZURE_LEGAL_STORAGE_KEY", azKeySecret: "azure-legal-storage-key", azContainer: "company", gcsBucket: null, cats: LEGAL_CATS, material: LEGAL_MATERIAL, nonacct: null, pathCat: () => null },
  commerce: { azAccountEnv: "AZURE_COMMERCE_STORAGE_ACCOUNT", azAccountSecret: "azure-commerce-storage-account", azAccount: "otchealthcommerce", azKeyEnv: "AZURE_COMMERCE_STORAGE_KEY", azKeySecret: "azure-commerce-storage-key", azContainer: "commerce-source-docs", gcsBucket: null, cats: COMMERCE_CATS, material: COMMERCE_MATERIAL, nonacct: COMMERCE_NONACCT, pathCat: () => null },
  commons: { azAccountEnv: "AZURE_COMMONS_STORAGE_ACCOUNT", azAccountSecret: "azure-commons-storage-account", azAccount: "otchealthcommons", azKeyEnv: "AZURE_COMMONS_STORAGE_KEY", azKeySecret: "azure-commons-storage-key", azContainer: "company-journal", gcsBucket: null, cats: [], material: new Set(), nonacct: null, pathCat: () => null }, // fleet commons: daily digests + shared learnings
  generic: { azAccountEnv: "AZURE_STORAGE_ACCOUNT", azAccountSecret: "azure-cfo-storage-account", azAccount: null, azKeyEnv: "AZURE_STORAGE_KEY", azKeySecret: "azure-cfo-storage-key", azContainer: null, gcsBucket: null, cats: [], material: new Set(), nonacct: null, pathCat: () => null },
};
const P = PROFILES[PROFILE] || PROFILES.generic;

// ---------------- Secret Manager (claude-driver SA) ----------------
function saJwt(scope) {
  const __r=process.env.GCP_CLAUDE_DRIVER_SA_JSON;if(!__r){return null;}let sa;try{sa=JSON.parse(__r);}catch{return null;}if(!sa||!sa.private_key){return null;}
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const s = crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
  return i + "." + s;
}
async function gToken(scope) {
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt(scope))}` });
  if (!r.ok) throw new Error("SA auth " + r.status);
  return (await r.json()).access_token;
}
// AWS SSM first, then Key Vault, then this file's GCP tier -- see doc-indexer/fleet-secret.mjs for
// why (the jobs' Azure managed identity cannot authenticate from Fargate, so the pre-AWS chain
// resolved NOTHING on AWS and surfaced as a misleading "Missing storage key").
async function sm(id) { return fleetSecret(id, gcpSecret); }
async function gcpSecret(id) {
  if (!id) return null;
  try { const t = await gToken("https://www.googleapis.com/auth/cloud-platform"); const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } }); if (!r.ok) return null; return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim(); } catch { return null; }
}

// ---------------- storage layer (gcs | azure) ----------------
let GBUCKET, ACCT, CONTAINER, AKEY, _gtok = null, _gtokAt = 0;
async function gAuth() { if (!_gtok || Date.now() - _gtokAt > 50 * 60 * 1000) { _gtok = await gToken("https://www.googleapis.com/auth/devstorage.read_write"); _gtokAt = Date.now(); } return _gtok; }
const AVER = "2021-12-02";
const encPath = (name) => name.split("/").map(encodeURIComponent).join("/");
// List Blobs returns <Name> XML-escaped, so a blob literally named "Moore I&E.pdf" comes back as
// "Moore I&amp;E.pdf". Capturing it raw stored the escaped form as the path, so every later getBuf
// requested a non-existent blob -> "missing" errors for any name with & < > " '. Decode on capture.
const xmlDec = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
let AZ_SAS; // account SAS for blob ops: signs the SAS fields, not the blob path, so special-char
// names (spaces, parens, +, &) work where per-request SharedKey canonicalization 403s.
function buildAzSas() {
  const sv = "2021-12-02", sp = "rwlc", ss = "b", srt = "co";
  const st = new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19) + "Z";
  const se = new Date(Date.now() + 12 * 3600 * 1000).toISOString().slice(0, 19) + "Z";
  const sts = [ACCT, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(AKEY, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
}
// S3ACCT/S3CONTAINER resolve the SAME way ACCT/CONTAINER do for Azure (same profile defaults +
// overrides), so a room targeted with --azure and the same room targeted with --s3 (or the
// default) are the SAME logical room. No storage key needed for S3 -- credentials resolve inside
// s3-blob.mjs. Fails loud, before any network call, when the resolved room has no row in
// s3-blob.mjs's MIRROR table: an unmapped room (e.g. the commerce profile's
// otchealthcommerce/commerce-source-docs -- out of scope of the 2026-08-18 completeness audit)
// must be reported and audited, never silently written into a guessed bucket.
let S3ACCT, S3CONTAINER;
function resolveS3Room() {
  S3ACCT = ACCT_OV || process.env[P.azAccountEnv] || P.azAccount || "otchealthcfodata";
  S3CONTAINER = containerOverride || process.env.CFO_AZURE_CONTAINER || P.azContainer || "data-room";
  if (!s3LocationFor(S3ACCT, S3CONTAINER)) {
    console.error(`no S3 mirror mapping for ${S3ACCT}/${S3CONTAINER} (refusing to guess a bucket). ` +
      `Add a verified row to skills/kb-memory/s3-blob.mjs's MIRROR table (bucket chosen from an ` +
      `OBSERVED S3 listing, never inferred from IAM) before targeting this room on S3, or run with ` +
      `--azure for read-only inspection in the meantime.`);
    process.exit(2);
  }
}
async function initStorage() {
  if (BACKEND === "gcs") {
    GBUCKET = BUCKET_OV || process.env.CFO_SOURCE_BUCKET || P.gcsBucket || (await sm("cfo-source-bucket")) || "otchealth-cfo-source-docs"; await gAuth();
  } else if (BACKEND === "s3") {
    resolveS3Room();
  } else {
    ACCT = ACCT_OV || process.env[P.azAccountEnv] || P.azAccount || (await sm(P.azAccountSecret)) || "otchealthcfodata";
    CONTAINER = containerOverride || process.env.CFO_AZURE_CONTAINER || P.azContainer || "data-room";
    AKEY = (KEYSECRET_OV ? await sm(KEYSECRET_OV) : null) || process.env[P.azKeyEnv] || (await sm(P.azKeySecret));
    if (!AKEY) { console.error(`Missing storage key for profile ${PROFILE} (secret ${KEYSECRET_OV || P.azKeySecret}). Account ${ACCT}, container ${CONTAINER}.`); process.exit(2); }
    AZ_SAS = buildAzSas();
  }
}
async function listAll(prefix) {
  const out = [];
  if (BACKEND === "gcs") {
    let url = `https://storage.googleapis.com/storage/v1/b/${GBUCKET}/o?maxResults=1000${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ""}`;
    while (url) { const r = await fetch(url, { headers: { Authorization: `Bearer ${await gAuth()}` } }); if (!r.ok) throw new Error("list " + r.status); const j = await r.json(); for (const o of j.items || []) out.push({ name: o.name, size: +o.size, mtime: o.updated }); url = j.nextPageToken ? `https://storage.googleapis.com/storage/v1/b/${GBUCKET}/o?maxResults=1000&pageToken=${j.nextPageToken}${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ""}` : null; }
  } else if (BACKEND === "s3") {
    const rows = await listBlobsMetaFromS3(S3ACCT, S3CONTAINER, prefix);
    for (const o of rows) out.push({ name: o.name, size: o.size, mtime: o.lastModified });
  } else {
    let marker = "";
    do { let url = `https://${ACCT}.blob.core.windows.net/${CONTAINER}?restype=container&comp=list&${AZ_SAS}`; if (prefix) url += `&prefix=${encodeURIComponent(prefix)}`; if (marker) url += `&marker=${encodeURIComponent(marker)}`; const r = await fetch(url); if (!r.ok) throw new Error("list " + r.status); const xml = await r.text(); for (const m of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) { const b = m[1]; const name = xmlDec((b.match(/<Name>([^<]+)<\/Name>/) || [])[1] || ""); const size = +((b.match(/<Content-Length>([^<]+)<\/Content-Length>/) || [])[1] || 0); const mtime = (b.match(/<Last-Modified>([^<]+)<\/Last-Modified>/) || [])[1] || ""; if (name) out.push({ name, size, mtime }); } marker = (xml.match(/<NextMarker>([^<]+)<\/NextMarker>/) || [])[1] || ""; } while (marker);
  }
  return out;
}
// Decode XML entities on 404: the List-Blobs parser captures escaped names (a blob "(L&C).pdf" comes
// back as "(L&amp;C).pdf"), so source fetches by the stored name 404. Retry with the decoded name.
const htmlEnt = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
async function getBuf(name) {
  if (BACKEND === "gcs") { let r = await fetch(`https://storage.googleapis.com/storage/v1/b/${GBUCKET}/o/${encodeURIComponent(name)}?alt=media`, { headers: { Authorization: `Bearer ${await gAuth()}` } }); if (r.status === 404 && /&(amp|lt|gt|quot|#39|apos);/.test(name)) { const d = htmlEnt(name); if (d !== name) r = await fetch(`https://storage.googleapis.com/storage/v1/b/${GBUCKET}/o/${encodeURIComponent(d)}?alt=media`, { headers: { Authorization: `Bearer ${await gAuth()}` } }); } if (r.status === 404) return null; if (!r.ok) throw new Error("get " + r.status); return Buffer.from(await r.arrayBuffer()); }
  if (BACKEND === "s3") return getBufferFromS3(S3ACCT, S3CONTAINER, name);
  let r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${encPath(name)}?${AZ_SAS}`); if (r.status === 404 && /&(amp|lt|gt|quot|#39|apos);/.test(name)) { const d = htmlEnt(name); if (d !== name) r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${encPath(d)}?${AZ_SAS}`); } if (r.status === 404) return null; if (!r.ok) throw new Error("get " + r.status); return Buffer.from(await r.arrayBuffer());
}
async function putBuf(name, buf, ct) {
  if (BACKEND === "gcs") { const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${GBUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}`, { method: "POST", headers: { Authorization: `Bearer ${await gAuth()}`, "Content-Type": ct || "application/octet-stream" }, body: buf }); if (!r.ok) throw new Error("put " + r.status + " " + (await r.text()).slice(0, 120)); return; }
  if (BACKEND === "s3") { await putObjectToS3(S3ACCT, S3CONTAINER, name, buf, ct); return; }
  const c = ct || "application/octet-stream"; const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${encPath(name)}?${AZ_SAS}`, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": c }, body: buf }); if (!r.ok) throw new Error("put " + r.status + " " + (await r.text()).slice(0, 120));
}
// Human-readable "where is this" label for status/log lines, one place for all three backends so a
// new one (or a renamed variable) can't leave a stale `ACCT === "gcs" ? ... : ACCT` ternary behind.
const targetRoom = () => BACKEND === "gcs" ? GBUCKET : BACKEND === "s3" ? `${S3ACCT}/${S3CONTAINER}` : `${ACCT}/${CONTAINER}`;
const targetContainer = () => BACKEND === "gcs" ? GBUCKET : BACKEND === "s3" ? S3CONTAINER : CONTAINER;

// ---- single-writer lease on the catalog (Azure) -------------------------------------------
// `understand` rewrites the whole catalog.jsonl, so two concurrent passes (cron overlap, a manual
// run, or an in-session worker) clobber each other and a stale snapshot can REGRESS progress. A
// 60s renewable blob lease on a lock file makes the write mutually exclusive: a second worker that
// can't acquire it exits cleanly instead of corrupting. Auto-expires in 60s if a holder dies.
const LOCK_BLOB = "_CATALOG/.understand.lock";
const azLockUrl = () => `https://${ACCT}.blob.core.windows.net/${CONTAINER}/${encPath(LOCK_BLOB)}?${AZ_SAS}`;
async function leaseAcquire() {
  if (BACKEND !== "azure") return { id: null, skip: true };          // lease only on azure rooms
  try { await fetch(azLockUrl(), { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "If-None-Match": "*", "Content-Length": "0" }, body: "" }); } catch {} // create-if-absent; ignore exists/leased
  const proposed = crypto.randomUUID();
  const r = await fetch(azLockUrl() + "&comp=lease", { method: "PUT", headers: { "x-ms-lease-action": "acquire", "x-ms-lease-duration": "60", "x-ms-proposed-lease-id": proposed } });
  if (r.status === 201) return { id: r.headers.get("x-ms-lease-id") || proposed };
  return { id: null, busy: true, status: r.status };                 // 409 = already leased
}
async function leaseRenew(id) { if (id) try { await fetch(azLockUrl() + "&comp=lease", { method: "PUT", headers: { "x-ms-lease-action": "renew", "x-ms-lease-id": id } }); } catch {} }
async function leaseRelease(id) { if (id) try { await fetch(azLockUrl() + "&comp=lease", { method: "PUT", headers: { "x-ms-lease-action": "release", "x-ms-lease-id": id } }); } catch {} }

// ---------------- text extraction ----------------
const stripTags = (s) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#?\w+;/g, " ").replace(/\s+/g, " ").trim();
const alnum = (s) => (s.match(/[a-z0-9]/gi) || []).length;
// 2026-08-04 (CLO brief §3, task #53): a real legal-correctness bug, root-caused via company-brain
// against two concrete live paths (Broadridge + VStock NOBO shareholder-election request forms) --
// NOT a mojibake/encoding issue (verified: the pipeline's installed poppler-utils already defaults
// -enc to UTF-8; a synthetic checkbox/curly-quote/em-dash reproduction round-tripped byte-identical
// with and without an explicit -enc UTF-8 flag, so that earlier lead was a dead end). Both real
// documents are XFA (Adobe LiveCycle dynamic) forms: pdftotext's non-rendering content-stream
// extraction on an XFA-only PDF returns Adobe's standard "Please wait... if this message is not
// eventually replaced by the proper contents of the document" static placeholder page instead of
// the actual (checkbox-bearing) form content -- the real data lives only in an embedded XFA XML
// stream pdftotext never reads. That placeholder boilerplate is ~540 alnum characters, 18x the
// alnum>=30 "did we get real text" gate below, so it was silently ACCEPTED as a successful
// pdftotext extraction and the DocIntel OCR fallback (which rasterizes the page and CAN read the
// visually-rendered form, XFA or not) never ran -- a shareholder-election form indexes as if fully
// extracted while containing zero of its actual checkbox/selection data. Detect the placeholder by
// its stable, Adobe-standard signature phrase and treat it as NO real content regardless of alnum
// count, so extract() falls through to OCR/DocIntel the same as any other image-only/thin PDF.
const XFA_PLACEHOLDER_RE = /if this message is not eventually replaced by the proper contents of the document/i;
export const isXfaPlaceholder = (s) => XFA_PLACEHOLDER_RE.test(s);
function sh(bin, args, opts) { try { return execFileSync(bin, args, { maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], ...(opts || {}) }).toString("utf8"); } catch { return ""; } }
function officeToText(buf, ext) {
  const inF = tmp(ext); writeFileSync(inF, buf); const outDir = tmp(""); mkdirSync(outDir, { recursive: true }); const prof = "file://" + tmp("");
  try { sh("soffice", ["--headless", "-env:UserInstallation=" + prof, "--convert-to", "pdf", "--outdir", outDir, inF], { timeout: 120000 }); const pdfPath = join(outDir, basename(inF).replace(/\.[^.]+$/, "") + ".pdf"); let text = ""; try { text = sh("pdftotext", ["-layout", pdfPath, "-"]); } catch {} try { unlinkSync(pdfPath); } catch {} return text; }
  catch { return ""; } finally { try { unlinkSync(inF); } catch {} }
}
function officeUnzipFallback(buf, ext) {
  const f = tmp(ext); writeFileSync(f, buf); const parts = [];
  const entries = ext === ".docx" ? ["word/document.xml"] : ext === ".xlsx" ? ["xl/sharedStrings.xml"] : ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"];
  for (const e of entries) { const x = sh("unzip", ["-p", f, e]); if (x) parts.push(stripTags(x)); }
  try { unlinkSync(f); } catch {}
  return parts.join(" ");
}
let DI_EP, DI_KEY, _diInit = false;
async function diInit() { if (_diInit) return; _diInit = true; DI_EP = (process.env.AZURE_DOCINTEL_ENDPOINT || (await sm("azure-docintel-endpoint")) || "").replace(/\/$/, ""); DI_KEY = process.env.AZURE_DOCINTEL_KEY || (await sm("azure-docintel-key")); }
async function docintel(buf, model) {
  await diInit(); if (!DI_EP || !DI_KEY) return null;
  const url = `${DI_EP}/documentintelligence/documentModels/${model || OCR_MODEL}:analyze?api-version=2024-11-30`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, { method: "POST", headers: { "Ocp-Apim-Subscription-Key": DI_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ base64Source: buf.toString("base64") }) });
    if (r.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    if (r.status !== 202) throw new Error("DI analyze " + r.status + " " + (await r.text()).slice(0, 120));
    const op = r.headers.get("operation-location"); if (!op) throw new Error("DI no operation-location");
    for (let i = 0; i < 80; i++) { await sleep(1500); const g = await fetch(op, { headers: { "Ocp-Apim-Subscription-Key": DI_KEY } }); if (!g.ok) continue; const j = await g.json(); if (j.status === "succeeded") return j.analyzeResult?.content || ""; if (j.status === "failed") throw new Error("DI failed"); }
    throw new Error("DI poll timeout");
  }
  throw new Error("DI 429 exhausted");
}
function tesseractImg(buf, ext) { const f = tmp(ext); try { writeFileSync(f, buf); const out = tmp(); sh("tesseract", [f, out, "--psm", "3"]); try { return readFileSync(out + ".txt", "utf8"); } catch { return ""; } finally { try { unlinkSync(out + ".txt"); } catch {} } } finally { try { unlinkSync(f); } catch {} } }
async function extract(name, buf) {
  const ext = extname(name).toLowerCase();
  if ([".txt", ".csv", ".log", ".md", ".json", ".tsv"].includes(ext)) return { text: buf.toString("utf8").slice(0, MAXTEXT), ocr: false, engine: "text" };
  if ([".html", ".htm", ".xml", ".eml"].includes(ext)) return { text: (ext === ".eml" ? buf.toString("utf8") : stripTags(buf.toString("utf8"))).slice(0, MAXTEXT), ocr: false, engine: "text" };
  if (ext === ".pdf") {
    const f = tmp(".pdf"); writeFileSync(f, buf); let text = ""; try { text = sh("pdftotext", ["-layout", f, "-"]); } catch {} try { unlinkSync(f); } catch {}
    const xfaPlaceholder = isXfaPlaceholder(text);
    if (!xfaPlaceholder && alnum(text) >= 30) return { text: text.slice(0, MAXTEXT), ocr: false, engine: "pdftotext" };
    if (!NO_OCR) { try { const di = await docintel(buf); if (di && alnum(di) >= 10) return { text: di.slice(0, MAXTEXT), ocr: true, engine: "docintel:" + OCR_MODEL }; } catch {} }
    // XFA placeholder text is real, well-formed prose (easily clears alnum>=30) but is NOT the
    // document's actual content, so if DocIntel also failed/was skipped, report it honestly as
    // no-real-content rather than silently indexing the boilerplate as if it were the document.
    return { text: text.slice(0, MAXTEXT), ocr: false, engine: text ? "pdftotext-thin" : "none", err: xfaPlaceholder ? "xfa-form-placeholder-only" : alnum(text) < 30 ? "image-only/thin-text" : "" };
  }
  if ([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"].includes(ext)) {
    if (!NO_OCR) { try { const di = await docintel(buf); if (di !== null) return { text: di.slice(0, MAXTEXT), ocr: true, engine: "docintel:" + OCR_MODEL }; } catch {} const t = tesseractImg(buf, ext); if (t) return { text: t.slice(0, MAXTEXT), ocr: true, engine: "tesseract" }; }
    return { text: "", ocr: false, engine: "none" };
  }
  if ([".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt", ".rtf", ".odt", ".ods", ".odp"].includes(ext)) {
    let text = officeToText(buf, ext); let engine = "libreoffice";
    if (alnum(text) < 5 && [".docx", ".xlsx", ".pptx"].includes(ext)) { text = officeUnzipFallback(buf, ext); engine = text ? "office-unzip" : "none"; }
    return { text: (text || "").slice(0, MAXTEXT), ocr: false, engine };
  }
  return { text: "", ocr: false, engine: "skip" };
}

// ---------------- classifier (profile-driven) ----------------
function entityOf(path) {
  const seg = (path.split("/")[0] || "").trim();
  if (PROFILE === "finance") { const t = seg.toLowerCase(); if (t.startsWith("innd") || t.startsWith("innerscope")) return "InnerScope"; if (t.startsWith("hearingassist")) return "HearingAssist"; if (t.startsWith("otchealth")) return "OTCHealth"; if (t.startsWith("ihear")) return "iHEAR"; if (t.startsWith("personal")) return "Personal"; if (t.startsWith("qbo-export")) return "QBO-Mixed"; return "Unknown"; }
  return seg || "(root)";
}
function classify(path, text) {
  const hay = (path.replace(/[\/_-]/g, " ") + " \n " + (text || "")).slice(0, 8000).toLowerCase();
  const pc = P.pathCat && P.pathCat(path); if (pc) return { category: pc, material: P.material.has(pc) };
  for (const [folder, re] of P.cats) { if (re.test(hay)) return { category: folder, material: P.material.has(folder) }; }
  if (P.nonacct && P.nonacct.test(hay)) return { category: "_NON-ACCOUNTING", material: false };
  return { category: "_INBOX-UNCLASSIFIED", material: false };
}
function describe(path, text) { const bn = basename(path); const line = (text || "").split(/\r?\n/).map((s) => s.trim()).find((s) => alnum(s) >= 8) || ""; return (bn + (line ? " | " + line : "")).replace(/\s+/g, " ").slice(0, 180); }

// ---------------- FTS5 index (node:sqlite) ----------------
let _SQLITE = null;
async function sqliteCtor() { if (_SQLITE === null) { try { _SQLITE = (await import("node:sqlite")).DatabaseSync; } catch { _SQLITE = false; } } return _SQLITE; }
let _db = null, _dbPath = null, _dbInsert = null, _dbDelete = null;
async function openIndex() {
  const S = await sqliteCtor(); if (!S) { console.error("  (node:sqlite unavailable; FTS index skipped, sidecars still written)"); return false; }
  _dbPath = tmp(".sqlite"); const ex = await getBuf(INDEX_KEY); if (ex) writeFileSync(_dbPath, ex);
  _db = new S(_dbPath); _db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(path UNINDEXED, entity, category, title, body)");
  _dbDelete = _db.prepare("DELETE FROM docs WHERE path = ?"); _dbInsert = _db.prepare("INSERT INTO docs(path,entity,category,title,body) VALUES(?,?,?,?,?)");
  return true;
}
function indexUpsert(row, body) { if (!_db) return; try { _dbDelete.run(row.path); _dbInsert.run(row.path, row.entity || "", row.category || "", row.title || "", body || ""); } catch {} }
async function uploadIndex() { if (!_db) return; try { _db.close(); } catch {} try { await putBuf(INDEX_KEY, readFileSync(_dbPath), "application/x-sqlite3"); } catch (e) { console.error("  index upload failed: " + e.message); } }

// ---------------- catalog io ----------------
async function loadCatalog() { const buf = await getBuf(CATALOG_KEY); if (!buf) return []; const rows = []; for (const ln of buf.toString("utf8").split("\n")) { const s = ln.trim(); if (!s) continue; try { rows.push(JSON.parse(s)); } catch {} } return rows; }
async function flushCatalog(rows) { await putBuf(CATALOG_KEY, Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8"), "application/x-ndjson"); }

// ---------------- commands ----------------
async function runIndex() {
  await initStorage();
  const rows = REINDEX ? [] : await loadCatalog();
  const done = new Set(rows.map((r) => r.path));
  const objs = (await listAll(PREFIX)).filter((o) => !SKIP_PREFIXES.some((p) => o.name.startsWith(p)) && !o.name.endsWith("/"));
  const todo = objs.filter((o) => REINDEX || !done.has(o.name));
  console.error(`[index] profile=${PROFILE} backend=${BACKEND} target=${targetRoom()} room=${objs.length}; ${done.size} cataloged; ${todo.length} to do${LIMIT ? ` (limit ${LIMIT})` : ""}.`);
  const haveIndex = await openIndex();
  let n = 0, since = 0, sidecarFailures = 0;
  for (const o of todo) {
    if (LIMIT && n >= LIMIT) break;
    const ext = extname(o.name).toLowerCase();
    const row = { path: o.name, backend: BACKEND, ext: ext.replace(".", ""), size: o.size, mtime: o.mtime, entity: entityOf(o.name), ts: new Date().toISOString() };
    if (o.size > MAX_INDEX_BYTES) {
      // Too large to load into memory safely; catalog it, skip text extraction (prevents OOM).
      row.err = `oversize-skipped:${Math.round(o.size / 1e6)}MB>${MAX_INDEX_MB}MB`;
      row.text_chars = 0; row.category = classify(o.name, "").category; row.title = basename(o.name);
      rows.push(row); done.add(o.name); n++; since++;
      if (since >= FLUSH_EVERY) { await flushCatalog(rows); since = 0; console.error(`  ...${n}/${todo.length} (oversize-skip ${row.path.slice(-48)})`); }
      continue;
    }
    try {
      const buf = await getBuf(o.name);
      if (!buf) { row.err = "missing"; }
      else {
        row.sha256 = crypto.createHash("sha256").update(buf).digest("hex");
        const ex = await extract(o.name, buf);
        row.text_chars = alnum(ex.text); row.ocr = ex.ocr; row.engine = ex.engine; if (ex.err) row.err = ex.err;
        const c = classify(o.name, ex.text); row.category = c.category; row.material = c.material;
        row.title = basename(o.name); row.desc = describe(o.name, ex.text);
        // FAIL LOUD, NOT SILENT (2026-08-18): this used to be `catch {}` -- an empty catch, so a
        // sidecar PUT failure (e.g. a real storage-backend outage, exactly the class of failure
        // that motivated this whole fix) vanished with no trace: no row.err, no failure count, no
        // non-zero exit. The document's catalog row would look completely normal (sidecar: falsy is
        // the only tell, and nothing reads that as a failure signal) while the actual text sidecar
        // silently never got written. Now it is recorded on the row AND counted, so the run-level
        // exit code below reflects reality even though one bad document does not abort the other
        // 268 in the same batch.
        if (!NO_TEXT && ex.text && row.text_chars >= 3) {
          try { await putBuf(TEXT_PREFIX + o.name + ".txt", Buffer.from(ex.text, "utf8"), "text/plain; charset=utf-8"); row.sidecar = true; }
          catch (se) { row.err = (row.err ? row.err + "; " : "") + "sidecar put failed: " + se.message.slice(0, 120); sidecarFailures++; }
        }
        if (haveIndex) indexUpsert(row, ex.text);
      }
    } catch (e) { row.err = (row.err ? row.err + "; " : "") + e.message.slice(0, 120); }
    rows.push(row); done.add(o.name); n++; since++;
    if (since >= FLUSH_EVERY) { await flushCatalog(rows); since = 0; console.error(`  ...${n}/${todo.length} (flushed; ${row.category || "?"} :: ${row.path.slice(-48)})`); }
  }
  await flushCatalog(rows);
  if (haveIndex) await uploadIndex();
  console.error(`[index] done: +${n} rows, ${rows.length} total. catalog=${CATALOG_KEY} index=${haveIndex ? INDEX_KEY : "(skipped)"} sidecars=${NO_TEXT ? "off" : TEXT_PREFIX}`);
  if (sidecarFailures > 0) {
    console.error(`[index] ERROR: ${sidecarFailures} sidecar write(s) failed this run (see per-row "sidecar put failed" errors in the catalog) -- exiting non-zero so this is never mistaken for a clean run.`);
    process.exit(1);
  }
}

async function runSearch(q) {
  if (!q) { console.error('usage: search "<query>"  (FTS5: terms, "phrases", prefix*, AND/OR/NOT)'); process.exit(2); }
  await initStorage(); const S = await sqliteCtor(); if (!S) { console.error("node:sqlite unavailable"); process.exit(1); }
  const buf = await getBuf(INDEX_KEY); if (!buf) { console.error("no index yet; run `index` (builds it) or `build-index`"); process.exit(1); }
  const p = tmp(".sqlite"); writeFileSync(p, buf); const db = new S(p);
  let rows; try { rows = db.prepare(`SELECT path, entity, category, snippet(docs, 4, '»', '«', ' … ', 16) AS snip FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?`).all(q, LIMIT || 25); }
  catch (e) { console.error("query error: " + e.message); process.exit(1); }
  for (const r of rows) console.log(`[${(r.category || "?").padEnd(32)}] ${r.entity}  ${r.path}\n      ${(r.snip || "").replace(/\s+/g, " ").slice(0, 200)}`);
  console.log(`(${rows.length} hits for: ${q})`);
}

async function runBuildIndex() {
  await initStorage(); const S = await sqliteCtor(); if (!S) { console.error("node:sqlite unavailable"); process.exit(1); }
  const meta = new Map((await loadCatalog()).map((r) => [r.path, r]));
  const sides = (await listAll(TEXT_PREFIX)).filter((o) => o.name.endsWith(".txt"));
  const p = tmp(".sqlite"); const db = new S(p); db.exec("CREATE VIRTUAL TABLE docs USING fts5(path UNINDEXED, entity, category, title, body)");
  const ins = db.prepare("INSERT INTO docs(path,entity,category,title,body) VALUES(?,?,?,?,?)");
  let n = 0;
  for (const s of sides) { const orig = s.name.slice(TEXT_PREFIX.length).replace(/\.txt$/, ""); const m = meta.get(orig) || {}; const body = (await getBuf(s.name))?.toString("utf8") || ""; ins.run(orig, m.entity || entityOf(orig), m.category || "", m.title || basename(orig), body); n++; if (n % 250 === 0) console.error(`  indexed ${n}/${sides.length}`); }
  db.close(); await putBuf(INDEX_KEY, readFileSync(p), "application/x-sqlite3");
  console.log(`built ${INDEX_KEY} from ${n} sidecars`);
}

async function runStatus() {
  await initStorage();
  const rows = await loadCatalog();
  const objs = (await listAll(PREFIX)).filter((o) => !SKIP_PREFIXES.some((p) => o.name.startsWith(p)) && !o.name.endsWith("/"));
  const byCat = {}, byEnt = {}, byEng = {}; let ocrN = 0, errN = 0, material = 0, side = 0;
  for (const r of rows) { byCat[r.category] = (byCat[r.category] || 0) + 1; byEnt[r.entity] = (byEnt[r.entity] || 0) + 1; byEng[r.engine || "?"] = (byEng[r.engine || "?"] || 0) + 1; if (r.ocr) ocrN++; if (r.err) errN++; if (r.material) material++; if (r.sidecar) side++; }
  console.log(`profile=${PROFILE} target=${targetRoom()}`);
  console.log(`catalog: ${rows.length} rows | room: ${objs.length} objects | remaining: ${Math.max(0, objs.length - rows.length)}`);
  console.log(`text sidecars: ${side} | ocr'd: ${ocrN} | material: ${material} | errors: ${errN}`);
  const show = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `   ${String(v).padStart(6)}  ${k}`).join("\n");
  console.log("\nby entity:\n" + show(byEnt)); console.log("\nby category:\n" + show(byCat)); console.log("\nby engine:\n" + show(byEng));
}

function entityFolder(e) { if (PROFILE === "finance") return ({ InnerScope: "INND", HearingAssist: "HearingAssist", OTCHealth: "OTCHealth", iHEAR: "iHEAR", Personal: "Personal", "QBO-Mixed": "_SHARED-QBO", Unknown: "_SHARED" })[e] || "_SHARED"; return e || "_SHARED"; }
async function runProposeMapping() {
  await initStorage(); const rows = await loadCatalog(); if (!rows.length) { console.error("no catalog yet; run index first"); process.exit(1); }
  const seen = new Map(); const lines = ["old_path,new_path,entity,category,material"];
  for (const r of rows) {
    const cat = r.category || "_INBOX-UNCLASSIFIED";
    const top = cat === "_NON-ACCOUNTING" ? "_NON-ACCOUNTING/" + entityFolder(r.entity) : entityFolder(r.entity) + "/" + cat;
    let np = `${top}/${basename(r.path)}`;
    if (seen.has(np)) { const h = (r.sha256 || "").slice(0, 6) || Math.random().toString(36).slice(2, 8); const b = basename(r.path); const dot = b.lastIndexOf("."); np = `${top}/${dot > 0 ? b.slice(0, dot) + "_" + h + b.slice(dot) : b + "_" + h}`; }
    seen.set(np, 1);
    const q = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
    lines.push([q(r.path), q(np), q(r.entity), q(cat), r.material ? "1" : "0"].join(","));
  }
  await putBuf("_CATALOG/mapping-proposed.csv", Buffer.from(lines.join("\n") + "\n", "utf8"), "text/csv");
  console.log(`proposed mapping for ${rows.length} docs -> _CATALOG/mapping-proposed.csv (owner reviews; CTO executes during migration)`);
}
async function runBuildCsv() {
  await initStorage(); const rows = await loadCatalog();
  const cols = ["path", "entity", "category", "material", "ext", "size", "sha256", "ocr", "engine", "text_chars", "sidecar", "mtime", "desc", "err"];
  const q = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
  const lines = [cols.join(",")]; for (const r of rows) lines.push(cols.map((c) => (c === "material" || c === "sidecar" ? (r[c] ? 1 : 0) : q(r[c]))).join(","));
  await putBuf("_CATALOG/catalog.csv", Buffer.from(lines.join("\n") + "\n", "utf8"), "text/csv");
  console.log(`wrote _CATALOG/catalog.csv (${rows.length} rows)`);
}

// ---------------- Azure AI Search (hybrid keyword + vector + semantic retrieval brain) ----------------
// The managed retrieval brain (per the 2026-06-19 architecture decision). Push model: we compute
// embeddings at index time (Azure OpenAI) and push docs; a query-time azureOpenAI vectorizer lets
// agents query with plain text (service embeds the query) for hybrid keyword+vector+semantic.
const AIS_API = "2024-07-01";
const EMB_DIMS = parseInt(process.env.AZURE_OPENAI_EMBEDDING_DIMS || "3072", 10); // text-embedding-3-large=3072, -small=1536
let AIS_EP, AIS_KEY, AOAI_EP, AOAI_KEY, AOAI_DEP, AOAI_MODEL, IDXNAME;
// Shared by BOTH backends (Azure AI Search index name AND OpenSearch room/index name): "identical to
// the Azure rooms by design" -- see otchealth-mcp-server/src/search/opensearch.ts's own file header
// and enrich.mjs's roomName(), which use this exact same `${PROFILE}-${container}` convention. Factored
// out so aisInit() and the new OpenSearch path below compute the SAME name from the SAME inputs rather
// than risk two copies drifting apart.
function computeIndexName() {
  return (idxOverride || `${PROFILE}-${targetContainer()}`).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 128);
}
let _foundryEmbedReady = false;
/** Resolve the Azure Foundry embedding endpoint/key/deployment (AOAI_*), independent of whether the
 *  SEARCH backend is Azure or OpenSearch -- extracted out of aisInit() so --embeddings-provider
 *  foundry works on the OpenSearch push-search path too (EMBEDDINGS_PROVIDER is an axis independent
 *  of SEARCH_BACKEND, mirroring semantic.mjs/index-one.mjs). Idempotent; fails loud exactly once. */
async function ensureFoundryEmbedConfig() {
  if (_foundryEmbedReady) return;
  AOAI_EP = (process.env.AZURE_FOUNDRY_OPENAI_ENDPOINT || (await sm("azure-foundry-openai-endpoint")) || process.env.AZURE_OPENAI_ENDPOINT || (await sm("azure-openai-endpoint")) || "").replace(/\/$/, "");
  AOAI_KEY = process.env.AZURE_FOUNDRY_KEY || (await sm("azure-foundry-key")) || process.env.AZURE_OPENAI_API_KEY || (await sm("azure-openai-key"));
  AOAI_DEP = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || (await sm("azure-openai-embedding-deployment")) || "text-embedding-3-large";
  AOAI_MODEL = process.env.AZURE_OPENAI_EMBEDDING_MODEL || AOAI_DEP;
  if (!AOAI_EP || !AOAI_KEY) { console.error("Missing azure-openai-endpoint / azure-openai-key (needed for --embeddings-provider foundry)."); process.exit(2); }
  _foundryEmbedReady = true;
}
async function aisInit() {
  await initStorage(); // sets GBUCKET / CONTAINER for the derived index name
  AIS_EP = (process.env.AZURE_SEARCH_ENDPOINT || (await sm("azure-search-endpoint")) || "").replace(/\/$/, "");
  AIS_KEY = process.env.AZURE_SEARCH_KEY || (await sm("azure-search-admin-key"));
  // Embeddings live on the Foundry resource (text-embedding-3-large). Prefer the foundry
  // openai endpoint + foundry key; fall back to the designer azure-openai resource.
  await ensureFoundryEmbedConfig();
  IDXNAME = computeIndexName();
  if (!AIS_EP || !AIS_KEY) { console.error("Missing azure-search-endpoint / azure-search-admin-key (provision the Azure AI Search resource)."); process.exit(2); }
}
async function embed(texts) {
  for (let attempt = 0; attempt < 9; attempt++) {
    let r;
    try { r = await fetch(`${AOAI_EP}/openai/deployments/${AOAI_DEP}/embeddings?api-version=2024-02-01`, { method: "POST", headers: { "api-key": AOAI_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ input: texts }) }); }
    catch (e) { await sleep(2000 * (attempt + 1)); continue; } // transient network -> retry
    if (r.status === 429 || r.status === 503 || r.status === 500) { const ra = +(r.headers.get("retry-after") || 0); await sleep((ra ? ra * 1000 : 0) + 2000 * (attempt + 1) + Math.floor(Math.random() * 1000)); continue; }
    if (!r.ok) { const b = await r.text(); if (attempt < 8 && /resolve_no_records|private\/reserved IP|Host resolves|EAI_AGAIN|ENOTFOUND|temporarily/i.test(b)) { await sleep(3000 * (attempt + 1)); continue; } throw new Error("embed " + r.status + " " + b.slice(0, 120)); } // proxy DNS blip -> retry
    return (await r.json()).data.map((d) => d.embedding);
  }
  throw new Error("embed retries exhausted");
}
async function aisCreateIndex() {
  const schema = {
    name: IDXNAME,
    fields: [
      { name: "id", type: "Edm.String", key: true, filterable: true },
      { name: "path", type: "Edm.String", searchable: true, retrievable: true },
      { name: "entity", type: "Edm.String", filterable: true, facetable: true, searchable: true },
      { name: "category", type: "Edm.String", filterable: true, facetable: true, searchable: true },
      { name: "title", type: "Edm.String", searchable: true },
      { name: "summary", type: "Edm.String", searchable: true, retrievable: true },
      { name: "content", type: "Edm.String", searchable: true },
      { name: "material", type: "Edm.Boolean", filterable: true },
      { name: "execution_status", type: "Edm.String", filterable: true, facetable: true, retrievable: true },
      { name: "signed", type: "Edm.Boolean", filterable: true },
      // FRESHNESS (2026-07-13): the room indexes carried NO time field of any kind, so index staleness
      // was structurally UNMEASURABLE -- the exact blind spot that let `otchealth-brain` sit frozen for
      // ~12 days behind a green doc-count canary. indexed_at is stamped on every mergeOrUpload and is
      // sortable, so a canary can assert max(indexed_at) age instead of a doc-count floor (a frozen
      // index never drops below a floor; it stays identical forever).
      { name: "indexed_at", type: "Edm.DateTimeOffset", filterable: true, sortable: true, retrievable: true },
      { name: "contentVector", type: "Collection(Edm.Single)", searchable: true, retrievable: false, dimensions: EMB_DIMS, vectorSearchProfile: "vp" },
    ],
    vectorSearch: {
      algorithms: [{ name: "hnsw", kind: "hnsw" }],
      vectorizers: [{ name: "aoai", kind: "azureOpenAI", azureOpenAIParameters: { resourceUri: AOAI_EP, deploymentId: AOAI_DEP, apiKey: AOAI_KEY, modelName: AOAI_MODEL } }],
      profiles: [{ name: "vp", algorithm: "hnsw", vectorizer: "aoai" }],
    },
    semantic: { configurations: [{ name: "sem", prioritizedFields: { titleField: { fieldName: "title" }, prioritizedContentFields: [{ fieldName: "summary" }, { fieldName: "content" }], prioritizedKeywordsFields: [{ fieldName: "category" }] } }] },
  };
  // SKEW-PROOF (2026-07-14): a PUT that omits a field the LIVE index already has is rejected by Azure
  // ("Existing field(s) 'X' cannot be deleted"), so a writer whose code schema lags the live index
  // hard-fails push-search under set -e. This took down daily-digest the night indexed_at was
  // backfilled onto commons while daily-digest still ran a pre-indexed_at image. GET the live index (if
  // any) and merge additively so the PUT is always a non-destructive superset. See ./schema-merge.mjs.
  let putSchema = schema;
  try {
    const g = await fetch(`${AIS_EP}/indexes/${IDXNAME}?api-version=${AIS_API}`, { headers: { "api-key": AIS_KEY } });
    if (g.ok) putSchema = mergeSchemaAdditive(schema, await g.json());
  } catch { /* index absent or a transient GET error -> PUT the code schema as-is (first-create path) */ }
  const r = await fetch(`${AIS_EP}/indexes/${IDXNAME}?api-version=${AIS_API}`, { method: "PUT", headers: { "api-key": AIS_KEY, "Content-Type": "application/json" }, body: JSON.stringify(putSchema) });
  if (!r.ok) throw new Error("create index " + r.status + " " + (await r.text()).slice(0, 220));
}
async function aisPush(batch) {
  const r = await fetch(`${AIS_EP}/indexes/${IDXNAME}/docs/index?api-version=${AIS_API}`, { method: "POST", headers: { "api-key": AIS_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ value: batch }) });
  if (!r.ok) throw new Error("push " + r.status + " " + (await r.text()).slice(0, 220));
}
async function aisPushRetry(batch) {
  // Retry transient failures incl. the agent-proxy's SSRF guard firing on a momentary DNS blip
  // ("push 403 ... Host resolves to a private/reserved IP: resolve_no_records"), which killed a
  // finance reindex one batch from done. 8 tries, longer backoff so DNS has time to recover.
  for (let a = 0; a < 8; a++) {
    try { await aisPush(batch); return; }
    catch (e) { const m = String(e.message); if (a < 7 && /(429|503|500|408|throttl|timeout|ECONNRESET|fetch failed|resolve_no_records|private\/reserved IP|Host resolves|EAI_AGAIN|ENOTFOUND)/i.test(m)) { await sleep(3000 * (a + 1)); continue; } throw e; }
  }
}
async function runSearchInitAzure() { await aisInit(); await aisCreateIndex(); console.log(`Azure AI Search index ready: ${IDXNAME} (dims ${EMB_DIMS}, vectorizer ${AOAI_DEP})`); }
async function aisExistingIds() {
  // Resumability: collect ids already in the index so re-runs only push NEW docs. Without this,
  // push-search re-embeds ALL docs every run, so a room too big to finish push-search in one
  // window (finance: 16.6k docs) restarts from doc 1 each run and stays stuck at whatever a
  // single window reaches. Paging $skip up to AI Search's 100k limit.
  const ids = new Set();
  for (let skip = 0; skip < 100000; skip += 1000) {
    let r;
    try { r = await fetch(`${AIS_EP}/indexes/${IDXNAME}/docs?api-version=${AIS_API}&$select=id&$top=1000&$skip=${skip}`, { headers: { "api-key": AIS_KEY } }); }
    catch { break; }
    if (!r.ok) break;
    const v = (await r.json()).value || [];
    for (const d of v) ids.add(d.id);
    if (v.length < 1000) break;
  }
  return ids;
}
async function runPushSearchAzure() {
  await aisInit();
  // CHUNKED-ROOM GUARD (2026-07-21): after the Phase-3 S1 cutover the doc rooms are CHUNKED
  // (key=chunk_id, text_vector) and fed by native S1 pull-indexers -- a flat push (key=id,
  // contentVector) has nothing valid to do there. The 4 librarian jobs sat RED for ~6 days on
  // exactly this: a pinned pre-cutover image ignored SKIP_PUSH_SEARCH=1, ran push-search anyway,
  // and the schema-ensure PUT died 400 ("Found 2 key fields") merging the flat schema onto the
  // chunked one. Detect the live shape and SKIP cleanly instead of failing the whole job.
  // Freshness for chunked rooms is monitored via the pull-indexer (writer_indexer in
  // setup/expected-indexes.json), so this skip hides nothing.
  try {
    const g = await fetch(`${AIS_EP}/indexes/${IDXNAME}?api-version=${AIS_API}`, { headers: { "api-key": AIS_KEY } });
    if (g.ok) {
      const liveKey = ((await g.json()).fields || []).find((f) => f.key)?.name;
      if (liveKey && liveKey !== "id") {
        console.error(`[push-search] SKIP: index ${IDXNAME} is CHUNKED (key=${liveKey}; S1 pull-indexer-fed). A flat push does not apply to this room; set SKIP_PUSH_SEARCH=1 on its job to skip earlier.`);
        return;
      }
    }
  } catch { /* GET failure -> proceed; aisCreateIndex handles first-create + real errors */ }
  await aisCreateIndex();
  let rows = (await loadCatalog()).filter((r) => r.sidecar && !r.err);
  if (SKIP > 0) { console.error(`[push-search] --skip ${SKIP}: re-pushing only the tail (docs ${SKIP}..${rows.length}) after an interrupted reindex`); rows = rows.slice(SKIP); }
  const existing = REINDEX ? new Set() : await aisExistingIds(); // --reindex forces a full re-push
  console.error(`[push-search] ${rows.length} docs with text; ${existing.size} already indexed -> index ${IDXNAME}`);
  // Embed in BATCHES of 16 (the endpoint accepts an array): ~16x fewer requests than per-doc, which
  // is what ends the 429-exhaustion death spiral on a 16k-doc room. Push to AI Search in 64-doc
  // batches with retry. embErr docs are skipped (logged) so one bad doc never stalls the room.
  const EMB_BATCH = 16, PUSH_BATCH = 64;
  let n = 0, skipped = 0, embErr = 0, ready = [], pend = [], texts = [];
  async function pushReady(force) {
    while (ready.length >= PUSH_BATCH || (force && ready.length)) { const b = ready.splice(0, PUSH_BATCH); await aisPushRetry(b); n += b.length; console.error(`  pushed ${n} (skip ${skipped}${embErr ? `, embErr ${embErr}` : ""})`); }
  }
  async function flushEmb() {
    if (!texts.length) return;
    let vecs; try { vecs = await embed(texts); } catch (e) { embErr += pend.length; console.error(`  embed batch fail (${pend.length}): ${e.message}`); pend = []; texts = []; return; }
    for (let i = 0; i < pend.length; i++) { pend[i].contentVector = vecs[i]; ready.push(pend[i]); }
    pend = []; texts = [];
    await pushReady(false);
  }
  for (const r of rows) {
    const id = crypto.createHash("sha1").update(r.path).digest("hex");
    if (existing.has(id)) { skipped++; continue; } // resumable: already in the index
    const txt = (await getBuf(TEXT_PREFIX + r.path + ".txt"))?.toString("utf8") || ""; if (!txt) continue;
    const summary = r.summary || "";
    pend.push({ "@search.action": "mergeOrUpload", id, indexed_at: new Date().toISOString(), path: r.path, entity: r.entity || "", category: r.category || "", title: r.title || basename(r.path), summary: summary.slice(0, 16000), content: txt.slice(0, 32000), material: !!r.material, execution_status: r.execution_status || "", signed: !!r.has_signature });
    texts.push(((r.title || "") + "\n" + summary + "\n" + txt).slice(0, 8000));
    if (texts.length >= EMB_BATCH) await flushEmb();
  }
  await flushEmb();
  await pushReady(true);
  console.log(`pushed ${n} new docs (${skipped} already present${embErr ? `, ${embErr} embed-failed` : ""}) to Azure AI Search index ${IDXNAME}`);
}
async function runCloudSearchAzure(q) {
  if (!q) { console.error('usage: cloud-search "<query>"'); process.exit(2); }
  await aisInit();
  const body = { search: q, top: LIMIT || 15, queryType: "semantic", semanticConfiguration: "sem", vectorQueries: [{ kind: "text", text: q, fields: "contentVector", k: 50 }], select: "path,entity,category,title" };
  const r = await fetch(`${AIS_EP}/indexes/${IDXNAME}/docs/search?api-version=${AIS_API}`, { method: "POST", headers: { "api-key": AIS_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { console.error("cloud-search " + r.status + " " + (await r.text()).slice(0, 220)); process.exit(1); }
  const j = await r.json();
  for (const d of j.value || []) console.log(`[${(d.category || "?").padEnd(30)}] ${d.entity}  ${d.path}`);
  console.log(`(${(j.value || []).length} hits for: ${q}  via ${IDXNAME})`);
}

// ---------------- Amazon OpenSearch (default push-search / search-init / cloud-search backend, 2026-08-27) ----------------
// Writes/queries the SAME room/index name as the Azure path above (computeIndexName()) into the
// `otchealth-brain` OpenSearch domain, via skills/kb-memory/opensearch-write.mjs's already-proven
// credential resolution + bulk-update primitive (REUSED, not reimplemented -- see that file's own
// header for the SigV4 signer + the ECS-task-role/env/Key-Vault credential chain).
//
// ROOM SHAPE: a doc room on OpenSearch is either FLAT (one document per record, vector field
// `contentVector` -- exactly what push-search has always built) or CHUNKED (child-doc-per-source-
// chunk, vector field `text_vector`, populated by enrich.mjs's OpenSearch write path / the migration
// bulk loader, never by this file). This mirrors the Azure CHUNKED-ROOM GUARD above field-for-field:
// the registry is a property of the DATA (per otchealth-mcp-server/src/azure/search.ts's
// CHUNKED_ROOMS / src/search/opensearch.ts's vectorFieldFor, reused here by detecting the live
// mapping's vector field rather than duplicating that TypeScript list into a second, driftable copy)
// not of which search engine serves it, so a flat push has nothing valid to do against a chunked
// room and must SKIP cleanly, exactly like the Azure path already does.
const OS_VECTOR_FIELD_FLAT = "contentVector";
const OS_VECTOR_FIELD_CHUNKED = "text_vector";

/** The OpenSearch mapping for a freshly-created FLAT doc room. Field-for-field the same fields (and
 *  the same names) aisCreateIndex()'s Azure schema carries -- `content`/`summary`/`title` are exactly
 *  the gateway's own BM25_FIELDS for a flat room (see otchealth-mcp-server/src/search/opensearch.ts),
 *  and `contentVector` is exactly what vectorFieldFor() expects for a non-chunked index. Pure,
 *  exported for a direct unit test of the shape (mirrors opensearch-write.mjs's own
 *  memoryIndexMapping() convention). */
export function flatRoomMapping(dims = EMB_DIMS) {
  return {
    settings: { index: { knn: true } },
    mappings: {
      properties: {
        id: { type: "keyword" },
        path: { type: "text", fields: { keyword: { type: "keyword" } } },
        entity: { type: "keyword" },
        category: { type: "keyword" },
        title: { type: "text" },
        summary: { type: "text" },
        content: { type: "text" },
        material: { type: "boolean" },
        execution_status: { type: "keyword" },
        signed: { type: "boolean" },
        indexed_at: { type: "date" },
        [OS_VECTOR_FIELD_FLAT]: { type: "knn_vector", dimension: dims, method: { name: "hnsw", engine: "nmslib", space_type: "cosinesimil" } },
      },
    },
  };
}

/** Classify a room's live shape from its `_mapping` response body (the SAME REST shape osGetMapping()
 *  returns): 'chunked' (carries text_vector -- fed by enrich.mjs / the migration bulk loader, never by
 *  push-search), 'flat' (carries contentVector -- what push-search itself creates/maintains), or
 *  'unknown' (the index exists but neither vector field is mapped yet -- a room created but never
 *  written to under either shape). Pure -- no network -- so the decision is directly unit-testable
 *  without a live cluster. `index` is the index name (OpenSearch nests the mapping response under it). */
export function classifyRoomShape(mappingJson, index) {
  const props = mappingJson?.[index]?.mappings?.properties || {};
  if (props[OS_VECTOR_FIELD_CHUNKED]) return "chunked";
  if (props[OS_VECTOR_FIELD_FLAT]) return "flat";
  return "unknown";
}

/** Build the exact document `push-search` writes for one catalog row on OpenSearch -- field-for-field
 *  the Azure schema's non-`@search.action` fields (id/path/entity/category/title/summary/content/
 *  material/execution_status/signed/indexed_at/contentVector), so a room migrated between backends
 *  carries identical documents either way. Pure (no I/O; `vector` and `nowIso` are passed in) so the
 *  exact field names/shape are directly assertable in a unit test, incl. that the vector field is
 *  named `contentVector` -- matching vectorFieldFor()'s flat-room expectation and pickText()'s/
 *  BM25_FIELDS's `content` text field on the query side (see otchealth-mcp-server/src/azure/search.ts
 *  and src/search/opensearch.ts). */
export function buildFlatSearchDoc(row, txt, vector, nowIso = new Date().toISOString()) {
  const summary = row.summary || "";
  return {
    id: crypto.createHash("sha1").update(row.path).digest("hex"),
    indexed_at: nowIso,
    path: row.path,
    entity: row.entity || "",
    category: row.category || "",
    title: row.title || basename(row.path),
    summary: summary.slice(0, 16000),
    content: txt.slice(0, 32000),
    material: !!row.material,
    execution_status: row.execution_status || "",
    signed: !!row.has_signature,
    [OS_VECTOR_FIELD_FLAT]: vector,
  };
}

/** GET the room's live mapping and classify it, or 'absent' on a clean 404. Throws loud on any other
 *  non-2xx (a genuine outage/permissions problem must never read as "safe to create"). */
async function osRoomShape(cfg, index) {
  const m = await osGetMapping(cfg, index);
  if (m.status === 404) return "absent";
  if (!m.ok) throw new Error(`opensearch: mapping GET for ${index} failed: ${m.status} ${(m.text || "").slice(0, 200)}`);
  return classifyRoomShape(m.json, index);
}

/** Ensure the room is ready for a flat push: create it (flat schema) if genuinely absent, extend an
 *  existing-but-unmapped index's mapping additively if it exists with neither vector field yet, or
 *  report its real shape ('flat'/'chunked') if it already carries one. Never touches a chunked room's
 *  mapping -- the caller skips cleanly on 'chunked' before ever reaching a write. */
async function osEnsureRoomIndex(cfg, index) {
  const shape = await osRoomShape(cfg, index);
  if (shape === "chunked" || shape === "flat") return shape;
  if (shape === "absent") {
    const r = await osFetch(cfg, { method: "PUT", path: `/${encodeURIComponent(index)}`, body: JSON.stringify(flatRoomMapping()) });
    if (r.ok) return "flat";
    // Benign race: another writer created the index between our GET and this PUT.
    const recheck = await osRoomShape(cfg, index);
    if (recheck === "flat" || recheck === "chunked") return recheck;
    throw new Error(`opensearch: create index ${index} failed: ${r.status} ${(await r.text()).slice(0, 220)}`);
  }
  // 'unknown': index exists but has never been written to under either vector field. Settings
  // (index.knn) cannot be changed post-creation, but field ADDITIONS to a live mapping are allowed --
  // extend it with the flat schema's properties so the first real write lands on a correctly-typed
  // knn_vector field instead of a wrong type OpenSearch's own dynamic mapping would infer from a raw
  // float array.
  const r = await osFetch(cfg, { method: "PUT", path: `/${encodeURIComponent(index)}/_mapping`, body: JSON.stringify(flatRoomMapping().mappings) });
  if (!r.ok) throw new Error(`opensearch: extend mapping for ${index} failed: ${r.status} ${(await r.text()).slice(0, 220)}`);
  return "flat";
}

/** Embed a batch of texts for the search index, dispatching on EMBEDDINGS_PROVIDER -- the SAME
 *  independent-of-SEARCH_BACKEND switch semantic.mjs/index-one.mjs already use. 'openai' (default)
 *  reuses opensearch-write.mjs's embedOpenAI(); 'foundry' reuses this file's own pre-existing Azure
 *  embed() (resolving its config on first use, so choosing foundry embeddings does not require the
 *  rest of the Azure search path to be configured). */
async function embedForSearch(texts) {
  if (EMBEDDINGS_PROVIDER === "openai") return OS.embedOpenAI(texts);
  await ensureFoundryEmbedConfig();
  return embed(texts);
}

async function runSearchInitOpenSearch() {
  await initStorage();
  const cfg = await OS.resolveOpenSearchConfig();
  IDXNAME = computeIndexName();
  const shape = await osEnsureRoomIndex(cfg, IDXNAME);
  console.log(`OpenSearch index ready: ${IDXNAME} (shape=${shape}, dims ${EMB_DIMS})`);
}

async function runPushSearchOpenSearch() {
  await initStorage();
  const cfg = await OS.resolveOpenSearchConfig();
  IDXNAME = computeIndexName();
  const shape = await osEnsureRoomIndex(cfg, IDXNAME);
  if (shape === "chunked") {
    console.error(`[push-search] SKIP: index ${IDXNAME} is CHUNKED on OpenSearch (${OS_VECTOR_FIELD_CHUNKED} field present). A flat push does not apply to this room; it is fed by enrich.mjs's OpenSearch write path / the migration bulk loader instead.`);
    return;
  }
  let rows = (await loadCatalog()).filter((r) => r.sidecar && !r.err);
  if (SKIP > 0) { console.error(`[push-search] --skip ${SKIP}: re-pushing only the tail (docs ${SKIP}..${rows.length}) after an interrupted reindex`); rows = rows.slice(SKIP); }
  const existing = REINDEX ? new Set() : await OS.existingIds(IDXNAME); // --reindex forces a full re-push
  console.error(`[push-search] ${rows.length} docs with text; ${existing.size} already indexed -> index ${IDXNAME} (opensearch)`);
  // Same batching shape as the Azure path: embed 16 at a time, push 64 at a time, one bad doc/batch
  // never stalls the whole room.
  const EMB_BATCH = 16, PUSH_BATCH = 64;
  let n = 0, skipped = 0, embErr = 0, pushErr = 0, ready = [], pend = [], texts = [];
  async function pushReady(force) {
    while (ready.length >= PUSH_BATCH || (force && ready.length)) {
      const b = ready.splice(0, PUSH_BATCH);
      const r = await OS.pushDocs(IDXNAME, b);
      if (!r.ok) { pushErr += r.errors.length; console.error(`  bulk push had ${r.errors.length} error(s): ${JSON.stringify(r.errors.slice(0, 3))}`); }
      n += b.length - r.errors.length;
      console.error(`  pushed ${n} (skip ${skipped}${embErr ? `, embErr ${embErr}` : ""}${pushErr ? `, pushErr ${pushErr}` : ""})`);
    }
  }
  async function flushEmb() {
    if (!texts.length) return;
    let vecs;
    try { vecs = await embedForSearch(texts); }
    catch (e) { embErr += pend.length; console.error(`  embed batch fail (${pend.length}): ${e.message}`); pend = []; texts = []; return; }
    for (let i = 0; i < pend.length; i++) { pend[i][OS_VECTOR_FIELD_FLAT] = vecs[i]; ready.push(pend[i]); }
    pend = []; texts = [];
    await pushReady(false);
  }
  for (const r of rows) {
    const id = crypto.createHash("sha1").update(r.path).digest("hex");
    if (existing.has(id)) { skipped++; continue; } // resumable: already in the index
    const txt = (await getBuf(TEXT_PREFIX + r.path + ".txt"))?.toString("utf8") || ""; if (!txt) continue;
    pend.push(buildFlatSearchDoc(r, txt, null));
    texts.push(((r.title || "") + "\n" + (r.summary || "") + "\n" + txt).slice(0, 8000));
    if (texts.length >= EMB_BATCH) await flushEmb();
  }
  await flushEmb();
  await pushReady(true);
  if (n > 0) { try { await OS.refresh(IDXNAME); } catch { /* best-effort -- docs are already durably written; a refresh failure only delays search-visibility */ } }
  const failNote = pushErr ? `, ${pushErr} push-failed` : "";
  console.log(`pushed ${n} new docs (${skipped} already present${embErr ? `, ${embErr} embed-failed` : ""}${failNote}) to OpenSearch index ${IDXNAME}`);
  if (pushErr > 0) process.exitCode = 1; // a partial bulk failure must not read as a clean run
}

async function runCloudSearchOpenSearch(q) {
  if (!q) { console.error('usage: cloud-search "<query>"'); process.exit(2); }
  await initStorage();
  const cfg = await OS.resolveOpenSearchConfig();
  IDXNAME = computeIndexName();
  const shape = await osRoomShape(cfg, IDXNAME);
  if (shape === "absent") { console.error(`cloud-search: index ${IDXNAME} does not exist on OpenSearch yet (run push-search first)`); process.exit(1); }
  const vecField = shape === "chunked" ? OS_VECTOR_FIELD_CHUNKED : OS_VECTOR_FIELD_FLAT;
  let vector = null;
  try { vector = (await embedForSearch([q]))[0]; } catch { /* degrade to keyword-only, matching the gateway's own fail-open contract */ }
  const top = LIMIT || 15;
  const fetchTop = Math.min(50, Math.max(top * 3, top));
  // BM25_FIELDS, matching otchealth-mcp-server/src/search/opensearch.ts's own field list exactly
  // (title/content/chunk/summary): a chunked room carries chunk/title/path, a flat room carries
  // content/summary/title -- requesting the union is harmless (an absent field just never matches).
  const bmRes = await osSearch(cfg, IDXNAME, { size: fetchTop, _source: { excludes: [vecField] }, query: { multi_match: { query: q, fields: ["title^2", "content", "chunk", "summary", "path"] } } });
  if (!bmRes.ok) { console.error("cloud-search " + bmRes.status + " " + (bmRes.text || "").slice(0, 220)); process.exit(1); }
  let vecHits = [];
  if (vector) {
    const knnRes = await osSearch(cfg, IDXNAME, { size: fetchTop, _source: { excludes: [vecField] }, query: { knn: { [vecField]: { vector, k: fetchTop } } } });
    if (knnRes.ok) vecHits = (knnRes.json?.hits?.hits || []).map((h) => ({ id: String(h._id), source: h._source || {} }));
  }
  const bmHits = (bmRes.json?.hits?.hits || []).map((h) => ({ id: String(h._id), source: h._source || {} }));
  const rrf = OS.reciprocalRankFusion(vector ? [bmHits, vecHits] : [bmHits]);
  const bySource = new Map();
  for (const h of [...bmHits, ...vecHits]) if (h.id && !bySource.has(h.id)) bySource.set(h.id, h.source);
  const hits = [...rrf.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([id]) => bySource.get(id) || {});
  for (const d of hits) console.log(`[${(d.category || "?").toString().padEnd(30)}] ${d.entity || ""}  ${d.path || d.parent_id || ""}`);
  console.log(`(${hits.length} hits for: ${q}  via ${IDXNAME}, opensearch/${shape})`);
}

async function runSearchInit() { return SEARCH_BACKEND === "azure" ? runSearchInitAzure() : runSearchInitOpenSearch(); }
async function runPushSearch() { return SEARCH_BACKEND === "azure" ? runPushSearchAzure() : runPushSearchOpenSearch(); }
async function runCloudSearch(q) { return SEARCH_BACKEND === "azure" ? runCloudSearchAzure(q) : runCloudSearchOpenSearch(q); }

// ============================ Azure Content Understanding (the "understand" tier) ============================
// CU = the generative understanding engine (2026-06-19 decision). Per doc it returns clean Markdown
// + structured fields (classify into our taxonomy, doc type, summary, date, counterparty, amount,
// materiality) in ONE call, using a Foundry model deployment (gpt-4.1-mini default). It replaces the
// regex first-pass with model-grade understanding and overwrites the sidecar text with CU Markdown.
// Runs on the Foundry resource (azure-foundry-endpoint/-key). Pending live validation on provisioning.
const CU_API = "2025-11-01";
const CU_ANALYZER = `otc_${PROFILE}_audit`; // CU analyzer ids: no hyphens
let CU_EP, CU_KEY, CU_GEN_DEP, CU_EMB_DEP;
async function cuInit() {
  await initStorage();
  CU_EP = (process.env.AZURE_FOUNDRY_ENDPOINT || (await sm("azure-foundry-endpoint")) || "").replace(/\/$/, "");
  CU_KEY = process.env.AZURE_FOUNDRY_KEY || (await sm("azure-foundry-key"));
  CU_GEN_DEP = process.env.AZURE_FOUNDRY_GEN_DEPLOYMENT || (await sm("azure-foundry-gen-deployment")) || "gpt-4.1-mini";
  CU_EMB_DEP = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || (await sm("azure-openai-embedding-deployment")) || "text-embedding-3-large";
  if (!CU_EP || !CU_KEY) { console.error("Missing azure-foundry-endpoint / azure-foundry-key (provision the Foundry resource)."); process.exit(2); }
}
const cuH = () => ({ "Ocp-Apim-Subscription-Key": CU_KEY, "Content-Type": "application/json" });
async function cuPoll(url) { for (let i = 0; i < 240; i++) { await sleep(1500); const r = await fetch(url, { headers: { "Ocp-Apim-Subscription-Key": CU_KEY } }); if (!r.ok) continue; const j = await r.json(); const s = (j.status || "").toLowerCase(); if (s === "succeeded") return j; if (s === "failed") throw new Error("CU op failed: " + JSON.stringify(j).slice(0, 180)); } throw new Error("CU poll timeout"); }
const CU_OK = new Set(["pdf", "jpg", "jpeg", "png", "bmp", "heif", "tiff", "tif", "docx", "xlsx", "pptx", "html", "htm", "txt", "md", "rtf", "eml"]); // CU-supported input types; others (json/csv) keep index-time extraction
async function cuSetDefaults() {
  await cuInit();
  const body = { modelDeployments: { [CU_GEN_DEP]: CU_GEN_DEP, [CU_EMB_DEP]: CU_EMB_DEP } };
  const r = await fetch(`${CU_EP}/contentunderstanding/defaults?api-version=${CU_API}`, { method: "PATCH", headers: cuH(), body: JSON.stringify(body) });
  console.log(`CU defaults PATCH -> ${r.status}${r.ok ? " (gen=" + CU_GEN_DEP + ", emb=" + CU_EMB_DEP + ")" : " " + (await r.text()).slice(0, 200)}`);
}
function cuAnalyzerDef() {
  const cats = (P.cats || []).map((c) => c[0]); cats.push("_NON-ACCOUNTING", "_INBOX-UNCLASSIFIED");
  const entityEnum = PROFILE === "finance" ? ["InnerScope", "HearingAssist", "OTCHealth", "iHEAR", "Personal", "QBO-Mixed", "Unknown"] : ["Company", "Personal", "Unknown"];
  return {
    description: `OTCHealth ${PROFILE} audit analyzer: classify + extract + summarize`,
    baseAnalyzerId: "prebuilt-document",
    models: { completion: CU_GEN_DEP, embedding: CU_EMB_DEP }, // classify/generate need a completion model
    fieldSchema: { name: `OTC_${PROFILE}_Audit`, fields: {
      Category: { type: "string", method: "classify", description: "The single best audit category for this document.", enum: cats },
      Entity: { type: "string", method: "classify", description: "Which company/entity this document belongs to.", enum: entityEnum },
      DocumentType: { type: "string", method: "generate", description: "Short human label for the document type, e.g. 'Bank statement', 'Promissory note', 'Invoice', 'Board minutes'." },
      Summary: { type: "string", method: "generate", description: "One or two sentence factual summary of what this document is and contains. No speculation." },
      DocumentDate: { type: "string", method: "generate", description: "Primary date of the document as YYYY-MM-DD if present, else empty." },
      Counterparty: { type: "string", method: "generate", description: "The other party (vendor, customer, bank, court, or person), if any." },
      Amount: { type: "string", method: "generate", description: "The most significant monetary amount in the document (with currency), if any." },
      Material: { type: "boolean", method: "generate", description: "True if financially or legally material/significant (statements, agreements, equity, debt, raises, M&A, workpapers, board, related-party, pleadings); false for routine items like a single AP invoice, a logo, or a QBO attachment." },
    } },
  };
}
async function cuEnsureAnalyzer() {
  const ah = { "Ocp-Apim-Subscription-Key": CU_KEY };
  const aurl = `${CU_EP}/contentunderstanding/analyzers/${CU_ANALYZER}?api-version=${CU_API}`;
  const g = await fetch(aurl, { headers: ah });
  if (g.ok) { const j = await g.json(); if ((j.status || "").toLowerCase() === "succeeded") return; await fetch(aurl, { method: "DELETE", headers: ah }); }
  const r = await fetch(aurl, { method: "PUT", headers: cuH(), body: JSON.stringify(cuAnalyzerDef()) });
  if (!(r.status === 201 || r.status === 200)) throw new Error("CU analyzer create " + r.status + " " + (await r.text()).slice(0, 240));
  const op = r.headers.get("operation-location"); if (op) await cuPoll(op);
  const v = await (await fetch(aurl, { headers: ah })).json();
  if (!["succeeded", "ready"].includes((v.status || "").toLowerCase())) throw new Error("CU analyzer build " + (v.status || "?") + " models=" + JSON.stringify(v.models || {}) + " warn=" + JSON.stringify(v.warnings || []).slice(0, 200));
}
async function cuAnalyze(buf) {
  const r = await fetch(`${CU_EP}/contentunderstanding/analyzers/${CU_ANALYZER}:analyzeBinary?api-version=${CU_API}`, { method: "POST", headers: { "Ocp-Apim-Subscription-Key": CU_KEY, "Content-Type": "application/octet-stream" }, body: buf });
  if (r.status === 429) { const ra = parseInt(r.headers.get("retry-after") || "0", 10); await sleep((ra > 0 ? ra * 1000 : 4000) + Math.floor(Math.random() * 1000)); return cuAnalyze(buf); }
  if (!(r.status === 202 || r.status === 200)) throw new Error("CU analyze " + r.status + " " + (await r.text()).slice(0, 180));
  const op = r.headers.get("operation-location"); const j = op ? await cuPoll(op) : await r.json();
  const res = j.result || j; const contents = res.contents || [];
  const md = contents.map((c) => c.markdown || "").join("\n\n").trim();
  const f = (contents[0] && contents[0].fields) || res.fields || {};
  const val = (k) => { const x = f[k]; if (x == null) return ""; return x.valueString ?? x.valueBoolean ?? x.valueNumber ?? x.valueDate ?? x.value ?? ""; };
  return { md, fields: { Category: val("Category"), Entity: val("Entity"), DocumentType: val("DocumentType"), Summary: val("Summary"), DocumentDate: val("DocumentDate"), Counterparty: val("Counterparty"), Amount: val("Amount"), Material: val("Material") }, usage: res.usage || j.usage || {} };
}
function costFromUsage(u) { // illustrative published rates; calibrate before the full run
  const extraction = ((u.documentPagesStandard || 0) + (u.documentPagesBasic || 0)) / 1000 * 5 + (u.documentPagesMinimal || 0) / 1000 * 1;
  const ctx = (u.contextualizationToken || 0) / 1e6 * 1;
  const tk = u.tokens || {}; let tin = 0, tout = 0; for (const [k, v] of Object.entries(tk)) { if (k.endsWith("-input")) tin += v; else if (k.endsWith("-output")) tout += v; }
  const tokcost = tin / 1e6 * 0.40 + tout / 1e6 * 1.60; // gpt-4.1-mini global (illustrative)
  const pages = (u.documentPagesStandard || 0) + (u.documentPagesBasic || 0) + (u.documentPagesMinimal || 0);
  return { pages, cost: extraction + ctx + tokcost };
}
async function runUnderstand() {
  await cuInit(); await cuEnsureAnalyzer();
  const rows = await loadCatalog();
  const todo = rows.filter((r) => (REINDEX || !r.cu) && !r.err && CU_OK.has((r.ext || "").toLowerCase()));
  const skipped = rows.filter((r) => !CU_OK.has((r.ext || "").toLowerCase())).length;
  const work = LIMIT ? todo.slice(0, LIMIT) : todo;
  console.error(`[understand] profile=${PROFILE} analyzer=${CU_ANALYZER} model=${CU_GEN_DEP}; ${work.length} docs (concurrency ${CONCURRENCY})${LIMIT ? ` (limit ${LIMIT})` : ""} (${skipped} non-CU types keep index-time text).`);
  // Bounded worker pool: CU analyze + poll is ~30-60s/doc serially, the dominant cost. Running
  // N in parallel (CU tolerates it; 429s self-retry in cuAnalyze) is the speedup. Resumable: each
  // flushed catalog row marks r.cu, so a timeout/restart only re-does the unfinished tail.
  let n = 0, since = 0, totCost = 0, totPages = 0, next = 0, flushing = false, budgetHit = false;
  const startTs = Date.now();
  const maybeFlush = async () => { if (flushing) return; flushing = true; try { await flushCatalog(rows); } finally { flushing = false; } };
  async function processOne(r) {
    try {
      const buf = await getBuf(r.path); if (!buf) { r.err = "missing"; return; }
      const a = await cuAnalyze(buf);
      if (a.fields.Category) r.category = a.fields.Category;
      if (a.fields.Entity && a.fields.Entity !== "Unknown") r.entity = a.fields.Entity;
      r.doc_type = a.fields.DocumentType; r.summary = a.fields.Summary; r.doc_date = a.fields.DocumentDate; r.counterparty = a.fields.Counterparty; r.amount = a.fields.Amount;
      r.material = a.fields.Material === true || a.fields.Material === "true" || P.material.has(r.category);
      r.cu = true; r.cu_engine = "cu:" + CU_GEN_DEP;
      if (a.md && !NO_TEXT) { try { await putBuf(TEXT_PREFIX + r.path + ".txt", Buffer.from(a.md, "utf8"), "text/plain; charset=utf-8"); r.sidecar = true; r.engine = "cu:" + CU_GEN_DEP; } catch {} }
      const c = costFromUsage(a.usage); totCost += c.cost; totPages += c.pages; r.cu_pages = c.pages;
    } catch (e) { r.err = "cu: " + e.message.slice(0, 120); }
  }
  async function worker() {
    for (;;) {
      // Soft time budget: stop pulling new work before the job's replicaTimeout so the run exits 0
      // ("Succeeded") having flushed its progress, instead of being killed (which shows "Failed").
      // The pass is resumable, so the next scheduled run picks up the unfinished tail.
      if (MAX_MIN && (Date.now() - startTs) > MAX_MIN * 60000) { budgetHit = true; return; }
      const i = next++; if (i >= work.length) return;
      await processOne(work[i]);
      n++; since++;
      if (since >= Math.min(FLUSH_EVERY, 50)) { since = 0; await maybeFlush(); console.error(`  understood ${n}/${work.length} | ~$${totCost.toFixed(2)} / ${totPages} pages`); }
    }
  }
  if (!work.length) { console.error("[understand] nothing to enrich (all caught up)."); return; }
  const lease = await leaseAcquire();
  if (lease.busy) { console.error(`[understand] SKIP: another understand worker holds the catalog lease (HTTP ${lease.status}). Exiting cleanly to avoid clobbering the shared catalog; the active writer continues (resumable).`); return; }
  const renewTimer = lease.id ? setInterval(() => leaseRenew(lease.id), 30000) : null;
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length || 1) }, () => worker()));
    await flushCatalog(rows);
    const tail = budgetHit ? ` | stopped at ${MAX_MIN}min budget, ${work.length - n} docs deferred to next run (resumable)` : "";
    console.log(`[understand] +${n} docs | ~$${totCost.toFixed(2)} over ${totPages} pages (~$${totPages ? (totCost / totPages * 1000).toFixed(2) : "?"}/1k pages)${tail}. Next: push-search.`);
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    await leaseRelease(lease.id);
  }
}
async function runCuCalibrate() {
  const N = LIMIT || 200;
  await cuInit(); await cuEnsureAnalyzer();
  const rows = await loadCatalog(); const sample = rows.filter((r) => !r.err).slice(0, N);
  if (!sample.length) { console.error("no catalog yet; run `index --no-ocr` first to inventory the room."); process.exit(1); }
  console.error(`[cu-calibrate] running CU on ${sample.length} representative docs (analyzer ${CU_ANALYZER}, model ${CU_GEN_DEP})...`);
  let cost = 0, pages = 0, ok = 0;
  for (const r of sample) { try { const buf = await getBuf(r.path); if (!buf) continue; const a = await cuAnalyze(buf); const c = costFromUsage(a.usage); cost += c.cost; pages += c.pages; ok++; } catch (e) { console.error("  fail " + r.path.slice(-40) + ": " + e.message.slice(0, 80)); } }
  const total = rows.length, perDoc = ok ? cost / ok : 0, perPage = pages ? cost / pages : 0;
  console.log(`\n[cu-calibrate] ${ok} docs, ${pages} pages, $${cost.toFixed(2)} actual (model ${CU_GEN_DEP})`);
  console.log(`  per-doc ~$${perDoc.toFixed(4)} | per-1k-pages ~$${(perPage * 1000).toFixed(2)}`);
  console.log(`  PROJECTED full corpus (${total} docs): ~$${(perDoc * total).toFixed(0)}`);
}

// CLI entrypoint guard: only dispatch when this file is run directly (`node indexer.mjs ...`),
// never when imported (e.g. by tests importing `isXfaPlaceholder` for regression coverage) --
// without this guard, importing the module for its exports would unconditionally hit the final
// `process.exit(2)` (no-args -> cmd="help" -> falls into the usage-error branch) and kill the
// importing process, exactly the kind of import-time side effect fixed in backup.mjs the same day.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (cmd === "index") await runIndex();
    else if (cmd === "search") await runSearch(pos.slice(1).join(" "));
    else if (cmd === "build-index") await runBuildIndex();
    else if (cmd === "status") await runStatus();
    else if (cmd === "propose-mapping") await runProposeMapping();
    else if (cmd === "build-csv") await runBuildCsv();
    else if (cmd === "search-init") await runSearchInit();
    else if (cmd === "push-search") await runPushSearch();
    else if (cmd === "cloud-search") await runCloudSearch(pos.slice(1).join(" "));
    else if (cmd === "cu-defaults") await cuSetDefaults();
    else if (cmd === "cu-init") { await cuInit(); await cuEnsureAnalyzer(); console.log("CU analyzer ready: " + CU_ANALYZER); }
    else if (cmd === "understand") await runUnderstand();
    else if (cmd === "cu-calibrate") await runCuCalibrate();
    else { console.error('commands: index | search "<q>" | build-index | status | build-csv | propose-mapping | search-init | push-search | cloud-search "<q>" | cu-defaults | cu-init | understand | cu-calibrate\nflags: --profile finance|legal|generic --s3|--azure|--gcs --container c --azure-account a --bucket b --key-secret s --index name --prefix p --limit n --ocr-model prebuilt-read|prebuilt-layout --no-ocr --no-text --reindex\nsearch-init/push-search/cloud-search only: --search-backend opensearch|azure (default opensearch; env SEARCH_BACKEND) --embeddings-provider openai|foundry (default openai; env EMBEDDINGS_PROVIDER)'); process.exit(2); }
  } catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
}

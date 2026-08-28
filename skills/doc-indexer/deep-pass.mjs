#!/usr/bin/env node
// deep-pass.mjs — HIGH-POWER re-summarization + signature/execution detection + confidence-gated
// outlier flagging for the legal + finance data rooms. The fix for botched gpt-4.1-mini summaries.
//
// For each catalogued doc it: reads the EXISTING _TEXT sidecar (no re-OCR by default), runs a Bedrock
// Claude model (forced tool-use, strict JSON) for a rich, faithful, decision-grade summary +
// structured fields, runs a VISION pass on the final page(s) of signature-capable docs for the
// signature taxonomy (requires / present / WET / DIGITAL + signatories + execution date), composes a
// canonical filename (YYYY-MM-DD-of-execution_Title.ext) + a dedup key, and applies a CONFIDENCE GATE:
// anything it cannot confidently classify (thin text, ambiguous type, undetermined signature, missing
// fields) is flagged NEEDS_CLAUDE_REVIEW with reasons instead of guessing.
//
// Enriches _CATALOG/catalog.jsonl IN PLACE (keeps the old mini summary as summary_mini for audit).
// Writes _REVIEW/review-queue.csv (the "job one" list for the CLO/CFO) + _CATALOG/deep-fields.csv
// (for the later dedup/rename sorter). Resumable: skips rows already marked .deep unless --reindex.
// Bounded concurrency + soft time budget so it exits 0 ("Succeeded") having flushed, and the next
// run picks up the tail. Non-PHI ring.
//
// ============================================================================================
// 2026-08-28 AWS/Bedrock PORT. Both Azure dependencies this file used to have are gone:
//   1. STORAGE was Azure Blob (account SAS), hardcoded. Azure died with subscription 55c84f6b
//      (2026-08-13). Ported to the SAME S3 mirror layer indexer.mjs/enrich.mjs already use
//      (skills/kb-memory/s3-blob.mjs) -- `--storage-backend s3` (default) or `--azure` (read-only
//      history/inspection of pre-lockdown data; writes on it still throw loud).
//   2. THE LLM STEP was Azure Foundry gpt-4.1 (`chat()`, now `chatAzure()`, kept as the azure/history
//      rollback path only). Foundry returns HTTP 401 (FND-20260821-783d). Ported to AWS Bedrock's
//      Converse API (bedrock-client.mjs) -- `--llm-provider bedrock` (default) or `azure`
//      (history/rollback). OpenAI-direct is DELIBERATELY not an option: this file sends full document
//      TEXT plus page-image VISION calls for finance-cfo-source-docs and legal-company, both of which
//      carry MNPI/attorney-privileged material, and Bedrock inside our own AWS account (the SAME
//      account the source documents already live in via the S3 mirror) is the whole reason that
//      processor decision resolved this way -- see otchealth-cto/CLAUDE.md's 2026-08-19 entry.
//
// THE FLOOD BUG THIS PORT ALSO CLOSES (FND-20260821-783d): before this port, ANY chat() failure
// (network, auth, a dead endpoint) was caught and turned into a TERMINAL row state (`deep: true`,
// `review: 'NEEDS_CLAUDE_REVIEW'`), and selectTodo's `!r.deep` filter never re-selects a terminal row.
// One transient/dead-model tick would have PERMANENTLY flooded all three privileged rooms'
// `_REVIEW/review-queue.csv` -- the CFO/CLO "job one" list -- with near-total false positives. This is
// why the deep-* EventBridge crons were held at a placeholder cron (FND-20260821-97e9) rather than
// armed: arming them against the OLD code, even pointed at a working endpoint, was one bad tick away
// from the same flood on a genuine transient outage. Fixed here via a two-tier failure taxonomy (see
// analyze()'s and worker()'s comments): a TRANSPORT failure (the model was never reached) leaves the
// row completely untouched so it is retried next run; only a CONTENT failure (the model answered but
// produced nothing usable) is terminal. An all-calls-failed run now exits non-zero (FATAL), matching
// enrich.mjs's own #462 fix for the identical class of bug.
//
// PRIVILEGED-ROOM POLICY (read before changing): finance-cfo-source-docs and legal-company proceed to
// Bedrock LLM analysis (Bedrock-in-our-own-account is the boundary that makes this acceptable for
// MNPI/attorney-privileged content). legal-personal is CATEGORICALLY EXCLUDED from all LLM
// enrichment -- not merely ring-gated at the search layer the way PERSONAL_LEGAL_RING gates read
// access, but refused BEFORE this script ever calls a model, model provider irrelevant. This is a
// deliberate STRICTER posture than legal-company/finance and is enforced in code (isLlmExcludedRoom(),
// checked first thing in main()), not left as a documentation-only convention. See that function's own
// comment for the reasoning.
//
// A KNOWN, EXPLICIT, NON-SILENT GAP (verify pass REQUIRED FIX #4, kept as an accepted decision rather
// than fixed in this PR): selectTodo()'s eligibility filter is still the blanket `!path.startsWith("_")`
// pattern-match that enrich.mjs's #463 fix (2026-08-19) replaced with an explicit isPipelineInternal()
// prefix list after finding it silently excluded ~2,900 real documents in the commons room alone.
// deep-pass.mjs's rooms (finance/legal) lose fewer documents to this than commons did, but legal-company
// alone lost +183 real docs to the identical bug per that same fix's measurement. Porting selectTodo to
// isPipelineInternal() is out of this PR's scope (it is a selection-logic change orthogonal to the
// provider/storage port, and touches the pure, separately regression-tested selectTodo/unresolved
// contract tests/deep-pass-loop.test.mjs pins) -- recorded here as an accepted, tracked gap, not silence.
//
// Usage: node deep-pass.mjs --profile legal|finance
//          [--container company|personal|cfo-source-docs] [--account <acct>] [--key-secret <sm>]
//          [--storage-backend s3|azure] [--llm-provider bedrock|azure] [--model <id>]
//          [--bedrock-region us-east-1] [--limit N] [--reindex] [--concurrency 6]
//          [--max-minutes 110] [--prefix p]
// NOTE: --container personal under --profile legal is REFUSED unconditionally (see above); there is
// no flag combination that routes around it.

import crypto from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kvSecret, requireSecrets } from "../kb-memory/azure-secret.mjs";
import { fleetSecret } from "./fleet-secret.mjs";
import { getBufferFromS3, putObjectToS3, deleteObjectFromS3, s3LocationFor } from "../kb-memory/s3-blob.mjs";
import { converseJson } from "./bedrock-client.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const PROFILE = (val('--profile', 'legal')).toLowerCase();
const DEF = PROFILE === 'finance'
  ? { acct: 'otchealthcfodata', container: 'cfo-source-docs', key: 'azure-cfo-storage-key' }
  : { acct: 'otchealthlegalstore', container: 'company', key: 'azure-legal-storage-key' };
const ACCT = val('--account', DEF.acct);
const CONTAINER = val('--container', DEF.container);
const KEYSECRET = val('--key-secret', DEF.key);
const PREFIX = val('--prefix', '');
const LIMIT = parseInt(val('--limit', '0'), 10) || 0;
const REINDEX = has('--reindex');
const CONC = Math.max(1, parseInt(val('--concurrency', '6'), 10) || 6);
const MAXMIN = parseInt(val('--max-minutes', '0'), 10) || 0;
const MAXTEXT = 52000; // chars of sidecar fed to the summary model

// ---------- storage backend (mirrors enrich.mjs's identical flag/env resolution exactly) ----------
// NOTE: value computation only, NO validation/exit here -- see main()'s own guard for why. Every
// const in this section is read by closure from functions (getBuf/putBuf/callLlm/...) that fire only
// from inside main(), so the VALUES must be module-scope constants, but any process.exit() belongs
// exclusively inside main(), never at import time (see the comment on that guard).
const STORAGE = (
  val('--storage-backend', null) ||
  (has('--s3') ? 's3' : has('--azure') ? 'azure' : null) ||
  process.env.STORAGE_BACKEND || 's3'
).toLowerCase();

// ---------- LLM provider: Bedrock only, plus historical Azure. NO OpenAI option (see file header) ----------
// DEEP_LLM_PROVIDER, not the more generic LLM_PROVIDER: this fleet's session-start.sh and other
// scripts already export a bare LLM_PROVIDER for unrelated purposes (observed live in this sandbox as
// LLM_PROVIDER=openai) -- reusing that name here would silently misconfigure (or, before this file's
// validation was moved into main(), outright CRASH on merely importing this module for its pure
// exports, since an ambient "openai" value tripped a validation that used to live at module scope and
// call process.exit() at import time, killing every test file sharing that `node --test` process,
// this one included). A prefixed, script-specific name is the fix in both directions.
const PROVIDER = (val('--llm-provider', process.env.DEEP_LLM_PROVIDER || 'bedrock')).toLowerCase();
const BEDROCK_REGION = val('--bedrock-region', process.env.BEDROCK_REGION || 'us-east-1');
// Per-room model split (design doc section 2): Sonnet 4.5 for legal (INND MNPI; the strongest
// faithfulness + signature-vision judgment), Haiku 4.5 for finance bulk (mini-class models are BANNED
// for decision-grade summarization per setup/model-routing.mjs -- Haiku 4.5 is NOT mini-class).
// UNVERIFIED LIVE as of this port: confirm both the model id and its current on-demand price via
// `aws bedrock list-inference-profiles --region us-east-1` + https://aws.amazon.com/bedrock/pricing/
// before trusting a real backfill's cost estimate (see bedrock-client.mjs's header for the same note).
const BEDROCK_DEFAULT_MODEL = PROFILE === 'finance'
  ? 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
  : 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const MODEL_ID = val('--model', process.env.DEEP_MODEL || (PROVIDER === 'bedrock' ? BEDROCK_DEFAULT_MODEL : 'gpt-4.1'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alnum = (s) => (String(s).match(/[A-Za-z0-9]/g) || []).length;
const slug = (s) => String(s || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72);
const J = (t) => { try { return JSON.parse(t); } catch { try { return JSON.parse(String(t).slice(String(t).indexOf('{'), String(t).lastIndexOf('}') + 1)); } catch { return null; } } };
const csv = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';

// PRIVILEGED-ROOM EXCLUSION (2026-08-28 Bedrock port -- ground truth for this port, not a design-doc
// recommendation; the design's own T4 test plan named legal-personal as its smallest-room pilot
// target, and this deliberately OVERRIDES that plan). legal-personal is attorney-client-privileged
// material bound to PERSONAL_LEGAL_RING (['clo-personal','exec']) at the search-access layer (see
// otchealth-cto/CLAUDE.md's 2026-07-16 P0 personal-legal cross-ring leak entry). This function
// generalizes that same "never widen personal-legal access" instinct one layer earlier: no LLM call
// -- Bedrock's included, though it runs entirely inside our own AWS account -- is authorized to
// RECEIVE that content in the first place, categorically, regardless of --llm-provider. Checked first
// thing in main(), before any lock/network/secret call, so there is no code path that reaches an LLM
// with this room's content by accident.
export function isLlmExcludedRoom(profile, container) {
  return String(profile || '').toLowerCase() === 'legal' && String(container || '').toLowerCase() === 'personal';
}

// ---------- fleet secret resolver (AWS SSM first, then Key Vault) ----------
async function sm(id) { return fleetSecret(id); }

// ---------- Azure Blob (account SAS) -- READ-ONLY-HISTORY path only when --storage-backend azure ----------
let AKEY, SAS;
function buildSas() { const sv = '2021-12-02', sp = 'rwdlc', ss = 'b', srt = 'co'; const st = new Date(Date.now() - 3e5).toISOString().slice(0, 19) + 'Z'; const se = new Date(Date.now() + 12 * 36e5).toISOString().slice(0, 19) + 'Z'; const sts = [ACCT, sp, ss, srt, st, se, '', 'https', sv, ''].join('\n') + '\n'; const sig = crypto.createHmac('sha256', Buffer.from(AKEY, 'base64')).update(sts, 'utf8').digest('base64'); return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: 'https', sig }).toString(); }
const enc = (n) => n.split('/').map(encodeURIComponent).join('/');
const htmlEnt = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
async function getBufAzure(n) {
  let r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(n)}?${SAS}`);
  if (r.status === 404 && /&(amp|lt|gt|quot|#39|apos);/.test(n)) { const d = htmlEnt(n); if (d !== n) r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(d)}?${SAS}`); }
  if (r.status === 404) return null; if (!r.ok) throw new Error('get ' + r.status); return Buffer.from(await r.arrayBuffer());
}
async function putBufAzure(n, buf, ct) { const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(n)}?${SAS}`, { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': ct || 'application/octet-stream' }, body: buf }); if (!r.ok) throw new Error('put ' + r.status + ' ' + (await r.text()).slice(0, 120)); }

// ---------- storage dispatch (2026-08-28 port; mirrors enrich.mjs's getBuf/putBuf/delBuf exactly) ----------
// The null-vs-throw contract is IDENTICAL on both backends and load-bearing: null means a genuine 404
// and ONLY 404. A 403 must throw, never read as "this document is empty" -- s3-blob.mjs guarantees
// this on its side, which is why it is a drop-in here, same as it already is in enrich.mjs/indexer.mjs.
async function getBuf(n) {
  if (STORAGE === 'azure') return getBufAzure(n);
  let b = await getBufferFromS3(ACCT, CONTAINER, n);
  if (b == null && /&(amp|lt|gt|quot|#39|apos);/.test(n)) { const d = htmlEnt(n); if (d !== n) b = await getBufferFromS3(ACCT, CONTAINER, d); }
  return b;
}
async function putBuf(n, buf, ct) {
  if (STORAGE === 's3') return putObjectToS3(ACCT, CONTAINER, n, buf, ct || 'application/octet-stream');
  return putBufAzure(n, buf, ct);
}

// ---------- cron-safe lock: one deep-pass execution per room at a time ----------
const LOCK = '_CATALOG/.deep.lock';
const LOCK_TTL = 15 * 60 * 1000;
const LOCK_ID = crypto.randomBytes(6).toString('hex');
async function acquireLock() { try { const b = await getBuf(LOCK); if (b) { const j = JSON.parse(b.toString('utf8')); if (Date.now() - (j.ts || 0) < LOCK_TTL) return false; } } catch {} try { await putBuf(LOCK, Buffer.from(JSON.stringify({ ts: Date.now(), id: LOCK_ID })), 'application/json'); } catch {} return true; }
async function refreshLock() { try { await putBuf(LOCK, Buffer.from(JSON.stringify({ ts: Date.now(), id: LOCK_ID })), 'application/json'); } catch {} }
async function releaseLock() {
  if (STORAGE === 's3') { try { await deleteObjectFromS3(ACCT, CONTAINER, LOCK); } catch {} return; }
  try { await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(LOCK)}?${SAS}`, { method: 'DELETE' }); } catch {}
}

// ---------- Azure Foundry gpt-4.1 chat -- HISTORY/ROLLBACK path only (--llm-provider azure) ----------
// Kept byte-for-byte as it behaved before this port (including its own pre-existing unbounded-retry
// quirk on 429, not fixed here): this path exists so a genuine Azure-Foundry-is-back rollback is one
// flag away, not so it is a maintained parallel implementation. The default (Bedrock) path never
// calls this.
let FEP, FKEY;
async function chatAzure(messages, max_tokens, json) {
  const body = { messages, max_tokens, temperature: 0.1 };
  if (json) body.response_format = { type: 'json_object' };
  for (const host of [FEP, 'https://otchealth-foundry.cognitiveservices.azure.com']) {
    if (!host) continue;
    try {
      const r = await fetch(`${host}/openai/deployments/${MODEL_ID}/chat/completions?api-version=2024-10-21`, { method: 'POST', headers: { 'api-key': FKEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 429) { const ra = parseInt(r.headers.get('retry-after') || '0', 10); await sleep((ra > 0 ? ra * 1000 : 5000) + Math.floor(Math.random() * 1500)); return chatAzure(messages, max_tokens, json); }
      const j = await r.json();
      if (r.ok) return { text: j.choices?.[0]?.message?.content || '', usage: j.usage || {} };
      if (r.status !== 404) throw new Error('chat ' + r.status + ' ' + JSON.stringify(j).slice(0, 140));
    } catch (e) { if (!String(e).includes('404')) throw e; }
  }
  throw new Error('chat: no working endpoint');
}

// ---------- LLM adapter dispatch: the ONE place analyze()/visionSig() branch on provider ----------
// Both callers pass a Bedrock-shaped `userContent` ([{text},{image:{format,source:{bytes}}}, ...])
// plus the tool name/schema Bedrock needs; on the Azure history path this reshapes that into the old
// chat-completions message/content shape and reconstructs the SAME {obj, usage, stopReason} contract
// by JSON-parsing the raw text response, so analyze()/visionSig() never need a provider branch of
// their own.
async function callLlm({ systemBedrock, systemAzureFull, userContent, toolName, toolSchema, maxTokens, temperature }) {
  if (PROVIDER === 'bedrock') {
    return converseJson({ modelId: MODEL_ID, region: BEDROCK_REGION, system: systemBedrock, userContent, toolName, toolSchema, maxTokens, temperature });
  }
  const textContent = userContent.filter((b) => b && b.text).map((b) => b.text).join('\n');
  const images = userContent.filter((b) => b && b.image).map((b) => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + b.image.source.bytes, detail: 'high' } }));
  const content = images.length ? [{ type: 'text', text: textContent }, ...images] : textContent;
  const r = await chatAzure([{ role: 'system', content: systemAzureFull }, { role: 'user', content }], maxTokens, true);
  const obj = J(r.text);
  return { obj, usage: { prompt_tokens: r.usage.prompt_tokens || 0, completion_tokens: r.usage.completion_tokens || 0 }, stopReason: obj ? 'tool_use' : 'parse_or_filter_fail' };
}

// ---------- Azure Document Intelligence: AUTO RE-OCR for thin/garbled sidecars ----------
// Azure DI is permanently gone (same estate as everything else on subscription 55c84f6b). This
// function is kept only for the --storage-backend azure / re-OCR-off-by-default history path; its own
// `sm()` lookups resolve to null via the SSM->Key-Vault fleet chain when the Azure secrets do not
// exist, so leaving it in place costs nothing when DEEP_REOCR is unset (the default -- see the call
// site in analyze()). A genuinely thin scanned PDF now classifies as image/binary instead of being
// healed; a Bedrock-vision OCR fallback is a follow-up, not this port.
let DI_EP, DI_KEY;
async function docintel(buf, model) {
  if (DI_EP === undefined) { DI_EP = (await sm('azure-docintel-endpoint') || '').replace(/\/$/, ''); DI_KEY = await sm('azure-docintel-key') || ''; }
  if (!DI_EP || !DI_KEY) return null;
  const url = `${DI_EP}/documentintelligence/documentModels/${model || 'prebuilt-read'}:analyze?api-version=2024-11-30`;
  for (let a = 0; a < 4; a++) {
    const r = await fetch(url, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': DI_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ base64Source: buf.toString('base64') }) });
    if (r.status === 429) { await sleep(2000 * (a + 1)); continue; }
    if (r.status !== 202) throw new Error('DI ' + r.status + ' ' + (await r.text()).slice(0, 80));
    const op = r.headers.get('operation-location'); if (!op) throw new Error('DI no operation-location');
    for (let i = 0; i < 80; i++) { await sleep(1500); const g = await fetch(op, { headers: { 'Ocp-Apim-Subscription-Key': DI_KEY } }); if (!g.ok) continue; const j = await g.json(); if (j.status === 'succeeded') return j.analyzeResult?.content || ''; if (j.status === 'failed') throw new Error('DI failed'); }
    throw new Error('DI poll timeout');
  }
  throw new Error('DI 429 exhausted');
}

// ---------- prompts + schemas ----------
// AZURE history path: unchanged full-JSON-in-prompt text (json_object mode has no separate schema
// slot). BEDROCK path: short instruction prose (HARD RULES kept verbatim) + the equivalent JSON
// Schema expressed as a forced tool's inputSchema, per the design doc's C4.
const SUMSYS = `You are a meticulous legal+financial document analyst. Output ONLY a JSON object, no prose. Schema:
{"summary": a faithful 5-9 sentence decision-grade summary that QUOTES exact figures, all parties, effective/execution dates, key operative terms, obligations, conditions, and default/termination triggers; "title": concise canonical title (type + counterparty + principal, e.g. "8pct Convertible Note - Odyssey Capital - 100k"); "doc_type": short type; "counterparty": main other party or ""; "principal_amount": main amount or ""; "doc_date":"YYYY-MM-DD stated date or ''"; "key_terms":[up to 6 critical terms]; "materiality":"high|medium|low"; "requires_signature": true if this kind of document is only legally effective when signed (contracts, notes, agreements, consents, certifications, declarations) else false; "category":"best taxonomy guess"; "confidence":"high|medium|low"; "flags":[reasons it needs human/Claude review, e.g. "text too thin to trust","ambiguous type","conflicting dates","missing parties","does not fit any category"]}.
HARD RULES: Never invent a value to fill a field. If the extracted text is too thin or garbled to analyze faithfully, set confidence "low", flags ["text too thin to trust"], and leave the substantive fields empty. Flagging for review is ALWAYS better than fabricating. Do not produce a confident summary you are not sure of.`;

const SIGSYS = `You inspect the final page(s) image of a document to determine EXECUTION status. Output ONLY JSON. Schema:
{"has_signature": true if ANY signature line is actually filled (not blank); "wet_signature": true if a handwritten ink signature is present; "digital_signature": true if an electronic signature is present (DocuSign/Adobe Sign certificate block, "/s/", "Electronically signed by", a typed cursive e-signature, an envelope/transaction ID); "signature_method":"wet|digital|both|none|unclear"; "signatories":["Name (Title, Party)"]; "execution_date":"YYYY-MM-DD of the signature or ''"; "execution_status":"FULLY_EXECUTED|PARTIALLY_EXECUTED|UNSIGNED_DRAFT|NOT_APPLICABLE|CANNOT_DETERMINE"; "sig_confidence":"high|medium|low"}.
A line is SIGNED only if a mark/signature/typed-name sits on it; an empty line is BLANK. Never claim a signature on a blank line. If you cannot tell, set sig_confidence "low" and execution_status "CANNOT_DETERMINE".`;

const SUMSYS_PROSE = `You are a meticulous legal+financial document analyst. Call the emit_analysis tool exactly once with your analysis; do not respond with prose.
HARD RULES: Never invent a value to fill a field. If the extracted text is too thin or garbled to analyze faithfully, set confidence "low", flags ["text too thin to trust"], and leave the substantive fields empty. Flagging for review is ALWAYS better than fabricating. Do not produce a confident summary you are not sure of.`;

const SIGSYS_PROSE = `You inspect the final page(s) image of a document to determine EXECUTION status. Call the emit_signature tool exactly once with your determination; do not respond with prose.
A line is SIGNED only if a mark/signature/typed-name sits on it; an empty line is BLANK. Never claim a signature on a blank line. If you cannot tell, set sig_confidence "low" and execution_status "CANNOT_DETERMINE".`;

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'A faithful 5-9 sentence decision-grade summary that QUOTES exact figures, all parties, effective/execution dates, key operative terms, obligations, conditions, and default/termination triggers.' },
    title: { type: 'string', description: 'Concise canonical title (type + counterparty + principal), e.g. "8pct Convertible Note - Odyssey Capital - 100k".' },
    doc_type: { type: 'string', description: 'Short type.' },
    counterparty: { type: 'string', description: 'Main other party, or empty string.' },
    principal_amount: { type: 'string', description: 'Main amount, or empty string.' },
    doc_date: { type: 'string', description: 'YYYY-MM-DD stated date, or empty string.' },
    key_terms: { type: 'array', items: { type: 'string' }, description: 'Up to 6 critical terms.' },
    materiality: { type: 'string', enum: ['high', 'medium', 'low'] },
    requires_signature: { type: 'boolean', description: 'True if this kind of document is only legally effective when signed (contracts, notes, agreements, consents, certifications, declarations).' },
    category: { type: 'string', description: 'Best taxonomy guess.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    flags: { type: 'array', items: { type: 'string' }, description: 'Reasons this needs human/Claude review, e.g. "text too thin to trust", "ambiguous type", "conflicting dates", "missing parties", "does not fit any category".' },
  },
  required: ['summary', 'title', 'doc_type', 'materiality', 'requires_signature', 'confidence', 'flags'],
};

const SIGNATURE_SCHEMA = {
  type: 'object',
  properties: {
    has_signature: { type: 'boolean', description: 'True if ANY signature line is actually filled (not blank).' },
    wet_signature: { type: 'boolean', description: 'True if a handwritten ink signature is present.' },
    digital_signature: { type: 'boolean', description: 'True if an electronic signature is present (DocuSign/Adobe Sign certificate block, "/s/", "Electronically signed by", a typed cursive e-signature, an envelope/transaction ID).' },
    signature_method: { type: 'string', enum: ['wet', 'digital', 'both', 'none', 'unclear'] },
    signatories: { type: 'array', items: { type: 'string' }, description: 'e.g. "Name (Title, Party)".' },
    execution_date: { type: 'string', description: 'YYYY-MM-DD of the signature, or empty string.' },
    execution_status: { type: 'string', enum: ['FULLY_EXECUTED', 'PARTIALLY_EXECUTED', 'UNSIGNED_DRAFT', 'NOT_APPLICABLE', 'CANNOT_DETERMINE'] },
    sig_confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['has_signature', 'execution_status', 'sig_confidence'],
};

// ---------- per-model cost table (2026-08-28 port; C9). A loud fallback beats a wrong number ----------
// gpt-4.1 kept for the --llm-provider azure history path. Bedrock prices are UNVERIFIED LIVE -- see
// the file header's "VERIFY BEFORE A REAL BACKFILL" note.
const RATES = {
  'gpt-4.1': { in: 2.00, out: 8.00 },
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0': { in: 3.00, out: 15.00 },
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': { in: 1.00, out: 5.00 },
  'us.amazon.nova-pro-v1:0': { in: 0.80, out: 3.20 },
};
let _unknownRateWarned = false;
function estCost(tin, tout, modelId) {
  const r = RATES[modelId];
  if (!r) {
    if (!_unknownRateWarned) {
      _unknownRateWarned = true;
      console.error(`[deep-pass] WARN: no known $/token rate for model "${modelId}" -- cost figures below are $0 placeholders, NOT real estimates. Add a RATES entry before trusting a backfill's cost line.`);
    }
    return 0;
  }
  return (tin / 1e6) * r.in + (tout / 1e6) * r.out;
}

async function visionSig(pdfBuf) {
  const f = join(tmpdir(), 'dp' + crypto.randomBytes(6).toString('hex'));
  try {
    writeFileSync(f + '.pdf', pdfBuf);
    const pages = +((execFileSync('pdfinfo', [f + '.pdf']).toString().match(/Pages:\s+(\d+)/) || [])[1] || 1);
    execFileSync('pdftoppm', ['-png', '-r', '110', '-f', String(Math.max(1, pages - 1)), '-l', String(pages), f + '.pdf', f + 'p']);
    const pngs = readdirSync(tmpdir()).filter((n) => n.startsWith(basename(f) + 'p') && n.endsWith('.png')).sort().slice(-2).map((n) => readFileSync(join(tmpdir(), n)));
    if (!pngs.length) return { res: null, usage: {} };
    const content = [{ text: 'Final page(s) of the document. Determine execution status.' }];
    for (const p of pngs) content.push({ image: { format: 'png', source: { bytes: p.toString('base64') } } });
    let v;
    try {
      v = await callLlm({ systemBedrock: SIGSYS_PROSE, systemAzureFull: SIGSYS, userContent: content, toolName: 'emit_signature', toolSchema: SIGNATURE_SCHEMA, maxTokens: 500, temperature: 0.1 });
    } catch (e) {
      // TRANSPORT failure (verify pass REQUIRED FIX #2): a throttled/dead model mid-vision-call must
      // NOT degrade to CANNOT_DETERMINE, because CANNOT_DETERMINE feeds straight into the confidence
      // gate below (`sg.execution_status === 'CANNOT_DETERMINE'` -> a terminal review flag). A
      // throttle storm that lets small summary calls through but kills the larger image calls would
      // otherwise terminally flood every requires_signature row it touches -- the exact flood class
      // this whole port exists to close, just reached through the vision sub-call instead of the
      // summary call. Return callFailed so the CALLER fails the WHOLE row (retryable), not just the
      // signature sub-finding.
      return { callFailed: true, err: String(e.message).slice(0, 150) };
    }
    if (!v.obj) return { res: { execution_status: 'CANNOT_DETERMINE', sig_confidence: 'low' }, usage: v.usage };
    return { res: v.obj, usage: v.usage };
  } finally {
    for (const n of readdirSync(tmpdir()).filter((n) => n.startsWith(basename(f)))) { try { unlinkSync(join(tmpdir(), n)); } catch {} }
  }
}

/** Build the terminal "the model answered but gave nothing usable" patch (a CONTENT failure -- see
 *  analyze()'s two-tier taxonomy comment). Pure, exported for direct unit testing. */
export function contentFailPatch(stopReason) {
  return {
    summary_deep: '', title_deep: '', doc_type: '', confidence: 'low', requires_signature: false, non_text_asset: false,
    reocr: false, reocr_tried: true,
    deep_softerr: `no usable tool-call response (stopReason=${stopReason || 'unknown'})`,
    review: 'NEEDS_CLAUDE_REVIEW', review_reasons: ['summary model returned no usable analysis'],
  };
}

async function analyze(r) {
  let tin = 0, tout = 0;
  const sidecarBuf = await getBuf('_TEXT/' + r.path + '.txt');
  if (sidecarBuf == null) {
    // C6 (2026-08-28 port, S3-mirror-specific): `null` here means a genuine 404 (getBuf's contract),
    // distinct from an EMPTY-but-present sidecar. On a possibly-partial S3 mirror (the design doc's
    // section 0 flags the finance room's mirror as a REAL, not-yet-confirmed risk: ~21k observed keys
    // against a room recorded at 36,454 docs) this must NOT silently fall through to the non-text-asset
    // branch below and get mislabeled `image-pdf`/`binary` forever -- it must stay eligible and retry
    // once the mirror catches up. Non-terminal: no `deep`/`review` write at all.
    return { tin, tout, missingSidecar: true, noLlmCall: true };
  }
  let txt = sidecarBuf.toString('utf8');
  const ext = (r.ext || '').toLowerCase().replace(/^\./, '');
  let reocr = false;
  // AUTO RE-OCR: Azure Document Intelligence is permanently gone. Off by default (C7) -- a genuinely
  // thin scanned PDF now classifies as image/binary below instead of being healed. Set DEEP_REOCR=1
  // only if a working DI endpoint (or its eventual Bedrock-vision replacement) is actually wired.
  if (process.env.DEEP_REOCR === '1' && alnum(txt) < 60 && ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp'].includes(ext)) {
    try {
      const src = await getBuf(r.path);
      if (src) { const di = await docintel(src, 'prebuilt-layout'); if (di && alnum(di) >= 60) { txt = di; await putBuf('_TEXT/' + r.path + '.txt', Buffer.from(di, 'utf8'), 'text/plain; charset=utf-8'); reocr = true; } }
    } catch { /* still-thin -> flagged below */ }
  }
  if (alnum(txt) < 60) {
    // NON-TEXT ASSET: audio/video/archive/photo/image-pdf with no extractable text. Classify + catalog
    // them but do NOT flag for review (that is what was burying the queue pre-2026-08-13). No LLM call
    // is made on this path at all.
    const KIND = { mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', wma: 'audio', aiff: 'audio',
      mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', wmv: 'video', webm: 'video', m4v: 'video',
      zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', tgz: 'archive' };
    const kind = KIND[ext] || (['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'gif', 'heic', 'heif', 'webp'].includes(ext) ? 'image' : (ext === 'pdf' ? 'image-pdf' : 'binary'));
    return { tin, tout, noLlmCall: true, patch: {
      summary_deep: `Non-text ${kind} asset (no extractable text): ${basename(r.path)}.`,
      title_deep: basename(r.path), doc_type: kind === 'image-pdf' ? 'image (no text)' : kind,
      category: (kind === 'image' || kind === 'image-pdf') ? 'image/photo (no extractable text)' : `${kind} asset`,
      materiality: 'low', confidence: 'n/a', requires_signature: false, non_text_asset: true,
      reocr, reocr_tried: true, review: '', review_reasons: [],
    } };
  }
  let s;
  try {
    s = await callLlm({ systemBedrock: SUMSYS_PROSE, systemAzureFull: SUMSYS, userContent: [{ text: `Path: ${r.path}\nExtracted text:\n${txt.slice(0, MAXTEXT)}` }], toolName: 'emit_analysis', toolSchema: ANALYSIS_SCHEMA, maxTokens: 900, temperature: 0.1 });
  } catch (e) {
    // TRANSPORT FAILURE: the model was NEVER reached (network, auth, throttle-exhausted, region
    // misconfig). This is the two-tier taxonomy's first tier (the FND-20260821-783d fix). The row is
    // returned completely UNTOUCHED -- no deep, no review, no patch of any kind -- so selectTodo
    // re-selects it next run instead of this outage becoming a permanent, wrong terminal state.
    return { tin, tout, callFailed: true, err: String(e.message).slice(0, 200) };
  }
  tin += s.usage.prompt_tokens || 0; tout += s.usage.completion_tokens || 0;
  if (!s.obj) {
    // CONTENT FAILURE: the model answered but produced no usable tool call (a forced-tool refusal, or
    // truncation before the tool call closed). One maxTokens-bumped retry before declaring this
    // terminal, per the design doc's C5 -- a genuinely too-short cap is common on a dense document and
    // should not cost a permanent review flag when doubling the budget would have resolved it cleanly.
    if (s.stopReason === 'max_tokens') {
      try {
        const retry = await callLlm({ systemBedrock: SUMSYS_PROSE, systemAzureFull: SUMSYS, userContent: [{ text: `Path: ${r.path}\nExtracted text:\n${txt.slice(0, MAXTEXT)}` }], toolName: 'emit_analysis', toolSchema: ANALYSIS_SCHEMA, maxTokens: 1600, temperature: 0.1 });
        tin += retry.usage.prompt_tokens || 0; tout += retry.usage.completion_tokens || 0;
        if (retry.obj) { s = retry; } else { return { tin, tout, patch: contentFailPatch(retry.stopReason) }; }
      } catch (e) {
        return { tin, tout, callFailed: true, err: String(e.message).slice(0, 200) };
      }
    } else {
      return { tin, tout, patch: contentFailPatch(s.stopReason) };
    }
  }
  const m = s.obj || {};
  const patch = { summary_deep: m.summary || '', title_deep: m.title || '', doc_type: m.doc_type || '', counterparty: m.counterparty || '', principal: m.principal_amount || '', doc_date: m.doc_date || '', materiality: m.materiality || '', requires_signature: !!m.requires_signature, confidence: m.confidence || 'low', flags: m.flags || [] };
  let sg = null;
  if (m.requires_signature && (r.ext || '').toLowerCase() === 'pdf') {
    try {
      const pdf = await getBuf(r.path);
      if (pdf) {
        const v = await visionSig(pdf);
        if (v.callFailed) {
          // See visionSig()'s own comment: a transport-classed vision failure fails the WHOLE row
          // (discarding the already-good summary tokens above is the accepted cost of never risking
          // a terminal-but-wrong CANNOT_DETERMINE flood). Counts toward the aggregate FATAL/WARN gate
          // exactly like a summary-call transport failure.
          return { tin, tout, callFailed: true, err: 'vision: ' + v.err };
        }
        sg = v.res; tin += v.usage.prompt_tokens || 0; tout += v.usage.completion_tokens || 0;
      }
    } catch (e) {
      // A LOCAL failure inside the vision helper itself (pdftoppm/pdfinfo missing, a corrupt PDF) --
      // a genuine content-scoped problem, not a Bedrock outage. Keep the pre-existing degrade behavior
      // for THIS class only (distinct from visionSig()'s own callFailed branch above).
      sg = { execution_status: 'CANNOT_DETERMINE', sig_confidence: 'low', err: String(e.message).slice(0, 50) };
    }
    if (sg) Object.assign(patch, { has_signature: !!sg.has_signature, wet_signature: !!sg.wet_signature, digital_signature: !!sg.digital_signature, signature_method: sg.signature_method || '', signatories: sg.signatories || [], execution_date: sg.execution_date || '', execution_status: sg.execution_status || '', sig_confidence: sg.sig_confidence || '' });
  }
  const date = patch.execution_date || patch.doc_date || '';
  patch.proposed_name = (date ? date + '_' : 'UNDATED_') + slug(patch.title_deep || r.title || basename(r.path)) + '.' + (ext || 'pdf');
  patch.dedup_key = slug((patch.doc_type || '') + '|' + (patch.counterparty || '') + '|' + (patch.principal || '')).toLowerCase();
  patch.reocr = reocr;
  // reocr_tried = true unconditionally once a full LLM analysis pass has completed (see the original
  // 2026-08-13 bug-history comment this preserves the intent of): prevents an unbounded reselection
  // loop for a doc whose text already cleared the alnum(60) threshold but which the model still
  // flags e.g. ["text too thin to trust"] on identical, unchanging input.
  patch.reocr_tried = true;
  const reasons = [...(patch.flags || [])];
  if (patch.confidence === 'low') reasons.push('low summary confidence');
  if (!patch.title_deep && patch.confidence !== 'high') reasons.push('no title extracted');
  if (patch.requires_signature) {
    if (!sg || sg.sig_confidence === 'low' || sg.execution_status === 'CANNOT_DETERMINE') reasons.push('signature undetermined on a doc that requires one');
    else if (sg.execution_status === 'UNSIGNED_DRAFT' && patch.materiality === 'high') reasons.push('material document appears UNSIGNED');
    else if (sg.execution_status === 'PARTIALLY_EXECUTED') reasons.push('only partially executed');
    if (!date) reasons.push('signature-required doc with no execution date');
  }
  patch.review = reasons.length ? 'NEEDS_CLAUDE_REVIEW' : '';
  patch.review_reasons = reasons.length ? [...new Set(reasons)] : [];
  patch.non_text_asset = false;
  return { tin, tout, patch };
}

// ---------- catalog I/O ----------
const CATALOG = '_CATALOG/catalog.jsonl';
async function loadCatalog() { const b = await getBuf(CATALOG); if (!b) throw new Error('no catalog at ' + CONTAINER + '/' + CATALOG); return b.toString('utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
let flushing = false;
async function flush(rows) { if (flushing) return; flushing = true; try { await putBuf(CATALOG, Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8'), 'application/x-ndjson'); } finally { flushing = false; } }

// ---------- selection logic (pure, exported for regression testing -- see tests/deep-pass-loop.test.mjs) ----------
// KNOWN, TRACKED, EXPLICIT GAP (verify pass REQUIRED FIX #4, deliberately NOT fixed in this PR -- see
// the file header's "A KNOWN, EXPLICIT, NON-SILENT GAP" note): this filter is still the blanket
// `!path.startsWith("_")` pattern-match enrich.mjs's #463 fix replaced with isPipelineInternal()
// elsewhere in this pipeline. Left as-is here because this PR's scope is the storage/LLM-provider
// port and the flood-guard fix, and selectTodo/unresolved carry their own separately-pinned regression
// contract (tests/deep-pass-loop.test.mjs) this port must not disturb.
const REOCR_RE = /thin|re-?OCR/i;
const unresolved = (r) => (r.review_reasons || []).some((x) => REOCR_RE.test(x)) && !r.non_text_asset && !r.reocr && !r.reocr_tried;
function selectTodo(rows, { reindex = false, prefix = '', limit = 0 } = {}) {
  let todo = rows.filter((r) => r.path && !r.path.startsWith('_') && (reindex || !r.deep || unresolved(r)));
  if (prefix) todo = todo.filter((r) => (r.path || '').startsWith(prefix));
  if (limit) todo = todo.slice(0, limit);
  return todo;
}

/** Given the run's total attempted-and-answered LLM calls and how many of those were TRANSPORT
 *  failures, decide the process exit code. Deliberately "all failed", not "any failed": one
 *  unreachable document in a large room is worth a warning but not worth failing the batch, whereas a
 *  0% success rate is never anything but a broken dependency (mirrors enrich.mjs's #462 fix exactly).
 *  Pure, exported for direct unit testing. Returns 1 (fail) or undefined (leave exitCode alone). */
export function aggregateExitCode(llmCalls, llmFailed) {
  if (llmCalls > 0 && llmFailed === llmCalls) return 1;
  return undefined;
}

/**
 * Apply one analyze() result onto its catalog row, mutating `row` ONLY when the outcome is not a
 * transport failure. Returns `{ callFailed, noLlmCall, missingSidecar, flagged }` so the caller can
 * maintain its own run-level counters without re-deriving them from the row's post-mutation state
 * (which, for the callFailed case, is deliberately unchanged and therefore uninformative).
 *
 * THIS is the function that closes FND-20260821-783d's flood bug, factored out as a pure,
 * side-effect-contained (aside from the explicit `row` mutation) unit so its exact contract --
 * "callFailed leaves the row untouched" -- is directly testable without any network/S3/lock
 * machinery, mirroring this file's own established selectTodo/unresolved testing convention.
 */
export function applyAnalysisResult(row, result, modelId) {
  if (result.callFailed) {
    row.deep_call_err = result.err; // ephemeral diagnostic only; never read by selectTodo/unresolved
    return { callFailed: true, noLlmCall: false, missingSidecar: false, flagged: false };
  }
  if (result.missingSidecar) {
    return { callFailed: false, noLlmCall: true, missingSidecar: true, flagged: false };
  }
  const patch = result.patch || {};
  if (typeof row.summary === 'string' && row.summary && row.summary_mini == null) row.summary_mini = row.summary;
  if (patch.summary_deep) row.summary = patch.summary_deep;
  Object.assign(row, patch, { deep: true, deep_engine: modelId });
  delete row.deep_call_err;
  const flagged = row.review === 'NEEDS_CLAUDE_REVIEW';
  if (!flagged) { delete row.review; delete row.review_reasons; }
  return { callFailed: false, noLlmCall: !!result.noLlmCall, missingSidecar: false, flagged };
}

async function main() {
  // INPUT-SHAPE VALIDATION, deliberately INSIDE main(), never at module top level. Importing this
  // file (as every test in tests/deep-pass-loop.test.mjs and tests/deep-pass-flood-guard.test.mjs
  // does, for its pure exports) must NEVER be able to call process.exit() as a side effect of module
  // evaluation -- that is precisely the import-time-side-effect class of bug the CLI-entrypoint guard
  // at the bottom of this file exists to prevent for main() itself, and validation-with-exit at
  // top-level scope is the same hazard by another name: it doesn't even need main() to be CALLED, an
  // ordinary `import` is enough to trigger it. (Caught live during this port: STORAGE/PROVIDER
  // validation briefly lived at module scope here, and this sandbox's ambient
  // LLM_PROVIDER=openai -- set fleet-wide for an unrelated purpose -- caused the mere act of
  // `import`ing this file to call process.exit(2), which killed the ENTIRE node --test process and
  // took down every OTHER test file sharing that invocation, this file's own pre-existing
  // deep-pass-loop.test.mjs included.)
  if (STORAGE !== 'azure' && STORAGE !== 's3') { console.error(`--storage-backend must be "s3" or "azure" (got "${STORAGE}").`); process.exit(2); }
  if (PROVIDER !== 'bedrock' && PROVIDER !== 'azure') {
    console.error(`--llm-provider must be "bedrock" or "azure" (got "${PROVIDER}"). This is a STRUCTURAL ` +
      `boundary, not a preference: this room's content may be MNPI/attorney-privileged, and OpenAI-direct ` +
      `is deliberately NOT an option here -- Bedrock keeps the data inside our own AWS account. See ` +
      `otchealth-cto/CLAUDE.md's 2026-08-19 entry and FND-20260821-783d.`);
    process.exit(2);
  }
  // PRIVILEGED-ROOM HARD REFUSAL: checked next, before any lock/secret/network call. See
  // isLlmExcludedRoom()'s own comment for the reasoning; this is a policy boundary, not a
  // runtime/config error, and no flag combination routes around it.
  if (isLlmExcludedRoom(PROFILE, CONTAINER)) {
    console.error(`[deep-pass] REFUSED: ${ACCT}/${CONTAINER} is the attorney-privileged legal-personal ` +
      `room and is categorically excluded from ALL LLM enrichment (Bedrock included). This is a hard ` +
      `policy boundary, not a runtime error -- there is no --storage-backend, --account, or --llm-provider ` +
      `combination that routes around it. See isLlmExcludedRoom()'s comment in this file.`);
    process.exit(2);
  }
  if (STORAGE === 's3') {
    if (!s3LocationFor(ACCT, CONTAINER)) {
      console.error(`no S3 mirror mapping for ${ACCT}/${CONTAINER} (refusing to guess a bucket). Add a ` +
        `verified row to skills/kb-memory/s3-blob.mjs's MIRROR table, with the bucket taken from an ` +
        `OBSERVED S3 listing, before targeting this room on S3. --storage-backend azure is read-only ` +
        `inspection of pre-lockdown history in the meantime.`);
      process.exit(2);
    }
  } else {
    if (KEYSECRET) await requireSecrets([KEYSECRET]);
    AKEY = (KEYSECRET ? await sm(KEYSECRET) : null); if (!AKEY) { console.error('Missing storage key ' + KEYSECRET); process.exit(2); }
    SAS = buildSas();
  }
  if (PROVIDER === 'azure') {
    FEP = (await sm('azure-foundry-openai-endpoint') || '').replace(/\/$/, ''); FKEY = await sm('azure-foundry-key');
    if (!FKEY) { console.error('Missing azure-foundry-key'); process.exit(2); }
  }
  // Bedrock (the default) needs no secret lookup here: AWS credentials resolve inside
  // bedrock-client.mjs's awsCreds() call (ECS task role first), the SAME chain the S3 storage path
  // above already uses -- one consistent AWS credential story for the whole run.
  if (!(await acquireLock())) { console.error(`[deep-pass] another execution holds a fresh lock for ${CONTAINER}; exiting 0 (cron-safe, no double-run).`); return; }
  const rows = await loadCatalog();
  const todo = selectTodo(rows, { reindex: REINDEX, prefix: PREFIX, limit: LIMIT });
  console.error(`[deep-pass] profile=${PROFILE} ${ACCT}/${CONTAINER} | ${rows.length} catalog rows | ${todo.length} to process | storage=${STORAGE} provider=${PROVIDER} model=${MODEL_ID} conc=${CONC}${MAXMIN ? ` budget=${MAXMIN}m` : ''}`);
  let n = 0, since = 0, next = 0, flagged = 0, tin = 0, tout = 0, budgetHit = false;
  let llmCalls = 0, llmFailed = 0, firstErr = '', missingSidecarCount = 0;
  const start = Date.now();
  async function worker() {
    for (;;) {
      if (MAXMIN && (Date.now() - start) > MAXMIN * 60000) { budgetHit = true; return; }
      const i = next++; if (i >= todo.length) return;
      const r = todo[i];
      try {
        const res = await analyze(r);
        tin += res.tin || 0; tout += res.tout || 0;
        const applied = applyAnalysisResult(r, res, MODEL_ID);
        if (applied.callFailed) {
          llmCalls++; llmFailed++; if (!firstErr) firstErr = res.err;
        } else if (applied.missingSidecar) {
          missingSidecarCount++;
        } else if (!applied.noLlmCall) {
          llmCalls++;
          if (applied.flagged) flagged++;
        }
      } catch (e) {
        // A throw escaping analyze() itself (a bug, not a classified outcome) -- keep the original
        // fallback behavior: a non-terminal diagnostic field, no deep/review write, so the row is
        // simply re-examined next run rather than silently treated as either failure tier.
        r.deep_err = String(e.message).slice(0, 120);
      }
      n++; since++;
      if (since >= 100) {
        since = 0; await flush(rows); await refreshLock();
        console.error(`  ...${n}/${todo.length} (flagged ${flagged}; llm ${llmCalls - llmFailed}/${llmCalls} ok; $${estCost(tin, tout, MODEL_ID).toFixed(2)})`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  await flush(rows);
  // review queue (the CLO/CFO "job one" list) + dedup fields csv (for the sorter)
  const flaggedRows = rows.filter((r) => r.review === 'NEEDS_CLAUDE_REVIEW');
  const rq = ['path,category,confidence,reasons,proposed_name', ...flaggedRows.map((r) => [csv(r.path), csv(r.category), csv(r.confidence), csv((r.review_reasons || []).join('; ')), csv(r.proposed_name)].join(','))].join('\n');
  await putBuf('_REVIEW/review-queue.csv', Buffer.from(rq, 'utf8'), 'text/csv');
  const deepRows = rows.filter((r) => r.deep && !r.review);
  const df = ['path,dedup_key,doc_type,counterparty,principal,execution_date,signed,wet,digital,proposed_name', ...deepRows.map((r) => [csv(r.path), csv(r.dedup_key), csv(r.doc_type), csv(r.counterparty), csv(r.principal), csv(r.execution_date), csv(r.has_signature), csv(r.wet_signature), csv(r.digital_signature), csv(r.proposed_name)].join(','))].join('\n');
  await putBuf('_CATALOG/deep-fields.csv', Buffer.from(df, 'utf8'), 'text/csv');
  const cost = estCost(tin, tout, MODEL_ID);
  console.error(`[deep-pass] DONE${budgetHit ? ' (time budget hit - resumable, rerun for the tail)' : ''}: processed ${n}, flagged ${flagged} for Claude review, cost $${cost.toFixed(2)} (in ${tin} out ${tout}, model ${MODEL_ID}).`);
  console.error(`[deep-pass] review queue -> ${CONTAINER}/_REVIEW/review-queue.csv (${flaggedRows.length} docs) | dedup fields -> ${CONTAINER}/_CATALOG/deep-fields.csv`);
  if (missingSidecarCount > 0) {
    console.error(`[deep-pass] NOTE: ${missingSidecarCount} row(s) had no _TEXT sidecar on ${STORAGE === 's3' ? 'the S3 mirror' : 'storage'} (skipped, non-terminal, will retry next run -- see this file's C6/missingSidecar comment; a large count may mean a partial S3 mirror).`);
  }
  // AGGREGATE FATAL/WARN GATE (closes FND-20260821-783d, mirrors enrich.mjs's #462 fix exactly): a
  // scheduled job that cannot reach its model must go RED, not report "+N docs processed" with a
  // deceptive $0.00 cost line having deep-processed nothing.
  const exitCode = aggregateExitCode(llmCalls, llmFailed);
  if (exitCode) {
    console.error(`[deep-pass] FATAL: all ${llmCalls} LLM call(s) failed -- provider=${PROVIDER} model=${MODEL_ID} is unreachable, so nothing was actually deep-processed. First error: ${firstErr}`);
    process.exitCode = exitCode;
  } else if (llmFailed > 0) {
    console.error(`[deep-pass] WARN: ${llmFailed}/${llmCalls} LLM call(s) failed (transport); those rows were left untouched and will retry next run. First error: ${firstErr}`);
  }
  // On room completion, refresh the search layer so it serves the NEW summaries. Azure AI Search is
  // permanently gone (this call now fails loud+fast via indexer.mjs's own --search-backend azure
  // guard rather than a slow network timeout against a dead host -- see indexer.mjs's 2026-08-27
  // OpenSearch port); the surrounding try/catch keeps that failure non-fatal to THIS job, same as
  // before this port. A direct OpenSearch projection (the design doc's C10) is a tracked follow-up,
  // NOT built in this PR -- every completed room will print the WARN below every time until it lands;
  // that WARN is expected noise, not a new regression.
  const remaining = rows.filter((r) => r.path && !r.path.startsWith('_') && !r.deep).length;
  const deepCount = rows.filter((r) => r.deep).length;
  const reocrCount = rows.filter((r) => r.reocr).length;
  const nonText = rows.filter((r) => r.non_text_asset).length;
  const fp = `${deepCount}:${reocrCount}:${nonText}`;
  if (!budgetHit && deepCount > 0) {
    if (remaining) console.error(`[deep-pass] note: ${remaining} docs still non-deep (persistent errors); reindexing the rest anyway`);
    let last = ''; try { const b = await getBuf('_CATALOG/.deep-reindexed'); if (b) { const j = JSON.parse(b.toString('utf8')); last = j.fp != null ? j.fp : `${j.deepCount}:0`; } } catch {}
    if (fp !== last) {
      console.error(`[deep-pass] ROOM COMPLETE (${deepCount} deep, ${reocrCount} re-OCR'd) -> full AI Search re-index on the new summaries`);
      try {
        execFileSync('node', [join(HERE, 'indexer.mjs'), 'push-search', '--profile', PROFILE, '--azure', '--container', CONTAINER, '--azure-account', ACCT, '--key-secret', KEYSECRET, '--reindex'], { stdio: 'inherit', env: process.env });
        await putBuf('_CATALOG/.deep-reindexed', Buffer.from(JSON.stringify({ fp, deepCount, reocrCount, ts: Date.now() }), 'utf8'), 'application/json');
        console.error('[deep-pass] AI Search re-indexed on the new summaries. ROOM FULLY DONE.');
      } catch (e) { console.error('[deep-pass] WARN (expected until C10 lands, see this file\'s comment above): AI Search re-index failed: ' + String(e.message).slice(0, 200)); }
    } else { console.error(`[deep-pass] room complete (${deepCount} deep, ${reocrCount} re-OCR'd); AI Search already current.`); }
  }
  await releaseLock();
}

// CLI entrypoint guard: only run main() when this file is executed directly (`node deep-pass.mjs ...`),
// never when imported (e.g. by tests importing selectTodo/unresolved/isLlmExcludedRoom/
// applyAnalysisResult/aggregateExitCode/contentFailPatch for regression coverage) -- without this
// guard, importing the module would unconditionally kick off a real AWS-credentialed run.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[deep-pass] FATAL', e.message); process.exit(1); });
}

export { selectTodo, unresolved, REOCR_RE };

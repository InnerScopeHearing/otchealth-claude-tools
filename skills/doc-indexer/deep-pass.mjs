#!/usr/bin/env node
// deep-pass.mjs — HIGH-POWER re-summarization + signature/execution detection + confidence-gated
// outlier flagging for the legal + finance data rooms. The fix for botched gpt-4.1-mini summaries.
//
// For each catalogued doc it: reads the EXISTING _TEXT sidecar (no re-OCR), runs gpt-4.1 (strict
// JSON) for a rich, faithful, decision-grade summary + structured fields, runs a gpt-4.1 VISION
// pass on the final page(s) of signature-capable docs for the signature taxonomy (requires /
// present / WET / DIGITAL + signatories + execution date), composes a canonical filename
// (YYYY-MM-DD-of-execution_Title.ext) + a dedup key, and applies a CONFIDENCE GATE: anything it
// cannot confidently classify (thin text, ambiguous type, undetermined signature, missing fields)
// is flagged NEEDS_CLAUDE_REVIEW with reasons instead of guessing.
//
// Enriches _CATALOG/catalog.jsonl IN PLACE (keeps the old mini summary as summary_mini for audit).
// Writes _REVIEW/review-queue.csv (the "job one" list for the CLO/CFO) + _CATALOG/deep-fields.csv
// (for the later dedup/rename sorter). Resumable: skips rows already marked .deep unless --reindex.
// Bounded concurrency + soft time budget so it exits 0 ("Succeeded") having flushed, and the next
// run picks up the tail. Runs on Azure credits (gpt-4.1 on the Foundry resource). Non-PHI ring;
// legal `personal` container is privileged (run it with --container personal in its own lane).
//
// Usage: GCP_CLAUDE_DRIVER_SA_JSON=... node deep-pass.mjs --profile legal|finance
//          [--container company|personal|cfo-source-docs] [--account <acct>] [--key-secret <sm>]
//          [--limit N] [--reindex] [--concurrency 6] [--max-minutes 110] [--prefix p]

import crypto from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

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
const SUMMODEL = val('--model', 'gpt-4.1');
const MAXTEXT = 52000; // chars of sidecar fed to the summary model

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alnum = (s) => (String(s).match(/[A-Za-z0-9]/g) || []).length;
const slug = (s) => String(s || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72);
const J = (t) => { try { return JSON.parse(t); } catch { try { return JSON.parse(String(t).slice(String(t).indexOf('{'), String(t).lastIndexOf('}') + 1)); } catch { return null; } } };
const csv = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';

// ---------- GCP Secret Manager via the claude-driver SA ----------
const SA = JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON || readFileSync(process.env.HOME + '/.gcp_claude_driver_sa.json', 'utf8'));
function saJwt(scope) { const n = Math.floor(Date.now() / 1e3), e = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); const i = `${e({ alg: 'RS256', typ: 'JWT' })}.${e({ iss: SA.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: n, exp: n + 3600 })}`; return i + '.' + crypto.createSign('RSA-SHA256').update(i).sign(SA.private_key, 'base64url'); }
async function gTok(scope) { const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt(scope))}` }); return (await r.json()).access_token; }
async function sm(id) { const t = await gTok('https://www.googleapis.com/auth/cloud-platform'); const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/otchealth-shared-prod/secrets/${id}/versions/latest:access`, { headers: { Authorization: 'Bearer ' + t } }); return r.ok ? Buffer.from((await r.json()).payload.data, 'base64').toString('utf8').trim() : null; }

// ---------- Azure Blob (account SAS) ----------
let AKEY, SAS;
function buildSas() { const sv = '2021-12-02', sp = 'rwlc', ss = 'b', srt = 'co'; const st = new Date(Date.now() - 3e5).toISOString().slice(0, 19) + 'Z'; const se = new Date(Date.now() + 12 * 36e5).toISOString().slice(0, 19) + 'Z'; const sts = [ACCT, sp, ss, srt, st, se, '', 'https', sv, ''].join('\n') + '\n'; const sig = crypto.createHmac('sha256', Buffer.from(AKEY, 'base64')).update(sts, 'utf8').digest('base64'); return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: 'https', sig }).toString(); }
const enc = (n) => n.split('/').map(encodeURIComponent).join('/');
async function getBuf(n) { const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(n)}?${SAS}`); if (r.status === 404) return null; if (!r.ok) throw new Error('get ' + r.status); return Buffer.from(await r.arrayBuffer()); }
async function putBuf(n, buf, ct) { const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(n)}?${SAS}`, { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': ct || 'application/octet-stream' }, body: buf }); if (!r.ok) throw new Error('put ' + r.status + ' ' + (await r.text()).slice(0, 120)); }

// ---------- gpt-4.1 on the Foundry resource ----------
let FEP, FKEY;
async function chat(messages, max_tokens, json) {
  const body = { messages, max_tokens, temperature: 0.1 };
  if (json) body.response_format = { type: 'json_object' };
  for (const host of [FEP, 'https://otchealth-foundry.cognitiveservices.azure.com']) {
    if (!host) continue;
    try {
      const r = await fetch(`${host}/openai/deployments/${SUMMODEL}/chat/completions?api-version=2024-10-21`, { method: 'POST', headers: { 'api-key': FKEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 429) { const ra = parseInt(r.headers.get('retry-after') || '0', 10); await sleep((ra > 0 ? ra * 1000 : 5000) + Math.floor(Math.random() * 1500)); return chat(messages, max_tokens, json); }
      const j = await r.json();
      if (r.ok) return { text: j.choices?.[0]?.message?.content || '', usage: j.usage || {} };
      if (r.status !== 404) throw new Error('chat ' + r.status + ' ' + JSON.stringify(j).slice(0, 140));
    } catch (e) { if (!String(e).includes('404')) throw e; }
  }
  throw new Error('chat: no working endpoint');
}

const SUMSYS = `You are a meticulous legal+financial document analyst. Output ONLY a JSON object, no prose. Schema:
{"summary": a faithful 5-9 sentence decision-grade summary that QUOTES exact figures, all parties, effective/execution dates, key operative terms, obligations, conditions, and default/termination triggers; "title": concise canonical title (type + counterparty + principal, e.g. "8pct Convertible Note - Odyssey Capital - 100k"); "doc_type": short type; "counterparty": main other party or ""; "principal_amount": main amount or ""; "doc_date":"YYYY-MM-DD stated date or ''"; "key_terms":[up to 6 critical terms]; "materiality":"high|medium|low"; "requires_signature": true if this kind of document is only legally effective when signed (contracts, notes, agreements, consents, certifications, declarations) else false; "category":"best taxonomy guess"; "confidence":"high|medium|low"; "flags":[reasons it needs human/Claude review, e.g. "text too thin to trust","ambiguous type","conflicting dates","missing parties","does not fit any category"]}.
HARD RULES: Never invent a value to fill a field. If the extracted text is too thin or garbled to analyze faithfully, set confidence "low", flags ["text too thin to trust"], and leave the substantive fields empty. Flagging for review is ALWAYS better than fabricating. Do not produce a confident summary you are not sure of.`;

const SIGSYS = `You inspect the final page(s) image of a document to determine EXECUTION status. Output ONLY JSON. Schema:
{"has_signature": true if ANY signature line is actually filled (not blank); "wet_signature": true if a handwritten ink signature is present; "digital_signature": true if an electronic signature is present (DocuSign/Adobe Sign certificate block, "/s/", "Electronically signed by", a typed cursive e-signature, an envelope/transaction ID); "signature_method":"wet|digital|both|none|unclear"; "signatories":["Name (Title, Party)"]; "execution_date":"YYYY-MM-DD of the signature or ''"; "execution_status":"FULLY_EXECUTED|PARTIALLY_EXECUTED|UNSIGNED_DRAFT|NOT_APPLICABLE|CANNOT_DETERMINE"; "sig_confidence":"high|medium|low"}.
A line is SIGNED only if a mark/signature/typed-name sits on it; an empty line is BLANK. Never claim a signature on a blank line. If you cannot tell, set sig_confidence "low" and execution_status "CANNOT_DETERMINE".`;

async function visionSig(pdfBuf) {
  const f = join(tmpdir(), 'dp' + crypto.randomBytes(6).toString('hex'));
  try {
    writeFileSync(f + '.pdf', pdfBuf);
    const pages = +((execFileSync('pdfinfo', [f + '.pdf']).toString().match(/Pages:\s+(\d+)/) || [])[1] || 1);
    execFileSync('pdftoppm', ['-png', '-r', '110', '-f', String(Math.max(1, pages - 1)), '-l', String(pages), f + '.pdf', f + 'p']);
    const pngs = readdirSync(tmpdir()).filter((n) => n.startsWith(basename(f) + 'p') && n.endsWith('.png')).sort().slice(-2).map((n) => readFileSync(join(tmpdir(), n)));
    if (!pngs.length) return { res: null, usage: {} };
    const content = [{ type: 'text', text: 'Final page(s) of the document. Determine execution status.' }];
    for (const p of pngs) content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + p.toString('base64'), detail: 'high' } });
    const v = await chat([{ role: 'system', content: SIGSYS }, { role: 'user', content }], 320, true);
    return { res: J(v.text), usage: v.usage };
  } finally {
    for (const n of readdirSync(tmpdir()).filter((n) => n.startsWith(basename(f)))) { try { unlinkSync(join(tmpdir(), n)); } catch {} }
  }
}

async function analyze(r) {
  let tin = 0, tout = 0;
  const txt = (await getBuf('_TEXT/' + r.path + '.txt'))?.toString('utf8') || '';
  if (alnum(txt) < 60) {
    return { tin, tout, patch: { confidence: 'low', review: 'NEEDS_CLAUDE_REVIEW', review_reasons: ['extracted text too thin/empty - re-OCR then Claude review'], summary_deep: '' } };
  }
  const s = await chat([{ role: 'system', content: SUMSYS }, { role: 'user', content: `Path: ${r.path}\nExtracted text:\n${txt.slice(0, MAXTEXT)}` }], 750, true);
  tin += s.usage.prompt_tokens || 0; tout += s.usage.completion_tokens || 0;
  const m = J(s.text) || { flags: ['summary JSON parse failed'], confidence: 'low' };
  const patch = { summary_deep: m.summary || '', title_deep: m.title || '', doc_type: m.doc_type || '', counterparty: m.counterparty || '', principal: m.principal_amount || '', doc_date: m.doc_date || '', materiality: m.materiality || '', requires_signature: !!m.requires_signature, confidence: m.confidence || 'low', flags: m.flags || [] };
  let sg = null;
  if (m.requires_signature && (r.ext || '').toLowerCase() === 'pdf') {
    try { const pdf = await getBuf(r.path); if (pdf) { const v = await visionSig(pdf); sg = v.res; tin += v.usage.prompt_tokens || 0; tout += v.usage.completion_tokens || 0; } }
    catch (e) { sg = { execution_status: 'CANNOT_DETERMINE', sig_confidence: 'low', err: String(e.message).slice(0, 50) }; }
    if (sg) Object.assign(patch, { has_signature: !!sg.has_signature, wet_signature: !!sg.wet_signature, digital_signature: !!sg.digital_signature, signature_method: sg.signature_method || '', signatories: sg.signatories || [], execution_date: sg.execution_date || '', execution_status: sg.execution_status || '', sig_confidence: sg.sig_confidence || '' });
  }
  const ext = r.ext || 'pdf';
  const date = patch.execution_date || patch.doc_date || '';
  patch.proposed_name = (date ? date + '_' : 'UNDATED_') + slug(patch.title_deep || r.title || basename(r.path)) + '.' + ext;
  patch.dedup_key = slug((patch.doc_type || '') + '|' + (patch.counterparty || '') + '|' + (patch.principal || '')).toLowerCase();
  // confidence gate
  const reasons = [...(patch.flags || [])];
  if (patch.confidence === 'low') reasons.push('low summary confidence');
  if (!patch.title_deep) reasons.push('no title extracted');
  if (patch.requires_signature && (!sg || sg.sig_confidence === 'low' || sg.execution_status === 'CANNOT_DETERMINE')) reasons.push('signature could not be determined on a doc that requires one');
  if (!date) reasons.push('no execution/doc date');
  if (reasons.length) { patch.review = 'NEEDS_CLAUDE_REVIEW'; patch.review_reasons = [...new Set(reasons)]; }
  return { tin, tout, patch };
}

// ---------- catalog I/O ----------
const CATALOG = '_CATALOG/catalog.jsonl';
async function loadCatalog() { const b = await getBuf(CATALOG); if (!b) throw new Error('no catalog at ' + CONTAINER + '/' + CATALOG); return b.toString('utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
let flushing = false;
async function flush(rows) { if (flushing) return; flushing = true; try { await putBuf(CATALOG, Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8'), 'application/x-ndjson'); } finally { flushing = false; } }

async function main() {
  if (!SA) { console.error('Missing GCP_CLAUDE_DRIVER_SA_JSON / SA file'); process.exit(2); }
  AKEY = (KEYSECRET ? await sm(KEYSECRET) : null); if (!AKEY) { console.error('Missing storage key ' + KEYSECRET); process.exit(2); }
  SAS = buildSas();
  FEP = (await sm('azure-foundry-openai-endpoint') || '').replace(/\/$/, ''); FKEY = await sm('azure-foundry-key');
  if (!FKEY) { console.error('Missing azure-foundry-key'); process.exit(2); }
  const rows = await loadCatalog();
  let todo = rows.filter((r) => r.path && !r.path.startsWith('_') && (REINDEX || !r.deep));
  if (PREFIX) todo = todo.filter((r) => (r.path || '').startsWith(PREFIX));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  console.error(`[deep-pass] profile=${PROFILE} ${ACCT}/${CONTAINER} | ${rows.length} catalog rows | ${todo.length} to process | model=${SUMMODEL} conc=${CONC}${MAXMIN ? ` budget=${MAXMIN}m` : ''}`);
  let n = 0, since = 0, next = 0, flagged = 0, tin = 0, tout = 0, budgetHit = false;
  const start = Date.now();
  async function worker() {
    for (;;) {
      if (MAXMIN && (Date.now() - start) > MAXMIN * 60000) { budgetHit = true; return; }
      const i = next++; if (i >= todo.length) return;
      const r = todo[i];
      try {
        const { tin: a, tout: b, patch } = await analyze(r);
        tin += a; tout += b;
        if (typeof r.summary === 'string' && r.summary && r.summary_mini == null) r.summary_mini = r.summary; // preserve old mini summary for audit
        if (patch.summary_deep) r.summary = patch.summary_deep; // promote the rich summary to the read field
        Object.assign(r, patch, { deep: true, deep_engine: SUMMODEL });
        if (r.review) flagged++;
      } catch (e) { r.deep_err = String(e.message).slice(0, 120); }
      n++; since++;
      if (since >= 100) { since = 0; await flush(rows); console.error(`  ...${n}/${todo.length} (flagged ${flagged}; $${(tin / 1e6 * 2 + tout / 1e6 * 8).toFixed(2)})`); }
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
  const cost = tin / 1e6 * 2 + tout / 1e6 * 8;
  console.error(`[deep-pass] DONE${budgetHit ? ' (time budget hit - resumable, rerun for the tail)' : ''}: processed ${n}, flagged ${flagged} for Claude review, cost $${cost.toFixed(2)} (in ${tin} out ${tout}).`);
  console.error(`[deep-pass] review queue -> ${CONTAINER}/_REVIEW/review-queue.csv (${flaggedRows.length} docs) | dedup fields -> ${CONTAINER}/_CATALOG/deep-fields.csv`);
}
main().catch((e) => { console.error('[deep-pass] FATAL', e.message); process.exit(1); });

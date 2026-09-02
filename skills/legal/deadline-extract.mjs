#!/usr/bin/env node
// deadline-extract.mjs — proposes CANDIDATE deadline dates from a legal document's TEXT for CLO
// confirmation. `extract` NEVER writes to a matter's docket; it only prints candidates
// (source:'extracted', verified:false). A separate `confirm` step (a human decision) adds ONE
// chosen candidate to the docket via legal.mjs's shared docketAdd(), so the docket-row schema
// stays single-sourced in legal.mjs (see that file's header comment for the full schema).
//
// INPUT: this script takes TEXT, not a raw PDF/image. Produce the text first via the existing
// OCR/pdf extraction path: doc-indexer (--profile legal) writes a `_TEXT/<path>.txt` sidecar
// alongside every document it indexes in the legal Blob store. Pipe that sidecar in, or pass
// --file/--text directly. Keeping this decoupled from doc-indexer's heavier Azure/OCR machinery
// keeps it fixture-testable offline, and keeps "who owns Azure Blob access" singular (legal.mjs).
//
// DATE PARSING IS DETERMINISTIC (regex + real calendar-date validation), never an LLM: a
// fabricated or misread date is exactly the failure mode a CLO cannot afford, and legal.mjs's
// whole design point is "never let a fabricated citation/date reach a document." An LLM is used
// ONLY, optionally, to rewrite a candidate's surrounding-text context into a short human label
// (--label-llm); it NEVER invents or adjusts the date itself, and it fails open (leaves the
// deterministic context untouched) on any error or missing credentials. Per the fleet's
// model-routing ban (setup/model-routing.mjs), the label call ALWAYS uses TIERS.standard (gpt-4.1
// on the Foundry resource, primary as of 2026-08-01) and NEVER gpt-4.1-mini (TIERS.cheap is banned
// for quality/summarization work).
//
// Usage:
//   node deadline-extract.mjs extract --file <sidecar.txt> [--matter <id>] [--personal] [--json] [--label-llm]
//   node deadline-extract.mjs extract --text "<...>" [--json]
//   cat _TEXT/some-filing.txt | node deadline-extract.mjs extract [--json]
//   node deadline-extract.mjs confirm <matter-id> --date <YYYY-MM-DD> --what "<text>" [--personal]

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { TIERS, chatBody } from "../../setup/model-routing.mjs";
import { logPrefixForText } from "../../setup/prompt-shape.mjs";
import { docketAdd, ensureStore } from "./legal.mjs";

const MONTHS = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
const MONTH_NUM = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const monthNum = (name) => MONTH_NUM[String(name).slice(0, 3).toLowerCase()];

// A real calendar date (rejects 2026-02-30, month 13, etc.) round-tripped through Date.UTC.
// Returns the normalized YYYY-MM-DD string, or null if not a real date.
function validDate(y, m, d) {
  if (!(y >= 1000 && y <= 9999) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
// 2-digit year pivot: 00-79 -> 20xx, 80-99 -> 19xx (matches common court-form conventions).
function pivotYear(yy) { const n = parseInt(yy, 10); return yy.length === 4 ? n : (n <= 79 ? 2000 + n : 1900 + n); }
function collapseWs(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

// Deadline-indicating phrases. A date found nearby gets confidence 'high' (the matched keyword
// is surfaced so the CLO sees WHY it was flagged); otherwise 'low' (still surfaced -- a bare date
// in a legal document is worth a human glance, e.g. a document date or an incorporation date, just
// less confidently an actual deadline).
const KEYWORDS = [
  "no later than", "not later than", "on or before", "due by", "due on", "deadline",
  "response due", "answer due", "opposition due", "reply due", "reply brief due",
  "file by", "filed by", "must be filed", "must file", "must respond", "must answer",
  "serve by", "service of", "hearing", "trial date", "trial is set", "status conference",
  "case management conference", "deposition", "discovery cutoff", "discovery closes",
  "motion cutoff", "expires", "expiration", "statute of limitations", "mediation",
  "arbitration", "notice of appeal", "appeal must", "cure period", "grace period",
  "within 10 days", "within 20 days", "within 30 days",
];
const KEYWORD_RE = new RegExp(KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");

// Find every raw date-shaped match in `text`. Filters out anything that is not a real calendar
// date (so "13/45/2026" or "February 30, 2026" never becomes a candidate).
function rawDateMatches(text) {
  const out = [];
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) // ISO: 2026-07-15
    out.push({ start: m.index, end: m.index + m[0].length, date: validDate(+m[1], +m[2], +m[3]) });
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/g)) // US slash: 7/15/2026 or 07/15/26
    out.push({ start: m.index, end: m.index + m[0].length, date: validDate(pivotYear(m[3]), +m[1], +m[2]) });
  for (const m of text.matchAll(new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "gi"))) // "July 15, 2026"
    out.push({ start: m.index, end: m.index + m[0].length, date: validDate(+m[3], monthNum(m[1]), +m[2]) });
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS})\\.?,?\\s+(\\d{4})\\b`, "gi"))) // "15 July 2026"
    out.push({ start: m.index, end: m.index + m[0].length, date: validDate(+m[3], monthNum(m[2]), +m[1]) });
  return out.filter((m) => m.date);
}

// Line containing [start,end) (delimited by \n on either side; clamped to the text bounds).
function lineBounds(text, start, end) {
  const lineStart = text.lastIndexOf("\n", start) + 1; // -1+1 = 0 when there is no preceding \n
  const nl = text.indexOf("\n", end);
  return { lineStart, lineEnd: nl === -1 ? text.length : nl };
}

// The pure, offline, fixture-testable core: text -> candidate deadlines. Has NO import of
// legal.mjs's write path (docketAdd/putBlob/etc.) -- structurally it cannot commit anything.
// `contextChars` sizes the human-readable `what` window (may span multiple lines, for
// readability). Keyword detection is scoped to the LINE containing the date, not a fixed
// character radius: legal orders/notices are typically one item per line, and a fixed radius
// falsely attaches a neighboring line's keyword to this date (a genuine failure mode observed
// on dense, short-line text). A date-only line (e.g. a table row) also checks the previous line,
// so a "Discovery Cutoff:" label on its own line above a date-only line still attaches.
export function extractCandidates(text, { contextChars = 100, source = "extracted", maxWhat = 400 } = {}) {
  const t = String(text || "");
  const matches = rawDateMatches(t).sort((a, b) => a.start - b.start);
  const candidates = [];
  let prev = null;
  for (const m of matches) {
    // Collapse near-duplicate matches of the SAME date caught by more than one pattern at
    // (almost) the same spot (e.g. an ISO date immediately followed by its long-form restatement
    // in parens). Two genuinely separate mentions of the same date elsewhere in the document are
    // NOT collapsed (only spans within 30 chars of the previous accepted match are).
    if (prev && prev.date === m.date && m.start - prev.end < 30) continue;
    prev = m;
    const what = collapseWs(t.slice(Math.max(0, m.start - contextChars), Math.min(t.length, m.end + contextChars))).slice(0, maxWhat);
    const { lineStart, lineEnd } = lineBounds(t, m.start, m.end);
    let kwWindow = t.slice(lineStart, lineEnd);
    if (collapseWs(kwWindow).length <= 15 && lineStart > 0) { // date-only line -> also check the line above (label-then-date tables)
      const prevLineEnd = lineStart - 1; // the \n separating the previous line from this one
      const prevLineStart = t.lastIndexOf("\n", prevLineEnd - 1) + 1; // search strictly BEFORE that \n
      kwWindow = t.slice(Math.max(0, prevLineStart), prevLineEnd) + " " + kwWindow;
    }
    const kw = collapseWs(kwWindow).match(KEYWORD_RE);
    candidates.push({
      date: m.date,
      what,
      matchText: t.slice(m.start, m.end).trim(),
      keyword: kw ? kw[0] : null,
      confidence: kw ? "high" : "low",
      source,
      verified: false,
    });
  }
  return candidates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---- optional LLM context labeling (never touches the date; fails open) ----
async function defaultChat(system, user) {
  // Foundry FIRST (TIERS.standard.deployment = gpt-4.1 lives there, 2,000K TPM); the legacy resource
  // is checked only as a fallback if the Foundry secrets are somehow unavailable. Note: if that
  // fallback DOES resolve, TIERS.standard.deployment ('gpt-4.1') does not exist on the legacy resource
  // and the call below would 404 - but `!r.ok` already fails open into `return null` (no label, the
  // deterministic `what` stands), so that edge case is harmless here, unlike the multi-provider
  // detectors (contradiction-staleness.mjs/groundedness.mjs) which retry against the fallback's real
  // model name instead of just giving up.
  const ep = ((await kvSecret("azure-foundry-openai-endpoint")) || (await kvSecret("azure-openai-endpoint")) || "").replace(/\/$/, "");
  const key = (await kvSecret("azure-foundry-key")) || (await kvSecret("azure-openai-key"));
  if (!ep || !key) return null; // no creds -> fail open, deterministic context stands
  const dep = TIERS.standard.deployment; // gpt-4.1 on Foundry. NEVER TIERS.cheap (gpt-4.1-mini banned for quality work).
  // Prompt-caching hygiene (2026-09-02): LABEL_SYSTEM (this file's only caller) is fully static and
  // already sent first, with the per-candidate date/context text last -- already cache-friendly order,
  // observability only. NOTE (not fixed here, out of this PR's scope): this call still targets Azure
  // Foundry, which returns HTTP 401 forever since the Azure estate's permanent deletion (see
  // otchealth-cto/CLAUDE.md's 2026-08-27 correction) -- unlike the six FND-20260819-c9bb callers, this
  // one was never ported to OpenAI-direct, so it is NOT one of this sweep's "nightly OpenAI-direct
  // jobs" and gets no batch/EVAL_JUDGE treatment; it fails open (returns null, the deterministic `what`
  // stands) rather than crashing, so this is a discovered-but-dark gap, not a live incident.
  logPrefixForText("legal-deadline-extract", system);
  const body = chatBody(dep, { messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens: 60, temperature: 0.1 });
  const r = await fetch(`${ep}/openai/deployments/${dep}/chat/completions?api-version=2024-06-01`, { method: "POST", headers: { "api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j?.choices?.[0]?.message?.content?.trim() || null;
}
const LABEL_SYSTEM = "You are a legal-docket assistant. Given the raw surrounding text of a date found in a legal document, write ONE short label (8 words or fewer) describing what the deadline IS (for example: 'Response to motion due', 'Case management conference', 'Discovery cutoff'). Output ONLY the label: no punctuation at the end, no quotes, no preamble. If the text does not actually describe a deadline or dated event, output exactly: UNCLEAR. Never invent a date or fact that is not present in the given text.";
// `chatFn` is injectable for tests (never hits the network in a test); production defaults to
// ONE best-effort TIERS.standard (gpt-4.1) call per candidate, bounded to `limit` candidates (remaining candidates
// beyond the bound keep their deterministic `what` untouched, to cap cost/latency on a big
// document). Per-candidate errors are caught so one bad call never drops the rest of the batch;
// the deterministic `what` is always preserved as `context` when a label replaces it.
export async function labelWithLLM(candidates, { chatFn = defaultChat, limit = 20 } = {}) {
  const out = [];
  let attempted = 0;
  for (const c of candidates) {
    if (attempted >= limit) { out.push(c); continue; }
    attempted++;
    try {
      const label = await chatFn(LABEL_SYSTEM, `Date: ${c.date}\nSurrounding text: ${c.what}`);
      out.push(label && label !== "UNCLEAR" ? { ...c, what: label, context: c.what } : c);
    } catch {
      out.push(c);
    }
  }
  return out;
}

// ---- CLI ----
const flagVal = (argv, name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
function readStdin() {
  if (process.stdin.isTTY) return ""; // avoid hanging when nothing is piped in
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const personal = argv.includes("--personal");
  const NS = personal ? "personal" : "company";
  try {
    if (cmd === "extract") {
      const file = flagVal(argv, "file");
      const inline = flagVal(argv, "text");
      const text = file ? readFileSync(file, "utf8") : (inline !== undefined ? inline : readStdin());
      if (!text || !text.trim()) { console.error('usage: deadline-extract.mjs extract (--file <path> | --text "<...>" | stdin) [--matter <id>] [--personal] [--json] [--label-llm]'); process.exit(2); }
      let candidates = extractCandidates(text);
      if (argv.includes("--label-llm")) candidates = await labelWithLLM(candidates);
      const matterId = flagVal(argv, "matter");
      if (argv.includes("--json")) {
        console.log(JSON.stringify(candidates, null, 2));
      } else {
        console.log(`${candidates.length} candidate deadline(s)${matterId ? " for " + NS + "/" + matterId : ""} -- NOT committed; review then run 'confirm' to add one:`);
        for (const c of candidates) console.log(`  [${c.confidence}] ${c.date}  ${c.what}${c.keyword ? `  (keyword: "${c.keyword}")` : ""}`);
        if (candidates.length && matterId) console.log(`\nconfirm one: node deadline-extract.mjs confirm ${matterId} --date <date> --what "<text>"${personal ? " --personal" : ""}`);
      }

    } else if (cmd === "confirm") {
      const id = argv[1];
      const date = flagVal(argv, "date");
      const what = flagVal(argv, "what");
      if (!id || !date || !what) { console.error('usage: deadline-extract.mjs confirm <matter-id> --date <YYYY-MM-DD> --what "<text>" [--personal]'); process.exit(2); }
      ensureStore();
      const row = await docketAdd(NS, id, { date, what, source: "extracted", verified: true });
      console.log(`confirmed + docketed ${row.date} "${row.what}" on ${NS}/${id} [extracted, verified]`);

    } else {
      console.error('commands: extract (--file <path> | --text "<...>" | stdin) [--matter <id>] [--personal] [--json] [--label-llm] | confirm <matter-id> --date <date> --what "<text>" [--personal]');
      process.exit(2);
    }
  } catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) { await main(); }

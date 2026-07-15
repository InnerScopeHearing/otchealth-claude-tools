// kb-memory / dedupe.mjs, pure dependency-free write-time advisory helpers.
//
// The ledger is append-only and dedup today is only a soft LLM instruction in the reflect /
// librarian prompts, so a live `mem.mjs remember|fact|decision` call has no guard against piling up
// near-identical rows (which dilute keyword ranking in pack/recall) or against silently stating a
// CHANGED value as a fresh fact (leaving two active, disagreeing rows instead of a correction).
//
// These helpers are ADVISORY ONLY. They never block or mutate a write. `writeAdvisory` prints a hint
// to stderr so the operator/agent can choose to `correct --was ... --supersedes <id>` instead of
// creating a duplicate. All functions are pure and IO-free (writeAdvisory only writes to stderr).

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "is", "are", "was",
  "were", "be", "been", "being", "it", "its", "this", "that", "these", "those", "with", "as", "by",
  "we", "our", "us", "i", "you", "he", "she", "they", "them", "has", "have", "had", "do", "does",
  "did", "will", "now", "not", "no", "yes", "from", "into", "per", "via", "so", "if", "then",
]);

// Tokenize to a Set of meaningful lowercased word tokens (drops stopwords + 1-char tokens).
export function tokenize(s) {
  const out = new Set();
  for (const t of String(s || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length > 1 && !STOP.has(t)) out.add(t);
  }
  return out;
}

// Jaccard similarity of two token Sets: |intersection| / |union|. 0 when either is empty.
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// Numeric/value tokens (numbers, money, percentages, versions) present in a string.
function valueTokens(s) {
  const out = new Set();
  for (const m of String(s || "").matchAll(/\$?\d[\d,.:kmx/%-]*\b/g)) out.add(m[0].replace(/[,$]/g, ""));
  return out;
}

// Rows still "active": exclude any row that a later row supersedes, and match the same type only.
function activeRowsOfType(rows, type) {
  const superseded = new Set((rows || []).map((r) => r && r.supersedes).filter(Boolean));
  return (rows || []).filter((r) => r && r.type === type && r.id && !superseded.has(r.id) && r.text);
}

// Highest-similarity prior row of the same type. Returns { id, score, text } or null.
export function nearDuplicate(text, rows, { type = "fact", threshold = 0.8 } = {}) {
  const q = tokenize(text);
  if (!q.size) return null;
  let best = null;
  for (const r of activeRowsOfType(rows, type)) {
    const score = jaccard(q, tokenize(r.text));
    if (score >= threshold && (!best || score > best.score)) best = { id: r.id, score, text: r.text };
  }
  return best;
}

// Same-subject, different-value: a prior active row whose NON-numeric wording strongly overlaps but
// whose numeric/value tokens differ, which usually means a value changed and should be a correction,
// not a new fact. Conservative (high textual overlap required) to keep false positives low.
export function possibleContradiction(text, rows, { type = "fact", subjectThreshold = 0.6 } = {}) {
  const qWords = tokenize(text);
  const qVals = valueTokens(text);
  if (!qWords.size || !qVals.size) return null;
  for (const r of activeRowsOfType(rows, type)) {
    const rVals = valueTokens(r.text);
    if (!rVals.size) continue;
    const subjectSim = jaccard(qWords, tokenize(r.text));
    const valsDiffer = [...qVals].some((v) => !rVals.has(v)) || [...rVals].some((v) => !qVals.has(v));
    if (subjectSim >= subjectThreshold && valsDiffer) {
      return { id: r.id, subjectSim, text: r.text };
    }
  }
  return null;
}

// Non-blocking advisory printed to stderr. Never throws. Returns the advisory string (or "").
export function writeAdvisory(text, rows, type = "fact", log = (m) => process.stderr.write(m + "\n")) {
  try {
    const contra = possibleContradiction(text, rows, { type });
    if (contra) {
      const msg = `[kb-memory] advisory: this looks like a CHANGED value vs an existing ${type} (${contra.id}). Consider a correction:\n  mem.mjs correct "${String(text).slice(0, 80)}" --was "<old value>" --supersedes ${contra.id}\n  existing: "${String(contra.text).slice(0, 100)}"`;
      log(msg);
      return msg;
    }
    const dup = nearDuplicate(text, rows, { type });
    if (dup) {
      const msg = `[kb-memory] advisory: near-duplicate of ${dup.id} (similarity ${(dup.score * 100).toFixed(0)}%). If this supersedes it, use --supersedes ${dup.id} instead of a new row.\n  existing: "${String(dup.text).slice(0, 100)}"`;
      log(msg);
      return msg;
    }
  } catch {
    // advisory must never affect the write path
  }
  return "";
}

// ============================ RING / PRIVILEGE WALL (shared, cross-file) ============================
// The ONE fleet-wide MNPI/PHI content wall, kept BYTE-IDENTICAL to kb-memory/mem.mjs's own RING_DENY
// (used for read-side cross-agent recall, mem.mjs:233) and company-brain/brain.mjs's RING_DENY (used
// for diff-mode cross-lane reads, brain.mjs:170). Defined ONCE here (dedupe.mjs is pure, side-effect
// free, and already imported by both mem.mjs's siblings and every other kb-memory script) so an
// automated CROSS-lane process -- contradiction-scan.mjs's cross-agent comparison, nightly-reflection's
// --share output path -- can hard-exclude privileged/MNPI/PHI content instead of relying on an LLM
// prompt's soft instruction not to leak it. Can only ever REFUSE, never widen; never delete/redact
// content in place, only decide whether a row is safe to read/compare/publish CROSS-lane.
//
// If a fourth copy of this regex is ever needed, import it from here instead of retyping it; the three
// existing copies (mem.mjs, brain.mjs, and this one) must never be allowed to drift apart. As of the
// adversarial-review hardening pass below, mem.mjs and brain.mjs no longer hold their own literal copy
// at all: they IMPORT this constant, so there is exactly ONE place the pattern can drift.
//
// ADVERSARIAL-REVIEW HARDENING (vocabulary gap closed): the original pattern matched the bare ticker
// "innd" but never the company's actual name "innerscope", and had a broken "inscope hearing" fragment
// (missing the "n") that never matched anything. It also carried ZERO personal-legal vocabulary, so
// clo-personal content that got mistagged under any other agent (e.g. the legitimate "clo" company-legal
// lane) had no content-level backstop at all, only the agent-tag check. Both gaps are closed below by
// widening the vocabulary, never by changing how the wall is applied. Two deliberate scoping calls, so
// the wall stays precise instead of nuking unrelated legitimate content in THIS fleet's own vocabulary:
//   - "raise" is NOT added bare (it would trip on "raise a PR" / "raise an issue", constant developer
//     language); only specific capital-raise phrasings are matched.
//   - "settlement" is NOT added bare (Flatstick's whole product is a "debt-minimized settlement engine",
//     see flatstick/CLAUDE.md; a bare match would ring-deny nearly every Flatstick engineering note).
//     Only the personal-legal phrasings (settlement offer/agreement/talks/conference/negotiation) match.
//   - "litigation" is NOT added bare either, for the same reason: the CLO agent's OWN non-personal
//     docket includes company litigation (an FLSA employment matter; see dream-team/agents/clo.md
//     section E, "company is defendant") that must stay readable in the clo lane. Only "civil case" /
//     "civil litigation" match, which is how this company's own docs frame Matt's PERSONAL matter
//     (dream-team/agents/clo.md section D, "California civil litigation (Matt, personal)").
// "insolven\w*" (not a bare "insolven" fragment) is deliberate too: the whole pattern is wrapped in a
// trailing \b, so an UN-suffixed fragment like "insolven" can never actually match inside "insolvent" or
// "insolvency" (no word boundary exists between "n" and the following "t"/"c"); \w* lets it match the
// whole word it starts, exactly like "divorc\w*" for divorce/divorced/divorcing.
export const RING_DENY = /\b(innd|innerscope|inscope hearing|otcmkts|ticker|reg\s*(cf|d|a|c)\b|rule\s*144|form\s*s-?1|8-?k|10-?[qk]|share\s*price|stock\s*price|price\s*per\s*share|materially?\s*non.?public|mnpi|reg\s*fd|dividend|capital\s*raise|raise\s*round|the\s*raise\s*of|financing|term\s*sheet|convertible\s*note|safe\s*note|warrants?|insiders?|runway|insolven\w*|dilution|patient|\bphi\b|diagnos|medication|prescrib|hipaa|audiogram|hearing\s*number|divorc\w*|custody|dissolution|spousal\s*support|child\s*support|alimony|deposition|opposing\s*counsel|settlement\s*(offer|agreement|talks|conference|negotiation)|mediation|family\s*court|community[\s-]*property|marital|restraining\s*order|civil\s*case|civil\s*litigation)\b/i;

// Privileged/personal AGENT lanes that must NEVER be read cross-lane, regardless of content (mirrors
// kb-memory/mem.mjs's own NO_SHARE set). A Set, not a scattered literal string compare, so a future
// privileged lane is a one-line addition everywhere that imports PRIVILEGED_AGENTS instead of a
// grep-and-hope across every cross-lane script.
export const PRIVILEGED_AGENTS = new Set(["clo-personal"]);

/**
 * True when `row` (shape: { agent?, text?, tags?, was? }) is safe to read, compare, or publish
 * CROSS-lane: not from a privileged agent lane, AND its own text/tags/was carry no MNPI/PHI marker.
 * This is a CONTENT check, not just an agent check: an otherwise-shareable agent (cfo/clo/capital/cto)
 * can still assert an individual MNPI-flagged fact that must stay in ITS OWN lane, so agent identity
 * alone is not a sufficient gate. Pure, no I/O, never throws. Mirrors mem.mjs's ringSafeCross /
 * brain.mjs's ringSafeForDiff (this copy never carries the MNPI_AUTHORIZED viewer exception those two
 * have, because a scheduled batch job's output has no reliable "authorized viewer" boundary).
 */
export function ringSafeCross(row) {
  if (!row) return false;
  if (PRIVILEGED_AGENTS.has(String(row.agent || "").toLowerCase())) return false;
  const tags = Array.isArray(row.tags) ? row.tags.join(" ") : (row.tags || "");
  return !RING_DENY.test(`${row.text || ""} ${tags} ${row.was || ""}`);
}

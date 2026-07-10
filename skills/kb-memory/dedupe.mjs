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

// fleet-telemetry / result-guard.mjs, pure dependency-free oversized-tool-result guard.
//
// Input tokens price the FULL running transcript on every subsequent turn, so one oversized tool
// result (a big grep, a large file read, a verbose API dump) keeps getting re-billed for the rest of
// a session. Truncation today is ad hoc and per-callsite (doc-indexer MAXTEXT, company-brain top-N).
// This generalizes it: a head+tail clamp with an explicit marker so the model knows the content was
// cut and can re-query more narrowly. Pure + IO-free.

const DEFAULT_MAX = 20000; // chars; ~5k tokens, generous for a single tool result

/**
 * guardResult(text, opts?) -> { text, truncated, originalLen }
 * opts: { max?:number (char budget), headRatio?:number 0..1 (share kept from the top) }
 * Keeps the head and tail (both usually carry the signal) and drops the middle with a clear marker.
 */
export function guardResult(text, opts = {}) {
  const s = String(text ?? "");
  const max = Math.max(200, opts.max ?? DEFAULT_MAX);
  if (s.length <= max) return { text: s, truncated: false, originalLen: s.length };
  const headRatio = Math.min(0.95, Math.max(0.05, opts.headRatio ?? 0.7));
  const dropped = s.length - max;
  const marker = `\n... [result-guard: truncated ${dropped} of ${s.length} chars; re-query more narrowly for the omitted middle] ...\n`;
  const budget = max - marker.length;
  if (budget <= 0) return { text: marker.trim(), truncated: true, originalLen: s.length };
  const head = Math.floor(budget * headRatio);
  const tail = budget - head;
  return { text: s.slice(0, head) + marker + s.slice(s.length - tail), truncated: true, originalLen: s.length };
}

/**
 * guardResultFields(obj, opts?) -> shallow-cloned object with string fields guarded.
 * opts adds: { fields?:string[] (only guard these keys; default: all string values) }
 */
export function guardResultFields(obj, opts = {}) {
  if (!obj || typeof obj !== "object") return { value: guardResult(obj, opts).text, truncated: false };
  const only = opts.fields ? new Set(opts.fields) : null;
  const out = Array.isArray(obj) ? [] : {};
  let truncated = false;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && (!only || only.has(k))) {
      const g = guardResult(v, opts);
      out[k] = g.text;
      truncated = truncated || g.truncated;
    } else {
      out[k] = v;
    }
  }
  return { value: out, truncated };
}

export { DEFAULT_MAX };

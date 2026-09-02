// prompt-shape.mjs — the ONE shared helper for automatic-prompt-caching hygiene across every
// OpenAI-direct caller in the toolkit (2026-09-02, the OpenAI cost-lever sweep: see
// FLEET-BULLETIN.md / the PR that shipped this file for the full list of callers wired to it).
//
// WHAT THIS IS FOR: OpenAI's automatic prompt caching (verified live against
// https://developers.openai.com/api/docs/guides/prompt-caching, fetched 2026-09-02) discounts the
// INPUT-token price of any repeated PREFIX, but ONLY when that prefix is byte-identical across calls
// AND is placed at the START of the request. Concretely, for GPT-5.6-and-later (this fleet's
// OPENAI_TIERS default -- see setup/model-routing.mjs), the minimum cacheable prefix length is
// 1,024 tokens (2,048 for pre-5.6 models; this file's threshold targets the fleet's actual default).
// A cache HIT prices the matched prefix at 0.1x the normal input rate. On GPT-5.6+ specifically, a
// cache WRITE (the first time a new prefix is seen) costs 1.25x the normal input rate for that
// prefix, so the very FIRST call on a new prefix costs slightly MORE, not less -- but the arithmetic
// still favors caching hard: writing once and reading once costs 1.35x normal, versus 2x for two
// uncached calls; ten calls sharing one prefix (one write, nine reads) cost 2.15x versus 10x
// uncached. Every caller this file is wired into runs MANY calls per invocation (or across repeated
// nightly runs) sharing the SAME static system/rubric/schema text, so this is a clear net win, not a
// marginal one.
//
// THE ONE RULE THAT MAKES OR BREAKS A CACHE HIT: the prefix match is over the ENTIRE serialized
// request in order, so the STATIC part of a prompt (system instructions, a fixed rubric, a JSON
// schema, few-shot examples -- anything that reads byte-identical call after call) must come FIRST,
// and the VARIABLE part (the specific document, transcript, candidate answer, or task -- anything
// that genuinely differs every call) must come LAST. Interleaving a variable value BETWEEN two
// static blocks caps the cacheable prefix at whatever precedes the first byte that differs, which
// can be nearly nothing even when the total static text is large.
//
// staticFirst() below builds a { messages } shape in that order for a caller that wants a NEW,
// structured static block (system + rubric + examples). It is deliberately NOT force-adopted by
// every caller in this sweep: an audit of every listed nightly/scheduled OpenAI-direct caller found
// each one ALREADY places its static system prompt first and its variable content last (see the PR
// description for the per-file evidence) -- so for those callers this module is used ONLY for
// cacheableTokensEstimate()/logPrefixShape() (pure, additive observability), and staticFirst() itself
// is exercised directly by this file's own tests plus available for any FUTURE caller (or a
// caller found to need real reordering) to adopt without re-deriving the same string-assembly logic.
//
// NOT YET WIRED (a verified, documented follow-up, deliberately out of scope for this PR): OpenAI
// also exposes an optional `prompt_cache_key` request field (and, for GPT-5.6+, explicit
// `prompt_cache_options: { mode: "explicit", ttl }` cache-breakpoint control) that groups a caller's
// traffic onto the same backing machine pool to reduce cache-miss-by-routing under high concurrent
// volume ("mitigate request overflow to other machines, and therefore cache misses" per the same
// guide). Worth adding as a `caller`-derived stable key on setup/model-routing.mjs's chatBody() once
// a specific job is observed cache-missing under real concurrent load; not added here to keep this
// PR's blast radius to the three asked-for levers.
//
// Pure module: no network, no fs, no process.env reads at import time (mirrors model-routing.mjs's
// own "pure module" contract) -- every function here is a plain string/number transform.

/** OpenAI's documented minimum cacheable prefix length for GPT-5.6-and-later models (this fleet's
 *  OPENAI_TIERS default across cheap/standard/quality -- see model-routing.mjs). Older models need
 *  2,048; this fleet does not default to any of those today, so 1,024 is the operative floor for
 *  every caller this file is wired into. Exported so a caller/test can reference the SAME number
 *  rather than re-typing the literal. */
export const CACHE_TOKEN_THRESHOLD = 1024;

/**
 * cacheableTokensEstimate(text) -> integer
 * A rough, NETWORK-FREE token estimate (chars/4, the commonly-cited rule of thumb for English text --
 * see e.g. OpenAI's own tokenizer guidance). This is an ESTIMATE for logging/threshold purposes only;
 * it is never sent to the API and never billed on. Real cache-hit accounting comes back from the API
 * itself as `usage.prompt_tokens_details.cached_tokens` on a live response -- a caller that wants an
 * EXACT figure should read that field; this function exists so a caller can log a cheap, immediate,
 * offline signal ("is this prefix even in the right ballpark to be cacheable") without waiting on a
 * live call or parsing its usage block.
 */
export function cacheableTokensEstimate(text) {
  const s = String(text ?? "");
  return s.length ? Math.ceil(s.length / 4) : 0;
}

function renderBlock(label, value) {
  if (value == null || value === "") return "";
  const items = Array.isArray(value) ? value : [value];
  const filtered = items.filter((x) => x != null && x !== "");
  if (!filtered.length) return "";
  if (!label) return filtered.join("\n\n");
  return `${label}:\n${filtered.map((c, i) => `${i + 1}. ${c}`).join("\n")}`;
}

/**
 * staticFirst({ system, rubric, examples, variable }) -> { messages, prefixText, prefixTokensEstimate, cacheable }
 *
 * Builds a cache-friendly chat-completions `messages` array: ONE system message concatenating every
 * STATIC part given (system instructions, then a rubric block if given, then an examples block if
 * given, in that fixed order, each rendered exactly once), followed by ONE user message containing
 * ONLY the variable content. Any of the four options may be omitted; an omitted/empty part is
 * skipped entirely rather than leaving a blank block, so a caller passing only
 * `{system, variable}` gets a system message that is byte-identical to `system` alone (no extra
 * blank lines, no trailing separators) -- reordering a caller onto this helper must never change
 * what the model actually sees beyond the reorder itself.
 *
 * `rubric`/`examples` may each be a single string or an array of strings. `rubric` renders as a
 * numbered list (matching this fleet's existing judge-prompt convention, e.g.
 * skills/agent-evals/run-evals.mjs's judgeDefault() and skills/agent-evals/judge-bedrock-nova.mjs);
 * `examples` renders as a plain "EXAMPLES:" block, one item per numbered line.
 *
 * Returns the built `messages` array PLUS the measured static prefix (`prefixText`, the exact text
 * that became the system message), its rough token estimate, and whether that estimate crosses
 * CACHE_TOKEN_THRESHOLD -- so a caller can build its messages AND log cache eligibility from the one
 * return value, without a second call into cacheableTokensEstimate().
 */
export function staticFirst({ system, rubric, examples, variable } = {}) {
  const parts = [
    system != null && String(system).trim() !== "" ? String(system).trim() : "",
    renderBlock("RUBRIC", rubric),
    renderBlock("EXAMPLES", examples),
  ].filter((p) => p !== "");
  const prefixText = parts.join("\n\n");
  const messages = [];
  if (prefixText) messages.push({ role: "system", content: prefixText });
  if (variable != null && variable !== "") messages.push({ role: "user", content: String(variable) });
  const prefixTokensEstimate = cacheableTokensEstimate(prefixText);
  return { messages, prefixText, prefixTokensEstimate, cacheable: prefixTokensEstimate >= CACHE_TOKEN_THRESHOLD };
}

/**
 * logPrefixShape(caller, prefixTokensEstimate, cacheable) -> void
 * The ONE shared stderr line every OpenAI-direct caller in this sweep emits right before it sends a
 * chat-completions request, so a fleet-wide grep for "prefix~" across container logs shows every
 * call's cache eligibility in one uniform shape:
 *   [<caller>] prefix~<N> tokens (cacheable: yes|no)
 * Pure side effect (console.error only), never throws, never touches process.exit -- safe to call
 * unconditionally from any caller, including ones that end up erroring out immediately after.
 */
export function logPrefixShape(caller, prefixTokensEstimate, cacheable) {
  console.error(`[${caller}] prefix~${prefixTokensEstimate} tokens (cacheable: ${cacheable ? "yes" : "no"})`);
}

/**
 * logPrefixForText(caller, text) -> the estimate (int)
 * Convenience one-liner for the (common in this sweep) case where a caller already has its static
 * system-prompt STRING in hand and just wants to estimate + log it without going through
 * staticFirst()'s message-building. Equivalent to:
 *   const n = cacheableTokensEstimate(text); logPrefixShape(caller, n, n >= CACHE_TOKEN_THRESHOLD);
 * Returns the estimate so a caller can also use it for its own purposes (e.g. deciding a batch-size
 * heuristic) without a second computation.
 */
export function logPrefixForText(caller, text) {
  const n = cacheableTokensEstimate(text);
  logPrefixShape(caller, n, n >= CACHE_TOKEN_THRESHOLD);
  return n;
}

export default { CACHE_TOKEN_THRESHOLD, cacheableTokensEstimate, staticFirst, logPrefixShape, logPrefixForText };

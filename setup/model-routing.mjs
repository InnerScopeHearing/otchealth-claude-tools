// model-routing.mjs — the ONE place that defines "which model, which request-body shape" for the
// fleet's Azure OpenAI / Foundry callers. Every skill that does quality-tier chat synthesis
// (company-brain, focus-group-loop, agent-evals, and any future one) imports this instead of
// carrying its own copy of the tier defaults + the reasoning-vs-chat body branch.
//
// Why this exists: gpt-4.1-mini was hardcoded as the FALLBACK deployment in three separate skills
// (see #256, "Fix banned gpt-4.1-mini fallback default in quality-synthesis skills"). gpt-4.1-mini is
// BANNED for quality/summarization work (it botched decision-grade synthesis; see
// otchealth-mcp-server/src/azure/foundry.ts and otchealth-cto/CLAUDE.md). A future model swap or ban
// should be a ONE-LINE edit here that propagates fleet-wide via octools-sync, not a grep-and-fix across
// N skills. Mirrors the gateway's src/azure/foundry.ts chat() body-shape branch so the whole fleet
// (gateway + skills) agrees on the reasoning-vs-chat request shape.
//
// This module is PURE (no network, no Secret Manager reads): callers resolve endpoint/key however
// they already do (GCP Secret Manager JWT, env, etc.) and pass the resolved deployment name in here
// to get the tier defaults + the correctly-shaped request body. verifyOpenAITiers() below is the one
// deliberate, OPT-IN exception (see its own doc comment) -- it is never called automatically.

// Reasoning-family deployments (gpt-5.x, o-series) reject max_tokens + a non-default temperature;
// they require max_completion_tokens and no temperature override. Chat-family (gpt-4o, gpt-4.1-mini,
// etc.) keeps the classic max_tokens + temperature shape. Mirrors otchealth-mcp-server's foundry.ts.
// Defined BEFORE TIERS/OPENAI_TIERS below because OPENAI_TIERS's own defaults call modelFamilyOf() at
// module-load time to bake in each tier's family; a `const` used before its declaration in the same
// module is a temporal-dead-zone ReferenceError, so ordering here is load-bearing, not cosmetic.
const REASONING_FAMILY = /^(gpt-5|o[0-9])/i;

/** Classify a deployment name into 'reasoning' or 'chat'. Pure string test, no I/O. */
export function modelFamilyOf(deployment) {
  return REASONING_FAMILY.test(deployment || '') ? 'reasoning' : 'chat';
}

/**
 * Model tiers. 'quality' is the default synthesis/judge/persona-review tier (reasoning-family,
 * matches the gateway's Foundry "standard" tier - foundry.ts cfg().chat). 'cheap' is the commodity
 * extraction/classification tier - explicitly NOT for quality synthesis (see the ban above); it is
 * for bulk, non-summarization capture only (doc-indexer CU passes, kb-memory's bounded pitfall/decision
 * extraction). Deployment names mirror the real Foundry deployments; do not invent new ones here.
 */
export const TIERS = {
  quality: { deployment: 'gpt-5.1', modelFamily: 'reasoning' },
  standard: { deployment: 'gpt-4.1', modelFamily: 'chat' },
  cheap: { deployment: 'gpt-4.1-mini', modelFamily: 'chat' },
};

// LEGACY_STANDARD (2026-08-01): the deployment name for TIERS.standard on the OLD legacy Azure OpenAI
// resource (octhealth-aoai-4701, "azure-openai-endpoint"/"azure-openai-key"), which callers should now
// treat as a last-resort fallback ONLY, never primary. That resource's gpt-4o deployment sits on the
// regional "Standard" SKU at 50K TPM, already 100% subscribed (50/50, zero headroom) -- a hard capacity
// ceiling, not a config choice -- so any caller that still primaries on it will keep tripping the
// fleet-wide Datadog "Azure OpenAI throttled (blocked_calls)" monitor. TIERS.standard.deployment now
// points at 'gpt-4.1' on the Foundry resource ("azure-foundry-openai-endpoint"/"azure-foundry-key"),
// which has 2,000K TPM (GlobalStandard) and is chat-family (same request-body shape as gpt-4o, so this
// is a pure drop-in for every caller already using resolveTier('standard')/chatBody()). Callers that
// keep a legacy fallback provider for redundancy must use LEGACY_STANDARD as that provider's deployment
// name, NOT TIERS.standard.deployment (the legacy resource has no 'gpt-4.1' deployment).
export const LEGACY_STANDARD = { deployment: 'gpt-4o', modelFamily: 'chat' };

// OPENAI_TIERS (2026-08-27, Azure Foundry retirement port; deployments refreshed 2026-08-29). The
// OpenAI-provider counterpart to TIERS above. Azure subscription 55c84f6b (the whole Foundry estate)
// is permanently deleted, so every caller that resolved a tier for a Foundry deployment needs an
// OpenAI model id instead. Putting it here, once, means every quality-LLM caller (critic-pass,
// agent-evals, focus-group-loop, recall-evals, company-brain, memory-librarian, reflect, shark-round,
// the signal-radar detectors) resolves "which model, on OpenAI" from ONE place instead of a hardcoded
// literal re-typed per file -- the exact drift class that let a stale gpt-4.1-mini fallback linger
// across three skills before setup/model-routing.mjs existed (see this file's own header).
//
// 2026-08-29 REFRESH: bumped to the gpt-5.6 family (luna/sol/terra) -- LIVE-VERIFIED against a real
// `GET /v1/models` call on the fleet's own OpenAI account (all three present in a 124-model catalog,
// alongside the expected gpt-5.1 -> 5.2 -> 5.3 -> 5.4 -> 5.5 -> 5.6 progression, so this is a real
// shipped generation, not a typo) AND against a live `POST /v1/chat/completions` probe on each of the
// three names (all three: HTTP 200 on a real completion; all three REJECT `max_tokens` with
// `unsupported_parameter` and require `max_completion_tokens` -- i.e. all three are REASONING-FAMILY,
// same as gpt-5.1 before them; all three accept multimodal `image_url` content parts, confirmed via a
// live vision probe, so the focus-group-loop screenshot-review caller is unaffected). This is a
// FAMILY CHANGE for 'cheap' and 'standard': the OLD defaults (gpt-4o-mini, gpt-4.1) were CHAT-family;
// the new ones are REASONING-family. Every caller MUST build its request body via chatBody() (below),
// never a hardcoded `{max_tokens, temperature}` literal, or it will 400 the moment it picks up this
// tier -- see the 2026-08-29 sibling fixes to shark-round.mjs / reflect.mjs / memory-librarian.mjs,
// which hit exactly this. A reasoning-family model also spends part of its `max_completion_tokens`
// budget on hidden reasoning tokens before any visible output -- a caller with a very tight maxTokens
// budget (well under ~200) that used to work on a chat-family model can now come back with EMPTY
// content on the new tier; this is a real operational risk to watch after this ships, not something
// this file can fix generically without knowing each caller's tolerance.
//
// Every deployment below is ALSO env-overridable per-tier fleet-wide (OPENAI_TIER_CHEAP / _MID /
// _TOP -- "mid"/"top" are the human names for the 'standard'/'quality' tier keys, kept unchanged for
// backward compat with every existing resolveTier('standard'|'quality', 'openai') call site) so a
// future rotation is a redeploy with one env var, no code change, fleet-wide.
export const OPENAI_TIER_ENV_VARS = { cheap: 'OPENAI_TIER_CHEAP', standard: 'OPENAI_TIER_MID', quality: 'OPENAI_TIER_TOP' };
function _openaiTierEntry(envVar, fallback) {
  const deployment = process.env[envVar] || fallback;
  return { deployment, modelFamily: modelFamilyOf(deployment) };
}
export const OPENAI_TIERS = {
  // cheap: classification / simple extraction / bounded structured output. Was gpt-4o-mini
  // (chat-family); now gpt-5.6-luna (reasoning-family, live-verified above).
  cheap: _openaiTierEntry(OPENAI_TIER_ENV_VARS.cheap, 'gpt-5.6-luna'),
  // standard ("mid"): the default synthesis/judge tier -- company-brain, critic-pass verdicts,
  // reflect/memory-librarian lesson extraction, the eval judge. Was gpt-4.1 (chat-family); now
  // gpt-5.6-terra (reasoning-family, live-verified above). NEVER downgrade a quality-critical caller
  // (reflect lessons, critic-pass verdicts) below this tier.
  standard: _openaiTierEntry(OPENAI_TIER_ENV_VARS.standard, 'gpt-5.6-terra'),
  // quality ("top"): hard reasoning only -- the most expensive tier, used sparingly (a throttle
  // fallback, or a caller that explicitly asks for it). Was gpt-5.1 (already reasoning-family); now
  // gpt-5.6-sol (also reasoning-family, live-verified above) -- no family change for this tier.
  quality: _openaiTierEntry(OPENAI_TIER_ENV_VARS.quality, 'gpt-5.6-sol'),
};

// Loose, NETWORK-FREE sanity check for an OpenAI-style model id. This module stays pure (no fetch, no
// Secret Manager reads -- see the header) so this cannot be a live existence check; it only catches
// the shape of an obviously-wrong value (a typo'd OPENAI_TIER_* override, an accidentally-pasted Azure
// deployment name, an empty string). Every id shipped as a default in this file WAS live-verified
// against a real `GET /v1/models` + a real `POST /v1/chat/completions` call before being set (see the
// 2026-08-29 note above) -- this check exists for what an operator sets AFTER today, not for what
// shipped today. Warns at most once per distinct bad value per process (module-level Set), so a
// hot-path caller resolving the same bad override on every request does not spam stderr.
const KNOWN_OPENAI_PREFIX = /^(gpt-|o[0-9]|chatgpt-|omni-|text-|davinci|babbage)/i;
const _warnedBadOpenAIModel = new Set();
export function warnIfImplausibleOpenAIModel(deployment, label = 'model') {
  if (!deployment || KNOWN_OPENAI_PREFIX.test(deployment) || _warnedBadOpenAIModel.has(deployment)) return false;
  _warnedBadOpenAIModel.add(deployment);
  console.error(
    `[model-routing] WARNING: "${deployment}" (${label}) does not look like a recognised OpenAI model id. ` +
    `If this came from an OPENAI_TIER_CHEAP/_MID/_TOP override (or a per-caller *_MODEL env var), verify it ` +
    `exists via a live "GET /v1/models" call before relying on it in production -- an unverified name still ` +
    `fails LOUD (404 model_not_found) at call time, never silently, but this warning catches it earlier.`
  );
  return true;
}

/**
 * verifyOpenAITiers({ apiKey?, fetchImpl?, tiers? }) -> Promise<{ ok, checked, missing, error? }>
 * OPT-IN, NETWORK-CALLING live verification: confirms every configured OPENAI_TIERS deployment (or a
 * caller-supplied subset) actually exists in the account's `GET /v1/models` catalog. NEVER called
 * automatically by this module (see the "pure module" contract in the header) -- a caller (a CI gate,
 * a deploy preflight, an ops script) invokes this explicitly when it wants a hard proof-check rather
 * than the passive shape-only warnIfImplausibleOpenAIModel() above. `fetchImpl` defaults to the global
 * fetch so this is trivially mockable in tests without a real network call. Never throws on a network
 * failure -- returns `{ ok:false, error }` so a caller can decide whether an unreachable models
 * endpoint should block anything (it usually should not: a transient network blip must not fail a
 * deploy that would otherwise be fine).
 */
export async function verifyOpenAITiers({ apiKey, fetchImpl = fetch, tiers = OPENAI_TIERS } = {}) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  const wanted = [...new Set(Object.values(tiers).map((t) => t.deployment))];
  if (!key) return { ok: false, checked: [], missing: wanted, error: 'no OpenAI API key supplied (pass apiKey or set OPENAI_API_KEY)' };
  let r;
  try {
    r = await fetchImpl('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
  } catch (e) {
    return { ok: false, checked: [], missing: wanted, error: `network error: ${e.message}` };
  }
  if (!r.ok) return { ok: false, checked: [], missing: wanted, error: `GET /v1/models -> HTTP ${r.status}` };
  const j = await r.json();
  const live = new Set((j?.data || []).map((m) => m.id));
  const missing = wanted.filter((id) => !live.has(id));
  if (missing.length) {
    console.error(`[model-routing] verifyOpenAITiers: MISSING from the live catalog: ${missing.join(', ')} -- these tier defaults will 404 at call time.`);
  }
  return { ok: missing.length === 0, checked: wanted, missing };
}

/**
 * Resolve a tier name (or a raw deployment string) to { deployment, modelFamily }.
 * - A known tier key ('quality' | 'standard' | 'cheap') returns that tier's default deployment, from
 *   TIERS (provider omitted or 'azure'/'foundry') or OPENAI_TIERS (provider 'openai').
 * - Anything else is treated as an explicit deployment override (e.g. an env-var value a caller
 *   already resolved, such as BRAIN_MODEL / FGL_MODEL / AGENT_MODEL / CRITIC_MODEL); its family is
 *   inferred and `provider` has no effect.
 * `provider` defaults to 'azure' so every pre-existing single-argument call site (resolveTier('standard'))
 * is byte-for-byte unchanged; pass 'openai' explicitly to resolve against OPENAI_TIERS instead.
 */
export function resolveTier(tierOrDeployment, provider = 'azure') {
  const table = String(provider || 'azure').toLowerCase() === 'openai' ? OPENAI_TIERS : TIERS;
  const known = table[tierOrDeployment];
  if (known) return { deployment: known.deployment, modelFamily: known.modelFamily };
  const deployment = tierOrDeployment || table.standard.deployment;
  return { deployment, modelFamily: modelFamilyOf(deployment) };
}

/**
 * Build the correctly-shaped chat/completions request body for a given deployment.
 *   chatBody(deployment, { messages, maxTokens, temperature, jsonMode, serviceTier })
 * Reasoning-family: { messages, max_completion_tokens } (no temperature override, ever - the API
 * rejects a non-default value). Chat-family: { messages, max_tokens, temperature } (temperature
 * defaults to 0.2 when not given, matching the fleet's existing synthesis/judge callers).
 * `serviceTier` (2026-08-29, OpenAI Flex processing lane -- see the FLEX PROCESSING section below
 * for the full contract): when truthy, adds `service_tier: <value>` to the body (e.g. "flex"); when
 * falsy/omitted (the default for every pre-existing call site in this fleet), the key is NOT added
 * at all, so every caller that does not pass it gets a byte-identical body to before this option
 * existed. Never inferred from env here -- resolve the value with serviceTierFor() first and pass
 * it in explicitly, keeping this function pure (no I/O, no env reads) like the rest of the module.
 */
export function chatBody(deployment, { messages, maxTokens = 900, temperature, jsonMode, serviceTier } = {}) {
  const isReasoning = modelFamilyOf(deployment) === 'reasoning';
  const body = { messages };
  if (isReasoning) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
    body.temperature = typeof temperature === 'number' ? temperature : 0.2;
  }
  if (jsonMode) body.response_format = { type: 'json_object' };
  if (serviceTier) body.service_tier = serviceTier;
  return body;
}

// =============================================================================================
// FLEX PROCESSING (2026-08-29) -- an OpenAI `service_tier: "flex"` lane for nightly/background,
// latency-tolerant callers (agent-evals persona+judge calls, the recall-evals miners, the
// signal-radar detectors, critic-pass). Live-verified against OpenAI's current flex-processing
// guide (https://platform.openai.com/docs/guides/flex-processing, fetched 2026-08-29):
//
//   - Set `service_tier: "flex"` on a Chat Completions (or Responses) request body. Tokens are then
//     priced at Batch API rates (plus prompt-caching discounts on top) -- roughly half of standard
//     synchronous pricing for the same model. Beta, limited model availability (see the pricing page
//     for which models currently support it); an unsupported model/tier combination is rejected by
//     OpenAI itself (a normal HTTP error), never silently ignored by this module.
//   - Slower, best-effort latency. OpenAI's own SDKs default their client timeout to 10 minutes and
//     the guide explicitly recommends raising it to 15 minutes for flex requests specifically (their
//     own code samples: `timeout: 15 * 1000 * 60` / `timeout=900.0`). This fleet's callers use the
//     bare Node `fetch()`, which has no such SDK-level default timeout knob -- OPENAI_FLEX_TIMEOUT_MS
//     below (default 900000ms = 15 min) is applied via `AbortSignal.timeout()` on each attempt, the
//     direct native-fetch equivalent of the SDK `timeout` parameter shown in OpenAI's own examples.
//     KNOWN LIMITATION (documented, not silently assumed away): Node's built-in fetch is backed by an
//     internal (non-importable as of this Node version) undici dispatcher, which may itself enforce
//     its own default header/body socket timeouts independent of any AbortSignal. If a flex-tier
//     nightly job is later observed failing near that mark rather than the 15-minute AbortSignal
//     bound, the fix is a scoped `undici` dependency (Guardian/cooldown-reviewed) to set a custom
//     dispatcher with longer `headersTimeout`/`bodyTimeout` on these specific calls -- not yet done
//     here because it is unverified whether it is actually needed, and it is a new dependency this
//     PR deliberately does not add speculatively.
//   - Flex may return `429 Resource Unavailable` when capacity is tight. OpenAI's own docs: "You will
//     not be charged when this occurs." Their recommended handling is one of: (a) retry with
//     exponential backoff on the SAME tier, or (b) retry with `service_tier` set to "auto" (or
//     omitted) to fall through to standard-priced processing. This lane implements ONLY (a) -- it
//     never silently reissues a declined flex request at standard price, because a caller that opted
//     into flex specifically to save ~50% must not have that savings silently defeated without a
//     deliberate decision; a caller that wants (b) can catch the `.throttled` error this lane raises
//     on exhaustion and retry itself with `tier: "auto"`/no tier.
//
// Fully additive and env-gated: OPENAI_SERVICE_TIER unset (the fleet-wide default today, everywhere)
// means serviceTierFor() returns `undefined`, chatBody() adds no `service_tier` key, and
// flexRetryPolicy() returns the caller's own values completely untouched -- so every existing call
// site's behavior is byte-identical until an operator sets the env var. Ship dark; arm per job.
// =============================================================================================

// Per-caller override env var name, e.g. serviceTierEnvVar("agent-evals") -> "OPENAI_SERVICE_TIER_AGENT_EVALS".
// Pure string transform (uppercase, non-alnum runs -> single underscore, trimmed) -- never throws,
// returns null for an empty/missing caller name (serviceTierFor treats that as "no per-caller var").
export function serviceTierEnvVar(caller) {
  const slug = String(caller || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug ? `OPENAI_SERVICE_TIER_${slug}` : null;
}

/**
 * Resolve the effective OpenAI `service_tier` for a named caller: a per-caller env var
 * (OPENAI_SERVICE_TIER_<CALLER>) wins over the global OPENAI_SERVICE_TIER default; `caller` is
 * optional (omit it to resolve only the global default). Both unset -- the case for every caller in
 * this fleet until an operator opts in -- resolves to `undefined`, meaning "no service_tier at all,"
 * never the literal string "undefined" or an empty string (chatBody()'s `if (serviceTier)` treats
 * both identically, but downstream code that does `=== undefined` should not have to special-case
 * an empty string too). Values are trimmed and lowercased ("Flex" / " flex " both resolve to "flex").
 */
export function serviceTierFor(caller) {
  const perCallerVar = serviceTierEnvVar(caller);
  const raw = (perCallerVar && process.env[perCallerVar]) || process.env.OPENAI_SERVICE_TIER || '';
  const tier = raw.trim().toLowerCase();
  return tier || undefined;
}

/** True when a resolved tier value is the flex lane. Defensive against case/whitespace even though
 *  serviceTierFor() already normalizes, since a caller may pass a raw literal instead. */
export function isFlexTier(tier) {
  return String(tier || '').trim().toLowerCase() === 'flex';
}

// =============================================================================================
// REASONING-BUDGET SIBLINGS (2026-08-30, FND-20260830-e927): shared helpers factored out while
// fixing the SIBLINGS of critic-pass/run.mjs's own reasoning-truncation fix (FND-20260830-e7c1),
// so every OTHER caller that resolves a tier through this module gets them once instead of
// re-deriving (and risking re-bugging) them per file. See critic-pass/run.mjs's header for the
// full incident writeup; the summary: a reasoning-family model (gpt-5.x/o-series) spends part of
// its max_completion_tokens budget on HIDDEN reasoning tokens before any visible output. A budget
// sized for the prior CHAT-family default (no hidden cost) can come back with
// finish_reason:"length" and EMPTY content -- an HTTP 200, not an error -- so a caller that does
// not check for this treats the empty string as a real (if blank) answer.
//
// Observed reasoning-token spend is NON-DETERMINISTIC even on the IDENTICAL input (live-measured
// during the FND-20260830-e927 sweep): a single company-brain synthesis question truncated 6/6
// times at 900 tokens and 3/3 times at 2000, but succeeded reliably at 3000+ (visible completion
// up to ~2400 tokens); a signal-radar entailment call truncated on 1 of 4 initial live calls at
// 400 tokens but not on 24 further calls at 400-2000 on the same prompt. A single passing probe
// proves nothing, and a budget needs real margin, not just "one more than what failed once."
//
// fetchOpenAIWithFlexRetry DOES retry a truncated-empty response while attempts remain, in the same
// loop that already retries a 429, and throws (tagged .reasoningExhausted) only once the allowance is
// spent. It retries at the SAME budget rather than escalating it, which is the useful thing to do
// precisely because the spend is non-deterministic (above): the identical request often succeeds on a
// later attempt.
//
// An earlier revision of this comment claimed the opposite -- that truncation was deliberately left
// OUT of the retry loop, because "every current caller passes tries:1, so it would only ever fire
// under flex." That reasoning was wrong on its own terms. flexRetryPolicy() FLOORS tries to
// OPENAI_FLEX_MIN_RETRIES (6) whenever the resolved tier is flex, and flex is armed per caller by a
// live env switch, not a code change. So arming it silently granted six attempts, of which the old
// code burned one and discarded five, at exactly the moment retrying works. "Only fires under flex"
// describes a reachable configuration, not an unreachable one.
//
// Each sibling with its OWN hand-rolled retry loop (signal-radar's detectors, company-brain,
// agent-evals) additionally ESCALATES its budget between attempts inside that loop, mirroring
// critic-pass/run.mjs's pattern (that file's local copy is unchanged by this). This shared helper
// deliberately does not escalate: it has no caller-specific sense of what a safe larger budget is,
// and a caller that wants escalation has the tagged error to act on.

/** True when a chat-completions `choice` is the specific "reasoning model spent its entire
 *  max_completion_tokens budget on hidden reasoning and returned no visible output" shape: NOT an
 *  HTTP error, NOT a 429 -- the call itself succeeded -- so it needs its own detection, distinct
 *  from a throttle or a genuine (non-empty) malformed response. Pure; identical in shape and
 *  intent to critic-pass/run.mjs's own local truncatedEmpty() (kept there unchanged -- that file
 *  has its own settled fix); this is the shared copy every OTHER caller in this sweep imports. */
export function truncatedEmpty(choice) {
  return choice?.finish_reason === 'length' && !String(choice?.message?.content ?? '').trim();
}

/**
 * positiveIntEnv(envVar, fallback) -> a positive integer read from process.env[envVar], or
 * `fallback` when unset/blank/non-finite/zero/negative/fractional-below-1. FLOORS BEFORE the
 * positivity check (not after): a sub-1 fractional override such as "0.7" or "0.001" would
 * otherwise pass a `> 0` test on the raw value and only THEN floor to 0, silently sending a
 * zero-token budget to the API. This is the exact off-by-order bug critic-pass/run.mjs's own
 * positiveInt() carried until FND-20260830 fixed it (PR #501, squash 230b596); defined here,
 * correctly ordered from the start, so every OTHER file in this sweep that needs an
 * env-overridable token-budget guard reuses ONE already-correct implementation instead of each
 * re-typing (and risking re-introducing) the same off-by-order mistake.
 */
export function positiveIntEnv(envVar, fallback) {
  const n = Math.floor(Number(process.env[envVar]));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Flex-specific retry-count and timeout FLOORS, both env-overridable fleet-wide (one redeploy, no
// code change). These are floors applied ONLY when the resolved tier is "flex" -- flexRetryPolicy()
// below never lengthens or otherwise touches a non-flex call.
export const OPENAI_FLEX_TIMEOUT_MS = Number(process.env.OPENAI_FLEX_TIMEOUT_MS) || 900000; // 15 min (OpenAI's own flex guidance, raised from their SDK's 10-min default)
export const OPENAI_FLEX_MIN_RETRIES = Number(process.env.OPENAI_FLEX_MIN_RETRIES) || 6; // floor; most existing per-file retry loops pass tries=3-5 today, which this raises only under flex

/**
 * flexRetryPolicy(tier, { tries, timeoutMs }) -> { tries, timeoutMs }
 * The caller-visible retry contract this module signals for the flex lane: when `tier` is "flex",
 * floors `tries` to OPENAI_FLEX_MIN_RETRIES (never lowers a caller's own higher value) and defaults
 * `timeoutMs` to OPENAI_FLEX_TIMEOUT_MS (a caller-supplied `timeoutMs` still wins outright, so an
 * unusual caller can pick its own budget). For any other tier (undefined, "", "auto", ...) this
 * returns `{ tries, timeoutMs }` EXACTLY as passed in -- including `timeoutMs: undefined` when the
 * caller never asked for one -- so a non-flex call is byte-identical to before this function existed
 * (no AbortSignal, no extra retries). Pure: returns plain numbers, never constructs an AbortSignal
 * itself, so it stays trivially unit-testable and composable by any caller's own fetch loop (see
 * fetchOpenAIWithFlexRetry below for the one that also performs the actual retrying fetch).
 */
export function flexRetryPolicy(tier, { tries, timeoutMs } = {}) {
  if (!isFlexTier(tier)) return { tries, timeoutMs };
  return {
    tries: Math.max(Number(tries) || 0, OPENAI_FLEX_MIN_RETRIES),
    timeoutMs: Number(timeoutMs) || OPENAI_FLEX_TIMEOUT_MS,
  };
}

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * fetchOpenAIWithFlexRetry({ apiKey, deployment, messages, maxTokens, temperature, jsonMode, tier,
 *                            caller, tries }) -> Promise<string>
 * The ONE shared OpenAI chat-completions caller for anything that wants the flex lane through a
 * single call, built for callers that do not already hand-roll their own retry loop (the
 * recall-evals miners had NONE before this -- a bare `if (!r.ok) throw`, so adopting this here is a
 * strict improvement under flex and BYTE-IDENTICAL in the default/non-flex case, never a behavior
 * change to an existing retry contract). Builds the request body via chatBody() (the fleet's single
 * request-shape source of truth) and resolves `service_tier` via `tier` if given, else
 * `serviceTierFor(caller)`.
 *
 * DEFAULT (non-flex) BEHAVIOR IS BYTE-IDENTICAL TO A SINGLE PLAIN FETCH: `tries` defaults to 1 (no
 * retry at all), no `service_tier` key is added, and no AbortSignal is attached -- a 429 or any other
 * non-2xx throws immediately with the exact `chat ${status}: ${body}` message shape every existing
 * per-file callChatOpenAI/callOpenAI helper in this toolkit already uses. Only when the resolved tier
 * is "flex" does flexRetryPolicy() floor `tries` upward and attach a per-attempt timeout, and ONLY
 * then does a 429 get retried with backoff (honoring a `Retry-After` header when present, else
 * 1500ms * attempt-number) -- this is the "callers should retry 429 with backoff" contract flex
 * signals, and it activates ONLY under flex so a non-flex caller's timing is never touched.
 *
 * A non-429 HTTP failure NEVER retries (fails loud immediately, any tier) -- a flex-lane failure must
 * never masquerade as a completed judgement. On genuine 429 exhaustion under flex, the thrown error
 * carries `.throttled = true` (the same tag every existing per-file helper already uses so a caller
 * can distinguish "gave up after real retries" and, e.g., fall back to a different model/tier).
 *
 * REASONING-TRUNCATION (2026-08-30, FND-20260830-e927): on the FINAL attempt (no more retries left
 * in `effTries`), a truncatedEmpty() response now THROWS (tagged `.reasoningExhausted = true`)
 * instead of falling through to `return ... || ''`. Before this, a reasoning-family model that
 * spent its entire max_completion_tokens budget on hidden reasoning came back as an ordinary HTTP
 * 200 with empty content, and this function handed that empty string back to the caller as if it
 * were a real (if blank) answer -- both of this function's two current callers
 * (recall-evals/mine-hard-negatives.mjs, recall-evals/mine-cases.mjs) already treat a thrown error
 * from this call as "skip this candidate, log why, continue" (their own try/catch predates this
 * change), so throwing here costs nothing and turns a generic "unparseable/incomplete candidate"
 * diagnosis into a precise one.
 *
 * A truncated-empty response BEFORE the final attempt is RETRIED, in the same loop that retries a
 * 429, at the SAME budget -- reasoning spend is non-deterministic on identical input, so a plain
 * retry frequently succeeds (see this file's REASONING-BUDGET SIBLINGS section for the measurements).
 * With the default `tries: 1` there is no attempt after the first, so a truncated-empty throws
 * immediately and behavior is unchanged; the retry matters once a caller resolves to flex, where
 * flexRetryPolicy() floors `tries` to OPENAI_FLEX_MIN_RETRIES. What this helper does NOT do is
 * ESCALATE the budget between attempts -- it has no caller-specific sense of a safe larger budget, so
 * a caller wanting escalation raises its own `maxTokens`, or catches `.reasoningExhausted` and
 * decides for itself.
 */
export async function fetchOpenAIWithFlexRetry({ apiKey, deployment, messages, maxTokens, temperature, jsonMode, tier, caller, tries = 1 } = {}) {
  const resolvedTier = tier !== undefined ? tier : serviceTierFor(caller);
  const policy = flexRetryPolicy(resolvedTier, { tries });
  const effTries = Math.max(1, Number(policy.tries) || tries || 1);
  const body = { ...chatBody(deployment, { messages, maxTokens, temperature, jsonMode, serviceTier: resolvedTier }), model: deployment };
  for (let attempt = 0; attempt < effTries; attempt++) {
    const init = { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    if (policy.timeoutMs) init.signal = AbortSignal.timeout(policy.timeoutMs);
    const r = await fetch(OPENAI_CHAT_COMPLETIONS_URL, init);
    if (r.status === 429) {
      if (attempt < effTries - 1) {
        const ra = +(r.headers.get('retry-after') || 0);
        await new Promise((resolveWait) => setTimeout(resolveWait, ra ? ra * 1000 : 1500 * (attempt + 1)));
        continue;
      }
      const errBody = (await r.text()).slice(0, 160);
      throw Object.assign(new Error(`chat ${r.status}: ${errBody}`), effTries > 1 ? { throttled: true } : {});
    }
    if (!r.ok) throw new Error(`chat ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const choice = (await r.json()).choices?.[0];
    if (truncatedEmpty(choice)) {
      // RETRY while attempts remain, mirroring the 429 branch above -- do NOT throw on the first
      // occurrence. Reasoning-token spend is NON-DETERMINISTIC on identical input (339-1657 observed
      // across repeat calls), so a plain retry at the same budget frequently succeeds; throwing
      // immediately discards exactly the recovery this helper exists to provide.
      //
      // "every caller passes tries:1 so a retry loop is moot" is true only of the tries ARGUMENT.
      // flexRetryPolicy() FLOORS tries to OPENAI_FLEX_MIN_RETRIES (6) whenever the resolved tier is
      // flex, so arming flex on either recall-evals miner (per-caller OPENAI_SERVICE_TIER_* or the
      // fleet-wide OPENAI_SERVICE_TIER) silently makes effTries 6 -- and the old code would have
      // burned the first attempt and thrown away the other five, precisely when the non-determinism
      // above means retrying is most likely to work.
      if (attempt < effTries - 1) continue;
      throw Object.assign(
        new Error(`chat: reasoning model "${deployment}" exhausted its token budget (${maxTokens}) on hidden reasoning with no visible output (finish_reason=length) after ${effTries} attempt(s) -- this is an infra failure, not a real empty answer`),
        { reasoningExhausted: true }
      );
    }
    return choice?.message?.content || '';
  }
  /* c8 ignore next -- unreachable: every loop iteration above either continues, throws, or returns */
  throw Object.assign(new Error('chat 429 exhausted'), { throttled: true });
}

// =============================================================================================
// BATCH API (2026-09-02) -- OpenAI's `/v1/batches` lane for latency-tolerant nightly/scheduled
// callers that submit MANY independent chat-completions requests per run (agent-evals' persona +
// judge calls, the recall-evals miners, the signal-radar detectors, doc-indexer/enrich.mjs). Live-
// verified against OpenAI's current Batch guide (https://developers.openai.com/api/docs/guides/batch,
// fetched 2026-09-02):
//   - Flat 50% cost discount vs the synchronous endpoint, a SEPARATE (larger) rate-limit pool, and a
//     24-hour completion window ("often more quickly"). STACKS with prompt caching (a batched request
//     with a cache-hit prefix still gets the 0.1x cached-input rate on top of the 50% batch discount).
//   - Mechanics: POST a .jsonl file to /v1/files with purpose:"batch" (one line per request:
//     {custom_id, method:"POST", url:"/v1/chat/completions", body}), POST /v1/batches with that
//     file's id + endpoint + completion_window:"24h", then poll GET /v1/batches/{id} until status is
//     terminal. Status enum (verbatim from the live doc): validating -> in_progress -> finalizing ->
//     completed (success) | failed | expired | cancelling -> cancelled. On completed, download
//     output_file_id (and error_file_id, if any lines errored) via GET /v1/files/{id}/content; each
//     output line is {id, custom_id, response:{status_code, body:{...chat.completion...}}, error}.
//     "The output line order may not match the input line order" (verbatim) -- every consumer here
//     keys results by custom_id, NEVER by array position.
//   - Per-batch limits (verbatim): up to 50,000 requests per batch, input file up to 200 MB, and
//     "each input file can only include requests to a single model" -- submitBatch() below enforces
//     that last one (fail loud on a mixed-model batch) since silently splitting or rejecting-late
//     would be a worse failure mode than refusing up front.
//
// FAIL-LOUD CONTRACT (mirrors this file's existing fetchOpenAIWithFlexRetry/truncatedEmpty posture,
// and the fleet's standing "a dead dependency must never look like a clean empty result" rule -- see
// FND-20260819-c9bb): awaitBatch() THROWS on a terminal failed/expired/cancelled batch, THROWS if the
// batch completed with a per-line error (the error text is surfaced, never swallowed), and every
// caller in this sweep additionally calls assertAllBatchResultsPresent() so a custom_id that is simply
// ABSENT from both the output and error files (never treated as identical to "errored") is caught too.
//
// Fully additive and OFF by default: nothing in this section runs unless a caller explicitly invokes
// submitBatch()/awaitBatch(), which every caller in this sweep gates behind isBatchEnabled(<caller>)
// (OPENAI_BATCH=1 fleet-wide, or OPENAI_BATCH_<CALLER>=1 per job) -- see that function's own doc
// comment. Ship dark; arm per job once the CTO has reviewed the specific caller's batch integration.
// =============================================================================================

const OPENAI_FILES_URL = 'https://api.openai.com/v1/files';
const OPENAI_BATCHES_URL = 'https://api.openai.com/v1/batches';
const BATCH_TERMINAL_FAILURE_STATUSES = new Set(['failed', 'expired', 'cancelled']);

/** batchEnvVar(caller) -> "OPENAI_BATCH_<CALLER>", or null for an empty/missing caller name. Same
 *  slugification as serviceTierEnvVar() above (uppercase, non-alnum runs -> single underscore,
 *  trimmed) so the two families of per-caller override names are visually consistent fleet-wide. */
export function batchEnvVar(caller) {
  const slug = String(caller || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug ? `OPENAI_BATCH_${slug}` : null;
}

function truthyEnvFlag(raw) {
  return /^(1|true|yes|on)$/i.test(String(raw ?? '').trim());
}

/**
 * isBatchEnabled(caller) -> boolean
 * A per-caller override (OPENAI_BATCH_<CALLER>), when EXPLICITLY SET (even to "0"/"false"), always
 * wins over the fleet-wide default -- this is a presence check, not a truthiness-of-empty-string
 * check, so a job can force itself OFF even while OPENAI_BATCH=1 is set globally. When no per-caller
 * override is set, falls back to the fleet-wide OPENAI_BATCH. Both unset (the state of every job
 * today) resolves to false -- batch mode is opt-in, per job, never inferred.
 */
export function isBatchEnabled(caller) {
  const perCallerVar = batchEnvVar(caller);
  if (perCallerVar && process.env[perCallerVar] !== undefined) return truthyEnvFlag(process.env[perCallerVar]);
  return truthyEnvFlag(process.env.OPENAI_BATCH);
}

/**
 * buildBatchLine({ customId, deployment, messages, maxTokens, temperature, jsonMode, url }) -> line
 * Builds ONE JSONL-ready batch-request object via chatBody() (the SAME family-aware request-shape
 * source of truth every synchronous caller in this file already uses), so a request built for the
 * batch lane is byte-identical in shape to the equivalent synchronous request except for the
 * envelope (`custom_id`/`method`/`url` wrapping `body`, and `body.model` set explicitly the same way
 * fetchOpenAIWithFlexRetry() does). `customId` is required and coerced to a string (OpenAI's
 * custom_id is a string field); `url` defaults to the chat-completions endpoint.
 */
export function buildBatchLine({ customId, deployment, messages, maxTokens, temperature, jsonMode, url = '/v1/chat/completions' } = {}) {
  if (customId == null || customId === '') throw new Error('buildBatchLine: customId is required');
  const body = { ...chatBody(deployment, { messages, maxTokens, temperature, jsonMode }), model: deployment };
  return { custom_id: String(customId), method: 'POST', url, body };
}

/**
 * submitBatch(lines, { apiKey, completionWindow, metadata }) -> Promise<batchId>
 * `lines` is an array of already-built batch-line objects (see buildBatchLine() above). Validates
 * FIRST, before any network call: at least one line, every line has a non-empty custom_id, no
 * duplicate custom_id (a duplicate would make the result impossible to disambiguate later), and every
 * line targets the SAME model (OpenAI's own "single model per file" constraint -- see this section's
 * header). Writes the JSONL, uploads it via POST /v1/files (purpose:"batch"), then creates the batch
 * via POST /v1/batches. Returns the new batch's id. Throws with a descriptive message on any
 * validation failure or non-2xx response at either step -- never returns a falsy/partial id.
 */
export async function submitBatch(lines, { apiKey, completionWindow = '24h', endpoint = '/v1/chat/completions', metadata, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('submitBatch: missing apiKey');
  if (!Array.isArray(lines) || !lines.length) throw new Error('submitBatch: no requests supplied (lines must be a non-empty array)');
  const seen = new Set();
  const models = new Set();
  for (const line of lines) {
    if (!line || !line.custom_id) throw new Error('submitBatch: every line needs a non-empty custom_id');
    if (seen.has(line.custom_id)) throw new Error(`submitBatch: duplicate custom_id "${line.custom_id}"`);
    seen.add(line.custom_id);
    if (line.body?.model) models.add(line.body.model);
  }
  if (models.size > 1) {
    throw new Error(`submitBatch: OpenAI batches may only target a single model per file, got ${models.size}: ${[...models].join(', ')}`);
  }
  const jsonl = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'batch-input.jsonl');
  const upRes = await fetchImpl(OPENAI_FILES_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
  if (!upRes.ok) throw new Error(`submitBatch: file upload failed, HTTP ${upRes.status}: ${(await upRes.text()).slice(0, 200)}`);
  const upJson = await upRes.json();
  if (!upJson.id) throw new Error('submitBatch: file upload returned no file id');
  const createRes = await fetchImpl(OPENAI_BATCHES_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input_file_id: upJson.id, endpoint, completion_window: completionWindow, ...(metadata ? { metadata } : {}) }),
  });
  if (!createRes.ok) throw new Error(`submitBatch: batch create failed, HTTP ${createRes.status}: ${(await createRes.text()).slice(0, 200)}`);
  const createJson = await createRes.json();
  if (!createJson.id) throw new Error('submitBatch: batch create returned no batch id');
  return createJson.id;
}

async function downloadBatchJsonl(fileId, apiKey, fetchImpl) {
  const r = await fetchImpl(`${OPENAI_FILES_URL}/${fileId}/content`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!r.ok) throw new Error(`awaitBatch: GET /v1/files/${fileId}/content -> HTTP ${r.status}`);
  const text = await r.text();
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export const OPENAI_BATCH_POLL_MS = Number(process.env.OPENAI_BATCH_POLL_MS) || 30000; // 30s
export const OPENAI_BATCH_TIMEOUT_MS = Number(process.env.OPENAI_BATCH_TIMEOUT_MS) || 24 * 60 * 60 * 1000; // 24h, matches completion_window

/**
 * awaitBatch(batchId, { apiKey, timeoutMs, pollIntervalMs, onPoll, sleepFn }) -> Promise<{ batch, results }>
 * Polls GET /v1/batches/{id} until a terminal status. On "completed", downloads output_file_id (and
 * error_file_id, if present) and returns `results`, a Map<custom_id, { error, content, raw }> where
 * `content` is the assistant message text (choices[0].message.content) on success and `error` is a
 * short human-readable string on failure (`content` is null in that case). A custom_id present ONLY
 * in the error file still gets an entry here (never silently absent).
 *
 * FAIL LOUD (never treat a missing/ambiguous outcome as success):
 *   - A terminal failed/expired/cancelled batch THROWS (tagged `.batchStatus`/`.batch`), never
 *     returns a partial/empty result set silently.
 *   - A completed batch with NO output_file_id and NO error_file_id (should not happen per the API
 *     contract, but a network/response anomaly is not impossible) THROWS rather than returning `{}`.
 *   - Exceeding `timeoutMs` while still non-terminal THROWS (tagged `.timedOut`) rather than
 *     returning whatever partial state was last observed.
 * A per-line error (in either file) is recorded in `results` as `{error, content:null}`, NOT thrown
 * here -- the caller decides whether one bad line should fail the whole run; every caller in this
 * sweep additionally calls assertAllBatchResultsPresent() and then fails loud per-item, matching the
 * existing per-task/per-row error handling each of those callers already had for the synchronous path.
 *
 * `onPoll({ status, elapsedMs })` is an OPTIONAL heartbeat invoked once per poll iteration (including
 * the first), before the terminal check -- useful for a caller that needs to do something during a
 * potentially long wait (doc-indexer/enrich.mjs's batch mode uses it to refresh its Blob/S3 lock, which
 * otherwise expires after 15 minutes; see that file for the concrete use). Never awaited for its
 * return value and any exception it throws propagates (a caller's heartbeat failing is itself
 * information the caller should decide how to handle, not something this generic poller should hide).
 */
export async function awaitBatch(batchId, { apiKey, timeoutMs = OPENAI_BATCH_TIMEOUT_MS, pollIntervalMs = OPENAI_BATCH_POLL_MS, onPoll, sleepFn, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('awaitBatch: missing apiKey');
  if (!batchId) throw new Error('awaitBatch: missing batchId');
  const sleep = sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = Date.now();
  const deadline = start + timeoutMs;
  let batch;
  for (;;) {
    const r = await fetchImpl(`${OPENAI_BATCHES_URL}/${batchId}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!r.ok) throw new Error(`awaitBatch: GET /v1/batches/${batchId} -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    batch = await r.json();
    if (onPoll) onPoll({ status: batch.status, elapsedMs: Date.now() - start });
    if (batch.status === 'completed') break;
    if (BATCH_TERMINAL_FAILURE_STATUSES.has(batch.status)) {
      const errDetail = batch.errors ? JSON.stringify(batch.errors).slice(0, 400) : '(no error detail on the batch object)';
      throw Object.assign(new Error(`awaitBatch: batch ${batchId} ended in terminal status "${batch.status}": ${errDetail}`), { batchStatus: batch.status, batch });
    }
    if (Date.now() > deadline) {
      throw Object.assign(new Error(`awaitBatch: timed out after ${timeoutMs}ms waiting on batch ${batchId} (last status "${batch.status}")`), { timedOut: true, batch });
    }
    await sleep(pollIntervalMs);
  }

  const results = new Map();
  if (batch.output_file_id) {
    for (const line of await downloadBatchJsonl(batch.output_file_id, apiKey, fetchImpl)) {
      const customId = line.custom_id;
      if (!customId) continue;
      const respBody = line.response?.body;
      const choice = respBody?.choices?.[0];
      const content = choice?.message?.content;
      if (line.error || !respBody || content == null) {
        results.set(customId, { error: line.error ? (line.error.message || JSON.stringify(line.error)) : `batch line "${customId}" had no usable response body`, content: null, raw: line });
      } else if (truncatedEmpty(choice)) {
        // Same failure class this file already guards on the SYNCHRONOUS path (see
        // fetchOpenAIWithFlexRetry's own reasoningExhausted handling above): a reasoning-family model
        // can spend its entire max_completion_tokens budget on hidden reasoning and return an HTTP-200
        // batch line with finish_reason:"length" and EMPTY visible content. Batch has no retry-within-
        // the-same-request mechanism (unlike the synchronous escalate-and-retry paths elsewhere in this
        // file), so this is recorded as an ERROR rather than a real (blank) answer -- a caller decides
        // whether to resubmit just this custom_id in a follow-up batch/synchronous call.
        results.set(customId, { error: `batch line "${customId}": reasoning model exhausted its token budget on hidden reasoning with no visible output (finish_reason=length) -- an infra failure, not a real (blank) answer`, content: null, raw: line });
      } else {
        results.set(customId, { error: null, content, raw: line });
      }
    }
  }
  if (batch.error_file_id) {
    for (const line of await downloadBatchJsonl(batch.error_file_id, apiKey, fetchImpl)) {
      const customId = line.custom_id;
      if (!customId || results.has(customId)) continue; // the output file (if any) is authoritative for a given custom_id
      results.set(customId, { error: line.error ? (line.error.message || JSON.stringify(line.error)) : 'batch error-file entry with no detail', content: null, raw: line });
    }
  }
  if (!batch.output_file_id && !batch.error_file_id) {
    throw new Error(`awaitBatch: batch ${batchId} completed with neither an output_file_id nor an error_file_id -- cannot recover any result`);
  }
  return { batch, results };
}

/**
 * assertAllBatchResultsPresent(customIds, results) -> void (throws on any gap)
 * `results` is the Map returned by awaitBatch(). Throws if any of `customIds` has NO entry at all in
 * `results` (distinct from an entry with `.error` set -- that is a known, surfaced per-line failure;
 * a MISSING entry means the batch's own output/error files never mentioned that request at all, which
 * must never be silently treated as success). Every caller in this sweep calls this immediately after
 * awaitBatch() and before using any result, mirroring the task's own explicit requirement: "never
 * treat a missing result as success."
 */
export function assertAllBatchResultsPresent(customIds, results) {
  const missing = (customIds || []).filter((id) => !results.has(id));
  if (missing.length) {
    throw new Error(`batch: ${missing.length} custom_id(s) got NO result at all (missing from both the output and error files, not merely errored): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}`);
  }
}

export default {
  TIERS,
  OPENAI_TIERS,
  OPENAI_TIER_ENV_VARS,
  LEGACY_STANDARD,
  modelFamilyOf,
  truncatedEmpty,
  positiveIntEnv,
  resolveTier,
  chatBody,
  warnIfImplausibleOpenAIModel,
  verifyOpenAITiers,
  serviceTierEnvVar,
  serviceTierFor,
  isFlexTier,
  flexRetryPolicy,
  fetchOpenAIWithFlexRetry,
  OPENAI_FLEX_TIMEOUT_MS,
  OPENAI_FLEX_MIN_RETRIES,
  batchEnvVar,
  isBatchEnabled,
  buildBatchLine,
  submitBatch,
  awaitBatch,
  assertAllBatchResultsPresent,
  OPENAI_BATCH_POLL_MS,
  OPENAI_BATCH_TIMEOUT_MS,
};

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
 *   chatBody(deployment, { messages, maxTokens, temperature, jsonMode })
 * Reasoning-family: { messages, max_completion_tokens } (no temperature override, ever - the API
 * rejects a non-default value). Chat-family: { messages, max_tokens, temperature } (temperature
 * defaults to 0.2 when not given, matching the fleet's existing synthesis/judge callers).
 */
export function chatBody(deployment, { messages, maxTokens = 900, temperature, jsonMode } = {}) {
  const isReasoning = modelFamilyOf(deployment) === 'reasoning';
  const body = { messages };
  if (isReasoning) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
    body.temperature = typeof temperature === 'number' ? temperature : 0.2;
  }
  if (jsonMode) body.response_format = { type: 'json_object' };
  return body;
}

export default {
  TIERS,
  OPENAI_TIERS,
  OPENAI_TIER_ENV_VARS,
  LEGACY_STANDARD,
  modelFamilyOf,
  resolveTier,
  chatBody,
  warnIfImplausibleOpenAIModel,
  verifyOpenAITiers,
};

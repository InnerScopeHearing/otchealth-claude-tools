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
// to get the tier defaults + the correctly-shaped request body.

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

// OPENAI_TIERS (2026-08-27, Azure Foundry retirement port): the OpenAI-provider counterpart to TIERS
// above. Azure subscription 55c84f6b (the whole Foundry estate) is permanently deleted, so every
// caller that resolved a tier for a Foundry deployment needs an OpenAI model id instead. This reuses
// the SAME deployment-name strings as the Foundry tiers wherever OpenAI serves an identical model id
// -- 'gpt-4.1' and 'gpt-5.1' are both real OpenAI models, not just Azure deployment aliases -- which is
// the exact bet skills/company-brain/brain.mjs already makes and has proven live in production. Putting
// it here, once, means every quality-LLM caller (critic-pass, agent-evals, focus-group-loop,
// recall-evals, and company-brain before them) resolves "which model, on OpenAI" from ONE place
// instead of a hardcoded literal re-typed per file -- the exact drift class that let a stale
// gpt-4.1-mini fallback linger across three skills before setup/model-routing.mjs existed (see this
// file's own header). 'cheap' does NOT reuse TIERS.cheap ('gpt-4.1-mini', an Azure deployment name):
// OpenAI's equivalent commodity model for bulk extraction/classification is 'gpt-4o-mini'. The
// gpt-4.1-mini-for-quality-summarization ban this file documents applies to 'quality'/'standard' only;
// it never applied to 'cheap' on either provider.
export const OPENAI_TIERS = {
  quality: { deployment: TIERS.quality.deployment, modelFamily: TIERS.quality.modelFamily },   // gpt-5.1
  standard: { deployment: TIERS.standard.deployment, modelFamily: TIERS.standard.modelFamily }, // gpt-4.1
  cheap: { deployment: 'gpt-4o-mini', modelFamily: 'chat' },
};

// Reasoning-family deployments (gpt-5.x, o-series) reject max_tokens + a non-default temperature;
// they require max_completion_tokens and no temperature override. Chat-family (gpt-4o, gpt-4.1-mini,
// etc.) keeps the classic max_tokens + temperature shape. Mirrors otchealth-mcp-server's foundry.ts.
const REASONING_FAMILY = /^(gpt-5|o[0-9])/i;

/** Classify a deployment name into 'reasoning' or 'chat'. Pure string test, no I/O. */
export function modelFamilyOf(deployment) {
  return REASONING_FAMILY.test(deployment || '') ? 'reasoning' : 'chat';
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

export default { TIERS, OPENAI_TIERS, LEGACY_STANDARD, modelFamilyOf, resolveTier, chatBody };

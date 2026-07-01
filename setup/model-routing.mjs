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
  standard: { deployment: 'gpt-4o', modelFamily: 'chat' },
  cheap: { deployment: 'gpt-4.1-mini', modelFamily: 'chat' },
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
 * - A known tier key ('quality' | 'standard' | 'cheap') returns that tier's default deployment.
 * - Anything else is treated as an explicit deployment override (e.g. an env-var value a caller
 *   already resolved, such as BRAIN_MODEL / FGL_MODEL / AGENT_MODEL); its family is inferred.
 */
export function resolveTier(tierOrDeployment) {
  const known = TIERS[tierOrDeployment];
  if (known) return { deployment: known.deployment, modelFamily: known.modelFamily };
  const deployment = tierOrDeployment || TIERS.standard.deployment;
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

export default { TIERS, modelFamilyOf, resolveTier, chatBody };

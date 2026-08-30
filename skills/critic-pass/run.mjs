#!/usr/bin/env node
// critic-pass / run.mjs — the EXECUTOR that turns critic-pass from advisory into an actual pass.
//
// critic.mjs is pure (buildCriticPrompt / parseCriticVerdict / shouldRevise) and explicitly leaves the
// model call to "the orchestrator/gateway". This module IS that supplier: it makes the real cheap-model
// chat call (Azure OpenAI via the fleet's single model-routing source of truth) and returns a parsed
// verdict, so the orchestrator can RUN a critic pass in one call instead of hand-wiring prompt->model->parse.
//
// It is the executable the orchestrator invokes when compute-allocator sets useCritic=true (criticGate),
// and it is fail-SAFE end to end: any failure (no creds, throttle exhausted, network, malformed output)
// degrades to {verdict:"approve", malformed:true} — a broken critic pass NEVER blocks the pipeline, same
// report-mode posture as critic.mjs. Dependency injection (chatFn) keeps it unit-testable offline.
//
// Model tier: defaults to 'standard' (a gpt-4o-class model, chat-family) — the Sonnet-tier analog
// critic-pass is designed for, cheaper than the Opus/gpt-5.1 draft it reviews, and NOT the banned
// gpt-4.1-mini 'cheap' tier (banned for quality/synthesis work; a critic IS evaluation work). Override
// via CRITIC_MODEL.
//
// LLM_PROVIDER (2026-08-27, Azure Foundry retirement port): Azure subscription 55c84f6b (the whole
// Foundry estate this file called exclusively) is permanently deleted -- verified 401 forever, not a
// transient outage. Default flips to 'openai' (api.openai.com, model ids from
// setup/model-routing.mjs's OPENAI_TIERS -- the SAME tier keys, so CRITIC_MODEL/CRITIC_FALLBACK_MODEL
// still mean "standard"/"quality" regardless of provider). LLM_PROVIDER=foundry/azure keeps the
// original Foundry-then-legacy path selectable, one env var away, if that estate is ever re-provisioned.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { buildCriticPrompt, parseCriticVerdict, shouldRevise } from "./critic.mjs";
import { chatBody, resolveTier, LEGACY_STANDARD, serviceTierFor, flexRetryPolicy } from "../../setup/model-routing.mjs";
import { kvSecret } from "../kb-memory/azure-secret.mjs";

const SM = "otchealth-shared-prod";
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "openai").toLowerCase();
const TIER_PROVIDER = LLM_PROVIDER === "openai" ? "openai" : "azure";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
// FLEX PROCESSING (2026-08-29): critic-pass is a report-mode, non-blocking PR gate -- exactly the
// "latency-tolerant nightly/background" shape the flex lane targets. Caller label "critic-pass" ->
// env override OPENAI_SERVICE_TIER_CRITIC_PASS (or the fleet-wide OPENAI_SERVICE_TIER). UNSET (the
// default everywhere today) resolves to undefined, so CRITIC_TIER below is undefined and every line
// touched in callChatOpenAI is byte-identical to before this lane existed -- see model-routing.mjs's
// own header for the full contract (why 429 retries only activate under flex, why a genuine non-429
// failure never retries).
const CRITIC_TIER = serviceTierFor("critic-pass");
const CRITIC_SYSTEM =
  "You are a cheap, fast CRITIC pass. Review the draft strictly against the task and return STRICT JSON only, exactly as the prompt specifies. Do not rewrite the draft.";

// CRITIC_MAX_TOKENS (2026-08-30, root cause of FND-20260830-e7c1): OPENAI_TIERS.standard moved to a
// REASONING-family model (gpt-5.6-terra, model-routing.mjs's 2026-08-29 refresh). A reasoning model's
// hidden "thinking" tokens count against max_completion_tokens and are spent BEFORE any visible
// output -- so the old 700 default (tuned for the prior CHAT-family gpt-4.1, which had no hidden
// token cost) let the model burn its ENTIRE budget on reasoning and return finish_reason:"length"
// with an EMPTY content string. parseCriticVerdict("") then fails safe to malformed:true, which is
// exactly how every claude/* PR's auto critic silently stopped producing a real review overnight
// (reproduced live against the actual PR #499 diff that triggered the finding: 700 tokens -> 700
// reasoning_tokens -> empty content -> malformed:true; verified this is the SAME failure, not a
// coincidence). Live-tested against both a small real diff (7.7KB) and critic-pr.yml's own maximum
// (80KB, `head -c 80000`): 2000-4000 tokens reliably produced a real, parseable verdict every time
// (observed reasoning-token spend ranged 339-1657 across repeated calls on the SAME input -- itself
// non-deterministic, so this needs real margin, not just "one more than what failed once"). 3000
// leaves that margin. Env-overridable (CRITIC_MAX_TOKENS) like every other tunable in this file.
// positiveInt() guards that override: an unset, empty, zero, negative, or non-finite value (e.g.
// "0", "-1", "Infinity", a typo) falls back to the safe default instead of being sent to the API
// as-is, which would either silently disable the budget or throw a confusing provider error. Floors
// FIRST, then validates the floored result, not the raw input: a raw value strictly between 0 and 1
// (e.g. "0.7") is positive before flooring but floors to 0, which is exactly the degenerate value
// this guard exists to prevent -- validating the pre-floor value would have let it through.
function positiveInt(raw, fallback) {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const CRITIC_MAX_TOKENS = positiveInt(process.env.CRITIC_MAX_TOKENS, 3000);

// ---- creds (same JWT-SA -> Secret Manager pattern the rest of the toolkit uses) ----
function resolveSa() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  try { try { return readFileSync(`${homedir()}/.gcp_claude_driver_sa.json`, "utf8"); } catch { return null; } } catch { return null; }
}
function saJwt(saRaw) {
  const sa = JSON.parse(saRaw);
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
}
async function sm(id, saRaw) { const _kv = await kvSecret(id); if (_kv != null) return _kv;
  if (!saRaw) return null; // no GCP SA post-exit -> Key Vault only (via kvSecret above); skip the retired SM fallback
  const t = (await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt(saRaw))}` })).json()).access_token;
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: "Bearer " + t } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}

// truncatedEmpty(choice) -> true when a reasoning-family model spent its ENTIRE token budget on
// hidden reasoning and returned no visible output at all (finish_reason:"length" + empty/whitespace
// content). This is NOT an HTTP error and NOT a 429 -- the call itself succeeded -- so it needs its
// own detection, distinct from both existing retry branches below. See CRITIC_MAX_TOKENS's doc
// comment above for the incident this fixes (FND-20260830-e7c1).
function truncatedEmpty(choice) {
  return choice?.finish_reason === "length" && !String(choice?.message?.content ?? "").trim();
}

async function callChat(ep, key, dep, system, user, maxTokens, tries) {
  const body = chatBody(dep, { messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens, jsonMode: true });
  const tokenKey = body.max_completion_tokens != null ? "max_completion_tokens" : "max_tokens";
  let escalated = false;
  for (let a = 0; a < tries; a++) {
    const r = await fetch(`${ep}/openai/deployments/${dep}/chat/completions?api-version=2024-02-01`, { method: "POST", headers: { "api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 429) { const ra = +(r.headers.get("retry-after") || 0); await new Promise((s) => setTimeout(s, ra ? ra * 1000 : 1500 * (a + 1))); continue; }
    if (!r.ok) throw new Error("chat " + r.status + " " + (await r.text()).slice(0, 160));
    const choice = (await r.json()).choices[0];
    // On truncated-empty, retry within the SAME existing `tries` budget the 429 path already uses
    // (so this never costs more worst-case calls than that pre-existing retry allowance) -- but
    // double the token budget only the FIRST time this happens (`escalated` latches permanently),
    // never on every subsequent attempt. Reasoning-token spend is stochastic per call (observed
    // 339-1657 tokens on the SAME real input across repeated live calls), so a later attempt at the
    // SAME escalated budget can still succeed even without escalating again. See truncatedEmpty's
    // doc comment for the incident this fixes.
    if (truncatedEmpty(choice) && a < tries - 1) { if (!escalated) { escalated = true; body[tokenKey] = body[tokenKey] * 2; } continue; }
    return choice.message.content;
  }
  throw Object.assign(new Error("chat 429 exhausted"), { throttled: true });
}

// OpenAI-direct call, same request/response shape as Azure's chat.completions (chatBody() is
// provider-agnostic; OpenAI just wants the model NAME in the body instead of the URL, and a bearer
// token instead of an api-key header). Mirrors callChat's retry/429 handling exactly.
//
// FLEX PROCESSING (2026-08-29): when CRITIC_TIER resolves to "flex" (OPENAI_SERVICE_TIER_CRITIC_PASS
// or the fleet-wide OPENAI_SERVICE_TIER), flexRetryPolicy() floors `tries` upward and supplies a
// per-attempt AbortSignal timeout; the body carries `service_tier: "flex"`. CRITIC_TIER unset (the
// default) makes flexRetryPolicy() a pure passthrough -- `effTries === tries` and no signal is ever
// attached -- so this is BYTE-IDENTICAL to before this lane existed. A non-429 failure still never
// retries, any tier (fail loud, never a silently-defeated flex saving and never a masqueraded verdict).
async function callChatOpenAI(key, dep, system, user, maxTokens, tries) {
  const policy = flexRetryPolicy(CRITIC_TIER, { tries });
  const effTries = policy.tries || tries;
  const body = { ...chatBody(dep, { messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens, jsonMode: true, serviceTier: CRITIC_TIER }), model: dep };
  const tokenKey = body.max_completion_tokens != null ? "max_completion_tokens" : "max_tokens";
  let escalated = false;
  for (let a = 0; a < effTries; a++) {
    const init = { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) };
    if (policy.timeoutMs) init.signal = AbortSignal.timeout(policy.timeoutMs);
    const r = await fetch(OPENAI_CHAT_URL, init);
    if (r.status === 429) { const ra = +(r.headers.get("retry-after") || 0); await new Promise((s) => setTimeout(s, ra ? ra * 1000 : 1500 * (a + 1))); continue; }
    if (!r.ok) throw new Error("chat " + r.status + " " + (await r.text()).slice(0, 160));
    const choice = (await r.json()).choices[0];
    // On truncated-empty, retry within the SAME existing `effTries` budget the 429 path already
    // uses (never more worst-case calls than that pre-existing retry allowance) -- but double the
    // token budget only the FIRST time this happens (`escalated` latches permanently), never on
    // every subsequent attempt. See truncatedEmpty's doc comment on the Azure callChat() above
    // (same failure, same fix shape, same reasoning about why a same-budget retry can still help).
    if (truncatedEmpty(choice) && a < effTries - 1) { if (!escalated) { escalated = true; body[tokenKey] = body[tokenKey] * 2; } continue; }
    return choice.message.content;
  }
  throw Object.assign(new Error("chat 429 exhausted"), { throttled: true });
}

// The default (real) model call: primary Foundry (gpt-4.1 standard, 2,000K TPM GlobalStandard),
// Foundry-quality (gpt-5.1) as a secondary fallback on throttle, and the LEGACY azure-openai resource
// (gpt-4o, 50K TPM, already 100% subscribed) as the last-resort fallback only. The legacy resource used
// to be primary here; that pairing broke once TIERS.standard.deployment moved to 'gpt-4.1' (a deployment
// that does not exist on the legacy resource) and it was also the direct cause of the fleet-wide Datadog
// "Azure OpenAI throttled (blocked_calls)" flap (see model-routing.mjs LEGACY_STANDARD comment).
// Mirrors agent-evals/run-evals.mjs's chat() so the whole fleet agrees on endpoints + throttle handling.
async function defaultAzureChat({ system, user, tier, maxTokens = CRITIC_MAX_TOKENS }) {
  const saRaw = resolveSa(); // may be null post-GCP-exit; sm() then resolves via Key Vault (OIDC on CI)
  const dep = resolveTier(process.env.CRITIC_MODEL || tier || "standard", "azure").deployment;
  const [ep, key] = await Promise.all([sm("azure-foundry-openai-endpoint", saRaw), sm("azure-foundry-key", saRaw)]);
  if (!ep || !key) throw new Error("missing azure-foundry endpoint/key");
  const endpoint = ep.replace(/\/$/, "");
  try {
    return await callChat(endpoint, key, dep, system, user, maxTokens, 4);
  } catch (e) {
    if (e.throttled) {
      try {
        const fbDep = resolveTier(process.env.CRITIC_FALLBACK_MODEL || "quality", "azure").deployment;
        return await callChat(endpoint, key, fbDep, system, user, maxTokens, 2);
      } catch (e2) {
        // last resort only: the legacy resource has zero headroom (50K/50K TPM), so it is a final
        // safety net once Foundry itself is throttled/unavailable, never the primary path.
        const [legEp, legKey] = await Promise.all([sm("azure-openai-endpoint", saRaw), sm("azure-openai-key", saRaw)]);
        if (legEp && legKey) return await callChat(legEp.replace(/\/$/, ""), legKey, LEGACY_STANDARD.deployment, system, user, maxTokens, 3);
        throw e2;
      }
    }
    throw e;
  }
}

// The default (real) model call on OpenAI-direct. Primary 'standard' (gpt-4.1, chat-family), falling
// back to 'quality' (gpt-5.1, reasoning-family) on a sustained throttle -- same tier names, same
// fallback shape as the Foundry path above, resolved against OPENAI_TIERS instead of TIERS. Key comes
// from env first (a caller/CI may already have it resolved), else the fleet secret store (SSM primary
// per kvSecret()'s SECRET_BACKEND default, Key Vault fallback).
async function defaultOpenAIChat({ system, user, tier, maxTokens = CRITIC_MAX_TOKENS }) {
  const key = process.env.OPENAI_API_KEY || (await kvSecret("openai-api-key"));
  if (!key) throw new Error("missing openai-api-key (env OPENAI_API_KEY or the fleet secret)");
  const dep = resolveTier(process.env.CRITIC_MODEL || tier || "standard", "openai").deployment;
  try {
    return await callChatOpenAI(key, dep, system, user, maxTokens, 4);
  } catch (e) {
    if (e.throttled) {
      const fbDep = resolveTier(process.env.CRITIC_FALLBACK_MODEL || "quality", "openai").deployment;
      if (fbDep !== dep) return await callChatOpenAI(key, fbDep, system, user, maxTokens, 4);
    }
    throw e;
  }
}

// Provider dispatch. Default LLM_PROVIDER=openai; LLM_PROVIDER=foundry/azure selects the original
// Foundry-then-legacy path (kept intact above, not removed) for a future re-provisioned Azure estate.
async function defaultChat(args) {
  return LLM_PROVIDER === "openai" ? defaultOpenAIChat(args) : defaultAzureChat(args);
}

/**
 * runCriticPass({ task, draft, constraints?, context?, tier?, minSeverity?, chatFn? })
 *   -> { ran:true, verdict, issues, confidence, malformed, unreachable?, shouldRevise, model, error?, note? }
 * Makes ONE real critic-model call (or uses an injected chatFn for tests), parses the verdict, and
 * computes shouldRevise. Report-mode, non-blocking either way, but TWO DIFFERENT failure shapes are
 * distinguished on purpose (see the catch block below): a model that answered with junk JSON
 * (malformed:true, verdict:"approve" — parseCriticVerdict's own fail-safe) is not the same event as a
 * model that was never reached at all (unreachable:true, verdict:null — this function's own catch).
 * tier defaults to 'standard' (a gpt-4o-class model, never the banned gpt-4.1-mini).
 */
export async function runCriticPass({ task, draft, constraints, context, tier, minSeverity = "medium", chatFn } = {}) {
  const model = resolveTier(process.env.CRITIC_MODEL || tier || "standard", TIER_PROVIDER).deployment;
  try {
    const prompt = buildCriticPrompt(task, draft, { constraints, context });
    const call = chatFn || defaultChat;
    const raw = await call({ system: CRITIC_SYSTEM, user: prompt, tier: tier || "standard" });
    const verdict = parseCriticVerdict(raw);
    // HONESTY (2026-08-30, FND-20260830-e7c1): a malformed verdict's own `verdict` field reads
    // "approve" (parseCriticVerdict's fail-safe, kept as-is -- see the module header, this must never
    // become a hard block). Without an explicit signal alongside it, a caller/renderer can mistake
    // that for a real, passing review -- which is exactly what happened: critic-pr.yml rendered a
    // malformed response as "the critic ran... fail-safe approve" and "informational only," soft
    // enough to read as a real (if uneventful) review. Give malformed the SAME unmistakable `note`
    // shape unreachable already carries, so nothing downstream has to re-derive "was this a real
    // review" from `malformed` alone.
    const note = verdict.malformed
      ? "critic ran but its response could not be parsed into a valid verdict — treat this PR as NOT reviewed by the auto critic"
      : undefined;
    return { ran: true, ...verdict, unreachable: false, shouldRevise: shouldRevise(verdict, { minSeverity }), model, ...(note ? { note } : {}) };
  } catch (e) {
    // UNREACHABLE, not malformed. Nothing inside the try above throws except `call()` itself
    // (buildCriticPrompt/parseCriticVerdict/shouldRevise are pure and never throw) — so every catch
    // here means the model was never reached: no creds, a network failure, or a throttle that never
    // recovered. Reporting that identically to "the model answered with junk JSON, fail-safe approve"
    // (the old shape: malformed:true, verdict:"approve") is exactly what let a totally-dead critic
    // look, on a real PR, like a review that happened and quietly approved (see FND-20260819-c9bb:
    // "the auto critic posted 'could not run cleanly (fail-safe approve)' and reported its check
    // SUCCESS on real PRs"). Still non-blocking (shouldRevise stays false, report-mode contract
    // unchanged) but verdict is null — NEVER "approve" — and `note` gives callers (critic-pr.yml) an
    // unmistakable label to render instead of a green checkmark.
    return {
      ran: true,
      verdict: null,
      issues: [],
      confidence: 0,
      malformed: false,
      unreachable: true,
      shouldRevise: false,
      model,
      error: String((e && e.message) || e),
      note: "critic did not run (LLM unreachable)",
    };
  }
}

/**
 * criticGate({ useCritic, task, draft, ... }) -> Promise<result>
 * The literal wiring of compute-allocator -> critic-pass: run a real critic pass ONLY when the allocator
 * (or the orchestrator) set useCritic=true. When useCritic is falsy this SHORT-CIRCUITS with no model
 * call at all ({ ran:false, skipped }), so a quiet/low-stakes task never pays for a critic pass. When
 * true it delegates to runCriticPass. This is what the orchestrator calls after allocateCompute().
 */
export async function criticGate({ useCritic, ...rest } = {}) {
  if (!useCritic) return { ran: false, verdict: null, shouldRevise: false, skipped: "useCritic=false" };
  return runCriticPass(rest);
}

// ---------------------------------------------------------------------------
// CLI: run a real critic pass on a draft.
//   node run.mjs --task "<task>" --draft-file <path> [--draft "<text>"] [--constraints "a;b;c"]
//                [--context "..."] [--min-severity high] [--tier standard]
//                [--if-critic] [--live] [--fail-on-revise]
// --if-critic : consult compute-allocator (allocateCompute on the task text; --live also pulls signals)
//               and RUN the pass only if it recommends useCritic=true; otherwise print {ran:false} and exit 0.
// --fail-on-revise : exit 3 when the verdict says revise (for orchestrators wanting a hard gate). Default
//                    is report-mode: always exit 0 and print the verdict JSON.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // task / context accept a --*-file variant (injection-safe: CI passes a PR title/body via a file, never
  // interpolated into the command line, so quotes/newlines/backticks in untrusted PR text can't break arg
  // parsing or inject flags). The inline --task/--context still work for interactive use.
  let task = typeof args.task === "string" ? args.task : "";
  if (!task && typeof args["task-file"] === "string") {
    try { task = readFileSync(args["task-file"], "utf8"); } catch (e) { console.error("cannot read --task-file: " + e.message); process.exit(2); }
  }
  let draft = typeof args.draft === "string" ? args.draft : "";
  if (!draft && typeof args["draft-file"] === "string") {
    try { draft = readFileSync(args["draft-file"], "utf8"); } catch (e) { console.error("cannot read --draft-file: " + e.message); process.exit(2); }
  }
  if (!task || !draft) { console.error('usage: node run.mjs (--task "<t>"|--task-file <p>) (--draft "<d>"|--draft-file <p>) [--context-file <p>] [--if-critic] [--live] [--min-severity high] [--fail-on-revise]'); process.exit(2); }

  const constraints = typeof args.constraints === "string" ? args.constraints.split(";").map((s) => s.trim()).filter(Boolean) : [];
  let context = typeof args.context === "string" ? args.context : "";
  if (!context && typeof args["context-file"] === "string") {
    try { context = readFileSync(args["context-file"], "utf8"); } catch { context = ""; } // context is optional; a missing file is non-fatal
  }
  const minSeverity = typeof args["min-severity"] === "string" ? args["min-severity"] : "medium";
  const tier = typeof args.tier === "string" ? args.tier : "standard";

  // --if-critic: let compute-allocator decide whether a critic pass is even warranted for this task.
  let useCritic = true;
  if (args["if-critic"]) {
    useCritic = false;
    try {
      const alloc = await import("../compute-allocator/allocate.mjs").catch(() => null);
      if (alloc && typeof alloc.allocateCompute === "function") {
        let recentSignals = [];
        if (args.live && typeof alloc.recentSignalsFor === "function") recentSignals = await alloc.recentSignalsFor("").catch(() => []);
        useCritic = !!alloc.allocateCompute({ taskText: task, recentSignals }).useCritic;
      }
    } catch { useCritic = false; }
  }

  const result = await criticGate({ useCritic, task, draft, constraints, context, tier, minSeverity });
  console.log(JSON.stringify(result, null, 2));
  if (args["fail-on-revise"] && result.ran && result.shouldRevise) process.exit(3);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

export default { runCriticPass, criticGate };

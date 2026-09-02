#!/usr/bin/env node
// agent-evals — golden-task eval harness for the agent fleet. For each task: run the agent's
// persona on the task (Azure OpenAI, credits) to produce an answer, then score it with an
// LLM-as-judge against an explicit rubric. Aggregates a scorecard and (optionally) emits
// eval_result events to the PostHog Fleet Agents project so eval scores live next to the
// fleet-telemetry data (initiative #1 closes its own loop).
//
// Model-configurable: defaults to a gpt-4o-class model (credit-funded) for both run + judge, resolved
// via setup/model-routing.mjs so the tier + body shape agree with the rest of the fleet.
// When an Anthropic key is added, point AGENT_MODEL at Claude for true model-fidelity evals.
//
// LLM_PROVIDER (2026-08-27, Azure Foundry retirement port): Azure subscription 55c84f6b (the whole
// Foundry estate this file called exclusively) is permanently deleted -- verified 401 forever, not a
// transient outage. Default flips to 'openai' (api.openai.com, model ids from
// setup/model-routing.mjs's OPENAI_TIERS -- same tier keys, so AGENT_MODEL/AGENT_FALLBACK_MODEL still
// mean "standard"/an explicit override regardless of provider). LLM_PROVIDER=foundry/azure keeps the
// original Foundry-then-legacy path selectable, one env var away, if that estate is ever re-provisioned.
//
// Usage:
//   node run-evals.mjs                 # run all tasks
//   node run-evals.mjs --agent cto     # one role
//   node run-evals.mjs --task cto-diagnose-failing-job --emit
//   node run-evals.mjs --json out.json # also write a structured scorecard (for the CI prompt-regression
//                                       # gate to diff base-vs-head; see .github/workflows/promptcheck.yml)
import crypto from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { chatBody, LEGACY_STANDARD, resolveTier, serviceTierFor, flexRetryPolicy, truncatedEmpty, positiveIntEnv, isBatchEnabled, buildBatchLine, submitBatch, awaitBatch, assertAllBatchResultsPresent } from "../../setup/model-routing.mjs";
import { logPrefixForText } from "../../setup/prompt-shape.mjs";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { recordOpenAIUsage } from "../../setup/openai-usage.mjs";
import { judgeBedrockNova, BEDROCK_NOVA_MODELS } from "./judge-bedrock-nova.mjs";
import { compareJudgeRow, aggregateJudgeComparison, renderJudgeComparisonReport } from "./judge-compare.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const SM = "otchealth-shared-prod";
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "openai").toLowerCase();
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
// FLEX PROCESSING (2026-08-29): agent-evals is a nightly/on-demand golden-task harness (persona
// answer + judge, both run through chat() below) -- exactly the latency-tolerant shape the flex lane
// targets. Caller label "agent-evals" -> env override OPENAI_SERVICE_TIER_AGENT_EVALS (or the
// fleet-wide OPENAI_SERVICE_TIER). UNSET (the default everywhere today) resolves to undefined, so
// AGENT_EVALS_TIER is undefined and callChatOpenAI below is byte-identical to before this lane
// existed -- see setup/model-routing.mjs's own header for the full contract.
const AGENT_EVALS_TIER = serviceTierFor("agent-evals");
const argv = process.argv.slice(2);
const takeVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONLY_AGENT = (takeVal("--agent", "") || "").toLowerCase();
const ONLY_TASK = takeVal("--task", "");
const EMIT = argv.includes("--emit");
const JSON_OUT = takeVal("--json", "");
const PASS_AT = 0.7;
// JUDGE_PROVIDER (2026-08-29): the ORIGINAL opt-in alternative-judge env var. Kept working UNCHANGED
// for backward compat (SKILL.md and existing scripts reference it): "bedrock-nova" routes judge()
// through judge-bedrock-nova.mjs's Amazon Bedrock Nova Lite Converse call instead of the default,
// a genuinely different model family (removes the same-model-family judging-its-own-output
// correlated-bias risk the default judge carries).
//
// EVAL_JUDGE (2026-09-02, the OpenAI cost-lever sweep's third lever): the NEW, CTO-facing selector,
// with a third option JUDGE_PROVIDER never had -- openai (default, unchanged) | nova-micro | nova-lite.
// EVAL_JUDGE, when set, takes precedence over JUDGE_PROVIDER; JUDGE_PROVIDER=bedrock-nova (with
// EVAL_JUDGE unset) resolves to "nova-lite" for full backward compatibility, so nothing that already
// sets JUDGE_PROVIDER needs to change. Both unset (every job today) resolves to "openai", the
// EXACT pre-existing behavior -- judgeDefault() below is completely unchanged either way.
export const JUDGE_PROVIDER = (process.env.JUDGE_PROVIDER || "").toLowerCase();
const EVAL_JUDGE_RAW = (process.env.EVAL_JUDGE || "").toLowerCase();
export const EVAL_JUDGE = EVAL_JUDGE_RAW || (JUDGE_PROVIDER === "bedrock-nova" ? "nova-lite" : "openai");
// The resolved Nova model id for EVAL_JUDGE, or undefined when EVAL_JUDGE is "openai" (or any other
// unrecognized value, which also falls back to the default openai judge rather than throwing --
// an unrecognized EVAL_JUDGE is a config typo, not a reason to crash a nightly eval run).
export const NOVA_JUDGE_MODEL = BEDROCK_NOVA_MODELS[EVAL_JUDGE];
// The Nova model --judge-compare/--compare runs as "the other judge": whichever Nova model EVAL_JUDGE
// itself resolves to when EVAL_JUDGE names one, else nova-lite (the original, most-tested Nova judge)
// -- so `--compare` with no EVAL_JUDGE set (openai primary) still has a sensible default second judge
// to compare against, and `--compare` WITH `EVAL_JUDGE=nova-micro` compares against nova-micro
// specifically (not silently substituting nova-lite for what the caller explicitly asked to evaluate).
export const COMPARE_NOVA_MODEL = NOVA_JUDGE_MODEL || BEDROCK_NOVA_MODELS["nova-lite"];
// --judge-compare is the ORIGINAL flag name; --compare is the CTO-facing alias added 2026-09-02.
// Both run the identical comparison (BOTH judges on every task's answer), which already generalizes
// to "the same N golden answers" for whatever --agent/--task selects (or every task, if neither is
// given) -- there is no separate hardcoded-10 mode, since hardcoding a count would regress the
// moment the golden set's size changes.
export const JUDGE_COMPARE = argv.includes("--judge-compare") || argv.includes("--compare");

// short role briefs (v1). LATER: load the real dream-team agent definitions for full fidelity.
const PERSONA = {
  cto: "You are the CTO for OTCHealth + InnerScope. You own infrastructure, CI/CD, cloud (Azure-first on credits), security, and the agent fleet. DIAGNOSIS: reason from first principles to the ROOT cause (always consider resource limits like OOM / memory exhaustion when a container dies fast), find a diagnostic path even with no logs (compare expected vs actual artifact counts, inspect the largest inputs), and ship a DURABLE code fix (e.g. a guard) rather than a restart or a bigger box. SECURITY RINGS: never point a non-BAA tool (observability, analytics, AI) at MedReview or any PHI system without a signed BAA, explain the HIPAA reason, and offer a compliant alternative; store secrets in the otchealth-shared-prod Secret Manager (never chat/repos) and flag chat-exposed ones for rotation. Give concrete, paste-ready steps.",
  cfo: "You are the CFO for OTCHealth, InnerScope (public co, OTC: INND), HearingAssist, and Matt personally. You keep clean multi-entity books. INND + HearingAssist are a PUBLIC company: writes are gated + logged. Personal books are segregated. You never co-mingle entities and you cite the entity-scoping rule.",
  clo: "You are the CLO. You protect attorney-client privilege, keep the company-vs-personal matter wall absolute, enforce the securities firewall (INND/MNPI, Reg FD), never invent legal authority, and prepare decision-ready work for licensed counsel (you are not a lawyer). When you must refuse on privilege or firewall grounds, ALWAYS also offer the compliant path (what CAN be shared, or how to route the request through counsel), never a bare refusal.",
};
// Fleet personas (architect/builder/qa/guardian/release-captain/growth/medic/creative/coach +
// rainmaker/capital/commerce/lifecycle/compliance-officer/finance-ops/growth-exposure/switchboard)
// live in evals/personas.json so the suite scales past cto/cfo/clo. Merged over the inline briefs.
try { Object.assign(PERSONA, JSON.parse(readFileSync(join(HERE, "evals", "personas.json"), "utf8"))); } catch { /* optional */ }

function saJwt(scope) { const __r=process.env.GCP_CLAUDE_DRIVER_SA_JSON;if(!__r){return null;}let sa;try{sa=JSON.parse(__r);}catch{return null;}if(!sa||!sa.private_key){return null;} const now = Math.floor(Date.now() / 1000); const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`; return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url"); }
async function sm(id) { const _kv = await kvSecret(id); if (_kv != null) return _kv; const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt("https://www.googleapis.com/auth/cloud-platform"))}` }); const t = (await r0.json()).access_token; const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } }); if (!r.ok) return null; return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim(); }

let EP, KEY, DEP, FB_EP, FB_KEY, FB_DEP;
async function initModel() {
  if (LLM_PROVIDER === "openai") {
    KEY = process.env.OPENAI_API_KEY || (await sm("openai-api-key"));
    DEP = process.env.AGENT_MODEL || resolveTier("standard", "openai").deployment;
    FB_KEY = KEY;
    FB_DEP = process.env.AGENT_FALLBACK_MODEL || resolveTier("quality", "openai").deployment;
    if (!KEY) throw new Error("missing openai-api-key (env OPENAI_API_KEY or the fleet secret)");
    return;
  }
  // Azure/Foundry path, unchanged, selectable via LLM_PROVIDER=foundry|azure. PRIMARY is Foundry
  // (2,000K TPM GlobalStandard), not the legacy azure-openai resource (50K TPM, already 100%
  // subscribed, zero headroom -- the direct cause of the fleet-wide Datadog "Azure OpenAI throttled
  // (blocked_calls)" flap). DEP still resolves via TIERS.standard.deployment ('gpt-4.1'), which only
  // exists on Foundry, so EP/KEY must resolve there too (see model-routing.mjs LEGACY_STANDARD).
  EP = (await sm("azure-foundry-openai-endpoint") || "").replace(/\/$/, ""); KEY = await sm("azure-foundry-key"); DEP = process.env.AGENT_MODEL || resolveTier("standard", "azure").deployment;
  // FALLBACK: the legacy resource, demoted to last-resort only. Its gpt-4o deployment is the ONLY chat
  // deployment that exists there, so the fallback must use LEGACY_STANDARD.deployment ('gpt-4o'), never
  // TIERS.standard.deployment ('gpt-4.1', which 404s on the legacy resource).
  FB_EP = (await sm("azure-openai-endpoint") || "").replace(/\/$/, ""); FB_KEY = await sm("azure-openai-key"); FB_DEP = process.env.AGENT_FALLBACK_MODEL || LEGACY_STANDARD.deployment;
  if (!EP || !KEY) throw new Error("missing azure-foundry endpoint/key");
}
// Exported (2026-08-30, alongside the reasoning-truncation fix) for direct unit testing with a
// mocked fetch, mirroring callChatOpenAI's own existing export for the same reason. No behavior change.
export async function callChat(ep, key, dep, system, user, maxTokens, tries) {
  let curTokens = maxTokens;
  let escalated = false;
  for (let a = 0; a < tries; a++) {
    const body = chatBody(dep, { messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens: curTokens });
    const r = await fetch(`${ep}/openai/deployments/${dep}/chat/completions?api-version=2024-02-01`, { method: "POST", headers: { "api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 429) { const ra = +(r.headers.get("retry-after") || 0); await new Promise(s => setTimeout(s, ra ? ra * 1000 : 1500 * (a + 1))); continue; }
    if (!r.ok) throw new Error("chat " + r.status + " " + (await r.text()).slice(0, 160));
    const choice = (await r.json()).choices[0];
    // Reasoning-truncation handling (2026-08-30, FND-20260830-e927), same pattern as
    // callChatOpenAI's own copy below -- see that function's comment for the incident this closes.
    if (truncatedEmpty(choice) && a < tries - 1) { if (!escalated) { escalated = true; curTokens = curTokens * 2; } continue; }
    if (truncatedEmpty(choice)) {
      throw Object.assign(new Error(`chat: reasoning model "${dep}" exhausted its token budget (${curTokens}) on hidden reasoning with no visible output (finish_reason=length) even after retry+escalation`), { reasoningExhausted: true });
    }
    return choice.message.content;
  }
  throw Object.assign(new Error("chat 429 exhausted"), { throttled: true });
}
// OpenAI-direct call, same request/response shape as Azure's chat.completions (chatBody() is
// provider-agnostic; OpenAI just wants the model NAME in the body instead of the URL, and a bearer
// token instead of an api-key header). Mirrors callChat's retry/429 handling exactly.
//
// FLEX PROCESSING (2026-08-29): when AGENT_EVALS_TIER resolves to "flex", flexRetryPolicy() floors
// `tries` upward and supplies a per-attempt AbortSignal timeout; the body carries
// `service_tier: "flex"`. AGENT_EVALS_TIER unset (the default) makes flexRetryPolicy() a pure
// passthrough -- `effTries === tries` and no signal is ever attached -- so this is BYTE-IDENTICAL to
// before this lane existed. A non-429 failure still never retries, any tier. Exported so a test can
// exercise the real network path directly (mocking global.fetch), the same convention as
// signal-radar's makeChecker()/makeEntailer() and critic-pass's runCriticPass.
export async function callChatOpenAI(key, dep, system, user, maxTokens, tries) {
  const policy = flexRetryPolicy(AGENT_EVALS_TIER, { tries });
  const effTries = policy.tries || tries;
  let curTokens = maxTokens;
  let escalated = false;
  for (let a = 0; a < effTries; a++) {
    const body = { ...chatBody(dep, { messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens: curTokens, serviceTier: AGENT_EVALS_TIER }), model: dep };
    const init = { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) };
    if (policy.timeoutMs) init.signal = AbortSignal.timeout(policy.timeoutMs);
    const r = await fetch(OPENAI_CHAT_URL, init);
    if (r.status === 429) { const ra = +(r.headers.get("retry-after") || 0); await new Promise(s => setTimeout(s, ra ? ra * 1000 : 1500 * (a + 1))); continue; }
    if (!r.ok) throw new Error("chat " + r.status + " " + (await r.text()).slice(0, 160));
    const j = await r.json();
    recordOpenAIUsage({
      model: dep,
      kind: "chat",
      promptTokens: j.usage?.prompt_tokens || 0,
      completionTokens: j.usage?.completion_tokens || 0,
      cachedTokens: j.usage?.prompt_tokens_details?.cached_tokens || 0,
      caller: "agent-evals",
    });
    const choice = j.choices[0];
    // Reasoning-truncation handling (2026-08-30, FND-20260830-e927): on a truncated-empty response
    // (see chat()'s own comment below for the incident + measurements), escalate the token budget 2x
    // ONCE and retry within the SAME existing `effTries` allowance; if STILL truncated-empty on the
    // final attempt, THROW a distinct, non-throttled error instead of silently returning "" as a real
    // (blank) answer/verdict. Both of this function's callers below (chat()'s persona-answer path and
    // judgeDefault()'s judge path) have NO try/catch of their own around this call -- the throw
    // propagates to main()'s per-task `try { ... } catch (e) { console.error(...); continue; }`, the
    // SAME path an ordinary network failure already takes, so the task is skipped and logged instead
    // of silently scoring 0%/FAIL (the exact conflation FND-20260830-e927 flagged: a judge that could
    // not run must never look identical to a judge that ran and found the answer wanting).
    if (truncatedEmpty(choice) && a < effTries - 1) { if (!escalated) { escalated = true; curTokens = curTokens * 2; } continue; }
    if (truncatedEmpty(choice)) {
      throw Object.assign(new Error(`chat: reasoning model "${dep}" exhausted its token budget (${curTokens}) on hidden reasoning with no visible output (finish_reason=length) even after retry+escalation`), { reasoningExhausted: true });
    }
    return choice.message.content;
  }
  throw Object.assign(new Error("chat 429 exhausted"), { throttled: true });
}
// maxTokens default 1200 -> 4000 (2026-08-29, LIVE-REPRODUCED regression from the OPENAI_TIERS
// gpt-5.6 refresh): DEP now resolves to a REASONING-family model (gpt-5.6-terra), which spends part of
// max_completion_tokens on HIDDEN reasoning tokens before any visible output. Verified directly against
// the real API for this exact system+task pair (the architect-spec-first golden task): at 1200 AND at
// 2000, completion_tokens_details.reasoning_tokens consumed the ENTIRE budget (finish_reason:"length",
// zero visible content -- a wasted API call that scores 0% for producing nothing, not for a bad
// answer); at 4000 it succeeded cleanly (only 59 reasoning tokens, ~2800 completion tokens of real
// content). `reasoning_effort:"low"` did NOT fix the 1200-token case in the same probe. 4000 is the
// live-verified working floor for this fleet's persona-answering prompts on this model.
//
// 2026-08-30 UPDATE (FND-20260830-e927, the sibling sweep this same comment once deferred): every
// OTHER tight-budget caller in this toolkit was individually measured and fixed (company-brain,
// signal-radar's two detectors, the recall-evals miners) -- this function's own escalate-then-throw
// handling above (added in the same sweep) is the fleet-wide-consistent mechanism, not a re-tuned
// static number; 4000 remains this specific caller's live-verified working floor.
async function chat(system, user, maxTokens = 4000) {
  if (LLM_PROVIDER === "openai") {
    try { return await callChatOpenAI(KEY, DEP, system, user, maxTokens, 4); }
    catch (e) { if (e.throttled && FB_DEP && FB_DEP !== DEP) return await callChatOpenAI(FB_KEY, FB_DEP, system, user, maxTokens, 5); throw e; }
  }
  // primary Foundry gpt-4.1; fall back to the legacy gpt-4o deployment (separate, capacity-capped
  // resource) only on sustained throttle (Fleet Intel #5)
  try { return await callChat(EP, KEY, DEP, system, user, maxTokens, 4); }
  catch (e) { if (e.throttled && FB_EP && FB_KEY) return await callChat(FB_EP, FB_KEY, FB_DEP, system, user, maxTokens, 5); throw e; }
}

// personaPromptFor(t) -> { system, user } -- extracted (2026-09-02, unchanged wording/values) from
// the inline expression main()'s per-task loop used to build directly, so BOTH the synchronous path
// (chat(system, user)) and the new batch path (runPersonaBatch() below) build the IDENTICAL prompt
// from one place, with zero risk of the two drifting apart over time. `system` is STATIC per agent
// (the persona brief + the fixed "answer concretely" suffix, neither of which depends on the specific
// task); `user` is the single genuinely variable part (the task text). Already cache-friendly order
// (static first, variable last) -- logs its own cache-eligibility line via prompt-shape.mjs's shared
// helper, once per task regardless of which path (sync or batch) ultimately sends it.
export function personaPromptFor(t) {
  const system = (PERSONA[t.agent] || `You are the ${t.agent}.`) + " Answer concretely and completely: name the SPECIFIC tools, gates, thresholds, numbers, and rules you would apply and WHY, cover every relevant consideration explicitly rather than implying it, and whenever you refuse or block, also state the compliant path.";
  logPrefixForText(`agent-evals:persona:${t.agent}`, system);
  return { system, user: t.task };
}

// judgePromptFor(task, rubric) -> { sys, user } -- the default judge's STATIC system prompt + its
// TASK+RUBRIC+ANSWER user content, extracted (2026-09-02, unchanged wording) from judgeDefault() below
// so the batch judge path (runJudgeBatch()) builds the byte-identical prompt without a second copy of
// this template. `sys` never depends on task/rubric/answer (fully static across every call, any
// agent). `user` places TASK+RUBRIC (stable across repeated nightly runs of the SAME golden task)
// BEFORE `answer` (the one part that is genuinely different every run) -- already the cache-friendly
// order. Takes `answer` as a THIRD, separate argument (not baked into this function) so the batch
// path can build one request per task from a Map of already-known answers without re-deriving
// task/rubric each time; logs the SAME prompt-shape line either way.
const JUDGE_SYSTEM = "You are a strict eval judge. Given a task, a rubric (list of criteria), and a candidate answer, decide for EACH criterion whether the answer satisfies it. Return ONLY compact JSON: {\"met\":[true/false per criterion in order],\"notes\":\"one line\"}.";
export function judgePromptFor(task, rubric, answer) {
  logPrefixForText("agent-evals:judge", JUDGE_SYSTEM);
  return { sys: JUDGE_SYSTEM, user: `TASK:\n${task}\n\nRUBRIC:\n${rubric.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\nANSWER:\n${answer}` };
}

// parseJudgeOutput(raw, rubric) -> {met, score, notes} -- the default judge's parse/defensiveness
// logic, extracted (2026-09-02, unchanged) from judgeDefault() below so the batch judge path parses a
// batch-returned completion string through the IDENTICAL fail-safe logic (malformed JSON -> all-false
// with a "judge parse failed" note, short/long `met` arrays padded/truncated to rubric.length) rather
// than a second, potentially-drifting copy.
export function parseJudgeOutput(raw, rubric) {
  let j; try { j = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]); } catch { j = { met: rubric.map(() => false), notes: "judge parse failed" }; }
  const met = (j.met || []).slice(0, rubric.length); while (met.length < rubric.length) met.push(false);
  const score = met.filter(Boolean).length / rubric.length;
  return { met, score, notes: j.notes || "" };
}

// judgeDefault: the ORIGINAL judge, behavior byte-for-byte unchanged (2026-08-29: renamed from `judge`
// so judge() below can dispatch on EVAL_JUDGE/JUDGE_PROVIDER; 2026-09-02: its prompt-building and
// parsing were extracted into judgePromptFor()/parseJudgeOutput() above so the batch path can reuse
// them, but the actual wording, budget, and defensiveness are identical to before either change).
// Scores via the SAME chat()/DEP the agent persona ran on.
const JUDGE_MAX_TOKENS = positiveIntEnv("AGENT_EVALS_JUDGE_MAX_TOKENS", 1500);
export async function judgeDefault(task, rubric, answer) {
  const { sys, user } = judgePromptFor(task, rubric, answer);
  // 400 -> 800 -> 1500 (2026-08-29 then 2026-08-30, FND-20260830-e927): live-tested this exact judge
  // prompt shape, including a deliberately AMBIGUOUS/hedging candidate answer meant to force real
  // per-criterion deliberation rather than an obvious all-pass: 10 live calls across an easy and a hard
  // case never truncated at 800 (max completion observed 145 of 800), so this budget was not the
  // dominant risk chat()'s own persona-answer call was. Bumped anyway for real margin, consistent with
  // every other sibling in this sweep, and because callChatOpenAI()/callChat() (chat()'s own transport,
  // shared by every caller in this file) now escalate-then-throw on a truncated-empty response instead
  // of silently returning "" -- so an empty judge response no longer degrades to a fabricated 0%/FAIL
  // that is indistinguishable from a genuine rubric failure in the console output, the JSON scorecard,
  // AND the PostHog eval_result payload (whose properties never included `notes`); it now throws and
  // is caught by main()'s existing per-task catch, which skips the task entirely rather than scoring it.
  // Env-overridable (AGENT_EVALS_JUDGE_MAX_TOKENS).
  const out = await chat(sys, user, JUDGE_MAX_TOKENS);
  return parseJudgeOutput(out, rubric);
}
// judge: the dispatcher. EVAL_JUDGE resolving to "openai" (the default; also the legacy JUDGE_PROVIDER
// unset case) takes the EXACT pre-existing code path (judgeDefault); "nova-micro"/"nova-lite" route
// through judge-bedrock-nova.mjs instead, passing the resolved model id explicitly so this dispatcher
// never hardcodes a raw Bedrock inference-profile id. This is the ONLY call site the normal
// (non --judge-compare/--compare) per-task loop below uses.
export async function judge(task, rubric, answer) {
  return NOVA_JUDGE_MODEL ? judgeBedrockNova(task, rubric, answer, { model: NOVA_JUDGE_MODEL }) : judgeDefault(task, rubric, answer);
}
// The human-readable label for whichever judge produced a given result -- used in console output and
// the emitted PostHog judge_model property so a scorecard is legible about which judge scored it.
// `evalJudge` defaults to the module's own resolved EVAL_JUDGE; a caller (the --judge-compare/--compare
// report below) may pass a specific value to label the OTHER judge in a comparison.
export function judgeLabel(evalJudge = EVAL_JUDGE) {
  return BEDROCK_NOVA_MODELS[evalJudge] || DEP;
}
async function emit(results) {
  const key = await sm("posthog-fleet-ingest-key"); if (!key) return;
  // judge_model now names the ACTUAL judge that scored each result (2026-08-29: previously hardcoded
  // to DEP unconditionally, which was accurate before a second judge provider existed but would have
  // silently mislabeled every bedrock-nova-judged scorecard as judged by the OpenAI agent model).
  for (const r of results) await fetch("https://us.i.posthog.com/capture/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: key, event: "eval_result", distinct_id: r.agent, timestamp: new Date().toISOString(), properties: { agent: r.agent, task_id: r.id, callsite_id: r.callsite_id, score: r.score, pass: r.pass, model: DEP, judge_model: judgeLabel() } }) });
}

// ============================== BATCH MODE (2026-09-02, OPENAI_BATCH lever) ==============================
// Opt-in: isBatchEnabled("agent-evals") (env OPENAI_BATCH=1, or OPENAI_BATCH_AGENT_EVALS=1 to arm this
// caller alone). OpenAI provider only -- Batch API is an api.openai.com concept; LLM_PROVIDER=foundry/
// azure is unaffected and never enters this code path. Submits ALL of this run's persona-answer
// requests as ONE Batch API job (50% off, up to 24h turnaround, stacks with prompt caching -- see
// setup/model-routing.mjs's own BATCH API section header), then -- ONLY when the judge ALSO resolves
// to the default OpenAI judge (NOVA_JUDGE_MODEL unset; a Nova judge runs on Bedrock, which has no
// relationship to OpenAI's Batch API and is not batched here) -- submits a SECOND batch for the judge
// calls once every persona answer is known.
//
// ACCEPTED TRADE-OFF, disclosed rather than hidden: batch mode submits every task's persona/judge
// request UP FRONT in one shot; there is no equivalent here to a hypothetical "stop once enough
// results are collected" optimization, because Batch API has no such concept (every submitted line is
// billed and processed). This is a non-issue for agent-evals specifically -- unlike recall-evals'
// mine-cases/mine-hard-negatives generators (which stop early once a --target count of VALIDATED
// cases is reached), agent-evals always runs every task in its filtered set to completion regardless
// of mode, so batch mode changes WHEN/how the calls happen, never HOW MANY.
//
// --judge-compare/--compare's EXTRA per-task comparison call against the "other" judge stays
// SYNCHRONOUS even in batch mode: it is a manual, occasional diagnostic pass, not the nightly cost
// driver this lever targets, and folding a third batch into an already-two-batch run for an
// infrequently-used flag was judged not worth the added complexity for this PR.
// `apiKey` is an explicit parameter (not read off module-level KEY), mirroring callChat()/
// callChatOpenAI()'s existing convention -- this is what lets these three functions be exercised
// directly with a mocked fetch and a fake key in a test, without ever calling initModel() or
// resolving a real credential.
export async function runOneBatch(lines, label, { apiKey } = {}) {
  console.error(`[agent-evals] OPENAI_BATCH: submitting ${lines.length} ${label} request(s) as one Batch API job (50% off, up to 24h)...`);
  const batchId = await submitBatch(lines, { apiKey });
  console.error(`[agent-evals] OPENAI_BATCH: batch ${batchId} submitted, waiting for it to complete...`);
  const { results } = await awaitBatch(batchId, {
    apiKey,
    onPoll: ({ status, elapsedMs }) => console.error(`[agent-evals] OPENAI_BATCH: batch ${batchId} status=${status} (${Math.round(elapsedMs / 1000)}s elapsed)`),
  });
  assertAllBatchResultsPresent(lines.map((l) => l.custom_id), results);
  console.error(`[agent-evals] OPENAI_BATCH: batch ${batchId} complete, ${results.size} ${label} result(s).`);
  return results;
}
export function runPersonaBatch(tasks, { dep, apiKey } = {}) {
  const lines = tasks.map((t) => {
    const { system, user } = personaPromptFor(t);
    return buildBatchLine({ customId: t.id, deployment: dep, messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens: 4000 });
  });
  return runOneBatch(lines, "persona answer", { apiKey });
}
export function runJudgeBatch(tasks, answerById, { dep, apiKey } = {}) {
  const lines = tasks.map((t) => {
    const { sys, user } = judgePromptFor(t.task, t.rubric, answerById.get(t.id) || "");
    return buildBatchLine({ customId: t.id, deployment: dep, messages: [{ role: "system", content: sys }, { role: "user", content: user }], maxTokens: JUDGE_MAX_TOKENS, jsonMode: true });
  });
  return runOneBatch(lines, "judge verdict", { apiKey });
}

// The CLI driver. Wrapped in a function (2026-08-29, alongside the flex-lane adoption above) and
// guarded by isMain below -- purely a test-safety refactor (mirrors critic-pass/run.mjs's and
// mine-hard-negatives.mjs's existing isMain pattern in this same toolkit) so a test can
// `import(...)` this module (e.g. to exercise the exported callChatOpenAI directly with a mocked
// fetch) without the CLI driver executing real API calls and calling process.exit(). No logic inside
// this function changed from the pre-refactor top-level script -- only the enclosing function and the
// guard at the bottom are new.
async function main() {
  const tasks = readdirSync(join(HERE, "evals")).filter(f => f.endsWith(".json") && f !== "personas.json").flatMap(f => JSON.parse(readFileSync(join(HERE, "evals", f), "utf8")))
    .filter(t => (!ONLY_AGENT || t.agent === ONLY_AGENT) && (!ONLY_TASK || t.id === ONLY_TASK));
  if (!tasks.length) { console.error("no matching tasks"); process.exit(2); }
  await initModel();
  // BATCH MODE (2026-09-02): see the runOneBatch/runPersonaBatch/runJudgeBatch section above for the
  // full contract. Both unset (OPENAI_BATCH*, the state of every job today) means BATCH_MODE is false
  // and the two `let`s below stay null forever -- the per-task loop below then takes the EXACT
  // pre-existing synchronous code path, byte-identical to before this lever existed.
  const BATCH_MODE = LLM_PROVIDER === "openai" && isBatchEnabled("agent-evals");
  let batchedAnswers = null; // Map<task.id, {error, content}> from runPersonaBatch(), or null in sync mode
  let batchedJudged = null;  // Map<task.id, {met,score,notes}> from runJudgeBatch(), or null when not batching the judge
  if (BATCH_MODE) {
    batchedAnswers = await runPersonaBatch(tasks, { dep: DEP, apiKey: KEY });
    if (!NOVA_JUDGE_MODEL) {
      const answerById = new Map(tasks.map((t) => {
        const r = batchedAnswers.get(t.id);
        return [t.id, r && !r.error ? r.content : ""]; // a per-task persona-answer failure surfaces below via batchedAnswers itself, not by poisoning the judge batch with an empty string silently
      }));
      const judgeResults = await runJudgeBatch(tasks, answerById, { dep: DEP, apiKey: KEY });
      batchedJudged = new Map();
      for (const t of tasks) {
        const r = judgeResults.get(t.id);
        if (!r.error) batchedJudged.set(t.id, parseJudgeOutput(r.content, t.rubric));
        // else: leave unset -- the per-task loop below throws "no judge result" for this task, the
        // same per-task-skip UX a synchronous judge failure already produces.
      }
    }
    // NOVA_JUDGE_MODEL set: judge stays on the synchronous per-task judge() dispatch below (a Nova
    // judge call is not batched -- see this section's header comment), using the now-known batched
    // persona answer for each task.
  }
  // The "compare vs" label always names the OTHER judge -- DEP (the default openai judge) when Nova
  // is primary, else COMPARE_NOVA_MODEL (the resolved Nova model id) when openai is primary. Uses the
  // already-resolved constants directly rather than routing back through judgeLabel(), which exists to
  // label "whichever judge scored a given result", a different question from "what is the OTHER one".
  const compareOtherLabel = NOVA_JUDGE_MODEL ? DEP : COMPARE_NOVA_MODEL;
  console.log(`# agent-evals (run+judge on ${DEP}, judge=${judgeLabel()}${BATCH_MODE ? ` [OPENAI_BATCH${batchedJudged ? "" : ", judge sync"}]` : ""}${JUDGE_COMPARE ? ` +compare vs ${compareOtherLabel}` : ""}) - ${tasks.length} task(s), pass>=${PASS_AT}\n`);
  const results = [];
  // --judge-compare/--compare accumulates one compareJudgeRow() per successfully-scored task,
  // REGARDLESS of EVAL_JUDGE/JUDGE_PROVIDER -- it always compares the default OpenAI judge against a
  // Nova judge (COMPARE_NOVA_MODEL), reusing whichever of the two `scored` already IS (from the normal
  // judge() dispatch above) instead of paying for a redundant third call to the same judge. Runs
  // synchronously even under BATCH_MODE (see this file's BATCH MODE section header for why).
  const compareRows = [];
  for (const t of tasks) {
    process.stderr.write(`  running ${t.id}...`);
    let answer, scored;
    try {
      if (BATCH_MODE) {
        const ar = batchedAnswers.get(t.id);
        if (ar.error) throw new Error(`batch persona-answer error: ${ar.error}`);
        answer = ar.content;
      } else {
        const { system, user } = personaPromptFor(t);
        answer = await chat(system, user);
      }
      if (batchedJudged) {
        scored = batchedJudged.get(t.id);
        if (!scored) throw new Error(`batch: no judge result for task "${t.id}" (see the earlier per-task judge-batch error above)`);
      } else {
        scored = await judge(t.task, t.rubric, answer);
      }
    }
    catch (e) { console.error(` ERROR ${e.message}`); continue; }
    const pass = scored.score >= PASS_AT;
    // callsite_id/prompt_file identify WHICH prompt surface this task exercises (default to the agent
    // name when a task predates the tagging), the substrate a later quality-per-dollar router joins on.
    results.push({ id: t.id, agent: t.agent, callsite_id: t.callsite_id || t.agent, prompt_file: t.prompt_file || null, score: scored.score, pass, notes: scored.notes, met: scored.met });
    process.stderr.write(` ${(scored.score * 100).toFixed(0)}%\n`);
    console.log(`[${pass ? "PASS" : "FAIL"}] ${t.agent}/${t.id}  ${(scored.score * 100).toFixed(0)}%  (${scored.met.filter(Boolean).length}/${t.rubric.length})  ${scored.notes}`);

    // --judge-compare/--compare: score the SAME answer with the OTHER judge too, purely for the
    // comparison report below. A failure here (e.g. no AWS credentials configured for the Nova side)
    // is logged and SKIPPED for the comparison only -- it must never invalidate this task's primary
    // scorecard entry above, which is already recorded and unaffected by anything that happens from
    // here down.
    if (JUDGE_COMPARE) {
      try {
        const novaIsPrimary = Boolean(NOVA_JUDGE_MODEL);
        const other = novaIsPrimary ? await judgeDefault(t.task, t.rubric, answer) : await judgeBedrockNova(t.task, t.rubric, answer, { model: COMPARE_NOVA_MODEL });
        const a = novaIsPrimary ? other : scored;   // default-judge result
        const b = novaIsPrimary ? scored : other;   // nova-judge result
        compareRows.push(compareJudgeRow({ id: t.id, agent: t.agent, a, b }, PASS_AT));
      } catch (e) {
        console.error(`  [judge-compare] skipped comparison for ${t.agent}/${t.id}: ${e.message}`);
      }
    }
  }
  const avg = results.reduce((s, r) => s + r.score, 0) / (results.length || 1);
  const passed = results.filter(r => r.pass).length;
  console.log(`\nSCORECARD: ${passed}/${results.length} passed, avg ${(avg * 100).toFixed(0)}%`);
  if (EMIT) { await emit(results); console.log("emitted eval_result events -> PostHog Fleet Agents"); }
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ model: DEP, judge_model: judgeLabel(), passAt: PASS_AT, avg, passed, total: results.length, results }, null, 2));
    console.log(`wrote scorecard json -> ${JSON_OUT}`);
  }
  if (JUDGE_COMPARE) {
    const compareSummary = aggregateJudgeComparison(compareRows);
    // `a` is ALWAYS the default-OpenAI-judge result and `b` is ALWAYS the Nova-judge result, regardless
    // of which one main() treated as "primary" above (see the compareJudgeRow a/b assignment in the
    // per-task loop) -- so these labels never swap based on novaIsPrimary either.
    console.log("\n" + renderJudgeComparisonReport(compareRows, compareSummary, { labelA: `default (${DEP})`, labelB: `nova (${COMPARE_NOVA_MODEL})` }));
    if (JSON_OUT) {
      const comparePath = JSON_OUT.replace(/\.json$/i, "") + ".judge-compare.json";
      writeFileSync(comparePath, JSON.stringify({ labelA: DEP, labelB: COMPARE_NOVA_MODEL, rows: compareRows, summary: compareSummary }, null, 2));
      console.log(`wrote judge-compare json -> ${comparePath}`);
    }
  }
  process.exit(results.some(r => !r.pass) ? 1 : 0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();

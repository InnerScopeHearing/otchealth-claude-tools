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
// Model tier: defaults to 'standard' (gpt-4o, chat-family) — the Sonnet-tier analog critic-pass is
// designed for, cheaper than the Opus/gpt-5.1 draft it reviews, and NOT the banned gpt-4.1-mini 'cheap'
// tier (banned for quality/synthesis work; a critic IS evaluation work). Override via CRITIC_MODEL.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { buildCriticPrompt, parseCriticVerdict, shouldRevise } from "./critic.mjs";
import { chatBody, resolveTier } from "../../setup/model-routing.mjs";

const SM = "otchealth-shared-prod";
const CRITIC_SYSTEM =
  "You are a cheap, fast CRITIC pass. Review the draft strictly against the task and return STRICT JSON only, exactly as the prompt specifies. Do not rewrite the draft.";

// ---- creds (same JWT-SA -> Secret Manager pattern the rest of the toolkit uses) ----
function resolveSa() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  try { return readFileSync(`${homedir()}/.gcp_claude_driver_sa.json`, "utf8"); } catch { return null; }
}
function saJwt(saRaw) {
  const sa = JSON.parse(saRaw);
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
}
async function sm(id, saRaw) {
  const t = (await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt(saRaw))}` })).json()).access_token;
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: "Bearer " + t } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}

async function callChat(ep, key, dep, system, user, maxTokens, tries) {
  const body = chatBody(dep, { messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens, jsonMode: true });
  for (let a = 0; a < tries; a++) {
    const r = await fetch(`${ep}/openai/deployments/${dep}/chat/completions?api-version=2024-02-01`, { method: "POST", headers: { "api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 429) { const ra = +(r.headers.get("retry-after") || 0); await new Promise((s) => setTimeout(s, ra ? ra * 1000 : 1500 * (a + 1))); continue; }
    if (!r.ok) throw new Error("chat " + r.status + " " + (await r.text()).slice(0, 160));
    return (await r.json()).choices[0].message.content;
  }
  throw Object.assign(new Error("chat 429 exhausted"), { throttled: true });
}

// The default (real) model call: primary azure-openai (gpt-4o standard), foundry fallback on throttle.
// Mirrors agent-evals/run-evals.mjs's chat() so the whole fleet agrees on endpoints + throttle handling.
async function defaultAzureChat({ system, user, tier, maxTokens = 700 }) {
  const saRaw = resolveSa();
  if (!saRaw) throw new Error("no GCP SA available for the critic model call");
  const dep = resolveTier(process.env.CRITIC_MODEL || tier || "standard").deployment;
  const [ep, key] = await Promise.all([sm("azure-openai-endpoint", saRaw), sm("azure-openai-key", saRaw)]);
  if (!ep || !key) throw new Error("missing azure-openai endpoint/key");
  const endpoint = ep.replace(/\/$/, "");
  try {
    return await callChat(endpoint, key, dep, system, user, maxTokens, 4);
  } catch (e) {
    if (e.throttled) {
      const [fbEp, fbKey] = await Promise.all([sm("azure-foundry-openai-endpoint", saRaw), sm("azure-foundry-key", saRaw)]);
      const fbDep = resolveTier(process.env.CRITIC_FALLBACK_MODEL || "quality").deployment;
      if (fbEp && fbKey) return await callChat(fbEp.replace(/\/$/, ""), fbKey, fbDep, system, user, maxTokens, 5);
    }
    throw e;
  }
}

/**
 * runCriticPass({ task, draft, constraints?, context?, tier?, minSeverity?, chatFn? })
 *   -> { ran:true, verdict, issues, confidence, malformed, shouldRevise, model, error? }
 * Makes ONE real critic-model call (or uses an injected chatFn for tests), parses the verdict, and
 * computes shouldRevise. FAIL-SAFE: any throw degrades to a fail-safe "approve" (malformed:true) with
 * the error attached — a broken critic pass approves, never blocks. tier defaults to 'standard' (gpt-4o).
 */
export async function runCriticPass({ task, draft, constraints, context, tier, minSeverity = "medium", chatFn } = {}) {
  const model = resolveTier(process.env.CRITIC_MODEL || tier || "standard").deployment;
  try {
    const prompt = buildCriticPrompt(task, draft, { constraints, context });
    const call = chatFn || defaultAzureChat;
    const raw = await call({ system: CRITIC_SYSTEM, user: prompt, tier: tier || "standard" });
    const verdict = parseCriticVerdict(raw);
    return { ran: true, ...verdict, shouldRevise: shouldRevise(verdict, { minSeverity }), model };
  } catch (e) {
    // report-mode fail-safe: never block the pipeline on a critic failure.
    return { ran: true, verdict: "approve", issues: [], confidence: 0, malformed: true, shouldRevise: false, model, error: String((e && e.message) || e) };
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

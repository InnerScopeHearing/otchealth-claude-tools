#!/usr/bin/env node
// agent-evals — golden-task eval harness for the agent fleet. For each task: run the agent's
// persona on the task (Azure OpenAI, credits) to produce an answer, then score it with an
// LLM-as-judge against an explicit rubric. Aggregates a scorecard and (optionally) emits
// eval_result events to the PostHog Fleet Agents project so eval scores live next to the
// fleet-telemetry data (initiative #1 closes its own loop).
//
// Model-configurable: defaults to Azure OpenAI gpt-4o (credit-funded) for both run + judge.
// When an Anthropic key is added, point AGENT_MODEL at Claude for true model-fidelity evals.
//
// Usage:
//   node run-evals.mjs                 # run all tasks
//   node run-evals.mjs --agent cto     # one role
//   node run-evals.mjs --task cto-diagnose-failing-job --emit
import crypto from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HERE = dirname(fileURLToPath(import.meta.url));
const SM = "otchealth-shared-prod";
const argv = process.argv.slice(2);
const takeVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONLY_AGENT = (takeVal("--agent", "") || "").toLowerCase();
const ONLY_TASK = takeVal("--task", "");
const EMIT = argv.includes("--emit");
const PASS_AT = 0.7;

// short role briefs (v1). LATER: load the real dream-team agent definitions for full fidelity.
const PERSONA = {
  cto: "You are the CTO for OTCHealth + InnerScope. You own infrastructure, CI/CD, cloud (Azure-first on credits), security, and the agent fleet. DIAGNOSIS: reason from first principles to the ROOT cause (always consider resource limits like OOM / memory exhaustion when a container dies fast), find a diagnostic path even with no logs (compare expected vs actual artifact counts, inspect the largest inputs), and ship a DURABLE code fix (e.g. a guard) rather than a restart or a bigger box. SECURITY RINGS: never point a non-BAA tool (observability, analytics, AI) at MedReview or any PHI system without a signed BAA, explain the HIPAA reason, and offer a compliant alternative; store secrets in the otchealth-shared-prod Secret Manager (never chat/repos) and flag chat-exposed ones for rotation. Give concrete, paste-ready steps.",
  cfo: "You are the CFO for OTCHealth, InnerScope (public co, OTC: INND), HearingAssist, and Matt personally. You keep clean multi-entity books. INND + HearingAssist are a PUBLIC company: writes are gated + logged. Personal books are segregated. You never co-mingle entities and you cite the entity-scoping rule.",
  clo: "You are the CLO. You protect attorney-client privilege, keep the company-vs-personal matter wall absolute, enforce the securities firewall (INND/MNPI, Reg FD), never invent legal authority, and prepare decision-ready work for licensed counsel (you are not a lawyer). When you must refuse on privilege or firewall grounds, ALWAYS also offer the compliant path (what CAN be shared, or how to route the request through counsel), never a bare refusal.",
};

function saJwt(scope) { const sa = JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON); const now = Math.floor(Date.now() / 1000); const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`; return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url"); }
async function sm(id) { const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt("https://www.googleapis.com/auth/cloud-platform"))}` }); const t = (await r0.json()).access_token; const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } }); if (!r.ok) return null; return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim(); }

let EP, KEY, DEP, FB_EP, FB_KEY, FB_DEP;
async function initModel() {
  EP = (await sm("azure-openai-endpoint") || "").replace(/\/$/, ""); KEY = await sm("azure-openai-key"); DEP = process.env.AGENT_MODEL || "gpt-4o";
  FB_EP = (await sm("azure-foundry-openai-endpoint") || "").replace(/\/$/, ""); FB_KEY = await sm("azure-foundry-key"); FB_DEP = process.env.AGENT_FALLBACK_MODEL || "gpt-4.1-mini";
  if (!EP || !KEY) throw new Error("missing azure-openai endpoint/key");
}
async function callChat(ep, key, dep, system, user, maxTokens, tries) {
  for (let a = 0; a < tries; a++) {
    const r = await fetch(`${ep}/openai/deployments/${dep}/chat/completions?api-version=2024-02-01`, { method: "POST", headers: { "api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxTokens, temperature: 0.2 }) });
    if (r.status === 429) { const ra = +(r.headers.get("retry-after") || 0); await new Promise(s => setTimeout(s, ra ? ra * 1000 : 1500 * (a + 1))); continue; }
    if (!r.ok) throw new Error("chat " + r.status + " " + (await r.text()).slice(0, 160));
    return (await r.json()).choices[0].message.content;
  }
  throw Object.assign(new Error("chat 429 exhausted"), { throttled: true });
}
async function chat(system, user, maxTokens = 1200) {
  // primary gpt-4o; fall back to the foundry deployment (separate quota) on sustained throttle (Fleet Intel #5)
  try { return await callChat(EP, KEY, DEP, system, user, maxTokens, 4); }
  catch (e) { if (e.throttled && FB_EP && FB_KEY) return await callChat(FB_EP, FB_KEY, FB_DEP, system, user, maxTokens, 5); throw e; }
}
async function judge(task, rubric, answer) {
  const sys = "You are a strict eval judge. Given a task, a rubric (list of criteria), and a candidate answer, decide for EACH criterion whether the answer satisfies it. Return ONLY compact JSON: {\"met\":[true/false per criterion in order],\"notes\":\"one line\"}.";
  const user = `TASK:\n${task}\n\nRUBRIC:\n${rubric.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\nANSWER:\n${answer}`;
  const out = await chat(sys, user, 400);
  let j; try { j = JSON.parse(out.match(/\{[\s\S]*\}/)[0]); } catch { j = { met: rubric.map(() => false), notes: "judge parse failed" }; }
  const met = (j.met || []).slice(0, rubric.length); while (met.length < rubric.length) met.push(false);
  const score = met.filter(Boolean).length / rubric.length;
  return { met, score, notes: j.notes || "" };
}
async function emit(results) {
  const key = await sm("posthog-fleet-ingest-key"); if (!key) return;
  for (const r of results) await fetch("https://us.i.posthog.com/capture/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: key, event: "eval_result", distinct_id: r.agent, timestamp: new Date().toISOString(), properties: { agent: r.agent, task_id: r.id, score: r.score, pass: r.pass, judge_model: DEP } }) });
}

const tasks = readdirSync(join(HERE, "evals")).filter(f => f.endsWith(".json")).flatMap(f => JSON.parse(readFileSync(join(HERE, "evals", f), "utf8")))
  .filter(t => (!ONLY_AGENT || t.agent === ONLY_AGENT) && (!ONLY_TASK || t.id === ONLY_TASK));
if (!tasks.length) { console.error("no matching tasks"); process.exit(2); }
await initModel();
console.log(`# agent-evals (run+judge on ${DEP}) - ${tasks.length} task(s), pass>=${PASS_AT}\n`);
const results = [];
for (const t of tasks) {
  process.stderr.write(`  running ${t.id}...`);
  let answer, scored;
  try { answer = await chat(PERSONA[t.agent] || `You are the ${t.agent}.`, t.task); scored = await judge(t.task, t.rubric, answer); }
  catch (e) { console.error(` ERROR ${e.message}`); continue; }
  const pass = scored.score >= PASS_AT;
  results.push({ id: t.id, agent: t.agent, score: scored.score, pass });
  process.stderr.write(` ${(scored.score * 100).toFixed(0)}%\n`);
  console.log(`[${pass ? "PASS" : "FAIL"}] ${t.agent}/${t.id}  ${(scored.score * 100).toFixed(0)}%  (${scored.met.filter(Boolean).length}/${t.rubric.length})  ${scored.notes}`);
}
const avg = results.reduce((s, r) => s + r.score, 0) / (results.length || 1);
const passed = results.filter(r => r.pass).length;
console.log(`\nSCORECARD: ${passed}/${results.length} passed, avg ${(avg * 100).toFixed(0)}%`);
if (EMIT) { await emit(results); console.log("emitted eval_result events -> PostHog Fleet Agents"); }
process.exit(results.some(r => !r.pass) ? 1 : 0);

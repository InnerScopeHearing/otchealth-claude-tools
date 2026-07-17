#!/usr/bin/env node
// fleet-telemetry — agent LLM observability into PostHog (the $50k-credit lane; NOT Datadog).
// Parses a Claude Code session transcript (.jsonl) and emits, to the "Fleet Agents" PostHog
// project: (1) a PostHog LLM-Observability `$ai_generation` event (model, tokens, cost, latency)
// so the LLM Observability product shows traces + spend, and (2) a custom `agent_session` event
// (agent, turns, tool calls, tools used, outcome) for fleet analytics + funnels.
// Dependency-free; resolves the project ingest key from Secret Manager via the claude-driver SA.
//
// Ring safety: emits ONLY metadata (counts, tokens, model, tool NAMES, durations). It does NOT
// send prompts, outputs, file contents, or any PHI/MNPI. Safe for every agent including PHI ones.
//
// Usage (Stop hook passes {session_id, transcript_path} as JSON on stdin):
//   echo '{"transcript_path":"/path/x.jsonl","session_id":"..."}' | KB_AGENT=cto node telemetry.mjs session-end
//   node telemetry.mjs session-end --transcript <path> [--agent cto]
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
const INGEST = "https://us.i.posthog.com/capture/";
// approx Claude pricing $/Mtok [input, output, cache-write, cache-read]
const PRICE = {
  opus:   [15, 75, 18.75, 1.5], sonnet: [3, 15, 3.75, 0.3], haiku: [0.8, 4, 1.0, 0.08],
};
function priceFor(model) { const m = (model || "").toLowerCase(); for (const k of Object.keys(PRICE)) if (m.includes(k)) return PRICE[k]; return PRICE.sonnet; }

const argv = process.argv.slice(2);
const cmd = argv[0];
const takeVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
function readStdin() { try { return readFileSync(0, "utf8"); } catch { return ""; } }
function read1(p) { try { return readFileSync(p, "utf8").split("\n")[0].trim(); } catch { return ""; } }
/** Resolve the agent role for attribution. process.env.KB_AGENT is often ABSENT in the Stop-hook env
 *  (that is why every pre-blackout event was attributed to "unknown": 38/38). Fall back to the durable
 *  on-disk session marker written by `mem.mjs use <role>` (~/.claude/.kb-agent), then the per-repo
 *  marker, mirroring mem.mjs's own resolution, before giving up to "unknown". */
export function resolveAgent() {
  const explicit = (process.env.KB_AGENT || takeVal("--agent", "")).trim();
  if (explicit) return explicit.toLowerCase();
  const mark = read1(`${homedir()}/.claude/.kb-agent`) || read1(`${process.env.CLAUDE_PROJECT_DIR || "."}/.kb-agent`);
  return (mark || "unknown").toLowerCase();
}

// Secret resolution: Azure Key Vault ONLY. The GCP Secret Manager fallback that used to live here
// was removed after the 2026-07 GCP retirement -- GCP_CLAUDE_DRIVER_SA_JSON is unset fleet-wide, so
// the fallback could only ever return null, and its presence made a genuine "key unresolvable"
// failure look like there was still a backup. That silent-null path is exactly what let the
// 2026-07-02 telemetry blackout hide for 15 days: the old code fetched the ingest key via the GCP
// SA; when the SA left session hydration the fetch went dark and every session exited 0 unnoticed.
// kvSecret() is itself fail-open (returns null, never throws), so callers must treat null as
// "not resolved" and surface it loudly rather than swallow it.
async function sm(id) { return await kvSecret(id); }

function parseTranscript(path) {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  let inTok = 0, outTok = 0, cacheW = 0, cacheR = 0, turns = 0, toolCalls = 0, errors = 0;
  const tools = {}; const models = {}; let firstTs = null, lastTs = null;
  for (const ln of lines) {
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const ts = o.timestamp || o.ts; if (ts) { firstTs = firstTs || ts; lastTs = ts; }
    const msg = o.message || o;
    if (o.type === "assistant" || msg?.role === "assistant") {
      turns++;
      const u = msg?.usage || o.usage;
      if (u) { inTok += u.input_tokens || 0; outTok += u.output_tokens || 0; cacheW += u.cache_creation_input_tokens || 0; cacheR += u.cache_read_input_tokens || 0; }
      if (msg?.model) models[msg.model] = (models[msg.model] || 0) + 1;
      const content = msg?.content; if (Array.isArray(content)) for (const c of content) if (c.type === "tool_use") { toolCalls++; tools[c.name] = (tools[c.name] || 0) + 1; }
    }
    if (o.type === "user" || msg?.role === "user") { const content = msg?.content; if (Array.isArray(content)) for (const c of content) if (c.type === "tool_result" && c.is_error) errors++; }
  }
  const model = Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";
  const [pi, po, pcw, pcr] = priceFor(model);
  const cost = (inTok * pi + outTok * po + cacheW * pcw + cacheR * pcr) / 1e6;
  const durMs = firstTs && lastTs ? (new Date(lastTs) - new Date(firstTs)) : 0;
  return { inTok, outTok, cacheW, cacheR, totalTok: inTok + outTok + cacheW + cacheR, turns, toolCalls, tools, model, models: Object.keys(models), errors, cost, durMs };
}

async function capture(key, events) {
  for (const ev of events) {
    const r = await fetch(INGEST, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: key, ...ev }) });
    if (!r.ok) console.error("posthog capture " + r.status + " " + (await r.text()).slice(0, 120));
  }
}

async function sessionEnd() {
  let stdin = {}; try { stdin = JSON.parse(readStdin() || "{}"); } catch {}
  const path = takeVal("--transcript", "") || stdin.transcript_path;
  const sid = (stdin.session_id || takeVal("--session", "") || crypto.randomUUID()).slice(0, 64);
  const agent = resolveAgent();
  if (!path) { console.error("no transcript_path"); process.exit(0); } // never block session end
  let m; try { m = parseTranscript(path); } catch (e) { console.error("parse: " + e.message); process.exit(0); }
  const key = await sm("posthog-fleet-ingest-key");
  if (!key) {
    // LOUD + distinctive (not the old terse "no posthog-fleet-ingest-key"): an unresolvable ingest
    // key is the silent-failure CLASS that caused the 2026-07-02 blackout. We still exit 0 (a Stop
    // hook must never block a session from ending), but this line is greppable, and the nightly
    // stream-freshness pager (skills/azure-canary) is the real detector for a sustained outage.
    console.error("[fleet-telemetry][BLACKOUT-RISK] posthog-fleet-ingest-key did not resolve via Azure Key Vault -- telemetry NOT sent this session. Check the vault + the session KV auth path (managed identity / AZURE_SP_*).");
    process.exit(0);
  }
  const now = new Date().toISOString();
  const base = { distinct_id: agent, timestamp: now };
  // callsite_id: the prompt-surface identifier for this session (defaults to the agent role, matching
  // agent-evals' eval_result.callsite_id default). Substrate for a future quality-per-dollar router that
  // joins eval scores to real production model/cost by callsite; the router itself is NOT built here.
  const callsiteId = (takeVal("--callsite", "") || agent);
  const aiProps = { "$ai_trace_id": sid, "$ai_model": m.model, "$ai_provider": "anthropic", "$ai_input_tokens": m.inTok + m.cacheW + m.cacheR, "$ai_output_tokens": m.outTok, "$ai_latency": Math.round(m.durMs / 1000), "$ai_total_cost_usd": +m.cost.toFixed(4), agent, callsite_id: callsiteId, session_id: sid };
  const sessProps = { agent, callsite_id: callsiteId, session_id: sid, model: m.model, models: m.models, turns: m.turns, tool_calls: m.toolCalls, tools_used: Object.keys(m.tools), top_tools: Object.entries(m.tools).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`), tool_errors: m.errors, input_tokens: m.inTok, output_tokens: m.outTok, cache_read_tokens: m.cacheR, total_tokens: m.totalTok, est_cost_usd: +m.cost.toFixed(4), duration_s: Math.round(m.durMs / 1000), outcome: m.errors > 0 ? "had_tool_errors" : "clean" };
  await capture(key, [{ event: "$ai_generation", properties: { ...aiProps }, ...base }, { event: "agent_session", properties: { ...sessProps }, ...base }]);
  console.log(`telemetry sent: agent=${agent} model=${m.model} turns=${m.turns} tools=${m.toolCalls} tok=${m.totalTok} ~$${m.cost.toFixed(3)} -> PostHog Fleet Agents`);
}

// Only run the CLI dispatch when executed directly (node telemetry.mjs ...), NOT when imported by a
// test. Without this guard, importing the module to unit-test resolveAgent() would run sessionEnd()
// (or the usage branch) and process.exit() on load.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    if (cmd === "session-end") await sessionEnd();
    else { console.error("usage: telemetry.mjs session-end [--transcript <path>] [--agent <a>]"); process.exit(2); }
  } catch (e) { console.error("ERROR: " + e.message); process.exit(0); }
}

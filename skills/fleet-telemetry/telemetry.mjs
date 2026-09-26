#!/usr/bin/env node
// fleet-telemetry — metadata-only Claude Code session usage for PostHog.
// Parses a Claude Code session transcript (.jsonl) and emits one metadata-only `agent_session`
// event to the "Fleet Agents" PostHog project. A transcript is a session aggregate, not a single
// provider generation, so it must not be mislabeled as `$ai_generation`. This also deliberately
// omits dollar-cost fields: this transcript does not prove whether the session was subscription- or
// API-billed, and a public API price estimate is not an invoice.
// Resolves the project ingest key through the kb-memory secret adapter, which defaults to AWS SSM.
//
// Ring safety: emits ONLY metadata (counts, tokens, model, tool NAMES, durations) for the explicit
// company-seat allowlist above. It does NOT send prompts, outputs, or file contents. Protected
// personal-legal, PHI/service, and unknown lanes are skipped before transcript or secret access.
//
// Usage (Stop hook passes {session_id, transcript_path} as JSON on stdin):
//   echo '{"transcript_path":"/path/x.jsonl","session_id":"<uuid>"}' | KB_AGENT=cto node telemetry.mjs session-end
//   node telemetry.mjs session-end --transcript <path>
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
const INGEST = "https://us.i.posthog.com/capture/";

// Only ordinary company Claude Code lanes may send metadata to the shared Fleet Agents project.
// Keep this aligned with setup/session-start.sh's KB_VALID list, deliberately excluding clo-personal.
// Unknown and protected/service lanes fail closed so the user-scope hook cannot export their metadata.
export const COMPANY_TELEMETRY_AGENTS = Object.freeze(["cto", "cfo", "clo", "coo", "cpo", "cro", "cco", "developer"]);
const COMPANY_TELEMETRY_AGENT_SET = new Set(COMPANY_TELEMETRY_AGENTS);
function isCompanyTelemetryAgent(agent) {
  return COMPANY_TELEMETRY_AGENT_SET.has(String(agent || "").trim().toLowerCase());
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const takeVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
function readStdin() { try { return readFileSync(0, "utf8"); } catch { return ""; } }
function read1(p) { try { return readFileSync(p, "utf8").split("\n")[0].trim(); } catch { return ""; } }
/** Resolve the agent role from the per-session pin, then its durable marker. Do not accept a CLI
 *  role override: the Stop hook must not relabel a protected session as a company seat. */
export function resolveAgent() {
  const explicit = String(process.env.KB_AGENT || "").trim();
  if (explicit) return explicit.toLowerCase();
  const mark = read1(`${homedir()}/.claude/.kb-agent`) || read1(`${process.env.CLAUDE_PROJECT_DIR || "."}/.kb-agent`);
  return (mark || "unknown").toLowerCase();
}

const CALLSITE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeCallsiteId(value, fallback) {
  const candidate = String(value || "").trim().toLowerCase();
  return CALLSITE_ID_PATTERN.test(candidate) ? candidate : fallback;
}

function safeSessionId(value) {
  const candidate = String(value || "").trim();
  return SESSION_ID_PATTERN.test(candidate) ? candidate.toLowerCase() : crypto.randomUUID();
}

// Secret resolution uses the shared adapter at ../kb-memory/azure-secret.mjs (a legacy filename).
// Its default backend is AWS SSM Parameter Store. Azure Key Vault was permanently deleted and is
// not a valid fallback; do not set SECRET_BACKEND=keyvault for this service. GCP Secret Manager is
// retired too. kvSecret() is fail-open (returns null, never throws), so surface a missing key loudly
// rather than hiding a telemetry blackout.
async function sm(id) { return await kvSecret(id); }

function tokenCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

export function parseTranscriptText(text) {
  const lines = String(text || "").split("\n").filter(Boolean);
  let inTok = 0, outTok = 0, cacheW = 0, cacheR = 0, turns = 0, modelUsageEntries = 0, toolCalls = 0, errors = 0;
  const tools = Object.create(null); const models = Object.create(null); let firstTs = null, lastTs = null;
  for (const ln of lines) {
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const ts = Date.parse(o.timestamp || o.ts);
    if (Number.isFinite(ts)) {
      firstTs = firstTs === null ? ts : Math.min(firstTs, ts);
      lastTs = lastTs === null ? ts : Math.max(lastTs, ts);
    }
    const msg = o.message || o;
    if (o.type === "assistant" || msg?.role === "assistant") {
      turns++;
      const u = msg?.usage || o.usage;
      const model = msg?.model || o.model;
      if (model) models[model] = (models[model] || 0) + 1;
      if (u) {
        modelUsageEntries++;
        inTok += tokenCount(u.input_tokens);
        outTok += tokenCount(u.output_tokens);
        cacheW += tokenCount(u.cache_creation_input_tokens);
        cacheR += tokenCount(u.cache_read_input_tokens);
      }
      const content = msg?.content; if (Array.isArray(content)) for (const c of content) if (c.type === "tool_use") { toolCalls++; tools[c.name] = (tools[c.name] || 0) + 1; }
    }
    if (o.type === "user" || msg?.role === "user") { const content = msg?.content; if (Array.isArray(content)) for (const c of content) if (c.type === "tool_result" && c.is_error) errors++; }
  }
  const modelNames = Object.keys(models);
  const model = modelNames.length === 1 ? modelNames[0] : modelNames.length > 1 ? "mixed" : "unknown";
  const elapsed = firstTs !== null && lastTs !== null ? lastTs - firstTs : 0;
  const durMs = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  // These counters have different denominators. Model counts include assistant entries with a model
  // label, while usage entries include assistant entries with a usage object. Neither proves provider calls.
  return {
    inTok, outTok, cacheW, cacheR, totalTok: inTok + outTok + cacheW + cacheR,
    turns, modelUsageEntries,
    toolCalls, tools, model, models: modelNames, modelCounts: Object.fromEntries(Object.entries(models)),
    errors, durMs,
  };
}

function parseTranscript(path) {
  return parseTranscriptText(readFileSync(path, "utf8"));
}

export function buildSessionEvent(metrics, { agent, callsiteId, sessionId, timestamp }) {
  const resolvedAgent = String(agent || "").trim().toLowerCase();
  if (!isCompanyTelemetryAgent(resolvedAgent)) return null;
  const resolvedCallsite = safeCallsiteId(callsiteId, resolvedAgent);
  return {
    event: "agent_session",
    distinct_id: resolvedAgent,
    timestamp: timestamp || new Date().toISOString(),
    properties: {
      agent: resolvedAgent,
      callsite_id: resolvedCallsite,
      session_id: safeSessionId(sessionId),
      telemetry_schema_version: 2,
      cost_basis: "not_observed",
      model: metrics.model,
      models: metrics.models,
      model_counts: metrics.modelCounts, // assistant transcript entries with a model label, grouped by model
      model_call_count: metrics.modelUsageEntries, // schema-v2 name; usage-bearing entries, not verified provider calls
      turns: metrics.turns,
      tool_calls: metrics.toolCalls,
      tools_used: Object.keys(metrics.tools),
      top_tools: Object.entries(metrics.tools).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`),
      tool_errors: metrics.errors,
      input_tokens: metrics.inTok,
      output_tokens: metrics.outTok,
      cache_write_tokens: metrics.cacheW,
      cache_read_tokens: metrics.cacheR,
      total_tokens: metrics.totalTok,
      duration_s: Math.round(metrics.durMs / 1000),
      outcome: metrics.errors > 0 ? "had_tool_errors" : "clean",
    },
  };
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
  const sid = safeSessionId(stdin.session_id);
  const agent = resolveAgent();
  if (!isCompanyTelemetryAgent(agent)) {
    console.error("[fleet-telemetry] skipped non-company or segregated lane; no transcript read, SSM lookup, or PostHog event.");
    return;
  }
  if (!path) { console.error("no transcript_path"); process.exit(0); } // never block session end
  let m; try { m = parseTranscript(path); } catch (e) { console.error("parse: " + e.message); process.exit(0); }
  const key = await sm("posthog-fleet-ingest-key");
  if (!key) {
    // A Stop hook must never block the session from ending, but missing telemetry auth stays loud.
    // The current secret adapter defaults to AWS SSM Parameter Store; avoid directing operators to
    // the retired Azure vault when a secret is absent or the caller lacks the SSM/KMS grant.
    console.error(`[fleet-telemetry][BLACKOUT-RISK] posthog-fleet-ingest-key did not resolve from secret backend "${process.env.SECRET_BACKEND || "ssm"}" (normally AWS SSM Parameter Store /otchealth/*). Telemetry NOT sent this session. Check the parameter name and the caller's ssm:GetParameter/KMS decrypt access.`);
    process.exit(0);
  }
  const now = new Date().toISOString();
  // callsite_id: the prompt-surface identifier for this session (defaults to the agent role, matching
  // agent-evals' eval_result.callsite_id default). Join this to quality signals by callsite, but do
  // not infer provider spend from subscription transcript token counts.
  const callsiteId = (takeVal("--callsite", "") || agent);
  const event = buildSessionEvent(m, { agent, callsiteId, sessionId: sid, timestamp: now });
  await capture(key, [event]);
  console.log(`telemetry sent: agent=${agent} model=${m.model} turns=${m.turns} usage_entries=${m.modelUsageEntries} tools=${m.toolCalls} tok=${m.totalTok} -> PostHog Fleet Agents`);
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

#!/usr/bin/env node
// kb-memory reflect — the SELF-IMPROVING loop. At the end of a significant session, extract the
// durable, reusable lessons (pitfalls / decisions / facts) and write them to memory, deduped
// against what is already recorded. The safety net so the fleet keeps learning even when an agent
// forgets to write memory by hand. Stop-hook-friendly: significance-gated, exits 0 always, never
// blocks. Dry-run by default; --commit writes via mem.mjs (which keeps the ring + sharing correct).
//
// Usage (Stop hook passes {transcript_path} JSON on stdin):
//   echo '{"transcript_path":"x.jsonl"}' | KB_AGENT=cto node reflect.mjs [--commit] [--min-tools 12]
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HERE = dirname(fileURLToPath(import.meta.url));
const SM = "otchealth-shared-prod";
const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const COMMIT = argv.includes("--commit");
const MIN_TOOLS = parseInt(val("--min-tools", "12"), 10) || 12;
const AGENT = (process.env.KB_AGENT || val("--agent", "") || "").toLowerCase();
// PreCompact (the highest-stakes distill) passes --prefer-fallback: use the uncontended foundry
// gpt-4.1-mini as PRIMARY so the capture never blocks on the contended shared gpt-4o deployment.
const PREFER_FB = argv.includes("--prefer-fallback") || !!process.env.REFLECT_PREFER_FALLBACK;

function loadSA() { if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) { try { return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON); } catch {} } for (const p of [process.env.HOME + "/.gcp_claude_driver_sa.json", "/root/.gcp_claude_driver_sa.json"]) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} } return null; }
const _SA = loadSA(); // env var OR the file, so reflect does not silently no-op on a fresh shell
function saJwt(scope) { const sa = _SA; const now = Math.floor(Date.now() / 1000); const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`; return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url"); }
async function sm(id) { const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt("https://www.googleapis.com/auth/cloud-platform"))}` }); const t = (await r0.json()).access_token; const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } }); if (!r.ok) return null; return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim(); }
let EP, KEY, DEP, FB_EP, FB_KEY, FB_DEP;
async function initModel() {
  EP = (await sm("azure-openai-endpoint") || "").replace(/\/$/, ""); KEY = await sm("azure-openai-key"); DEP = process.env.REFLECT_MODEL || "gpt-4o";
  FB_EP = (await sm("azure-foundry-openai-endpoint") || "").replace(/\/$/, ""); FB_KEY = await sm("azure-foundry-key"); FB_DEP = process.env.REFLECT_FALLBACK_MODEL || "gpt-4.1-mini";
}
async function callChat(ep, key, dep, system, user, maxTokens, tries) {
  for (let a = 0; a < tries; a++) {
    const r = await fetch(`${ep}/openai/deployments/${dep}/chat/completions?api-version=2024-06-01`, { method: "POST", headers: { "api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxTokens, temperature: 0.3 }) });
    if (r.status === 429) { const ra = +(r.headers.get("retry-after") || 0); await new Promise(s => setTimeout(s, ra ? ra * 1000 : 1500 * (a + 1))); continue; }
    if (!r.ok) throw new Error("chat " + r.status); return (await r.json()).choices[0].message.content;
  }
  throw Object.assign(new Error("429"), { throttled: true });
}
async function ask(system, user, maxTokens = 700) {
  const primary = () => callChat(EP, KEY, DEP, system, user, maxTokens, 4);
  const hasFB = FB_EP && FB_KEY;
  const fallback = () => hasFB ? callChat(FB_EP, FB_KEY, FB_DEP, system, user, maxTokens, 5) : Promise.reject(Object.assign(new Error("no fallback"), { throttled: true }));
  // --prefer-fallback (PreCompact): use the uncontended foundry mini FIRST, gpt-4o only as backup.
  if (PREFER_FB && hasFB) { try { return await fallback(); } catch { return await primary(); } }
  // default: primary gpt-4o, fall back to the foundry deployment (separate quota) on sustained throttle.
  try { return await primary(); }
  catch (e) { if (e.throttled && hasFB) return await fallback(); throw e; }
}

// DETERMINISTIC safety net: when the LLM is fully unavailable (sustained 429 / error), do not lose the
// session's key facts. Pull the highest-signal verbatim statements from the condensed body so they land
// in the recall-able ledger immediately (the journal also has the raw turns; this is the recall layer).
function extractDurable(body) {
  const SIG = /\b(merged to main|SHIPPED|stored .{0,40}Secret Manager|CORRECTION|CFBundleVersion \d+|build \d+\b|bundle id|App Store Connect|DONE:|DECISION|decided to|the (?:current |correct |right )?value is)\b/i;
  const out = [], seen = new Set();
  for (const ln of body.split("\n")) {
    if (!ln.startsWith("ASSISTANT:")) continue;
    for (const sent of ln.replace(/^ASSISTANT:\s*/, "").split(/(?<=[.!?])\s+/)) {
      const s = sent.trim();
      if (s.length >= 30 && s.length <= 280 && SIG.test(s)) {
        const k = s.slice(0, 64).toLowerCase();
        if (!seen.has(k)) { seen.add(k); out.push(s); }
        break;
      }
    }
    if (out.length >= 3) break;
  }
  return out;
}

// condense the transcript to the SIGNAL: user asks + assistant conclusions, tool noise dropped, capped
function condense(path) {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  let tools = 0; const turns = [];
  for (const ln of lines) {
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const m = o.message || o;
    if (o.type === "user" || m?.role === "user") { const c = m?.content; const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter(x => x.type === "text").map(x => x.text).join(" ") : ""; if (t && !t.includes("tool_result")) turns.push("USER: " + t.slice(0, 400)); }
    else if (o.type === "assistant" || m?.role === "assistant") { const c = m?.content; if (Array.isArray(c)) { for (const x of c) { if (x.type === "tool_use") tools++; if (x.type === "text" && x.text && x.text.trim().length > 40) turns.push("ASSISTANT: " + x.text.slice(0, 600)); } } }
  }
  // keep the last ~50 signal turns, capped ~16k chars
  let body = turns.slice(-50).join("\n"); if (body.length > 16000) body = body.slice(-16000);
  return { tools, body };
}
function recentMemory() { try { return execFileSync("node", [join(HERE, "mem.mjs"), "tail", "--agent", AGENT, "--n", "30"], { encoding: "utf8" }).slice(0, 6000); } catch { return ""; } }

async function main() {
  if (!AGENT) { console.error("no KB_AGENT; skipping reflect"); process.exit(0); }
  if (!_SA) { console.error("no claude-driver SA; skipping reflect"); process.exit(0); }
  let stdin = {}; try { stdin = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch {}
  const path = val("--transcript", "") || stdin.transcript_path;
  if (!path) { console.error("no transcript_path; skipping"); process.exit(0); }
  let c; try { c = condense(path); } catch (e) { console.error("condense: " + e.message); process.exit(0); }
  if (c.tools < MIN_TOOLS) { console.error(`session not significant (${c.tools} tools < ${MIN_TOOLS}); skipping reflect`); process.exit(0); }
  await initModel();
  if (!EP || !KEY) { console.error("no model; skipping"); process.exit(0); }
  const known = recentMemory();
  const sys = `You are the memory-reflection step for agent "${AGENT}". From the session below, extract ONLY genuinely DURABLE, REUSABLE lessons that are NOT already in the agent's recent memory. Prefer: pitfalls (a wrong belief or trap + the fix), decisions (a standing choice + why), or facts (a stable identifier/config). Be strict: 0-3 items, each one sentence, specific and self-contained. If nothing new and durable, return []. Mark share=true ONLY if it is non-sensitive and useful cross-team (no MNPI/PHI/privileged). Return ONLY a JSON array: [{"type":"pitfall|decision|remember","text":"..","share":bool}].`;
  const user = `AGENT RECENT MEMORY (do NOT duplicate these):\n${known}\n\n===== SESSION SIGNAL (${c.tools} tool calls) =====\n${c.body}`;
  let items;
  try { items = JSON.parse((await ask(sys, user)).match(/\[[\s\S]*\]/)[0]); }
  catch (e) {
    // LLM unavailable (sustained 429 / error) -> deterministic safety net so a 429 never costs a fact.
    const verbatim = extractDurable(c.body);
    items = verbatim.map((t) => ({ type: "remember", text: t, share: false, _fallback: true }));
    if (items.length) console.error(`reflect: LLM unavailable (${e.message}); deterministic extract saved ${items.length} fact(s).`);
  }
  items = (Array.isArray(items) ? items : []).filter(x => x && x.text && /^(pitfall|decision|remember)$/.test(x.type)).slice(0, 3);
  if (!items.length) { console.log("reflect: no new durable lessons."); process.exit(0); }
  console.log(`reflect: ${items.length} candidate lesson(s)${COMMIT ? " (committing)" : " (dry-run; pass --commit to write)"}:`);
  for (const it of items) {
    console.log(`  [${it.type}${it.share ? ",share" : ""}] ${it.text}`);
    if (COMMIT) { try { const a = [join(HERE, "mem.mjs"), it.type, it.text, "--agent", AGENT, "--tags", it._fallback ? "auto-extract-fallback" : "auto-reflect"]; if (it.share) a.push("--share"); execFileSync("node", a, { stdio: "ignore" }); } catch (e) { console.error("  write failed: " + e.message); } }
  }
  process.exit(0);
}
main().catch((e) => { console.error("reflect ERROR: " + e.message); process.exit(0); });

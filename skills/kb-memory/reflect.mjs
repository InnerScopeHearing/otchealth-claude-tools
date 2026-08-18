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
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { kvSecret } from "./azure-secret.mjs";
import { FAILED_WRITE_FILE, appendFailedWriteFallback } from "./local-fallback.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const SM = "otchealth-shared-prod";
// Durable local fallback for a lesson that failed to persist to the real ledger (2026-08-18).
// MOVED to local-fallback.mjs (same day, the agent-seat credential bootstrap fix) so mem.mjs's own
// DIRECT CLI writes get the identical safety net, not just content that happens to route through this
// file's LLM-distillation loop. Re-exported here UNCHANGED so this file stays the stable import site
// existing callers/tests already use (`from "../reflect.mjs"`) -- nothing downstream needs to change.
export { FAILED_WRITE_FILE, appendFailedWriteFallback };
const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const COMMIT = argv.includes("--commit");
const MIN_TOOLS = parseInt(val("--min-tools", "12"), 10) || 12;
const AGENT = (process.env.KB_AGENT || val("--agent", "") || "").toLowerCase();
// PreCompact (the highest-stakes distill) passes --prefer-fallback. HISTORICAL meaning: use the
// uncontended foundry deployment as PRIMARY so the capture never blocks on the contended shared
// gpt-4o LEGACY deployment. As of 2026-08-01 this file's default PRIMARY already IS the foundry
// resource (see initModel()/ask() below), so that original intent is satisfied unconditionally now;
// the flag is effectively a no-op post-migration. Kept parsed for backward compat with existing
// callers (kb-inject.sh still passes it) -- see the comment in ask() for exactly why it must NOT be
// reinterpreted as "prefer the legacy fallback first".
// intentional cheap-capture, non-summarization: this extracts 0-3 short durable-lesson candidates
// from a session (a cheap, bounded-output classification task), NOT decision-grade quality synthesis.
// It primaries on Foundry TIERS.standard (gpt-4.1) -- NOT TIERS.cheap/gpt-4.1-mini as primary, see
// initModel() -- with the legacy azure-openai resource as a last-resort fallback only (the ban targets
// quality summarization work, e.g. company-brain / focus-group-loop / agent-evals, not this task).
const PREFER_FB = argv.includes("--prefer-fallback") || !!process.env.REFLECT_PREFER_FALLBACK;

function loadSA() { if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) { try { return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON); } catch {} } for (const p of [process.env.HOME + "/.gcp_claude_driver_sa.json", "/root/.gcp_claude_driver_sa.json"]) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} } return null; }
const _SA = loadSA(); // env var OR the file, so reflect does not silently no-op on a fresh shell
function saJwt(scope) { const sa = _SA; if (!sa || !sa.private_key) return null; const now = Math.floor(Date.now() / 1000); const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`; return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url"); }
async function sm(id) { const _kv = await kvSecret(id); if (_kv != null) return _kv; const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt("https://www.googleapis.com/auth/cloud-platform"))}` }); const t = (await r0.json()).access_token; const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } }); if (!r.ok) return null; return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim(); }
let EP, KEY, DEP, FB_EP, FB_KEY, FB_DEP;
async function initModel() {
  // PRIMARY now resolves to the FOUNDRY resource (2,000K TPM GlobalStandard, ample headroom).
  // FALLBACK resolves to the LEGACY azure-openai resource (its gpt-4o deployment is capped at 50K TPM
  // on the regional "Standard" SKU, already 100% subscribed with zero headroom -- the confirmed root
  // cause of the recurring "Azure OpenAI throttled (blocked_calls)" Datadog page, 2026-08-01). See
  // setup/model-routing.mjs LEGACY_STANDARD. Never swap these back so the legacy resource is primary.
  EP = (await sm("azure-foundry-openai-endpoint") || "").replace(/\/$/, ""); KEY = await sm("azure-foundry-key"); DEP = process.env.REFLECT_MODEL || "gpt-4.1";
  // Last-resort fallback only (see note above): the legacy resource, gpt-4o.
  FB_EP = (await sm("azure-openai-endpoint") || "").replace(/\/$/, ""); FB_KEY = await sm("azure-openai-key"); FB_DEP = process.env.REFLECT_FALLBACK_MODEL || "gpt-4o";
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
  // --prefer-fallback (PreCompact) HISTORICALLY meant "try the uncontended foundry deployment FIRST,
  // gpt-4o (legacy, contended) only as backup" -- back when `primary` WAS the legacy resource. As of
  // the 2026-08-01 migration, `primary` already IS foundry by default (see initModel()), so that
  // original intent is now satisfied unconditionally. This branch is therefore an intentional NO-OP
  // (identical to the default branch below): it must NOT be reinterpreted as "call `fallback` first",
  // since `fallback` is now the legacy/contended resource and doing so would reintroduce exactly the
  // throttle contention this fix removes on the PreCompact hot path.
  if (PREFER_FB && hasFB) { try { return await primary(); } catch { return await fallback(); } }
  // default: primary (foundry), fall back to the legacy deployment (separate quota, last resort) on
  // sustained throttle.
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
  // FIX 2026-07-05 (FAILLOUD-ADOPT): same vestigial GCP-only gate found in kb-journal.mjs — fired
  // unconditionally once GCP retired, silently disabling the memory distiller fleet-wide. Removed;
  // sm() below is Azure-first and already fails loud with a named message if truly unavailable.
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
  // FAIL-LOUD + DURABLE FALLBACK (2026-08-18). Exiting 0 unconditionally is still correct (a Stop
  // hook must never block a session over a best-effort memory distill), but doing so used to also
  // discard the evidence: `stdio: "ignore"` threw away mem.mjs's own stderr (the actual "ERROR: put
  // 403 ..." detail), the catch block logged one generic "write failed" line, and on the "stop" hook
  // path THAT line is itself piped to /dev/null by kb-inject.sh's invocations of this same script
  // (see kb-inject.sh's three call sites) -- so a session could exit clean while every one of its
  // distilled lessons silently vanished, with no trace anywhere. A failure reported as a plausible
  // success is worse than an ugly one, because nobody goes looking for it.
  let failures = 0;
  for (const it of items) {
    console.log(`  [${it.type}${it.share ? ",share" : ""}] ${it.text}`);
    if (COMMIT) {
      try {
        const a = [join(HERE, "mem.mjs"), it.type, it.text, "--agent", AGENT, "--tags", it._fallback ? "auto-extract-fallback" : "auto-reflect"];
        if (it.share) a.push("--share");
        // Capture stderr (was `stdio: "ignore"`, which threw the real diagnostic away) so a genuine
        // failure names its actual cause instead of a bare "Command failed" message.
        execFileSync("node", a, { stdio: ["ignore", "ignore", "pipe"] });
      } catch (e) {
        failures++;
        const detail = (e.stderr ? String(e.stderr) : e.message || String(e)).trim().slice(0, 500);
        console.error("=".repeat(78));
        console.error(`[reflect] LOST WRITE: a durable lesson for agent '${AGENT}' failed to persist and was NOT recorded.`);
        console.error(`  type=${it.type} text=${JSON.stringify(it.text).slice(0, 200)}`);
        console.error(`  cause: ${detail}`);
        console.error(`  saved to the local fallback below so this content is recoverable, not gone.`);
        console.error("=".repeat(78));
        appendFailedWriteFallback(AGENT, it, detail);
      }
    }
  }
  // ── CBP-1 (Checkpoint Bridge Protocol, 2026-07-05): after the existing per-item commit loop
  // above, ALSO sync the distilled item texts + a checkpoint marker into _STATE/<agent>.json via
  // mem.mjs state-sync, so cold-resume-test.mjs / any fresh instance can see what was just learned
  // without replaying the whole ledger. Wrapped in try/catch so a failure here never breaks the
  // existing commit behavior above (fail-open, matches this script's exit-0-always contract).
  if (COMMIT && items.length) {
    try {
      const factsJson = JSON.stringify(items.map((it) => it.text));
      const syncSource = process.env.KB_SYNC_SOURCE || "stop";
      const sessionId = process.env.KB_SESSION_ID || "";
      execFileSync("node", [join(HERE, "mem.mjs"), "state-sync", "--agent", AGENT, "--facts", factsJson, "--source", syncSource, "--session-id", sessionId], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) { console.error("  state-sync failed (non-fatal, checkpoint marker only, no memory content lost): " + String(e.stderr || e.message || e).trim().slice(0, 300)); }
  }
  // A plain container-log summary line: even where stdout/stderr both end up redirected to
  // /dev/null by a caller (kb-inject.sh's three invocations of this script do exactly that), a
  // human or a future audit grepping raw logs for "LOST WRITE" or this summary still finds the
  // fallback file's path named right here, once, unconditionally.
  if (COMMIT) console.log(`reflect: ${items.length - failures}/${items.length} lesson(s) committed${failures ? `, ${failures} LOST (recovered to ${FAILED_WRITE_FILE(AGENT)})` : ""}.`);
  process.exit(0);
}
// GUARDED (2026-08-18): only run the CLI flow (which calls process.exit()) when this file is the
// entry point, not merely imported. Previously main() ran unconditionally at module load, so even
// `import { appendFailedWriteFallback } from "./reflect.mjs"` for a unit test would read real stdin
// and terminate the importing process via process.exit(0) as a side effect of the import itself —
// invisible in a normal `node reflect.mjs` invocation (it IS the entry point there) but a landmine
// for any future test or tool that imports this file, exactly the gap that made this file untestable
// before today. Matches nightly-reflection.mjs's existing isMain guard, this file's own closest sibling.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => { console.error("reflect ERROR: " + e.message); process.exit(0); });
}

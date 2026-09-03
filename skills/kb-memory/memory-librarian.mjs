#!/usr/bin/env node
// memory-librarian — the nightly "secretary" that REVIEWS + CATALOGS the fleet's memory. It is the
// scheduled counterpart to the live capture hooks: it reads every session JOURNAL (the complete
// per-day input/output record kb-journal captured), and for each agent + day it
//   1) writes a human-readable DAILY DIGEST (LLM) -> _JOURNAL/<agent>/<date>/_DIGEST.md,
//   2) DISTILLS durable facts/decisions/corrections the live throttle missed -> the agent ledger
//      (via mem.mjs, deduped + ring-correct), the backstop that makes "the ledger is always current",
//   3) re-indexes the shared brain memory so everything is queryable,
//   4) prints a GAP report (agents whose journals have substance but whose ledger barely moved).
// Privileged lanes (clo-personal) are processed into their OWN segregated ledger and NEVER folded
// into the shared brain. Fail-open PER AGENT-DAY (one broken day never blocks the rest of the sweep);
// NOT fail-open on a missing LLM credential entirely (see the 2026-08-27 note below) -- those are
// different failure classes and conflating them is exactly what let this job "succeed" doing nothing.
//
// Run:  node memory-librarian.mjs [--days 2] [--agents cto,cfo,clo] [--no-reindex]
//
// PORTED (2026-08-27) -- BOTH storage AND the LLM, together, deliberately:
//
// STORAGE: the journals + digests used to live in Azure Blob (otchealthcommons/company-journal,
// account-SAS'd directly in this file). That storage account died with the Azure subscription
// deletion (2026-08-13). Now routes through skills/kb-memory/commons-store.mjs (the same facade
// setup/heartbeat.mjs, fleet-dispatch/dispatch.mjs, fleet-medic/medic.mjs, sunset-protocol/
// protocol.mjs, and fleet-search/search.mjs use).
//
// LLM: the model calls targeted TWO Azure OpenAI/Foundry deployments (azure-foundry-openai-endpoint
// primary, azure-openai-endpoint fallback) -- both permanently dead (Foundry returns HTTP 401; see
// skills/doc-indexer/enrich.mjs's identical 2026-08-19 finding and the fleet's `FND-20260819-c9bb`).
// Storage-only would NOT have fixed this job: every chat() call would still throw, every digest would
// still read "(digest unavailable: ...)", `items` would still be `[]` every time, and the job would
// still print "DONE" and exit 0 -- a job that runs and distills nothing, the exact silent-success
// class this whole port exists to close. So both halves ship together, per the design's own
// "ship both or neither" instruction.
//
// Ported to OpenAI direct (api.openai.com), the same proven pattern enrich.mjs already uses
// (`openai-api-key`, confirmed present in SSM). This is ALSO the point where the pre-existing
// "gpt-4.1-mini is BANNED for quality summarization" fleet correction (otchealth-claude-tools
// CLAUDE.md, 2026-08-01 entry) gets actually applied here, closing the TODO the original code left in
// its own header comment ("flag for the CTO to decide whether the digest call specifically should
// move to a quality-tier deployment"): the daily digest (a human-readable narrative summary) now uses
// a QUALITY-tier model (gpt-4o); the bounded pitfall/decision/fact extraction (a short, structured
// 0-4-item list, not narrative prose) stays on a CHEAP-tier model (gpt-4o-mini), matching enrich.mjs's
// own choice for a similarly bounded-extraction task. These are two deliberate, task-appropriate model
// picks now, not a "try cheap, fall back to quality" chain -- the old two-Azure-deployment fallback
// shape does not carry over cleanly onto a single provider, and conflating "cheap vs quality" with
// "primary vs fallback" was part of what let the wrong model serve the wrong job for as long as it did.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { kvSecret } from "./azure-secret.mjs";
import { cGet, cPut, cList, commonsConfigured } from "./commons-store.mjs";
import { chatBody, resolveTier } from "../../setup/model-routing.mjs";
import { recordOpenAIUsage } from "../../setup/openai-usage.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DAYS = parseInt(val("--days", "2"), 10) || 2;          // process the last N days (yesterday+today by default)
const ONLY = (val("--agents", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const NO_REINDEX = argv.includes("--no-reindex");

// ---- commons storage (the journals + digests live here) ----
async function list(prefix) { return cList(prefix); }
// Unlike the pre-port getTxt (which swallowed EVERY failure, permission errors included, as "no
// content" -> silently skip), cGet only returns null on a genuine 404 and THROWS on anything else.
// That throw propagates out of processAgentDay() and is caught by main()'s per-agent-day try/catch
// (see below), which prints a visible ERROR line for that agent-day instead of quietly treating a real
// storage failure as an empty journal. Deliberate tightening, not an oversight.
async function getTxt(n) { return cGet(n); }
async function putTxt(n, body, ct) { return cPut(n, body, ct || "text/plain; charset=utf-8"); }

// ============================ LLM (OpenAI direct; Azure Foundry died 2026-08-19) ============================
let OAI_KEY;
async function initModel() {
  OAI_KEY = process.env.OPENAI_API_KEY || (await kvSecret("openai-api-key"));
  if (!OAI_KEY) {
    console.error("[memory-librarian] Missing openai-api-key (env OPENAI_API_KEY or the fleet secret) -- cannot run without an LLM. This is a FATAL config error, not a per-agent skip: a missing key would otherwise make every digest read '(digest unavailable)' and every distillation silently extract nothing, while the job still exits 0.");
    process.exit(2);
  }
}
// 2026-08-29 fix: these used to be hardcoded literals ("gpt-4o" / "gpt-4o-mini"), completely bypassing
// setup/model-routing.mjs -- exactly the drift class that file's own header exists to prevent, and one
// this file was ironically held up as "the proven pattern" for in several sibling ports' comments
// (shark-round.mjs, reflect.mjs) despite never actually using it. Now resolved through OPENAI_TIERS
// (standard = mid tier for the narrative digest -- gpt-4.1-mini is banned here, fleet correction
// 2026-08-01; cheap tier for the bounded 0-4-item extraction), so a future fleet-wide model rotation
// via model-routing.mjs reaches this file automatically instead of leaving it frozen. Env var names
// (LIBRARIAN_DIGEST_MODEL / LIBRARIAN_MODEL) are unchanged for backward compat.
const QUALITY_MODEL = resolveTier(process.env.LIBRARIAN_DIGEST_MODEL || "standard", "openai").deployment;
const CHEAP_MODEL = resolveTier(process.env.LIBRARIAN_MODEL || "cheap", "openai").deployment;
async function openaiChat(model, sys, user, max, attempt = 0, reasoningEffort) {
  // chatBody() picks the family-correct request shape (2026-08-29 fix, required now that QUALITY_MODEL/
  // CHEAP_MODEL resolve through OPENAI_TIERS, which moved both tiers to reasoning-family -- the prior
  // hardcoded {max_tokens, temperature} literal only worked because gpt-4o/gpt-4o-mini were chat-family).
  // reasoningEffort (2026-09-03) is undefined for chatQuality's narrative-digest call (leaves it
  // omitted from the body, byte-identical to before this param existed) and "low" only for
  // chatCheap's bounded 0-4-item extraction -- see chatCheap's own call below.
  const reqBody = { ...chatBody(model, { messages: [{ role: "system", content: sys }, { role: "user", content: user }], maxTokens: max, temperature: 0.2, reasoningEffort }), model };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(reqBody),
  });
  if (r.status === 429 && attempt < 4) {
    const retryAfter = parseInt(r.headers.get("retry-after") || "0", 10);
    await new Promise((s) => setTimeout(s, (retryAfter > 0 ? retryAfter * 1000 : 2000 * (attempt + 1)) + Math.floor(Math.random() * 500)));
    return openaiChat(model, sys, user, max, attempt + 1, reasoningEffort);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("chat " + r.status + " " + JSON.stringify(j).slice(0, 160));
  recordOpenAIUsage({
    model,
    kind: "chat",
    promptTokens: j.usage?.prompt_tokens || 0,
    completionTokens: j.usage?.completion_tokens || 0,
    cachedTokens: j.usage?.prompt_tokens_details?.cached_tokens || 0,
    caller: "kb-memory-librarian",
  });
  return j.choices?.[0]?.message?.content || "";
}
async function chatQuality(sys, user, max = 900) { return openaiChat(QUALITY_MODEL, sys, user, max); }
async function chatCheap(sys, user, max = 900) { return openaiChat(CHEAP_MODEL, sys, user, max, 0, "low"); }

function recentMemory(agent) { try { return execFileSync("node", [join(HERE, "mem.mjs"), "tail", "--agent", agent, "--n", "40"], { encoding: "utf8" }).slice(0, 7000); } catch { return ""; } }
function writeMem(agent, type, text, share) { try { const a = [join(HERE, "mem.mjs"), type, text, "--agent", agent, "--tags", "librarian"]; if (share) a.push("--share"); execFileSync("node", a, { stdio: "ignore" }); return true; } catch { return false; } }

const lastDates = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10)); return out; };

async function processAgentDay(agent, date) {
  const blobs = (await list(`_JOURNAL/${agent}/${date}/`)).filter((n) => n.endsWith(".jsonl"));
  if (!blobs.length) return null;
  const turns = [];
  for (const b of blobs) { const t = await getTxt(b); if (!t) continue; for (const ln of t.trim().split("\n")) { try { const o = JSON.parse(ln); if (o.text) turns.push(o); } catch {} } }
  if (!turns.length) return null;
  turns.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
  // build the transcript-ish body for the LLM (cap)
  let body = turns.map((t) => `[${(t.ts || "").slice(11, 19)}] ${t.dir}: ${String(t.text).replace(/\s+/g, " ").slice(0, 500)}`).join("\n");
  if (body.length > 24000) body = body.slice(-24000);
  // 1) daily digest (human-readable catalog of the day) -- QUALITY tier (narrative summarization)
  const personal = agent.includes("personal");
  const digSys = `You are the memory secretary for agent "${agent}". Write a concise DAILY DIGEST (markdown, <= 350 words) of this day's sessions: what the operator asked, what was done/decided/shipped, key facts and numbers, and any open items. Group by theme, not by message. Factual, no fluff.`;
  let digest = ""; try { digest = await chatQuality(digSys, `Date ${date}. Journal:\n${body}`, 800); } catch (e) { digest = `(digest unavailable: ${e.message})`; }
  try { await putTxt(`_JOURNAL/${agent}/${date}/_DIGEST.md`, `# ${agent} daily digest ${date}\n\n_Generated by memory-librarian_\n\n${digest}\n`, "text/markdown; charset=utf-8"); } catch {}
  // 2) distill durable items the live throttle may have missed, deduped vs the ledger -- CHEAP tier (bounded, structured extraction)
  const known = recentMemory(agent);
  const dSys = `You are the memory-distillation step for agent "${agent}". From the day's journal, extract ONLY genuinely DURABLE, REUSABLE items NOT already in the agent's recent memory: pitfalls (a wrong belief/trap + fix), decisions (a standing choice + why), or facts (a stable identifier/config). 0-4 items, each one sentence, specific. If nothing new, return []. share=true ONLY if non-sensitive + cross-team useful (NEVER for ${personal ? "this privileged personal lane (always false)" : "MNPI/PHI/privileged"}). Return ONLY a JSON array: [{"type":"pitfall|decision|remember","text":"..","share":bool}].`;
  let items = []; try { items = JSON.parse((await chatCheap(dSys, `RECENT MEMORY (do NOT duplicate):\n${known}\n\nJOURNAL ${date}:\n${body}`, 700)).match(/\[[\s\S]*\]/)[0]); } catch {}
  items = (Array.isArray(items) ? items : []).filter((x) => x && x.text && /^(pitfall|decision|remember)$/.test(x.type)).slice(0, 4);
  let wrote = 0;
  for (const it of items) { if (writeMem(agent, it.type, it.text, personal ? false : !!it.share)) wrote++; }
  return { agent, date, sessions: blobs.length, turns: turns.length, distilled: wrote };
}

async function main() {
  // FIX 2026-07-05 (FAILLOUD-ADOPT): this job was silently exiting 0 (fake success) on EVERY run
  // since GCP retirement — the old GCP-SA gate fired unconditionally before ever reaching the
  // Azure-first storage calls. Then Azure died too (2026-08-13). Fail loud on EITHER a missing
  // storage credential or (below) a missing LLM credential, instead of a fake-success no-op.
  if (!(await commonsConfigured())) {
    console.error("[memory-librarian] AWS credentials unavailable for the commons S3 mirror (checked the ECS task role, AWS_ACCESS_KEY_ID/SECRET, OTC_AWS_ACCESS_KEY_ID/SECRET); cannot read journals.");
    process.exit(78);
  }
  await initModel();
  // discover agents from the journal tree
  const names = await list("_JOURNAL/");
  let agents = [...new Set(names.map((n) => n.split("/")[1]).filter(Boolean))];
  if (ONLY.length) agents = agents.filter((a) => ONLY.includes(a));
  const dates = lastDates(DAYS);
  console.error(`[memory-librarian] agents=${agents.join(",")} | days=${dates.join(",")}`);
  const report = [];
  for (const agent of agents) {
    for (const date of dates) {
      try { const r = await processAgentDay(agent, date); if (r) { report.push(r); console.error(`  ${agent}/${date}: ${r.sessions} session(s), ${r.turns} turns -> digest + ${r.distilled} distilled`); } }
      catch (e) { console.error(`  ${agent}/${date}: ERROR ${e.message}`); }
    }
  }
  // 3) refresh the shared brain memory index so the new ledger entries are queryable
  if (!NO_REINDEX) { try { console.error("[memory-librarian] reindexing brain memory (semantic.mjs reindex)..."); execFileSync("node", [join(HERE, "semantic.mjs"), "reindex"], { stdio: "inherit", env: process.env }); } catch (e) { console.error("[memory-librarian] reindex skipped: " + String(e.message).slice(0, 120)); } }
  // 4) gap report: substantial journal but little/no distillation = an agent that is not writing memory
  const gaps = report.filter((r) => r.turns >= 10 && r.distilled === 0);
  console.error(`\n[memory-librarian] DONE. ${report.length} agent-days cataloged.`);
  if (gaps.length) { console.error("GAP (journal active but ledger barely moved — check capture/identity):"); for (const g of gaps) console.error(`  ${g.agent}/${g.date}: ${g.turns} turns, 0 distilled`); }
  process.exit(0);
}
// FIX (2026-08-27, alongside the storage+LLM port): a FATAL, unhandled error now exits 1, not 0. The
// pre-port `process.exit(0)` here meant ANY crash -- including "the LLM key is entirely missing"
// before the initModel() guard above existed -- was reported as a clean run, the exact silent-success
// class this whole port exists to close. initModel()'s own process.exit(2) already catches the missing-
// key case earlier and more specifically; this is the backstop for anything else that manages to throw.
main().catch((e) => { console.error("[memory-librarian] FATAL " + e.message); process.exit(1); });

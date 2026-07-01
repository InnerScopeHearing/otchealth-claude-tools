#!/usr/bin/env node
// memory-librarian — the nightly "secretary" that REVIEWS + CATALOGS the fleet's memory. It is the
// scheduled counterpart to the live capture hooks: it reads every session JOURNAL (the complete
// per-day input/output record kb-journal captured), and for each agent + day it
//   1) writes a human-readable DAILY DIGEST (cheap LLM) -> _JOURNAL/<agent>/<date>/_DIGEST.md,
//   2) DISTILLS durable facts/decisions/corrections the live throttle missed -> the agent ledger
//      (via mem.mjs, deduped + ring-correct), the backstop that makes "the ledger is always current",
//   3) re-indexes the shared brain memory so everything is queryable,
//   4) prints a GAP report (agents whose journals have substance but whose ledger barely moved).
// Privileged lanes (clo-personal) are processed into their OWN segregated ledger and NEVER folded
// into the shared brain. Cheap model, Azure credits, $0 cash, zero Max draw. Fail-open per agent.
//
// Run:  node memory-librarian.mjs [--days 2] [--agents cto,cfo,clo] [--no-reindex]
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DAYS = parseInt(val("--days", "2"), 10) || 2;          // process the last N days (yesterday+today by default)
const ONLY = (val("--agents", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const NO_REINDEX = argv.includes("--no-reindex");

function loadSA() { if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) { try { return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON); } catch {} } for (const p of [join(homedir(), ".gcp_claude_driver_sa.json"), "/root/.gcp_claude_driver_sa.json"]) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} } return null; }
const SA = loadSA();
function saJwt(scope) { const now = Math.floor(Date.now() / 1000); const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: SA.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`; return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(SA.private_key, "base64url"); }
let GTOK;
async function gtok() { if (GTOK) return GTOK; const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt("https://www.googleapis.com/auth/cloud-platform"))}` }); return (GTOK = (await r.json()).access_token); }
async function sm(id) { const t = await gtok(); const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/otchealth-shared-prod/secrets/${id}/versions/latest:access`, { headers: { Authorization: "Bearer " + t } }); return r.ok ? Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim() : null; }

// ---- commons storage (the journals + digests live here) ----
let ACCT, AKEY, SAS;
function buildSas() { const sv = "2021-12-02", sp = "rwlc", ss = "b", srt = "co"; const st = new Date(Date.now() - 3e5).toISOString().slice(0, 19) + "Z"; const se = new Date(Date.now() + 6 * 36e5).toISOString().slice(0, 19) + "Z"; const sts = [ACCT, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n"; return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig: crypto.createHmac("sha256", Buffer.from(AKEY, "base64")).update(sts, "utf8").digest("base64") }).toString(); }
const CONTAINER = "company-journal";
const enc = (n) => n.split("/").map(encodeURIComponent).join("/");
async function list(prefix) { const out = []; let marker = ""; do { let u = `https://${ACCT}.blob.core.windows.net/${CONTAINER}?restype=container&comp=list&prefix=${encodeURIComponent(prefix)}&${SAS}`; if (marker) u += `&marker=${encodeURIComponent(marker)}`; const r = await fetch(u); if (!r.ok) break; const xml = await r.text(); for (const m of xml.matchAll(/<Name>([^<]+)<\/Name>/g)) out.push(m[1]); marker = (xml.match(/<NextMarker>([^<]+)<\/NextMarker>/) || [])[1] || ""; } while (marker); return out; }
async function getTxt(n) { const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(n)}?${SAS}`); return r.ok ? await r.text() : null; }
async function putTxt(n, body, ct) { const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(n)}?${SAS}`, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": ct || "text/plain; charset=utf-8" }, body }); if (!r.ok) throw new Error("put " + r.status); }

// ---- cheap model (foundry gpt-4.1-mini primary; azure-openai gpt-4o fallback) ----
// intentional cheap-capture, non-summarization: gpt-4.1-mini is kept as the PRIMARY here by design
// (nightly, high-volume, Azure-credit-funded distillation across every agent-day; gpt-4o is the
// fallback, not the other way round, precisely because this path is meant to stay cheap). The one
// NOTE for a future pass: the daily-digest call below (processAgentDay's digSys prompt) reads closer
// to quality summarization than the distillation call does (it is a human-readable narrative digest,
// not a bounded pitfall/decision/fact extraction); left UNCHANGED this pass per explicit scope (both
// callsites share this single init, so there is no separate "primary" to split without restructuring
// the chat() plumbing) rather than risk a regression. Flag for the CTO to decide whether the digest
// call specifically should move to a quality-tier deployment.
let M1, M1K, M1D, M2, M2K, M2D;
async function initModel() { M1 = (await sm("azure-foundry-openai-endpoint") || "").replace(/\/$/, ""); M1K = await sm("azure-foundry-key"); M1D = process.env.LIBRARIAN_MODEL || "gpt-4.1-mini"; M2 = (await sm("azure-openai-endpoint") || "").replace(/\/$/, ""); M2K = await sm("azure-openai-key"); M2D = "gpt-4o"; }
async function chatOne(ep, key, dep, sys, user, max) { for (let a = 0; a < 4; a++) { const r = await fetch(`${ep}/openai/deployments/${dep}/chat/completions?api-version=2024-06-01`, { method: "POST", headers: { "api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "system", content: sys }, { role: "user", content: user }], max_tokens: max, temperature: 0.2 }) }); if (r.status === 429) { await new Promise((s) => setTimeout(s, 2000 * (a + 1))); continue; } if (!r.ok) throw new Error("chat " + r.status); return (await r.json()).choices[0].message.content; } throw new Error("chat throttled"); }
async function chat(sys, user, max = 900) { try { if (M1 && M1K) return await chatOne(M1, M1K, M1D, sys, user, max); } catch {} return await chatOne(M2, M2K, M2D, sys, user, max); }

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
  // 1) daily digest (human-readable catalog of the day)
  const personal = agent.includes("personal");
  const digSys = `You are the memory secretary for agent "${agent}". Write a concise DAILY DIGEST (markdown, <= 350 words) of this day's sessions: what the operator asked, what was done/decided/shipped, key facts and numbers, and any open items. Group by theme, not by message. Factual, no fluff.`;
  let digest = ""; try { digest = await chat(digSys, `Date ${date}. Journal:\n${body}`, 800); } catch (e) { digest = `(digest unavailable: ${e.message})`; }
  try { await putTxt(`_JOURNAL/${agent}/${date}/_DIGEST.md`, `# ${agent} daily digest ${date}\n\n_Generated by memory-librarian_\n\n${digest}\n`, "text/markdown; charset=utf-8"); } catch {}
  // 2) distill durable items the live throttle may have missed, deduped vs the ledger
  const known = recentMemory(agent);
  const dSys = `You are the memory-distillation step for agent "${agent}". From the day's journal, extract ONLY genuinely DURABLE, REUSABLE items NOT already in the agent's recent memory: pitfalls (a wrong belief/trap + fix), decisions (a standing choice + why), or facts (a stable identifier/config). 0-4 items, each one sentence, specific. If nothing new, return []. share=true ONLY if non-sensitive + cross-team useful (NEVER for ${personal ? "this privileged personal lane (always false)" : "MNPI/PHI/privileged"}). Return ONLY a JSON array: [{"type":"pitfall|decision|remember","text":"..","share":bool}].`;
  let items = []; try { items = JSON.parse((await chat(dSys, `RECENT MEMORY (do NOT duplicate):\n${known}\n\nJOURNAL ${date}:\n${body}`, 700)).match(/\[[\s\S]*\]/)[0]); } catch {}
  items = (Array.isArray(items) ? items : []).filter((x) => x && x.text && /^(pitfall|decision|remember)$/.test(x.type)).slice(0, 4);
  let wrote = 0;
  for (const it of items) { if (writeMem(agent, it.type, it.text, personal ? false : !!it.share)) wrote++; }
  return { agent, date, sessions: blobs.length, turns: turns.length, distilled: wrote };
}

async function main() {
  if (!SA) { console.error("[memory-librarian] no SA; abort"); process.exit(0); }
  ACCT = await sm("azure-commons-storage-account"); AKEY = await sm("azure-commons-storage-key");
  if (!ACCT || !AKEY) { console.error("[memory-librarian] no commons creds; abort"); process.exit(0); }
  SAS = buildSas(); await initModel();
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
main().catch((e) => { console.error("[memory-librarian] FATAL " + e.message); process.exit(0); });

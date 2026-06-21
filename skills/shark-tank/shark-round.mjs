#!/usr/bin/env node
// shark-round — STANDALONE Shark Tank simulation. Pitch ANY business idea, app, product, or service
// to the 5 AI-twin sharks (shared roster in sharks.json) and get a Shark-Tank-style round: each
// shark reacts in their own voice, rates it, decides in/out, and (if in) makes an offer with real
// deal structure (equity, royalty, loan), then a deal summary + valuation range.
//
// The SAME sharks are the investor seat inside skills/focus-group-loop; this is the solo lane for
// pitching ideas across projects without the full 20-person panel.
//
// INTERNAL AI SIMULATION ONLY (see sharks.json _disclaimer). Not real offers/endorsements; never publish.
//
// Usage:
//   node shark-round.mjs pitch --idea <file.txt>            [--app <name>] [--panel cuban,oleary,...] [--catalog]
//   echo "<one-paragraph pitch>" | node shark-round.mjs pitch --app <name>
import crypto from "node:crypto";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HERE = dirname(fileURLToPath(import.meta.url));
const SM = "otchealth-shared-prod";
const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const APP = val("--app", "the venture");
const CATALOG = argv.includes("--catalog");

function saJwt(scope) { const sa = JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON); const now = Math.floor(Date.now() / 1000); const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`; return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url"); }
async function sm(id) { const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt("https://www.googleapis.com/auth/cloud-platform"))}` }); const t = (await r0.json()).access_token; const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } }); if (!r.ok) return null; return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim(); }
let EP, KEY, DEP;
async function initModel() { EP = (await sm("azure-openai-endpoint") || "").replace(/\/$/, ""); KEY = await sm("azure-openai-key"); DEP = process.env.SHARK_MODEL || "gpt-4o"; if (!EP || !KEY) throw new Error("missing azure-openai endpoint/key"); }
async function ask(system, user, maxTokens = 700) {
  for (let a = 0; a < 5; a++) {
    const r = await fetch(`${EP}/openai/deployments/${DEP}/chat/completions?api-version=2024-06-01`, { method: "POST", headers: { "api-key": KEY, "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxTokens, temperature: 0.7 }) });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 2000 * (a + 1))); continue; }
    if (!r.ok) throw new Error("chat " + r.status + " " + (await r.text()).slice(0, 140));
    return (await r.json()).choices[0].message.content;
  }
  throw new Error("chat 429 exhausted");
}
const parseJson = (s) => { try { return JSON.parse(s.match(/\{[\s\S]*\}/)[0]); } catch { return null; } };
const fmt$ = (n) => (typeof n === "number" ? "$" + n.toLocaleString() : "n/a");

async function pitch() {
  let idea = ""; const f = val("--idea", "");
  if (f && existsSync(f)) idea = readFileSync(f, "utf8");
  else { try { idea = readFileSync(0, "utf8"); } catch {} idea = idea || val("--text", ""); }
  if (!idea.trim()) { console.error('need a pitch: --idea <file> or pipe text on stdin'); process.exit(2); }
  const roster = JSON.parse(readFileSync(join(HERE, "sharks.json"), "utf8"));
  const panelIds = (val("--panel", "") ? val("--panel", "").split(",") : roster.panel_default).map(s => s.trim());
  const panel = panelIds.map(id => roster.sharks.find(s => s.id === id)).filter(Boolean);
  await initModel();
  console.error(`[shark-round] pitching "${APP}" to ${panel.length} sharks on ${DEP}`);
  const out = [];
  for (const s of panel) {
    const sys = `You are ${s.name}. ${s.brief}\nYou are on Shark Tank hearing a pitch for "${APP}". React authentically in YOUR voice and deal style. Be tough and real. If you invest, make a concrete offer with YOUR typical structure. Return ONLY compact JSON: {"reaction":"2-4 sentences in your voice","rating":0-10,"in":bool,"offer":{"amount_usd":number,"equity_pct":number,"valuation_usd":number,"structure":"equity|royalty|loan|line-of-credit","terms":"short"},"concerns":[".."]}. If you are out, set in=false and offer=null and say why in your voice.`;
    process.stderr.write(`  ${s.name}... `);
    let j; try { j = parseJson(await ask(sys, `PITCH:\n${idea}`)) || { rating: 0, in: false, reaction: "(no parse)" }; } catch (e) { j = { rating: 0, in: false, reaction: "ERR " + e.message }; }
    j.id = s.id; j.shark = s.name; out.push(j); process.stderr.write(`${j.in ? "IN" : "out"} (${j.rating}/10)\n`);
  }
  const ins = out.filter(o => o.in && o.offer);
  const avg = out.reduce((a, o) => a + (+o.rating || 0), 0) / (out.length || 1);
  const payload = { app: APP, ts: new Date().toISOString(), avg_rating: +avg.toFixed(1), offers: ins.length, sharks: out };
  const dir = join(HERE, "rounds"); if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${APP.replace(/[^a-z0-9]/gi, "_")}-${Date.now()}.json`), JSON.stringify(payload, null, 2));

  console.log(`\n================ SHARK TANK — ${APP} ================`);
  console.log("(internal AI simulation, not real offers/endorsements)\n");
  for (const o of out) {
    console.log(`### ${o.shark}  ${o.rating}/10  ${o.in ? "IN" : "OUT"}`);
    console.log(`   "${o.reaction}"`);
    if (o.in && o.offer) console.log(`   OFFER: ${fmt$(o.offer.amount_usd)} for ${o.offer.equity_pct}% (${o.offer.structure}; implied val ${fmt$(o.offer.valuation_usd)})${o.offer.terms ? ` - ${o.offer.terms}` : ""}`);
    if (o.concerns && o.concerns.length) console.log(`   concerns: ${o.concerns.slice(0, 3).join("; ")}`);
    console.log("");
  }
  console.log(`DEAL SUMMARY: ${ins.length}/${out.length} sharks in. Panel avg ${avg.toFixed(1)}/10.`);
  if (ins.length) { const best = ins.slice().sort((a, b) => (b.offer.valuation_usd || 0) - (a.offer.valuation_usd || 0))[0]; console.log(`Best valuation: ${best.shark} at ${fmt$(best.offer.valuation_usd)} (${fmt$(best.offer.amount_usd)}/${best.offer.equity_pct}%). Valuations ranged ${fmt$(Math.min(...ins.map(i => i.offer.valuation_usd || 0)))} - ${fmt$(Math.max(...ins.map(i => i.offer.valuation_usd || 0)))}.`); }
  else console.log("No offers, all sharks out. Fix the concerns and pitch again.");
  if (CATALOG) { try { const { execFileSync } = await import("node:child_process"); execFileSync("node", [join(HERE, "..", "kb-memory", "mem.mjs"), "remember", `Shark Round "${APP}": ${ins.length}/${out.length} in, avg ${avg.toFixed(1)}/10. Sharks' top concerns: ${out.flatMap(o => o.concerns || []).slice(0, 5).join("; ")}`, "--agent", "shark-tank", "--tags", `shark-tank,${APP},investment`, "--share"], { stdio: "ignore" }); console.log("\ncataloged to shared brain: yes"); } catch { } }
  console.log(`\nsaved: skills/shark-tank/rounds/`);
}
try { if (cmd === "pitch") await pitch(); else { console.error('usage: shark-round.mjs pitch --idea <file> [--app <name>] [--panel ids] [--catalog]'); process.exit(2); } }
catch (e) { console.error("ERROR: " + e.message); process.exit(1); }

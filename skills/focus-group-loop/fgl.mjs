#!/usr/bin/env node
// focus-group-loop — the autonomous product-improvement engine. Runs a 20-persona focus group
// (10 demo customers + 5 domain professionals + 5 fictional investor archetypes) against an app:
// each persona REVIEWS it (vision on real screenshots), rates it /10, answers their group's
// question, and gives feedback. Aggregates a scorecard + a prioritized change list (the
// professionals' technical fixes weighted, because they TEACH the builder), checks the 90% gate,
// and catalogs the lessons to the shared brain so a focus group on one app makes every app smarter.
//
// The LOOP (the orchestrating agent runs this in auto mode; see SKILL.md):
//   round -> hand change-list to the app-builder agent -> execute fixes -> round (--prior) -> repeat
//   until all 3 groups average >= 9.0/10 (90%). The same 20 personas persist across rounds and are
//   told what they said last time, so they detect whether changes actually landed.
//
// Usage:
//   node fgl.mjs round --app <name> --pitch <file.txt> [--screens <dir-of-pngs>] [--round N]
//        [--prior results/<app>-round-<N-1>.json] [--personas <override.json>] [--catalog]
// Model: Azure OpenAI gpt-4o (vision-capable, credit-funded). Set FGL_MODEL to override.
import crypto from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
const HERE = dirname(fileURLToPath(import.meta.url));
const SM = "otchealth-shared-prod";
const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const APP = val("--app", "app");
const ROUND = parseInt(val("--round", "1"), 10) || 1;
const PASS = 9.0; // 90% = avg rating >= 9.0/10 per group
const CATALOG = argv.includes("--catalog");

function saJwt(scope) { const sa = JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON); const now = Math.floor(Date.now() / 1000); const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`; return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url"); }
async function sm(id) { const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt("https://www.googleapis.com/auth/cloud-platform"))}` }); const t = (await r0.json()).access_token; const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } }); if (!r.ok) return null; return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim(); }

let EP, KEY, DEP;
async function initModel() { EP = (await sm("azure-openai-endpoint") || "").replace(/\/$/, ""); KEY = await sm("azure-openai-key"); DEP = process.env.FGL_MODEL || "gpt-4o"; if (!EP || !KEY) throw new Error("missing azure-openai endpoint/key"); }
async function ask(system, content, maxTokens = 1600) {
  for (let a = 0; a < 5; a++) {
    const r = await fetch(`${EP}/openai/deployments/${DEP}/chat/completions?api-version=2024-06-01`, { method: "POST", headers: { "api-key": KEY, "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content }], max_tokens: maxTokens, temperature: 0.5 }) });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 2000 * (a + 1))); continue; }
    if (!r.ok) throw new Error("chat " + r.status + " " + (await r.text()).slice(0, 140));
    return (await r.json()).choices[0].message.content;
  }
  throw new Error("chat 429 exhausted");
}
function parseJson(s) { try { return JSON.parse(s.match(/\{[\s\S]*\}/)[0]); } catch { return null; } }

function loadScreens() {
  const dir = val("--screens", "");
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f)).slice(0, 6).map(f => {
    const b = readFileSync(join(dir, f)); const mt = extname(f).toLowerCase() === ".png" ? "png" : "jpeg";
    return { type: "image_url", image_url: { url: `data:image/${mt};base64,${b.toString("base64")}` } };
  });
}

const GROUP_SPEC = {
  customers: { question: "Would you pay for it? (true/false + why)", q: "would_pay", out: '{"rating":0-10,"would_pay":bool,"strengths":[".."],"issues":[".."],"suggestions":[".."]}' },
  professionals: { question: "As a professional in this field, would you present this to your clients as complete and put YOUR name on it as the creator? (true/false + why)", q: "would_associate", out: '{"rating":0-10,"would_associate":bool,"technical_issues":["specific defect + where"],"technical_fixes":["the exact fix, teaching the builder how"],"suggestions":[".."]}' },
  investors: { question: "Would you invest? If yes, give an offer: amount, equity %, implied valuation, and any terms (Shark-Tank style).", q: "would_invest", out: '{"rating":0-10,"would_invest":bool,"amount_usd":number,"equity_pct":number,"valuation_usd":number,"terms":"..","feedback":[".."]}' },
};

async function reviewPersona(p, group, pitch, screens, prior) {
  const spec = GROUP_SPEC[group];
  const sys = `You are ${p.name}. ${p.brief}\nYou are in a product focus group for the app "${APP}". Be honest, specific, and demanding, you are helping build a 10-million-dollar-feeling product, so do not be polite for its own sake. ${group === "professionals" ? "Your job is to TEACH the builders: name exact defects and the exact fix." : ""}\nReturn ONLY compact JSON: ${spec.out}. Keep every array to AT MOST 4 short items so the JSON is never truncated. rating is 0-10 (10 = premium, ship-ready, world-class).`;
  const priorNote = prior && prior[p.id] ? `\n\nLAST ROUND you rated this ${prior[p.id].rating}/10 and raised: ${(prior[p.id].issues || prior[p.id].technical_issues || prior[p.id].feedback || []).slice(0, 4).join("; ")}. Note which of those were addressed this round and reflect that in your new rating.` : "";
  const content = [{ type: "text", text: `PITCH:\n${pitch}\n\nYou are now using the app. ${screens.length ? "The screenshots below are the ACTUAL screens, judge the real visual quality (alignment, typography, spacing, contrast, wrapping/overflow, broken or cheap-looking elements)." : "(No screenshots provided; review from the pitch + described flow.)"}${priorNote}\n\nYour group's required question: ${spec.question}` }, ...screens];
  let out = await ask(sys, content);
  let j = parseJson(out);
  // A truncated/invalid JSON must NOT hard-zero the persona (that silently poisoned the 90% gate:
  // verbose personas blew the token cap, parsed to null, scored 0, and made the gate unreachable).
  // Retry once with a bigger budget + a minified-only instruction; if it STILL fails, mark it a parse
  // failure with rating=null so avg() EXCLUDES it (tooling noise) instead of scoring it 0 (product signal).
  if (!j) { out = await ask(sys + "\nReturn ONLY minified JSON on a single line, no prose, no code fence.", content, 3000); j = parseJson(out); }
  if (!j) j = { rating: null, _parse_fail: true };
  j.id = p.id; j.name = p.name; j.group = group;
  return j;
}

// Average over SCORED personas only: a parse failure (rating=null) is tooling noise and is excluded,
// never counted as 0 (a 0 would silently poison the 90% gate, the exact bug this guards against).
function avg(arr) { const v = arr.filter(r => !r._parse_fail && r.rating != null); return v.length ? v.reduce((s, r) => s + (+r.rating || 0), 0) / v.length : 0; }
function parseFails(arr) { return arr.filter(r => r._parse_fail).length; }

async function catalog(app, round, summary, d) {
  // cross-app learning: write ALL THREE dimensions (customer + professional + investor) to the
  // shared brain (--share), which the memory-exec semantic index makes searchable by every app's
  // agents. So a focus group on one app teaches every builder what makes a product premium, what
  // customers will pay for, and what investors fund.
  const mem = join(HERE, "..", "kb-memory", "mem.mjs");
  const cut = (a) => (a || []).slice(0, 4).join(" | ");
  const text = `Focus-Group-Loop ${app} R${round}: ${summary}. PRO TEACHING (premium-build, cross-app): ${cut(d.proFixes)}. CUSTOMERS want: ${cut(d.custAsks)}. INVESTOR concerns: ${cut(d.invConcerns)}.`;
  try { const { execFileSync } = await import("node:child_process"); execFileSync("node", [mem, "pitfall", text, "--agent", "focus-group", "--tags", `focus-group,${app},premium-ux`, "--share"], { stdio: "ignore" }); return true; } catch { return false; }
}

async function runRound() {
  const pf = val("--pitch", ""); const pitch = pf && existsSync(pf) ? readFileSync(pf, "utf8") : (val("--pitch-text", "") || `The app "${APP}".`);
  const roster = JSON.parse(readFileSync(val("--personas", join(HERE, "personas.json")), "utf8"));
  // Investor seat = the SHARED Shark Tank roster (the same 5 AI-twin sharks as the standalone
  // skills/shark-tank Shark Round). Single source of truth; falls back to personas.json investors.
  let investors = roster.investors;
  try { const sp = join(HERE, "..", "shark-tank", "sharks.json"); if (existsSync(sp)) { const sk = JSON.parse(readFileSync(sp, "utf8")); const sharks = sk.panel_default.map(id => sk.sharks.find(s => s.id === id)).filter(Boolean); if (sharks.length) investors = sharks; } } catch {}
  const prior = (() => { const f = val("--prior", ""); try { return f && existsSync(f) ? JSON.parse(readFileSync(f, "utf8"))._byId : null; } catch { return null; } })();
  const screens = loadScreens();
  await initModel();
  console.error(`[fgl] ${APP} round ${ROUND}: 20 personas on ${DEP}, ${screens.length} screenshot(s)${prior ? ", with prior-round memory" : ""}`);
  const groups = { customers: roster.customers, professionals: roster.professionals, investors };
  const results = {}; const byId = {};
  for (const [g, people] of Object.entries(groups)) {
    results[g] = [];
    for (const p of people) { process.stderr.write(`  ${p.name}... `); let r; try { r = await reviewPersona(p, g, pitch, screens, prior); } catch (e) { r = { id: p.id, name: p.name, group: g, rating: 0, _err: e.message }; } results[g].push(r); byId[p.id] = r; process.stderr.write(`${r.rating}/10\n`); }
  }
  const avgs = { customers: avg(results.customers), professionals: avg(results.professionals), investors: avg(results.investors) };
  const pass = Object.values(avgs).every(a => a >= PASS);
  // consolidated, prioritized change list (pro technical_fixes first = they teach)
  const proFixes = results.professionals.flatMap(r => [...(r.technical_fixes || []), ...(r.technical_issues || [])]);
  const allIssues = [...results.customers.flatMap(r => [...(r.issues || []), ...(r.suggestions || [])]), ...results.investors.flatMap(r => r.feedback || [])];
  const changeList = [...proFixes, ...allIssues];
  const wouldPay = results.customers.filter(r => r.would_pay).length;
  const wouldAssoc = results.professionals.filter(r => r.would_associate).length;
  const invest = results.investors.filter(r => r.would_invest);
  const summary = `customers ${avgs.customers.toFixed(1)}/10 (${wouldPay}/10 would pay), pros ${avgs.professionals.toFixed(1)}/10 (${wouldAssoc}/5 would put their name on it), investors ${avgs.investors.toFixed(1)}/10 (${invest.length}/5 would invest)`;

  const outDir = join(HERE, "results"); if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const payload = { app: APP, round: ROUND, ts: new Date().toISOString(), avgs, pass, wouldPay, wouldAssoc, invest: invest.map(i => ({ name: i.name, amount_usd: i.amount_usd, equity_pct: i.equity_pct, valuation_usd: i.valuation_usd, terms: i.terms })), changeList, results, _byId: byId };
  writeFileSync(join(outDir, `${APP}-round-${ROUND}.json`), JSON.stringify(payload, null, 2));

  const nFail = parseFails(results.customers) + parseFails(results.professionals) + parseFails(results.investors);
  console.log(`\n================ FOCUS GROUP LOOP — ${APP} ROUND ${ROUND} ================`);
  console.log(summary);
  if (nFail) console.log(`(note: ${nFail} persona response(s) could not be parsed even after a retry and were EXCLUDED from the averages, not scored 0)`);
  console.log(`GATE (>=90% all groups): ${pass ? "PASSED -> ship-ready per the panel" : "NOT YET -> execute the change list and re-run"}`);
  console.log(`\nPER-PERSON:`);
  for (const g of ["customers", "professionals", "investors"]) for (const r of results[g]) console.log(`  [${g}] ${r.name}: ${r.rating}/10  ${g === "customers" ? (r.would_pay ? "would pay" : "would NOT pay") : g === "professionals" ? (r.would_associate ? "would put name on it" : "would NOT associate") : (r.would_invest ? `INVEST $${r.amount_usd} / ${r.equity_pct}% (val $${r.valuation_usd})` : "pass")}`);
  console.log(`\nPRIORITIZED CHANGE LIST (top 15, pro fixes first):`);
  changeList.slice(0, 15).forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
  if (pass && invest.length) { console.log(`\nINVESTOR HEADLINE: ${invest.length}/5 offered. Best terms: ${invest.map(i => `$${i.amount_usd}/${i.equity_pct}%`).join(", ")}`); }
  if (CATALOG) { const custAsks = results.customers.flatMap(r => r.suggestions || []); const invConcerns = results.investors.flatMap(r => [...(r.feedback || []), ...(r.concerns || [])]); const ok = await catalog(APP, ROUND, summary, { proFixes, custAsks, invConcerns }); console.log(`\ncataloged to shared brain (customer + pro + investor, cross-app learning): ${ok ? "yes" : "skipped"}`); }
  console.log(`\nsaved: skills/focus-group-loop/results/${APP}-round-${ROUND}.json`);
  process.exit(pass ? 0 : 2); // exit 2 = not yet at 90% (loop continues)
}

try { if (cmd === "round") await runRound(); else { console.error('usage: fgl.mjs round --app <name> --pitch <file> [--screens <dir>] [--round N] [--prior <json>] [--catalog]'); process.exit(2); } }
catch (e) { console.error("ERROR: " + e.message); process.exit(1); }

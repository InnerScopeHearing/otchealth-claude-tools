#!/usr/bin/env node
// legal.mjs — the CLO's operating backbone: a segregated matter + docket store and a
// citation VERIFIER (anti-hallucination). Wielded by the CLO agent.
//
// HARD separation: company matters live under company/, Matt's PERSONAL matters (the CA
// divorce + civil case) live under personal/ and are confidential, access-controlled, and
// NEVER committed to git or shared into other agents' context.
//
// Store: GCS bucket (default otchealth-legal-store in otchealth-shared-prod), auth via the
// claude-driver SA (GCP_CLAUDE_DRIVER_SA_JSON). Dependency-free (Node 18+).
//
// Usage:
//   node legal.mjs cite "<case name or citation>"                 # verify authority exists (CourtListener)
//   node legal.mjs matter new <id> --client <c> --jur <j> --type <t> [--personal]
//   node legal.mjs matter show <id> [--personal]
//   node legal.mjs matters [--personal]                           # list matters (company by default)
//   node legal.mjs docket add <id> <YYYY-MM-DD> "<what>" [--personal]
//   node legal.mjs docket due [days]                              # due/overdue across all matters (default 30)
//   node legal.mjs note <id> "<text>" [--personal]

import crypto from "node:crypto";

const BUCKET = process.env.LEGAL_STORE_BUCKET || "otchealth-legal-store";
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "otchealth-shared-prod";

// ---- args ----
const argv = process.argv.slice(2);
const personal = argv.includes("--personal");
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const pos = argv.filter((a, i, arr) => !a.startsWith("--") && !(i > 0 && arr[i - 1]?.startsWith("--")));
const NS = personal ? "personal" : "company";

// ---- citation verification (no store needed) ----
async function cite(q) {
  if (!q) { console.error('usage: legal.mjs cite "<case name or citation>"'); process.exit(2); }
  // CourtListener free search API. A verification AID, not authoritative; confirm the
  // opinion before relying on it. Add a token via LEGAL_COURTLISTENER_TOKEN for higher limits.
  const headers = { "User-Agent": "otchealth-clo/1.0" };
  if (process.env.LEGAL_COURTLISTENER_TOKEN) headers.Authorization = `Token ${process.env.LEGAL_COURTLISTENER_TOKEN}`;
  const url = `https://www.courtlistener.com/api/rest/v4/search/?q=${encodeURIComponent(q)}&order_by=score%20desc`;
  let r;
  try { r = await fetch(url, { headers }); } catch (e) { console.error("network error reaching CourtListener: " + e.message); process.exit(1); }
  if (!r.ok) { console.error(`CourtListener HTTP ${r.status} (try again, or set LEGAL_COURTLISTENER_TOKEN)`); process.exit(1); }
  const j = await r.json();
  const hits = j.results || [];
  if (!hits.length) { console.log(`NO MATCH for "${q}". Treat as UNVERIFIED. Do NOT cite until confirmed in primary authority.`); return; }
  console.log(`${j.count} result(s) for "${q}" (top ${Math.min(5, hits.length)}):`);
  for (const h of hits.slice(0, 5)) {
    const cites = (h.citation || []).join(", ");
    console.log(`  - ${h.caseName || h.caseNameShort || "?"} | ${h.court || ""} ${h.dateFiled ? "(" + h.dateFiled.slice(0, 4) + ")" : ""} ${cites ? "| " + cites : ""}`);
    if (h.absolute_url) console.log(`    https://www.courtlistener.com${h.absolute_url}`);
  }
  console.log("Note: CourtListener covers case law (not statutes/regs). Verify the holding + that it is still good law before citing.");
}

// ---- case-law search (CourtListener; token optional, raises limits) ----
async function caselaw(q) {
  if (!q) { console.error('usage: legal.mjs caselaw "<query>" [--court <id>]'); process.exit(2); }
  const headers = { "User-Agent": "otchealth-clo/1.0" };
  if (process.env.LEGAL_COURTLISTENER_TOKEN) headers.Authorization = `Token ${process.env.LEGAL_COURTLISTENER_TOKEN}`;
  let url = `https://www.courtlistener.com/api/rest/v4/search/?type=o&order_by=score%20desc&q=${encodeURIComponent(q)}`;
  if (flag("court")) url += `&court=${encodeURIComponent(flag("court"))}`;
  const r = await fetch(url, { headers });
  if (!r.ok) { console.error(`CourtListener HTTP ${r.status} (set LEGAL_COURTLISTENER_TOKEN for higher limits)`); process.exit(1); }
  const j = await r.json();
  console.log(`${j.count} opinion(s) for "${q}"${flag("court") ? " in " + flag("court") : ""} (top 8):`);
  for (const h of (j.results || []).slice(0, 8)) {
    console.log(`  - ${h.caseName || h.caseNameShort || "?"} | ${h.court || ""} ${h.dateFiled ? "(" + h.dateFiled.slice(0, 4) + ")" : ""} ${(h.citation || []).join(", ")}`);
    if (h.absolute_url) console.log(`    https://www.courtlistener.com${h.absolute_url}`);
  }
}

// ---- SEC EDGAR full-text search (free, no key; just a User-Agent) ----
async function edgar(q) {
  if (!q) { console.error('usage: legal.mjs edgar "<query>" [--form 10-K]'); process.exit(2); }
  const params = new URLSearchParams({ q: `"${q}"` });
  if (flag("form")) params.set("forms", flag("form"));
  const url = `https://efts.sec.gov/LATEST/search-index?${params}`;
  let r, j;
  for (let i = 0; i < 3; i++) {
    r = await fetch(url, { headers: { "User-Agent": "OTCHealth CLO legal@otchealthmart.com" } });
    if (r.ok) { j = await r.json(); break; }
    if (r.status < 500) { console.error(`SEC EDGAR HTTP ${r.status}`); process.exit(1); }
    await new Promise((s) => setTimeout(s, 1500)); // efts 5xx is often transient
  }
  if (!j) { console.error("SEC EDGAR unavailable (5xx after retries)"); process.exit(1); }
  const hits = j.hits?.hits || [];
  console.log(`SEC EDGAR: ${j.hits?.total?.value ?? hits.length} filing(s) for "${q}"${flag("form") ? " form " + flag("form") : ""} (top 8):`);
  for (const h of hits.slice(0, 8)) {
    const s = h._source || {}, cik = (s.cik || (s.ciks || []))[0] || "", adsh = (h._id || "").split(":")[0], file = (h._id || "").split(":")[1] || "";
    console.log(`  - ${(s.display_names || []).join("; ")} | ${s.file_type || s.root_form || ""} | ${s.file_date || ""}`);
    if (cik && adsh) console.log(`    https://www.sec.gov/Archives/edgar/data/${(cik + "").replace(/^0+/, "")}/${adsh.replace(/-/g, "")}/${file}`);
  }
  console.log("Use for securities precedent + comparables: find prior disclosure/risk-factor/agreement language across 20+ years of public filings.");
}

// ---- GCS store ----
function need(n) { const v = process.env[n]; if (!v) { console.error("Missing env " + n); process.exit(2); } return v; }
async function gcsToken() {
  const sa = JSON.parse(need("GCP_CLAUDE_DRIVER_SA_JSON"));
  const now = Math.floor(Date.now() / 1000), e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/devstorage.read_write", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const s = crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(i + "." + s)}` });
  if (!r.ok) throw new Error("GCS auth " + r.status);
  return (await r.json()).access_token;
}
async function ensureBucket(tok) {
  const g = await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (g.ok) return;
  if (g.status === 404) {
    console.error(`Legal store bucket gs://${BUCKET} does not exist, and the claude-driver SA cannot create buckets.`);
    console.error(`Create it once (admin / paste-ready), then re-run:`);
    console.error(`  gcloud storage buckets create gs://${BUCKET} --project ${PROJECT} --location US --uniform-bucket-level-access`);
    console.error(`Keeping legal matters (esp. the confidential personal divorce/civil) in their OWN bucket, separate from company financials, is the point.`);
    process.exit(3);
  }
  throw new Error("bucket check " + g.status);
}
async function putJSON(tok, name, obj) {
  const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(obj, null, 2) });
  if (!r.ok) throw new Error("put " + r.status + " " + (await r.text()).slice(0, 160));
}
async function getJSON(tok, name) {
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}?alt=media`, { headers: { Authorization: `Bearer ${tok}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("get " + r.status);
  return r.json();
}
async function listMatters(tok, ns) {
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o?prefix=${encodeURIComponent(ns + "/matters/")}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.items || []).map((o) => o.name);
}
const matterPath = (ns, id) => `${ns}/matters/${id}.json`;

// ---- main ----
const cmd = pos[0];
try {
  if (cmd === "cite") { await cite(pos.slice(1).join(" ")); process.exit(0); }
  if (cmd === "caselaw") { await caselaw(pos.slice(1).join(" ")); process.exit(0); }
  if (cmd === "edgar") { await edgar(pos.slice(1).join(" ")); process.exit(0); }

  const tok = await gcsToken();
  await ensureBucket(tok);

  if (cmd === "matter" && pos[1] === "new") {
    const id = pos[2];
    if (!id) { console.error("usage: legal.mjs matter new <id> --client <c> --jur <j> --type <t> [--personal]"); process.exit(2); }
    const m = { id, namespace: NS, client: flag("client") || (personal ? "Matthew Moore (personal)" : "?"), jurisdiction: flag("jur") || flag("jurisdiction") || "?", type: flag("type") || "?", status: "open", opened: new Date().toISOString(), adverse: flag("adverse") || "", docket: [], notes: [] };
    await putJSON(tok, matterPath(NS, id), m);
    console.log(`opened matter ${NS}/${id} (${m.client}, ${m.jurisdiction}, ${m.type})${personal ? " [CONFIDENTIAL]" : ""}`);

  } else if (cmd === "matter" && pos[1] === "show") {
    const id = pos[2]; const m = await getJSON(tok, matterPath(NS, id));
    if (!m) { console.log("no such matter"); } else console.log(JSON.stringify(m, null, 2));

  } else if (cmd === "matters") {
    const names = await listMatters(tok, NS);
    console.log(`${NS} matters: ${names.length}`);
    for (const n of names) { const m = await getJSON(tok, n); if (m) console.log(`  ${m.id} | ${m.client} | ${m.jurisdiction} | ${m.type} | ${m.status} | deadlines: ${(m.docket || []).length}`); }
    if (!personal) console.log("(personal matters are confidential; list with --personal)");

  } else if (cmd === "docket" && pos[1] === "add") {
    const id = pos[2], date = pos[3], what = pos.slice(4).join(" ");
    if (!id || !date || !what) { console.error('usage: legal.mjs docket add <id> <YYYY-MM-DD> "<what>" [--personal]'); process.exit(2); }
    const m = await getJSON(tok, matterPath(NS, id)); if (!m) { console.error("no such matter " + id); process.exit(1); }
    m.docket = m.docket || []; m.docket.push({ date, what, added: new Date().toISOString().slice(0, 10) });
    m.docket.sort((a, b) => a.date < b.date ? -1 : 1);
    await putJSON(tok, matterPath(NS, id), m);
    console.log(`docketed ${date} "${what}" on ${NS}/${id}`);

  } else if (cmd === "docket" && pos[1] === "due") {
    const days = parseInt(pos[2] || "30", 10);
    const cutoff = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const rows = [];
    for (const ns of ["company", "personal"]) {
      for (const n of await listMatters(tok, ns)) { const m = await getJSON(tok, n); for (const d of (m?.docket || [])) if (d.date <= cutoff) rows.push({ ns, id: m.id, ...d, overdue: d.date < today }); }
    }
    rows.sort((a, b) => a.date < b.date ? -1 : 1);
    console.log(`deadlines through ${cutoff} (${rows.length}):`);
    for (const r of rows) console.log(`  ${r.overdue ? "OVERDUE" : "due    "} ${r.date} | ${r.ns}/${r.id} | ${r.what}`);

  } else if (cmd === "note") {
    const id = pos[1], text = pos.slice(2).join(" ");
    if (!id || !text) { console.error('usage: legal.mjs note <id> "<text>" [--personal]'); process.exit(2); }
    const m = await getJSON(tok, matterPath(NS, id)); if (!m) { console.error("no such matter " + id); process.exit(1); }
    m.notes = m.notes || []; m.notes.push({ ts: new Date().toISOString(), text });
    await putJSON(tok, matterPath(NS, id), m);
    console.log(`noted on ${NS}/${id}`);

  } else {
    console.error('commands: cite "<q>" | matter new <id> --client --jur --type [--personal] | matter show <id> | matters [--personal] | docket add <id> <date> "<what>" | docket due [days] | note <id> "<text>"');
    process.exit(2);
  }
} catch (e) { console.error("ERROR: " + e.message); process.exit(1); }

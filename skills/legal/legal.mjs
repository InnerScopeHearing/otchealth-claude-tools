#!/usr/bin/env node
// legal.mjs — the CLO's operating backbone: a segregated matter + docket store and a
// citation VERIFIER (anti-hallucination). Wielded by the CLO agent.
//
// HARD separation: company matters live under company/, Matt's PERSONAL matters (the CA
// divorce + civil case) live under personal/ and are confidential, access-controlled, and
// NEVER committed to git or shared into other agents' context.
//
// Store: Azure Blob (off Google), account otchealthlegalstore, containers `company` and
// `personal`, SharedKey auth via AZURE_LEGAL_STORAGE_ACCOUNT + AZURE_LEGAL_STORAGE_KEY.
// Dependency-free (Node 18+).
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

// Store lives on AZURE (off Google): dedicated storage account otchealthlegalstore, with
// separate `company` and `personal` blob containers. The personal container holds the
// confidential divorce + civil matters. SharedKey auth.
const ACCT = process.env.AZURE_LEGAL_STORAGE_ACCOUNT || "otchealthlegalstore";
const AKEY = process.env.AZURE_LEGAL_STORAGE_KEY;
const AVER = "2021-06-08";

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

// ---- Azure Blob store (SharedKey; container = company | personal) ----
function ensureStore() {
  if (!AKEY) { console.error(`Missing AZURE_LEGAL_STORAGE_KEY (hydrated from secret azure-legal-storage-key). The legal matter/docket store is on Azure (account ${ACCT}, containers company/personal).`); process.exit(2); }
}
function azSig(method, container, blob, xms, query, contentLength, contentType) {
  const canonHeaders = Object.keys(xms).sort().map((k) => `${k.toLowerCase()}:${xms[k]}`).join("\n") + "\n";
  let canonResource = `/${ACCT}/${container}` + (blob ? `/${blob}` : "");
  if (query) for (const k of Object.keys(query).sort()) canonResource += `\n${k.toLowerCase()}:${query[k]}`;
  const sts = [method, "", "", contentLength || "", "", contentType || "", "", "", "", "", "", "", canonHeaders + canonResource].join("\n");
  return `SharedKey ${ACCT}:${crypto.createHmac("sha256", Buffer.from(AKEY, "base64")).update(sts, "utf8").digest("base64")}`;
}
async function putBlob(container, name, str) {
  const xms = { "x-ms-blob-type": "BlockBlob", "x-ms-date": new Date().toUTCString(), "x-ms-version": AVER };
  const ct = "application/json";
  const auth = azSig("PUT", container, name, xms, null, String(Buffer.byteLength(str)), ct);
  const r = await fetch(`https://${ACCT}.blob.core.windows.net/${container}/${name}`, { method: "PUT", headers: { ...xms, "Content-Type": ct, Authorization: auth }, body: str });
  if (!r.ok) throw new Error("blob put " + r.status + " " + (await r.text()).slice(0, 160));
}
async function getBlob(container, name) {
  const xms = { "x-ms-date": new Date().toUTCString(), "x-ms-version": AVER };
  const auth = azSig("GET", container, name, xms, null, "", "");
  const r = await fetch(`https://${ACCT}.blob.core.windows.net/${container}/${name}`, { headers: { ...xms, Authorization: auth } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("blob get " + r.status);
  return r.json();
}
async function listMatterNames(container) {
  const xms = { "x-ms-date": new Date().toUTCString(), "x-ms-version": AVER };
  const auth = azSig("GET", container, "", xms, { comp: "list", prefix: "matters/", restype: "container" }, "", "");
  const r = await fetch(`https://${ACCT}.blob.core.windows.net/${container}?restype=container&comp=list&prefix=${encodeURIComponent("matters/")}`, { headers: { ...xms, Authorization: auth } });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error("blob list " + r.status + " " + (await r.text()).slice(0, 120));
  const xml = await r.text();
  return [...xml.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1]); // matters/<id>.json
}
const matterBlob = (id) => `matters/${id}.json`;

// ---- main ----
const cmd = pos[0];
try {
  if (cmd === "cite") { await cite(pos.slice(1).join(" ")); process.exit(0); }
  if (cmd === "caselaw") { await caselaw(pos.slice(1).join(" ")); process.exit(0); }
  if (cmd === "edgar") { await edgar(pos.slice(1).join(" ")); process.exit(0); }

  ensureStore();

  if (cmd === "matter" && pos[1] === "new") {
    const id = pos[2];
    if (!id) { console.error("usage: legal.mjs matter new <id> --client <c> --jur <j> --type <t> [--personal]"); process.exit(2); }
    const m = { id, namespace: NS, client: flag("client") || (personal ? "Matthew Moore (personal)" : "?"), jurisdiction: flag("jur") || flag("jurisdiction") || "?", type: flag("type") || "?", status: "open", opened: new Date().toISOString(), adverse: flag("adverse") || "", docket: [], notes: [] };
    await putBlob(NS, matterBlob(id), JSON.stringify(m, null, 2));
    console.log(`opened matter ${NS}/${id} (${m.client}, ${m.jurisdiction}, ${m.type})${personal ? " [CONFIDENTIAL]" : ""}`);

  } else if (cmd === "matter" && pos[1] === "show") {
    const id = pos[2]; const m = await getBlob(NS, matterBlob(id));
    if (!m) { console.log("no such matter"); } else console.log(JSON.stringify(m, null, 2));

  } else if (cmd === "matters") {
    const names = await listMatterNames(NS);
    console.log(`${NS} matters: ${names.length}`);
    for (const n of names) { const m = await getBlob(NS, n); if (m) console.log(`  ${m.id} | ${m.client} | ${m.jurisdiction} | ${m.type} | ${m.status} | deadlines: ${(m.docket || []).length}`); }
    if (!personal) console.log("(personal matters are confidential; list with --personal)");

  } else if (cmd === "docket" && pos[1] === "add") {
    const id = pos[2], date = pos[3], what = pos.slice(4).join(" ");
    if (!id || !date || !what) { console.error('usage: legal.mjs docket add <id> <YYYY-MM-DD> "<what>" [--personal]'); process.exit(2); }
    const m = await getBlob(NS, matterBlob(id)); if (!m) { console.error("no such matter " + id); process.exit(1); }
    m.docket = m.docket || []; m.docket.push({ date, what, added: new Date().toISOString().slice(0, 10) });
    m.docket.sort((a, b) => a.date < b.date ? -1 : 1);
    await putBlob(NS, matterBlob(id), JSON.stringify(m, null, 2));
    console.log(`docketed ${date} "${what}" on ${NS}/${id}`);

  } else if (cmd === "docket" && pos[1] === "due") {
    const days = parseInt(pos[2] || "30", 10);
    const cutoff = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const rows = [];
    for (const ns of ["company", "personal"]) {
      for (const n of await listMatterNames(ns)) { const m = await getBlob(ns, n); for (const d of (m?.docket || [])) if (d.date <= cutoff) rows.push({ ns, id: m.id, ...d, overdue: d.date < today }); }
    }
    rows.sort((a, b) => a.date < b.date ? -1 : 1);
    console.log(`deadlines through ${cutoff} (${rows.length}):`);
    for (const r of rows) console.log(`  ${r.overdue ? "OVERDUE" : "due    "} ${r.date} | ${r.ns}/${r.id} | ${r.what}`);

  } else if (cmd === "note") {
    const id = pos[1], text = pos.slice(2).join(" ");
    if (!id || !text) { console.error('usage: legal.mjs note <id> "<text>" [--personal]'); process.exit(2); }
    const m = await getBlob(NS, matterBlob(id)); if (!m) { console.error("no such matter " + id); process.exit(1); }
    m.notes = m.notes || []; m.notes.push({ ts: new Date().toISOString(), text });
    await putBlob(NS, matterBlob(id), JSON.stringify(m, null, 2));
    console.log(`noted on ${NS}/${id}`);

  } else {
    console.error('commands: cite "<q>" | matter new <id> --client --jur --type [--personal] | matter show <id> | matters [--personal] | docket add <id> <date> "<what>" | docket due [days] | note <id> "<text>"');
    process.exit(2);
  }
} catch (e) { console.error("ERROR: " + e.message); process.exit(1); }

#!/usr/bin/env node
// notion-export: ring-routed, resumable export of Notion content to Azure Blob (the brain substrate).
// Part of the Notion -> Azure retirement (Matt directive 2026-06-22). Reuses the kb-memory storage
// pattern: claude-driver SA -> Secret Manager -> account SAS -> Blob REST.
//
// Usage:
//   GCP_CLAUDE_DRIVER_SA_JSON="$(cat ~/.gcp_claude_driver_sa.json)" \
//   node notion-export.mjs <RING> --manifest <routing-manifest.json> [--key <notion.key>] [--limit N] [--force] [--dry]
//
// RING is one of OPERATIONAL | MNPI-INND | PERSONAL-PRIVILEGED (CREDENTIALS regenerates from SM
// separately; PHI-HOLD is never exported here). Each ring maps to a (storage account, container, prefix).
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const SMPROJ = "otchealth-shared-prod";
const RING = (process.argv[2] || "OPERATIONAL").toUpperCase();
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const flag = (f) => process.argv.includes(f);
const MANIFEST = arg("--manifest", "/tmp/claude-0/-home-user/fc97663c-2fd0-5ca1-a02b-c6f7cfc37ab8/scratchpad/notion-routing-manifest.json");
const KEYFILE = arg("--key", "");
const LIMIT = parseInt(arg("--limit", "0"), 10) || 0;
const FORCE = flag("--force");
const DRY = flag("--dry");

// Ring -> destination. Operational goes to the shared commons (indexed into the brain). MNPI + personal
// go to the legal store's restricted/personal containers (ring-correct; NOT the shared commons).
const DEST = {
  OPERATIONAL:           { acctSecret: "azure-commons-storage-account", keySecret: "azure-commons-storage-key", container: "company-journal", prefix: "_NOTION/operational" },
  "MNPI-INND":           { acctSecret: "azure-legal-storage-account",   keySecret: "azure-legal-storage-key",   container: "company",         prefix: "_NOTION/innd-mnpi"  },
  "PERSONAL-PRIVILEGED": { acctSecret: "azure-legal-storage-account",   keySecret: "azure-legal-storage-key",   container: "personal",        prefix: "_NOTION/personal"  },
};
if (!DEST[RING]) { console.error(`RING must be one of ${Object.keys(DEST).join(", ")} (PHI-HOLD/CREDENTIALS are handled separately).`); process.exit(2); }
const D = DEST[RING];

// ---- Secret Manager (claude-driver SA) ----
function saJwt(scope) {
  const sa = JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
}
let SMTOK = null;
async function smToken() {
  if (SMTOK) return SMTOK;
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt("https://www.googleapis.com/auth/cloud-platform"))}` });
  SMTOK = (await r.json()).access_token; return SMTOK;
}
async function sm(id) {
  const t = await smToken();
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SMPROJ}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}

// ---- Azure Blob (account SAS) ----
const encPath = (name) => name.split("/").map(encodeURIComponent).join("/");
function buildSas(acct, key) {
  const sv = "2021-12-02", sp = "rwlc", ss = "b", srt = "co";
  const st = new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19) + "Z";
  const se = new Date(Date.now() + 12 * 3600 * 1000).toISOString().slice(0, 19) + "Z";
  const sts = [acct, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
}
let ACCT, SAS;
const bUrl = (name) => `https://${ACCT}.blob.core.windows.net/${D.container}/${encPath(name)}?${SAS}`;
async function bPut(name, body, ct) { const r = await fetch(bUrl(name), { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": ct || "text/markdown; charset=utf-8" }, body }); if (!r.ok) throw new Error("put " + r.status + " " + (await r.text()).slice(0, 160)); }
async function bList(prefix) { const out = new Set(); let marker = ""; do { let u = `https://${ACCT}.blob.core.windows.net/${D.container}?restype=container&comp=list&prefix=${encodeURIComponent(prefix)}&${SAS}`; if (marker) u += `&marker=${encodeURIComponent(marker)}`; const r = await fetch(u); if (!r.ok) break; const xml = await r.text(); for (const m of xml.matchAll(/<Name>([^<]+)<\/Name>/g)) out.add(m[1]); marker = (xml.match(/<NextMarker>([^<]+)<\/NextMarker>/) || [])[1] || ""; } while (marker); return out; }

// ---- Notion API (paced + 429 backoff) ----
let NKEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function nApi(method, path, body) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`https://api.notion.com/v1${path}`, { method, headers: { Authorization: "Bearer " + NKEY, "Notion-Version": "2022-06-28", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    await sleep(340); // ~3 req/s
    return r.json();
  }
  throw new Error(`${path} kept 429-ing`);
}
const rt = (arr) => (arr || []).map((t) => t.plain_text).join("");
function propToText(p) {
  if (!p) return "";
  switch (p.type) {
    case "title": return rt(p.title);
    case "rich_text": return rt(p.rich_text);
    case "select": return p.select?.name || "";
    case "status": return p.status?.name || "";
    case "multi_select": return (p.multi_select || []).map((s) => s.name).join(", ");
    case "number": return p.number ?? "";
    case "checkbox": return p.checkbox ? "yes" : "no";
    case "date": return [p.date?.start, p.date?.end].filter(Boolean).join(" -> ");
    case "url": return p.url || ""; case "email": return p.email || ""; case "phone_number": return p.phone_number || "";
    case "people": return (p.people || []).map((u) => u.name || u.id).join(", ");
    case "files": return (p.files || []).map((f) => f.name).join(", ");
    case "formula": return p.formula?.string ?? p.formula?.number ?? p.formula?.boolean ?? "";
    case "rollup": return p.rollup?.array ? `[rollup ${p.rollup.array.length}]` : (p.rollup?.number ?? "");
    case "relation": return (p.relation || []).map((r) => r.id).join(", ");
    case "created_time": return p.created_time || ""; case "last_edited_time": return p.last_edited_time || "";
    default: return JSON.stringify(p[p.type] ?? "");
  }
}
// recursive block -> markdown
async function blocksMd(blockId, depth = 0) {
  if (depth > 6) return "  ".repeat(depth) + "_(max depth)_\n";
  let md = "", cursor;
  do {
    const res = await nApi("GET", `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    for (const b of res.results) {
      const pad = "  ".repeat(depth), t = b.type, d = b[t] || {};
      const txt = rt(d.rich_text);
      if (t === "paragraph") md += `${pad}${txt}\n\n`;
      else if (t === "heading_1") md += `\n# ${txt}\n\n`;
      else if (t === "heading_2") md += `\n## ${txt}\n\n`;
      else if (t === "heading_3") md += `\n### ${txt}\n\n`;
      else if (t === "bulleted_list_item") md += `${pad}- ${txt}\n`;
      else if (t === "numbered_list_item") md += `${pad}1. ${txt}\n`;
      else if (t === "to_do") md += `${pad}- [${d.checked ? "x" : " "}] ${txt}\n`;
      else if (t === "toggle") md += `${pad}- ${txt}\n`;
      else if (t === "quote") md += `${pad}> ${txt}\n\n`;
      else if (t === "callout") md += `${pad}> ${d.icon?.emoji || ""} ${txt}\n\n`;
      else if (t === "code") md += `\n\`\`\`${d.language || ""}\n${txt}\n\`\`\`\n\n`;
      else if (t === "divider") md += `\n---\n\n`;
      else if (t === "child_page") md += `${pad}- (sub-page) ${d.title || ""}  <${b.id}>\n`;
      else if (t === "child_database") md += `${pad}- (sub-database) ${d.title || ""}  <${b.id}>\n`;
      else if (t === "bookmark" || t === "embed") md += `${pad}- ${d.url || ""}\n`;
      else if (t === "image") md += `${pad}![image](${d.file?.url || d.external?.url || ""})\n\n`;
      else if (t === "table_row") md += `${pad}| ${(d.cells || []).map((c) => rt(c)).join(" | ")} |\n`;
      else if (txt) md += `${pad}${txt}\n\n`;
      if (b.has_children && t !== "child_page" && t !== "child_database") md += await blocksMd(b.id, depth + 1);
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return md;
}
const slug = (s) => (s || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";

// CONTENT SAFETY NET: a structural ring classifier cannot see a secret VALUE pasted in a page body.
// Scan title+content; if a real secret value or a confidential marker is present, QUARANTINE the object
// (never upload it to the shared brain). High-precision patterns to avoid quarantining prose that merely
// MENTIONS a token. Secret VALUES live in Secret Manager anyway; they must not reach a searchable store.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,                                  // PEM (.p8 / RSA / EC / OpenSSH)
  /"private_key"\s*:\s*"-----BEGIN/,                                       // GCP service-account JSON
  /\bAKIA[0-9A-Z]{16}\b/, /\bASIA[0-9A-Z]{16}\b/,                          // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, /\bgithub_pat_[A-Za-z0-9_]{60,}\b/,    // GitHub
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,                                      // Slack
  /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{24,}\b/,                                // OpenAI / Anthropic
  /\b(sk|rk|pk)_live_[A-Za-z0-9]{20,}\b/,                                  // Stripe live
  /\bAIza[0-9A-Za-z_-]{35}\b/,                                             // Google API key
  /\bphx_[A-Za-z0-9]{40,}\b/,                                              // PostHog personal
  /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/,                                         // Google OAuth client secret
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/,      // JWT (3 segments)
  /(client[_\s-]?secret|secret[_\s-]?key|refresh[_\s-]?token|access[_\s-]?token|api[_\s-]?key|password)["'\s:=]{1,6}[A-Za-z0-9._\/+=-]{20,}/i, // secret-word = long value
];
const CONFIDENTIAL = /\b(never commit|do not (share|distribute|commit)|attorney[-\s]client privilege|privileged (and|&) confidential)\b/i;
function scrubFind(text) {
  for (const re of SECRET_PATTERNS) if (re.test(text)) return "secret-value:" + (re.source.slice(0, 28));
  if (CONFIDENTIAL.test(text)) return "confidential-marker";
  return null;
}

async function exportPage(o) {
  const meta = await nApi("GET", `/pages/${o.id}`).catch(() => null);
  const md = `# ${o.title}\n\n_Notion page ${o.id} | last edited ${meta?.last_edited_time || "?"} | ring ${RING}_\n\n` + (await blocksMd(o.id));
  return md;
}
async function exportDb(o) {
  const schema = await nApi("GET", `/databases/${o.id}`).catch(() => null);
  const cols = schema ? Object.keys(schema.properties) : [];
  const rows = []; let cursor;
  do {
    const res = await nApi("POST", `/databases/${o.id}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const pg of res.results) {
      const flat = { _id: pg.id, _edited: pg.last_edited_time };
      for (const k of Object.keys(pg.properties)) flat[k] = propToText(pg.properties[k]);
      rows.push(flat);
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  let md = `# ${o.title} (database)\n\n_Notion DB ${o.id} | ${rows.length} rows | ring ${RING}_\n\n`;
  if (cols.length) { md += `| ${cols.join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |\n`; for (const r of rows) md += `| ${cols.map((c) => String(r[c] ?? "").replace(/\n/g, " ").slice(0, 200)).join(" | ")} |\n`; }
  return { md, jsonl: rows.map((r) => JSON.stringify(r)).join("\n") + "\n", count: rows.length };
}

(async () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  let items = manifest.filter((m) => m.ring === RING);
  if (LIMIT) items = items.slice(0, LIMIT);
  NKEY = KEYFILE ? readFileSync(KEYFILE, "utf8").trim() : await sm("notion-api-key");
  if (!NKEY) throw new Error("no notion key");
  ACCT = await sm(D.acctSecret); const akey = await sm(D.keySecret);
  if (!ACCT || !akey) throw new Error(`missing storage creds (${D.acctSecret}/${D.keySecret})`);
  SAS = buildSas(ACCT, akey);
  console.log(`[notion-export] RING=${RING} -> ${ACCT}/${D.container}/${D.prefix}  items=${items.length}${DRY ? "  (DRY)" : ""}`);
  const done = FORCE || DRY ? new Set() : await bList(D.prefix + "/");
  const doneIds = new Set();                         // resume by unique 32-hex id, not by slug
  for (const n of done) { const m = n.match(/[0-9a-f]{32}/); if (m) doneIds.add(m[0]); }
  let okPages = 0, okDbs = 0, rowsTot = 0, skipped = 0, errs = 0, heldN = 0;
  const held = [];
  for (const o of items) {
    const idHex = o.id.replace(/-/g, "");
    const base = `${D.prefix}/${o.type === "database" ? "db" : "page"}-${idHex}-${slug(o.title)}`;
    if (doneIds.has(idHex)) { skipped++; continue; }
    try {
      if (DRY) { console.log(`  would export [${o.type}] ${o.title}`); continue; }
      if (o.type === "database") {
        const { md, jsonl, count } = await exportDb(o);
        const hit = scrubFind(`${o.title}\n${md}\n${jsonl.slice(0, 40000)}`);
        if (hit) { held.push({ id: o.id, title: o.title, type: o.type, reason: hit }); heldN++; console.log(`  [HELD db] ${o.title} (${hit})`); continue; }
        await bPut(`${base}.md`, md); await bPut(`${base}.rows.jsonl`, jsonl, "application/x-ndjson");
        okDbs++; rowsTot += count; console.log(`  [db] ${o.title} (${count} rows)`);
      } else {
        const md = await exportPage(o);
        const hit = scrubFind(`${o.title}\n${md}`);
        if (hit) { held.push({ id: o.id, title: o.title, type: o.type, reason: hit }); heldN++; if (heldN % 10 === 0) console.log(`  ...${heldN} held`); continue; }
        await bPut(`${base}.md`, md); okPages++;
        if (okPages % 100 === 0) console.log(`  ...${okPages} pages exported`);
      }
    } catch (e) { errs++; console.error(`  ERR ${o.type} ${o.title}: ${e.message}`); }
  }
  if (held.length) await bPut(`${D.prefix}/_HELD/held-${RING.toLowerCase()}.jsonl`, held.map((h) => JSON.stringify(h)).join("\n") + "\n", "application/x-ndjson");
  console.log(`[notion-export] DONE ring=${RING}: ${okPages} pages, ${okDbs} dbs (${rowsTot} rows), QUARANTINED ${heldN} (secret/confidential), skipped ${skipped}, errors ${errs}`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

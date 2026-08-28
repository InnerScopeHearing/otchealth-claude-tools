#!/usr/bin/env node
// notion-export: ring-routed, resumable export of Notion content to the brain substrate. Originally
// the one-time engine of the Notion -> Azure retirement (Matt directive 2026-06-22).
//
// STORAGE STATE (2026-08-28, FND-20260827-bcfc): RING=OPERATIONAL is ported to S3 via the shared
// skills/kb-memory/commons-store.mjs facade -- the same one heartbeat.mjs / fleet-dispatch /
// fleet-medic / sunset-protocol / fleet-search / memory-librarian already use. The old target,
// otchealthcommons's Azure Blob account, died with the Azure subscription deletion on 2026-08-13,
// exactly like theirs did.
//
// RING=MNPI-INND and RING=PERSONAL-PRIVILEGED are NOT ported here. Their target is the separate
// LEGAL store (otchealthlegalstore), and that store's own S3 port is a distinct, still-open finding
// (FND-20260827-e7c7) needing its own ring-gated design plus a CLO/Matt sign-off on the personal
// container specifically (the personal-legal S3 WRITE IAM grant is still ReadOnly pending approval,
// per otchealth-cto CLAUDE.md's 2026-08-28 entry) -- out of scope for this pass. Selecting either
// ring now FAILS LOUD immediately (see the RING gate below), before any Notion crawl or network call,
// instead of hanging/DNS-failing against a permanently dead Azure host or reporting a false success.
// The old Azure account-SAS code for those two rings (buildSas/bUrl/bPut/bList below) is left in
// place, unused by the live path, as a working reference for whoever builds the e7c7 port.
//
// NOTE ON skills/notion-export/SKILL.md: it carries a 2026-08-27 "SUPERSEDED -- do not run or port"
// banner from a sibling audit (PR #473 / commit a642c45) that judged this whole tool a zero-caller,
// migration-already-complete dead end not worth touching at all. Those specific factual claims (zero
// callers anywhere in the repo, no job/workflow/cron; the one-time migration already completed) were
// independently re-checked during this fix and still hold. This fix was dispatched separately anyway,
// to close a real residual bug the SUPERSEDED banner does not itself fix: even a zero-caller "do not
// run" tool can still be invoked by hand from this file's own USAGE comment or from SKILL.md's history
// section, and before this fix, doing so with the OPERATIONAL ring would silently exit 0 ("DONE ...
// errors N") even when every single upload failed against the dead Azure host -- see the `errs > 0`
// check near the bottom. The two documents now visibly disagree on whether this tool should be
// touched; that tension is deliberately left FOR THE CTO TO RECONCILE (keep both, revert this fix, or
// update the banner), not resolved unilaterally in this commit.
//
// Usage:
//   GCP_CLAUDE_DRIVER_SA_JSON="$(cat ~/.gcp_claude_driver_sa.json)" \
//   node notion-export.mjs <RING> --manifest <routing-manifest.json> [--key <notion.key>] [--limit N] [--force] [--dry]
//
// RING is one of OPERATIONAL | MNPI-INND | PERSONAL-PRIVILEGED (CREDENTIALS regenerates from SM
// separately; PHI-HOLD is never exported here). Each ring maps to a (storage account, container, prefix).
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { cPut, cList, commonsConfigured } from "../kb-memory/commons-store.mjs";

const SMPROJ = "otchealth-shared-prod";
const RING = (process.argv[2] || "OPERATIONAL").toUpperCase();
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const flag = (f) => process.argv.includes(f);
const MANIFEST = arg("--manifest", "/tmp/claude-0/-home-user/fc97663c-2fd0-5ca1-a02b-c6f7cfc37ab8/scratchpad/notion-routing-manifest.json");
const KEYFILE = arg("--key", "");
const LIMIT = parseInt(arg("--limit", "0"), 10) || 0;
const FORCE = flag("--force");
const DRY = flag("--dry");
// --no-scrub: skip the content scrubber. Use ONLY when the destination is a fully access-controlled,
// segregated, non-brain-federated store (e.g. the legal PERSONAL container) where the whole point is to
// move ALL sensitive content faithfully and the container's own access control is the protection.
const NOSCRUB = flag("--no-scrub");
// --no-confidential-scrub: keep the secret-VALUE scrub, drop the confidential-MARKER quarantine. For a
// restricted destination that IS still brain-federated internally (the legal `company` / MNPI container):
// confidential is the norm there so do not quarantine on it, but raw secret values must never reach any
// indexed store, even an internal one.
const NO_CONF_SCRUB = flag("--no-confidential-scrub");

// Ring -> destination. Operational goes to the shared commons (indexed into the brain, now S3-backed
// via commons-store.mjs, backend:"s3"). MNPI + personal go to the legal store's restricted/personal
// containers (ring-correct; NOT the shared commons) -- backend:"azure-pending" because that store's S3
// port (FND-20260827-e7c7) is not built yet; acctSecret/keySecret are kept only as documentation of
// what the eventual port replaces, and for the refusal message below (RING gate).
const DEST = {
  OPERATIONAL:           { backend: "s3",           container: "company-journal", prefix: "_NOTION/operational" },
  "MNPI-INND":           { backend: "azure-pending", acctSecret: "azure-legal-storage-account", keySecret: "azure-legal-storage-key", container: "company",  prefix: "_NOTION/innd-mnpi"  },
  "PERSONAL-PRIVILEGED": { backend: "azure-pending", acctSecret: "azure-legal-storage-account", keySecret: "azure-legal-storage-key", container: "personal", prefix: "_NOTION/personal"  },
};
if (!DEST[RING]) { console.error(`RING must be one of ${Object.keys(DEST).join(", ")} (PHI-HOLD/CREDENTIALS are handled separately).`); process.exit(2); }
const D = DEST[RING];

// FND-20260827-e7c7 (open, separate finding): the legal store's own S3 port is not built yet -- it
// needs its own ring-gated design plus a CLO/Matt sign-off (the personal-legal S3 WRITE IAM grant is
// still ReadOnly pending approval). Refuse IMMEDIATELY, before touching the manifest, Notion, or any
// network call, rather than let a run against MNPI-INND / PERSONAL-PRIVILEGED hang or DNS-fail deep
// into a paced Notion crawl, or -- worse -- silently no-op and report a false "DONE" success the way
// a bare per-item try/catch would (see the errs>0 check near the bottom for the OPERATIONAL half of
// this same fail-loud requirement).
if (D.backend !== "s3") {
  console.error(`[notion-export] RING=${RING} is not runnable: its S3 replacement is not built yet (FND-20260827-e7c7, open). Its old Azure Blob target (${D.acctSecret}/${D.container}) is permanently dead -- the Azure subscription was deleted 2026-08-13. Only RING=OPERATIONAL is live right now (ported to S3, FND-20260827-bcfc). Refusing rather than attempting a call against a dead host or silently no-op'ing.`);
  process.exit(3);
}

// SECURITY: scrub relaxations are GATED BY RING so a relaxation can never fail-open into a
// brain-indexed store. --no-scrub (drops the secret-value scrub too) is allowed ONLY for the legal
// `personal` container, which is fully segregated and never federated into the company brain.
// --no-confidential-scrub (keeps the secret-value scrub) is allowed for restricted rings but never for
// OPERATIONAL, which feeds the shared commons / brain.
if (NOSCRUB && RING !== "PERSONAL-PRIVILEGED") {
  console.error(`refusing --no-scrub for RING=${RING}: only PERSONAL-PRIVILEGED (segregated, non-brain-federated) may bypass the secret-value scrub. Use --no-confidential-scrub if you only mean to keep confidential content.`);
  process.exit(2);
}
if (NO_CONF_SCRUB && RING === "OPERATIONAL") {
  console.error(`refusing --no-confidential-scrub for OPERATIONAL: it feeds the shared commons / brain index and must keep full scrubbing.`);
  process.exit(2);
}

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
  const _kv = await kvSecret(id); if (_kv != null) return _kv;
  if (!process.env.GCP_CLAUDE_DRIVER_SA_JSON) return null;   // no GCP SA post-exit -> Key Vault only; skip the retired SM fallback (smToken/saJwt would throw)
  const t = await smToken();
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SMPROJ}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}

// ---- Azure Blob (account SAS) -- DEAD PATH, kept only as a reference for the pending legal-store S3
// port (FND-20260827-e7c7). RING=OPERATIONAL no longer calls any of this (it uses commons-store.mjs's
// cPut/cList above instead); RING=MNPI-INND / RING=PERSONAL-PRIVILEGED exit via the RING gate above
// before ever reaching it. Every function below targets an Azure Blob account permanently deleted with
// the Azure subscription on 2026-08-13 -- do not "fix" anything in here to make it reach Azure again;
// the fix is to port the caller to S3 the way OPERATIONAL was (see s3-blob.mjs's MIRROR table for the
// (account,container) -> (bucket,keyPrefix) mapping the legal store would need).
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
function scrubFind(text, confidential = true) {
  for (const re of SECRET_PATTERNS) if (re.test(text)) return "secret-value:" + (re.source.slice(0, 28));
  if (confidential && CONFIDENTIAL.test(text)) return "confidential-marker";
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
  // RING is guaranteed OPERATIONAL here (the D.backend!=="s3" gate above already exited for the other
  // two), so this is always the S3 commons store now -- no Azure account/key/SAS to resolve any more.
  if (!DRY && !(await commonsConfigured())) throw new Error("AWS credentials unavailable for the commons S3 mirror (checked the ECS task role, AWS_ACCESS_KEY_ID/SECRET, and OTC_AWS_ACCESS_KEY_ID/SECRET)");
  console.log(`[notion-export] RING=${RING} -> S3 otchealthcommons/company-journal/${D.prefix}  items=${items.length}${DRY ? "  (DRY)" : ""}`);
  const done = FORCE || DRY ? new Set() : new Set(await cList(D.prefix + "/"));
  const doneIds = new Set();                         // resume by unique 32-hex id, not by slug
  for (const n of done) { const m = n.match(/[0-9a-f]{32}/); if (m) doneIds.add(m[0]); }
  let okPages = 0, okDbs = 0, rowsTot = 0, skipped = 0, errs = 0, heldN = 0;
  const held = [], bypassed = [];
  const relaxed = NOSCRUB || NO_CONF_SCRUB;
  for (const o of items) {
    const idHex = o.id.replace(/-/g, "");
    const base = `${D.prefix}/${o.type === "database" ? "db" : "page"}-${idHex}-${slug(o.title)}`;
    if (doneIds.has(idHex)) { skipped++; continue; }
    try {
      if (DRY) { console.log(`  would export [${o.type}] ${o.title}`); continue; }
      let md, jsonl, count = 0;
      if (o.type === "database") ({ md, jsonl, count } = await exportDb(o)); else md = await exportPage(o);
      const scanText = `${o.title}\n${md}${jsonl ? "\n" + jsonl.slice(0, 40000) : ""}`;
      const hit = NOSCRUB ? null : scrubFind(scanText, !NO_CONF_SCRUB);
      if (hit) { held.push({ id: o.id, title: o.title, type: o.type, reason: hit }); heldN++; if (o.type === "database") console.log(`  [HELD db] ${o.title} (${hit})`); else if (heldN % 10 === 0) console.log(`  ...${heldN} held`); continue; }
      // AUDIT: even when scrubbing is relaxed, record what the FULL scrub WOULD have caught (no content).
      if (relaxed) { const w = scrubFind(scanText, true); if (w) bypassed.push({ id: o.id, title: o.title, type: o.type, reason: w }); }
      if (o.type === "database") { await cPut(`${base}.md`, md); await cPut(`${base}.rows.jsonl`, jsonl, "application/x-ndjson"); okDbs++; rowsTot += count; console.log(`  [db] ${o.title} (${count} rows)`); }
      else { await cPut(`${base}.md`, md); okPages++; if (okPages % 100 === 0) console.log(`  ...${okPages} pages exported`); }
    } catch (e) { errs++; console.error(`  ERR ${o.type} ${o.title}: ${e.message}`); }
  }
  if (held.length) await cPut(`${D.prefix}/_HELD/held-${RING.toLowerCase()}.jsonl`, held.map((h) => JSON.stringify(h)).join("\n") + "\n", "application/x-ndjson");
  if (bypassed.length) await cPut(`${D.prefix}/_HELD/scrub-bypassed-${RING.toLowerCase()}.jsonl`, bypassed.map((h) => JSON.stringify(h)).join("\n") + "\n", "application/x-ndjson");
  console.log(`[notion-export] DONE ring=${RING}: ${okPages} pages, ${okDbs} dbs (${rowsTot} rows), QUARANTINED ${heldN}, scrub-relaxed-but-flagged ${bypassed.length}, skipped ${skipped}, errors ${errs}`);
  // FAIL LOUD: a per-item error is caught above so one bad Notion object never aborts the whole run,
  // but the run as a WHOLE must never report success when items genuinely failed to upload -- the
  // exact silent-success shape (an S3/Azure write failing while the process still exits 0) this fix
  // exists to close. errs is always 0 in DRY mode (the DRY branch returns before any upload is
  // attempted), so this never fires there.
  if (errs > 0) throw new Error(`${errs} item(s) failed to export for RING=${RING} (see ERR lines above) -- exiting non-zero rather than reporting DONE as a success`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

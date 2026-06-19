#!/usr/bin/env node
// doc-indexer — fleet document data-room engine: READ + CATALOG + INDEX + RETRIEVE a whole
// document store. Used by the CFO (financial audit room), the CLO (legal files), and any agent
// with a document store. Resumable, idempotent, profile-driven.
//
// For every object in the target store/container: download -> sha256 -> extract text (free PDF
// text-layer; Azure Document Intelligence OCR for the image-only/mangled tier; LibreOffice for
// office docs incl. legacy .doc/.xls/.ppt; tesseract fallback) -> persist the text as a
// _TEXT/<path>.txt SIDECAR (content permanently readable + greppable without re-OCR) ->
// classify by the PROFILE's taxonomy (entity/matter + category + materiality) -> append a catalog
// row -> insert into a node:sqlite FTS5 full-text index.
//
// RETRIEVAL: `search "<query>"` runs ranked FTS5 full-text search over the corpus (path + category
// + snippet). _TEXT sidecars are also directly readable/greppable (rg).
//
// OUTPUT CO-LOCATION: all artifacts (_CATALOG/catalog.jsonl, _CATALOG/index.sqlite, _CATALOG/*.csv,
// _TEXT/*) are written INTO THE SAME store/container being indexed, so they inherit that store's
// access control. Point it at the legal `personal` container and its catalog/index/sidecars stay
// confidential in that same container, never co-mingled with company or other agents.
//
// PROFILES (--profile): finance (CFO audit room) | legal (CLO legal store) | generic.
//   Each profile sets default storage (account/container/bucket + which key secret) AND the
//   classification taxonomy. Override storage with --azure-account / --container / --bucket /
//   --key-secret. Override backend with --azure / --gcs (or STORAGE_BACKEND).
//
// Creds (env, else self-resolved from Secret Manager via the claude-driver SA):
//   GCP_CLAUDE_DRIVER_SA_JSON (always); per-profile storage account + key secret (below);
//   OCR: AZURE_DOCINTEL_ENDPOINT / AZURE_DOCINTEL_KEY (azure-docintel-endpoint / -key).
//
// Commands: index | search "<q>" | build-index | status | build-csv | propose-mapping
// index flags: --profile p --azure|--gcs --container c --azure-account a --bucket b --key-secret s
//              --prefix p --limit n --reindex --no-ocr --no-text --ocr-model prebuilt-read|prebuilt-layout --flush n
//
// Non-PHI ring only. INND content is MNPI. Legal `personal` container is privileged/confidential.

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, extname } from "node:path";

const argv = process.argv.slice(2);
function takeVal(name, def = null) { const i = argv.indexOf(name); if (i >= 0) { const v = argv[i + 1]; argv.splice(i, 2); return v; } return def; }
const PROFILE = (takeVal("--profile", "generic") || "generic").toLowerCase();
const containerOverride = takeVal("--container");
const BUCKET_OV = takeVal("--bucket");
const ACCT_OV = takeVal("--azure-account");
const KEYSECRET_OV = takeVal("--key-secret");
const PREFIX = takeVal("--prefix", "");
const LIMIT = parseInt(takeVal("--limit", "0"), 10) || 0;
const OCR_MODEL = takeVal("--ocr-model", "prebuilt-read");
const FLUSH_EVERY = parseInt(takeVal("--flush", "150"), 10) || 150;
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const pos = argv.filter((a) => !a.startsWith("--"));
const cmd = pos[0] || "index";
const BACKEND = flags.has("--azure") ? "azure" : flags.has("--gcs") ? "gcs" : (process.env.STORAGE_BACKEND || "gcs").toLowerCase();
const REINDEX = flags.has("--reindex");
const NO_OCR = flags.has("--no-ocr");
const NO_TEXT = flags.has("--no-text");

const SM = "otchealth-shared-prod";
const CATALOG_KEY = "_CATALOG/catalog.jsonl";
const INDEX_KEY = "_CATALOG/index.sqlite";
const TEXT_PREFIX = "_TEXT/";
const SKIP_PREFIXES = ["_CATALOG/", "_TEXT/", "_NON-ACCOUNTING/"]; // our own artifacts
const MAXTEXT = 400000; // chars persisted per doc
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (ext) => join(tmpdir(), `idx_${Date.now()}_${Math.random().toString(36).slice(2)}${ext || ""}`);

// ============================ PROFILES (storage + taxonomy) ============================
const FINANCE_CATS = [
  ["00_Financial-Statements", /balance sheet|income statement|profit (and|&) loss|\bp&l\b|cash flow statement|statement of operations|financial statement|trial balance|general ledger|\bgl\b/i],
  ["01_Bank-Statements", /bank statement|account statement|\bstmt\b|wells ?fargo|chase|mercury|schwab|brex|checking|savings|e?statement/i],
  ["02_Credit-Cards", /credit card|amex|american express|visa|mastercard|card statement|cc statement/i],
  ["05_Payroll", /payroll|pay ?stub|paystub|\bw-?2\b|\b941\b|\b940\b|gusto|adp|wages|withholding/i],
  ["11_Tax", /\b1099\b|\b1120\b|\b1065\b|\bk-?1\b|tax return|form 941|irs|franchise tax|sales tax|\bw-?9\b|depreciation schedule/i],
  ["06_Equity-and-Cap-Table", /cap ?table|capitalization table|stock (purchase|certificate|ledger)|share(holder)?|warrant|option grant|equity incentive|83\(b\)|restricted stock/i],
  ["07_Debt-and-Convertibles", /promissory note|convertible note|\bsafe\b|loan agreement|line of credit|\bdebt\b|term loan|note payable/i],
  ["08_Reg-A-and-Capital-Raises", /reg(ulation)? a\b|reg(ulation)? d\b|reg(ulation)? cf\b|offering|subscription agreement|\bppm\b|private placement|capital raise|form c\b|form 1-a|wefunder/i],
  ["09_Acquisitions", /asset purchase|stock purchase agreement|\bmerger\b|acquisition|letter of intent|\bloi\b|term sheet|\bm&a\b|ainnova/i],
  ["10_Audit-Workpapers", /work ?paper|\bpbc\b|tie-?out|audit (schedule|adjustment)|reconciliation|\brecon\b|lead schedule/i],
  ["12_Legal-and-Contingencies", /complaint|lawsuit|settlement|demand letter|litigation|subpoena|superior court|cease and desist|contingency|legal reserve|\bnda\b/i],
  ["13_Corporate-and-Board", /board (minutes|resolution|meeting)|bylaws|operating agreement|articles of (incorporation|organization)|written consent|certificate of (incorporation|good standing)|\bein\b|corporate resolution/i],
  ["14_Related-Party-Intercompany", /intercompany|inter-company|due (to|from)|related party|officer loan|shareholder loan|advance to/i],
  ["04_Accounts-Receivable", /accounts receivable|\bar aging\b|customer invoice|sales invoice|remittance/i],
  ["03_Accounts-Payable", /\binvoice\b|\bbill\b|vendor|accounts payable|\bap aging\b|purchase order|\bpo\b|receipt|expense/i],
];
const FINANCE_MATERIAL = new Set(["00_Financial-Statements", "06_Equity-and-Cap-Table", "07_Debt-and-Convertibles", "08_Reg-A-and-Capital-Raises", "09_Acquisitions", "10_Audit-Workpapers", "12_Legal-and-Contingencies", "13_Corporate-and-Board", "14_Related-Party-Intercompany"]);
const LEGAL_CATS = [
  ["00_Pleadings", /\bcomplaint\b|answer to|cross-?complaint|\bpetition\b|complaint for|verified complaint/i],
  ["01_Motions", /motion to|notice of motion|memorandum of points|points and authorities|\bdemurrer\b|motion for summary|\bmsj\b|ex parte|opposition to|reply (brief|in support)/i],
  ["02_Discovery", /interrogator|request(s)? for production|requests for admission|\brfa\b|\brfp\b|deposition|subpoena|discovery|privilege log|meet and confer/i],
  ["03_Orders-and-Rulings", /\border\b|ruling|judgment|minute order|tentative ruling|\bwrit\b|stipulation and order/i],
  ["06_Family-Law-Disclosures", /\bfl-1\d\d\b|income and expense|declaration of disclosure|schedule of assets|community property|child support|spousal support|custody|marital settlement/i],
  ["05_Contracts-and-Agreements", /\bagreement\b|\bcontract\b|\bnda\b|amendment|engagement letter|retainer|settlement agreement|release/i],
  ["07_Evidence-and-Exhibits", /\bexhibit\b|\bevidence\b|declaration of|\baffidavit\b/i],
  ["08_Filings-and-Service", /proof of service|certificate of service|notice of (hearing|filing|appeal)|\bpos\b|case management/i],
  ["09_Research-and-Memos", /legal (memo|research)|memorandum re|case law|\bauthorities\b|research note/i],
  ["10_Corporate-Governance", /bylaws|operating agreement|board (minutes|resolution)|articles of (incorporation|organization)|written consent|certificate of good standing/i],
  ["11_Securities-Regulatory", /\bsec\b|securities|reg(ulation)? [acd]\b|8-k|10-k|10-q|prospectus|offering|edgar|form (c|1-a)/i],
  ["12_IP-and-Trademark", /trademark|copyright|\bpatent\b|\buspto\b|intellectual property|\btm\b/i],
  ["04_Correspondence", /\bletter\b|correspondence|\bemail\b|via email|dear (mr|ms|counsel)/i],
];
const LEGAL_MATERIAL = new Set(["00_Pleadings", "01_Motions", "02_Discovery", "03_Orders-and-Rulings", "06_Family-Law-Disclosures", "05_Contracts-and-Agreements", "11_Securities-Regulatory"]);
const FINANCE_NONACCT = /\b(brochure|press release|logo|banner|screenshot|product (spec|sheet)|510\(k\)|fda|marketing|website|social media|advertis|packaging|user manual|datasheet)\b/i;
const PROFILES = {
  finance: { azAccountEnv: "AZURE_STORAGE_ACCOUNT", azAccountSecret: "azure-cfo-storage-account", azAccount: "otchealthcfodata", azKeyEnv: "AZURE_STORAGE_KEY", azKeySecret: "azure-cfo-storage-key", azContainer: "cfo-source-docs", gcsBucket: "otchealth-cfo-source-docs", cats: FINANCE_CATS, material: FINANCE_MATERIAL, nonacct: FINANCE_NONACCT, pathCat: (p) => (p.toLowerCase().startsWith("qbo-export/") ? "15_Source-Accounting-Exports(QBO)" : null) },
  legal: { azAccountEnv: "AZURE_LEGAL_STORAGE_ACCOUNT", azAccountSecret: "azure-legal-storage-account", azAccount: "otchealthlegalstore", azKeyEnv: "AZURE_LEGAL_STORAGE_KEY", azKeySecret: "azure-legal-storage-key", azContainer: "company", gcsBucket: null, cats: LEGAL_CATS, material: LEGAL_MATERIAL, nonacct: null, pathCat: () => null },
  generic: { azAccountEnv: "AZURE_STORAGE_ACCOUNT", azAccountSecret: "azure-cfo-storage-account", azAccount: null, azKeyEnv: "AZURE_STORAGE_KEY", azKeySecret: "azure-cfo-storage-key", azContainer: null, gcsBucket: null, cats: [], material: new Set(), nonacct: null, pathCat: () => null },
};
const P = PROFILES[PROFILE] || PROFILES.generic;

// ---------------- Secret Manager (claude-driver SA) ----------------
function saJwt(scope) {
  const sa = JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const s = crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
  return i + "." + s;
}
async function gToken(scope) {
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt(scope))}` });
  if (!r.ok) throw new Error("SA auth " + r.status);
  return (await r.json()).access_token;
}
async function sm(id) {
  if (!id) return null;
  try { const t = await gToken("https://www.googleapis.com/auth/cloud-platform"); const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } }); if (!r.ok) return null; return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim(); } catch { return null; }
}

// ---------------- storage layer (gcs | azure) ----------------
let GBUCKET, ACCT, CONTAINER, AKEY, _gtok = null, _gtokAt = 0;
async function gAuth() { if (!_gtok || Date.now() - _gtokAt > 50 * 60 * 1000) { _gtok = await gToken("https://www.googleapis.com/auth/devstorage.read_write"); _gtokAt = Date.now(); } return _gtok; }
const AVER = "2021-12-02";
const encPath = (name) => name.split("/").map(encodeURIComponent).join("/");
function azSig(method, blob, xms, query, contentLength, contentType) {
  const ch = Object.keys(xms).sort().map((k) => `${k.toLowerCase()}:${xms[k]}`).join("\n") + "\n";
  let cr = `/${ACCT}/${CONTAINER}` + (blob ? `/${blob}` : "");
  if (query) for (const k of Object.keys(query).sort()) cr += `\n${k.toLowerCase()}:${query[k]}`;
  const sts = [method, "", "", contentLength || "", "", contentType || "", "", "", "", "", "", "", ch + cr].join("\n");
  return `SharedKey ${ACCT}:${crypto.createHmac("sha256", Buffer.from(AKEY, "base64")).update(sts, "utf8").digest("base64")}`;
}
async function initStorage() {
  if (BACKEND === "gcs") {
    GBUCKET = BUCKET_OV || process.env.CFO_SOURCE_BUCKET || P.gcsBucket || (await sm("cfo-source-bucket")) || "otchealth-cfo-source-docs"; await gAuth();
  } else {
    ACCT = ACCT_OV || process.env[P.azAccountEnv] || P.azAccount || (await sm(P.azAccountSecret)) || "otchealthcfodata";
    CONTAINER = containerOverride || process.env.CFO_AZURE_CONTAINER || P.azContainer || "data-room";
    AKEY = (KEYSECRET_OV ? await sm(KEYSECRET_OV) : null) || process.env[P.azKeyEnv] || (await sm(P.azKeySecret));
    if (!AKEY) { console.error(`Missing storage key for profile ${PROFILE} (secret ${KEYSECRET_OV || P.azKeySecret}). Account ${ACCT}, container ${CONTAINER}.`); process.exit(2); }
  }
}
async function listAll(prefix) {
  const out = [];
  if (BACKEND === "gcs") {
    let url = `https://storage.googleapis.com/storage/v1/b/${GBUCKET}/o?maxResults=1000${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ""}`;
    while (url) { const r = await fetch(url, { headers: { Authorization: `Bearer ${await gAuth()}` } }); if (!r.ok) throw new Error("list " + r.status); const j = await r.json(); for (const o of j.items || []) out.push({ name: o.name, size: +o.size, mtime: o.updated }); url = j.nextPageToken ? `https://storage.googleapis.com/storage/v1/b/${GBUCKET}/o?maxResults=1000&pageToken=${j.nextPageToken}${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ""}` : null; }
  } else {
    let marker = "";
    do { const q = { comp: "list", restype: "container" }; if (prefix) q.prefix = prefix; if (marker) q.marker = marker; const xms = { "x-ms-date": new Date().toUTCString(), "x-ms-version": AVER }; const auth = azSig("GET", "", xms, q, "", ""); let url = `https://${ACCT}.blob.core.windows.net/${CONTAINER}?restype=container&comp=list`; if (prefix) url += `&prefix=${encodeURIComponent(prefix)}`; if (marker) url += `&marker=${encodeURIComponent(marker)}`; const r = await fetch(url, { headers: { ...xms, Authorization: auth } }); if (!r.ok) throw new Error("list " + r.status); const xml = await r.text(); for (const m of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) { const b = m[1]; const name = (b.match(/<Name>([^<]+)<\/Name>/) || [])[1]; const size = +((b.match(/<Content-Length>([^<]+)<\/Content-Length>/) || [])[1] || 0); const mtime = (b.match(/<Last-Modified>([^<]+)<\/Last-Modified>/) || [])[1] || ""; if (name) out.push({ name, size, mtime }); } marker = (xml.match(/<NextMarker>([^<]+)<\/NextMarker>/) || [])[1] || ""; } while (marker);
  }
  return out;
}
async function getBuf(name) {
  if (BACKEND === "gcs") { const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${GBUCKET}/o/${encodeURIComponent(name)}?alt=media`, { headers: { Authorization: `Bearer ${await gAuth()}` } }); if (r.status === 404) return null; if (!r.ok) throw new Error("get " + r.status); return Buffer.from(await r.arrayBuffer()); }
  const xms = { "x-ms-date": new Date().toUTCString(), "x-ms-version": AVER }; const auth = azSig("GET", name, xms, null, "", ""); const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${encPath(name)}`, { headers: { ...xms, Authorization: auth } }); if (r.status === 404) return null; if (!r.ok) throw new Error("get " + r.status); return Buffer.from(await r.arrayBuffer());
}
async function putBuf(name, buf, ct) {
  if (BACKEND === "gcs") { const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${GBUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}`, { method: "POST", headers: { Authorization: `Bearer ${await gAuth()}`, "Content-Type": ct || "application/octet-stream" }, body: buf }); if (!r.ok) throw new Error("put " + r.status + " " + (await r.text()).slice(0, 120)); return; }
  const xms = { "x-ms-blob-type": "BlockBlob", "x-ms-date": new Date().toUTCString(), "x-ms-version": AVER }; const c = ct || "application/octet-stream"; const auth = azSig("PUT", name, xms, null, String(buf.length), c); const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${encPath(name)}`, { method: "PUT", headers: { ...xms, "Content-Type": c, Authorization: auth }, body: buf }); if (!r.ok) throw new Error("put " + r.status + " " + (await r.text()).slice(0, 120));
}

// ---------------- text extraction ----------------
const stripTags = (s) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#?\w+;/g, " ").replace(/\s+/g, " ").trim();
const alnum = (s) => (s.match(/[a-z0-9]/gi) || []).length;
function sh(bin, args, opts) { try { return execFileSync(bin, args, { maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], ...(opts || {}) }).toString("utf8"); } catch { return ""; } }
function officeToText(buf, ext) {
  const inF = tmp(ext); writeFileSync(inF, buf); const outDir = tmp(""); mkdirSync(outDir, { recursive: true }); const prof = "file://" + tmp("");
  try { sh("soffice", ["--headless", "-env:UserInstallation=" + prof, "--convert-to", "pdf", "--outdir", outDir, inF], { timeout: 120000 }); const pdfPath = join(outDir, basename(inF).replace(/\.[^.]+$/, "") + ".pdf"); let text = ""; try { text = sh("pdftotext", ["-layout", pdfPath, "-"]); } catch {} try { unlinkSync(pdfPath); } catch {} return text; }
  catch { return ""; } finally { try { unlinkSync(inF); } catch {} }
}
function officeUnzipFallback(buf, ext) {
  const f = tmp(ext); writeFileSync(f, buf); const parts = [];
  const entries = ext === ".docx" ? ["word/document.xml"] : ext === ".xlsx" ? ["xl/sharedStrings.xml"] : ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"];
  for (const e of entries) { const x = sh("unzip", ["-p", f, e]); if (x) parts.push(stripTags(x)); }
  try { unlinkSync(f); } catch {}
  return parts.join(" ");
}
let DI_EP, DI_KEY, _diInit = false;
async function diInit() { if (_diInit) return; _diInit = true; DI_EP = (process.env.AZURE_DOCINTEL_ENDPOINT || (await sm("azure-docintel-endpoint")) || "").replace(/\/$/, ""); DI_KEY = process.env.AZURE_DOCINTEL_KEY || (await sm("azure-docintel-key")); }
async function docintel(buf, model) {
  await diInit(); if (!DI_EP || !DI_KEY) return null;
  const url = `${DI_EP}/documentintelligence/documentModels/${model || OCR_MODEL}:analyze?api-version=2024-11-30`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, { method: "POST", headers: { "Ocp-Apim-Subscription-Key": DI_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ base64Source: buf.toString("base64") }) });
    if (r.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    if (r.status !== 202) throw new Error("DI analyze " + r.status + " " + (await r.text()).slice(0, 120));
    const op = r.headers.get("operation-location"); if (!op) throw new Error("DI no operation-location");
    for (let i = 0; i < 80; i++) { await sleep(1500); const g = await fetch(op, { headers: { "Ocp-Apim-Subscription-Key": DI_KEY } }); if (!g.ok) continue; const j = await g.json(); if (j.status === "succeeded") return j.analyzeResult?.content || ""; if (j.status === "failed") throw new Error("DI failed"); }
    throw new Error("DI poll timeout");
  }
  throw new Error("DI 429 exhausted");
}
function tesseractImg(buf, ext) { const f = tmp(ext); try { writeFileSync(f, buf); const out = tmp(); sh("tesseract", [f, out, "--psm", "3"]); try { return readFileSync(out + ".txt", "utf8"); } catch { return ""; } finally { try { unlinkSync(out + ".txt"); } catch {} } } finally { try { unlinkSync(f); } catch {} } }
async function extract(name, buf) {
  const ext = extname(name).toLowerCase();
  if ([".txt", ".csv", ".log", ".md", ".json", ".tsv"].includes(ext)) return { text: buf.toString("utf8").slice(0, MAXTEXT), ocr: false, engine: "text" };
  if ([".html", ".htm", ".xml", ".eml"].includes(ext)) return { text: (ext === ".eml" ? buf.toString("utf8") : stripTags(buf.toString("utf8"))).slice(0, MAXTEXT), ocr: false, engine: "text" };
  if (ext === ".pdf") {
    const f = tmp(".pdf"); writeFileSync(f, buf); let text = ""; try { text = sh("pdftotext", ["-layout", f, "-"]); } catch {} try { unlinkSync(f); } catch {}
    if (alnum(text) >= 30) return { text: text.slice(0, MAXTEXT), ocr: false, engine: "pdftotext" };
    if (!NO_OCR) { try { const di = await docintel(buf); if (di && alnum(di) >= 10) return { text: di.slice(0, MAXTEXT), ocr: true, engine: "docintel:" + OCR_MODEL }; } catch {} }
    return { text: text.slice(0, MAXTEXT), ocr: false, engine: text ? "pdftotext-thin" : "none", err: alnum(text) < 30 ? "image-only/thin-text" : "" };
  }
  if ([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"].includes(ext)) {
    if (!NO_OCR) { try { const di = await docintel(buf); if (di !== null) return { text: di.slice(0, MAXTEXT), ocr: true, engine: "docintel:" + OCR_MODEL }; } catch {} const t = tesseractImg(buf, ext); if (t) return { text: t.slice(0, MAXTEXT), ocr: true, engine: "tesseract" }; }
    return { text: "", ocr: false, engine: "none" };
  }
  if ([".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt", ".rtf", ".odt", ".ods", ".odp"].includes(ext)) {
    let text = officeToText(buf, ext); let engine = "libreoffice";
    if (alnum(text) < 5 && [".docx", ".xlsx", ".pptx"].includes(ext)) { text = officeUnzipFallback(buf, ext); engine = text ? "office-unzip" : "none"; }
    return { text: (text || "").slice(0, MAXTEXT), ocr: false, engine };
  }
  return { text: "", ocr: false, engine: "skip" };
}

// ---------------- classifier (profile-driven) ----------------
function entityOf(path) {
  const seg = (path.split("/")[0] || "").trim();
  if (PROFILE === "finance") { const t = seg.toLowerCase(); if (t.startsWith("innd") || t.startsWith("innerscope")) return "InnerScope"; if (t.startsWith("hearingassist")) return "HearingAssist"; if (t.startsWith("otchealth")) return "OTCHealth"; if (t.startsWith("ihear")) return "iHEAR"; if (t.startsWith("personal")) return "Personal"; if (t.startsWith("qbo-export")) return "QBO-Mixed"; return "Unknown"; }
  return seg || "(root)";
}
function classify(path, text) {
  const hay = (path.replace(/[\/_-]/g, " ") + " \n " + (text || "")).slice(0, 8000).toLowerCase();
  const pc = P.pathCat && P.pathCat(path); if (pc) return { category: pc, material: P.material.has(pc) };
  for (const [folder, re] of P.cats) { if (re.test(hay)) return { category: folder, material: P.material.has(folder) }; }
  if (P.nonacct && P.nonacct.test(hay)) return { category: "_NON-ACCOUNTING", material: false };
  return { category: "_INBOX-UNCLASSIFIED", material: false };
}
function describe(path, text) { const bn = basename(path); const line = (text || "").split(/\r?\n/).map((s) => s.trim()).find((s) => alnum(s) >= 8) || ""; return (bn + (line ? " | " + line : "")).replace(/\s+/g, " ").slice(0, 180); }

// ---------------- FTS5 index (node:sqlite) ----------------
let _SQLITE = null;
async function sqliteCtor() { if (_SQLITE === null) { try { _SQLITE = (await import("node:sqlite")).DatabaseSync; } catch { _SQLITE = false; } } return _SQLITE; }
let _db = null, _dbPath = null, _dbInsert = null, _dbDelete = null;
async function openIndex() {
  const S = await sqliteCtor(); if (!S) { console.error("  (node:sqlite unavailable; FTS index skipped, sidecars still written)"); return false; }
  _dbPath = tmp(".sqlite"); const ex = await getBuf(INDEX_KEY); if (ex) writeFileSync(_dbPath, ex);
  _db = new S(_dbPath); _db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(path UNINDEXED, entity, category, title, body)");
  _dbDelete = _db.prepare("DELETE FROM docs WHERE path = ?"); _dbInsert = _db.prepare("INSERT INTO docs(path,entity,category,title,body) VALUES(?,?,?,?,?)");
  return true;
}
function indexUpsert(row, body) { if (!_db) return; try { _dbDelete.run(row.path); _dbInsert.run(row.path, row.entity || "", row.category || "", row.title || "", body || ""); } catch {} }
async function uploadIndex() { if (!_db) return; try { _db.close(); } catch {} try { await putBuf(INDEX_KEY, readFileSync(_dbPath), "application/x-sqlite3"); } catch (e) { console.error("  index upload failed: " + e.message); } }

// ---------------- catalog io ----------------
async function loadCatalog() { const buf = await getBuf(CATALOG_KEY); if (!buf) return []; const rows = []; for (const ln of buf.toString("utf8").split("\n")) { const s = ln.trim(); if (!s) continue; try { rows.push(JSON.parse(s)); } catch {} } return rows; }
async function flushCatalog(rows) { await putBuf(CATALOG_KEY, Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8"), "application/x-ndjson"); }

// ---------------- commands ----------------
async function runIndex() {
  await initStorage();
  const rows = REINDEX ? [] : await loadCatalog();
  const done = new Set(rows.map((r) => r.path));
  const objs = (await listAll(PREFIX)).filter((o) => !SKIP_PREFIXES.some((p) => o.name.startsWith(p)) && !o.name.endsWith("/"));
  const todo = objs.filter((o) => REINDEX || !done.has(o.name));
  console.error(`[index] profile=${PROFILE} backend=${BACKEND} target=${BACKEND === "gcs" ? GBUCKET : ACCT + "/" + CONTAINER} room=${objs.length}; ${done.size} cataloged; ${todo.length} to do${LIMIT ? ` (limit ${LIMIT})` : ""}.`);
  const haveIndex = await openIndex();
  let n = 0, since = 0;
  for (const o of todo) {
    if (LIMIT && n >= LIMIT) break;
    const ext = extname(o.name).toLowerCase();
    const row = { path: o.name, backend: BACKEND, ext: ext.replace(".", ""), size: o.size, mtime: o.mtime, entity: entityOf(o.name), ts: new Date().toISOString() };
    try {
      const buf = await getBuf(o.name);
      if (!buf) { row.err = "missing"; }
      else {
        row.sha256 = crypto.createHash("sha256").update(buf).digest("hex");
        const ex = await extract(o.name, buf);
        row.text_chars = alnum(ex.text); row.ocr = ex.ocr; row.engine = ex.engine; if (ex.err) row.err = ex.err;
        const c = classify(o.name, ex.text); row.category = c.category; row.material = c.material;
        row.title = basename(o.name); row.desc = describe(o.name, ex.text);
        if (!NO_TEXT && ex.text && row.text_chars >= 3) { try { await putBuf(TEXT_PREFIX + o.name + ".txt", Buffer.from(ex.text, "utf8"), "text/plain; charset=utf-8"); row.sidecar = true; } catch {} }
        if (haveIndex) indexUpsert(row, ex.text);
      }
    } catch (e) { row.err = (row.err ? row.err + "; " : "") + e.message.slice(0, 120); }
    rows.push(row); done.add(o.name); n++; since++;
    if (since >= FLUSH_EVERY) { await flushCatalog(rows); since = 0; console.error(`  ...${n}/${todo.length} (flushed; ${row.category || "?"} :: ${row.path.slice(-48)})`); }
  }
  await flushCatalog(rows);
  if (haveIndex) await uploadIndex();
  console.error(`[index] done: +${n} rows, ${rows.length} total. catalog=${CATALOG_KEY} index=${haveIndex ? INDEX_KEY : "(skipped)"} sidecars=${NO_TEXT ? "off" : TEXT_PREFIX}`);
}

async function runSearch(q) {
  if (!q) { console.error('usage: search "<query>"  (FTS5: terms, "phrases", prefix*, AND/OR/NOT)'); process.exit(2); }
  await initStorage(); const S = await sqliteCtor(); if (!S) { console.error("node:sqlite unavailable"); process.exit(1); }
  const buf = await getBuf(INDEX_KEY); if (!buf) { console.error("no index yet; run `index` (builds it) or `build-index`"); process.exit(1); }
  const p = tmp(".sqlite"); writeFileSync(p, buf); const db = new S(p);
  let rows; try { rows = db.prepare(`SELECT path, entity, category, snippet(docs, 4, '»', '«', ' … ', 16) AS snip FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?`).all(q, LIMIT || 25); }
  catch (e) { console.error("query error: " + e.message); process.exit(1); }
  for (const r of rows) console.log(`[${(r.category || "?").padEnd(32)}] ${r.entity}  ${r.path}\n      ${(r.snip || "").replace(/\s+/g, " ").slice(0, 200)}`);
  console.log(`(${rows.length} hits for: ${q})`);
}

async function runBuildIndex() {
  await initStorage(); const S = await sqliteCtor(); if (!S) { console.error("node:sqlite unavailable"); process.exit(1); }
  const meta = new Map((await loadCatalog()).map((r) => [r.path, r]));
  const sides = (await listAll(TEXT_PREFIX)).filter((o) => o.name.endsWith(".txt"));
  const p = tmp(".sqlite"); const db = new S(p); db.exec("CREATE VIRTUAL TABLE docs USING fts5(path UNINDEXED, entity, category, title, body)");
  const ins = db.prepare("INSERT INTO docs(path,entity,category,title,body) VALUES(?,?,?,?,?)");
  let n = 0;
  for (const s of sides) { const orig = s.name.slice(TEXT_PREFIX.length).replace(/\.txt$/, ""); const m = meta.get(orig) || {}; const body = (await getBuf(s.name))?.toString("utf8") || ""; ins.run(orig, m.entity || entityOf(orig), m.category || "", m.title || basename(orig), body); n++; if (n % 250 === 0) console.error(`  indexed ${n}/${sides.length}`); }
  db.close(); await putBuf(INDEX_KEY, readFileSync(p), "application/x-sqlite3");
  console.log(`built ${INDEX_KEY} from ${n} sidecars`);
}

async function runStatus() {
  await initStorage();
  const rows = await loadCatalog();
  const objs = (await listAll(PREFIX)).filter((o) => !SKIP_PREFIXES.some((p) => o.name.startsWith(p)) && !o.name.endsWith("/"));
  const byCat = {}, byEnt = {}, byEng = {}; let ocrN = 0, errN = 0, material = 0, side = 0;
  for (const r of rows) { byCat[r.category] = (byCat[r.category] || 0) + 1; byEnt[r.entity] = (byEnt[r.entity] || 0) + 1; byEng[r.engine || "?"] = (byEng[r.engine || "?"] || 0) + 1; if (r.ocr) ocrN++; if (r.err) errN++; if (r.material) material++; if (r.sidecar) side++; }
  console.log(`profile=${PROFILE} target=${BACKEND === "gcs" ? GBUCKET : ACCT + "/" + CONTAINER}`);
  console.log(`catalog: ${rows.length} rows | room: ${objs.length} objects | remaining: ${Math.max(0, objs.length - rows.length)}`);
  console.log(`text sidecars: ${side} | ocr'd: ${ocrN} | material: ${material} | errors: ${errN}`);
  const show = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `   ${String(v).padStart(6)}  ${k}`).join("\n");
  console.log("\nby entity:\n" + show(byEnt)); console.log("\nby category:\n" + show(byCat)); console.log("\nby engine:\n" + show(byEng));
}

function entityFolder(e) { if (PROFILE === "finance") return ({ InnerScope: "INND", HearingAssist: "HearingAssist", OTCHealth: "OTCHealth", iHEAR: "iHEAR", Personal: "Personal", "QBO-Mixed": "_SHARED-QBO", Unknown: "_SHARED" })[e] || "_SHARED"; return e || "_SHARED"; }
async function runProposeMapping() {
  await initStorage(); const rows = await loadCatalog(); if (!rows.length) { console.error("no catalog yet; run index first"); process.exit(1); }
  const seen = new Map(); const lines = ["old_path,new_path,entity,category,material"];
  for (const r of rows) {
    const cat = r.category || "_INBOX-UNCLASSIFIED";
    const top = cat === "_NON-ACCOUNTING" ? "_NON-ACCOUNTING/" + entityFolder(r.entity) : entityFolder(r.entity) + "/" + cat;
    let np = `${top}/${basename(r.path)}`;
    if (seen.has(np)) { const h = (r.sha256 || "").slice(0, 6) || Math.random().toString(36).slice(2, 8); const b = basename(r.path); const dot = b.lastIndexOf("."); np = `${top}/${dot > 0 ? b.slice(0, dot) + "_" + h + b.slice(dot) : b + "_" + h}`; }
    seen.set(np, 1);
    const q = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
    lines.push([q(r.path), q(np), q(r.entity), q(cat), r.material ? "1" : "0"].join(","));
  }
  await putBuf("_CATALOG/mapping-proposed.csv", Buffer.from(lines.join("\n") + "\n", "utf8"), "text/csv");
  console.log(`proposed mapping for ${rows.length} docs -> _CATALOG/mapping-proposed.csv (owner reviews; CTO executes during migration)`);
}
async function runBuildCsv() {
  await initStorage(); const rows = await loadCatalog();
  const cols = ["path", "entity", "category", "material", "ext", "size", "sha256", "ocr", "engine", "text_chars", "sidecar", "mtime", "desc", "err"];
  const q = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
  const lines = [cols.join(",")]; for (const r of rows) lines.push(cols.map((c) => (c === "material" || c === "sidecar" ? (r[c] ? 1 : 0) : q(r[c]))).join(","));
  await putBuf("_CATALOG/catalog.csv", Buffer.from(lines.join("\n") + "\n", "utf8"), "text/csv");
  console.log(`wrote _CATALOG/catalog.csv (${rows.length} rows)`);
}

try {
  if (cmd === "index") await runIndex();
  else if (cmd === "search") await runSearch(pos.slice(1).join(" "));
  else if (cmd === "build-index") await runBuildIndex();
  else if (cmd === "status") await runStatus();
  else if (cmd === "propose-mapping") await runProposeMapping();
  else if (cmd === "build-csv") await runBuildCsv();
  else { console.error('commands: index | search "<q>" | build-index | status | build-csv | propose-mapping\nflags: --profile finance|legal|generic --azure|--gcs --container c --azure-account a --bucket b --key-secret s --prefix p --limit n --ocr-model prebuilt-read|prebuilt-layout --no-ocr --no-text --reindex'); process.exit(2); }
} catch (e) { console.error("ERROR: " + e.message); process.exit(1); }

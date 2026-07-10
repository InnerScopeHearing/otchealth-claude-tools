#!/usr/bin/env node
// force-ocr-specific-files.mjs
//
// SURGICAL one-off: force real Azure Document Intelligence OCR re-extraction for an
// explicit list of already-cataloged blob paths, bypassing the doc-indexer's normal
// pdftotext "alnum >= 30" quality gate (indexer.mjs extract(), .pdf branch) which
// treats garbled-but-present text (bad font encoding) as "good enough" and never
// tries OCR. Confirmed root cause for these 2 files via direct _TEXT/ sidecar
// inspection: pdftotext produced ~2,900 chars of readable-count-but-unreadable
// mojibake, which passed the >=30 alnum gate and skipped OCR entirely.
//
// This script ONLY touches the exact paths passed on the command line. It does not
// re-scan the room, does not touch any other catalog row, and does not re-run the
// full indexer. It:
//   1. downloads each target blob
//   2. runs it through Azure Document Intelligence (prebuilt-read) directly
//   3. overwrites just that blob's _TEXT/<path>.txt sidecar with the OCR'd text
//   4. patches just that path's row in _CATALOG/catalog.jsonl (text_chars, ocr,
//      engine, err cleared, desc refreshed) -- every other row is re-written
//      byte-identical
//   5. best-effort upserts the FTS5 sqlite index (_CATALOG/index.sqlite) for the
//      same paths, matching indexer.mjs's own openIndex()/indexUpsert()/uploadIndex()
//      logic; if node:sqlite isn't available it skips silently (sidecars + catalog
//      are still authoritative -- same fallback the indexer itself uses)
//
// Usage:
//   node force-ocr-specific-files.mjs --container personal --path "clo-outgoing/Divorce Case Summary and ALL Filings/Summary of All Divorce Documents as of 7.6.26.pdf" --path "clo-outgoing/Divorce Case Summary and ALL Filings/Summary of All Divorce Hearings as of 7.6.26.pdf"
//
// Required env: AZURE_LEGAL_STORAGE_ACCOUNT, AZURE_LEGAL_STORAGE_KEY,
//               AZURE_DOCINTEL_ENDPOINT, AZURE_DOCINTEL_KEY

import { createHmac, createHash } from "node:crypto";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { basename } from "node:path";

const argv = process.argv.slice(2);
function takeVal(name) { const i = argv.indexOf(name); if (i < 0) return null; return argv[i + 1]; }
function takeAll(name) { const out = []; for (let i = 0; i < argv.length; i++) if (argv[i] === name) out.push(argv[i + 1]); return out; }

const CONTAINER = takeVal("--container") || "personal";
const TARGET_PATHS = takeAll("--path");
if (!TARGET_PATHS.length) { console.error("Usage: --container <c> --path <blob-path> [--path <blob-path> ...]"); process.exit(2); }

const ACCT = process.env.AZURE_LEGAL_STORAGE_ACCOUNT;
const AKEY = process.env.AZURE_LEGAL_STORAGE_KEY;
const DI_EP = (process.env.AZURE_DOCINTEL_ENDPOINT || "").replace(/\/$/, "");
const DI_KEY = process.env.AZURE_DOCINTEL_KEY;
if (!ACCT || !AKEY || !DI_EP || !DI_KEY) { console.error("Missing one of AZURE_LEGAL_STORAGE_ACCOUNT / AZURE_LEGAL_STORAGE_KEY / AZURE_DOCINTEL_ENDPOINT / AZURE_DOCINTEL_KEY"); process.exit(2); }

const CATALOG_KEY = "_CATALOG/catalog.jsonl";
const INDEX_KEY = "_CATALOG/index.sqlite";
const TEXT_PREFIX = "_TEXT/";
const MAXTEXT = 4_000_000;

const encPath = (name) => name.split("/").map(encodeURIComponent).join("/");
const alnum = (s) => (s.match(/[a-z0-9]/gi) || []).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildAzSas() {
  const sv = "2021-12-02", sp = "rwlc", ss = "b", srt = "co";
  const st = new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19) + "Z";
  const se = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 19) + "Z";
  const sts = [ACCT, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = createHmac("sha256", Buffer.from(AKEY, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
}
const AZ_SAS = buildAzSas();

async function getBuf(name) {
  const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${encPath(name)}?${AZ_SAS}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`get ${name} -> ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function putBuf(name, buf, ct) {
  const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${encPath(name)}?${AZ_SAS}`, {
    method: "PUT",
    headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": ct || "application/octet-stream" },
    body: buf,
  });
  if (!r.ok) throw new Error(`put ${name} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
}

// Mirrors indexer.mjs docintel() exactly (same endpoint shape, same poll loop).
async function docintel(buf, model = "prebuilt-read") {
  const url = `${DI_EP}/documentintelligence/documentModels/${model}:analyze?api-version=2024-11-30`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": DI_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ base64Source: buf.toString("base64") }),
    });
    if (r.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    if (r.status !== 202) throw new Error("DI analyze " + r.status + " " + (await r.text()).slice(0, 200));
    const op = r.headers.get("operation-location");
    if (!op) throw new Error("DI no operation-location");
    for (let i = 0; i < 80; i++) {
      await sleep(1500);
      const g = await fetch(op, { headers: { "Ocp-Apim-Subscription-Key": DI_KEY } });
      if (!g.ok) continue;
      const j = await g.json();
      if (j.status === "succeeded") return j.analyzeResult?.content || "";
      if (j.status === "failed") throw new Error("DI failed: " + JSON.stringify(j).slice(0, 300));
    }
    throw new Error("DI poll timeout");
  }
  throw new Error("DI 429 exhausted");
}

function describe(path, text) {
  const bn = basename(path);
  const line = (text || "").split(/\r?\n/).map((s) => s.trim()).find((s) => alnum(s) >= 8) || "";
  return (bn + (line ? " | " + line : "")).replace(/\s+/g, " ").slice(0, 180);
}

async function loadCatalog() {
  const buf = await getBuf(CATALOG_KEY);
  if (!buf) return [];
  const rows = [];
  for (const ln of buf.toString("utf8").split("\n")) {
    const s = ln.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch {}
  }
  return rows;
}
async function flushCatalog(rows) {
  await putBuf(CATALOG_KEY, Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8"), "application/x-ndjson");
}

async function main() {
  console.log(`[force-ocr] container=${CONTAINER} targets=${TARGET_PATHS.length}`);
  const rows = await loadCatalog();
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const results = [];

  for (const path of TARGET_PATHS) {
    console.log(`\n--- ${path} ---`);
    const row = byPath.get(path);
    if (!row) { console.error(`  SKIP: no existing catalog row for this path -- refusing to touch a file this script wasn't told is already cataloged.`); results.push({ path, ok: false, reason: "not-in-catalog" }); continue; }

    const buf = await getBuf(path);
    if (!buf) { console.error(`  SKIP: blob not found in storage.`); results.push({ path, ok: false, reason: "blob-missing" }); continue; }

    const sha256 = createHash("sha256").update(buf).digest("hex");
    console.log(`  downloaded ${buf.length} bytes, sha256=${sha256.slice(0, 12)}... (catalog had ${row.sha256?.slice(0, 12)}...)`);

    console.log(`  calling Azure Document Intelligence (prebuilt-read)...`);
    const t0 = Date.now();
    const ocrText = await docintel(buf, "prebuilt-read");
    const ms = Date.now() - t0;
    const chars = alnum(ocrText);
    console.log(`  OCR done in ${ms}ms -- ${ocrText.length} raw chars, ${chars} alnum chars`);

    if (!ocrText || chars < 10) {
      console.error(`  WARNING: OCR result looks empty/too-thin (${chars} alnum chars) -- NOT overwriting the sidecar/catalog for this file. Leaving prior pdftotext result in place.`);
      results.push({ path, ok: false, reason: "ocr-too-thin", chars });
      continue;
    }

    const clipped = ocrText.slice(0, MAXTEXT);
    await putBuf(TEXT_PREFIX + path + ".txt", Buffer.from(clipped, "utf8"), "text/plain; charset=utf-8");
    console.log(`  sidecar overwritten: ${TEXT_PREFIX}${path}.txt`);

    row.sha256 = sha256;
    row.text_chars = chars;
    row.ocr = true;
    row.engine = "docintel:prebuilt-read";
    row.sidecar = true;
    delete row.err;
    row.desc = describe(path, clipped);
    row.ts = new Date().toISOString();
    console.log(`  catalog row patched: text_chars ${chars}, ocr=true, engine=docintel:prebuilt-read`);

    results.push({ path, ok: true, chars, engine: row.engine, textPreview: clipped.slice(0, 300) });
  }

  const touched = results.filter((r) => r.ok).length;
  if (touched > 0) {
    await flushCatalog(rows);
    console.log(`\n[force-ocr] catalog.jsonl re-flushed (${rows.length} total rows, ${touched} patched, all others byte-identical).`);
  } else {
    console.log(`\n[force-ocr] no rows were successfully OCR'd -- catalog.jsonl left untouched.`);
  }

  // Best-effort FTS5 sqlite upsert, mirroring indexer.mjs's own fallback: if node:sqlite
  // isn't available in this runtime, skip it -- sidecars + catalog.jsonl remain authoritative.
  if (touched > 0) {
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const dbBuf = await getBuf(INDEX_KEY);
      if (dbBuf) {
        const tmpPath = `/tmp/force-ocr-index-${Date.now()}.sqlite`;
        writeFileSync(tmpPath, dbBuf);
        const db = new DatabaseSync(tmpPath);
        db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(path UNINDEXED, entity, category, title, body)");
        const del = db.prepare("DELETE FROM docs WHERE path = ?");
        const ins = db.prepare("INSERT INTO docs(path,entity,category,title,body) VALUES(?,?,?,?,?)");
        for (const r of results.filter((x) => x.ok)) {
          const row = byPath.get(r.path);
          const bodyBuf = await getBuf(TEXT_PREFIX + r.path + ".txt");
          const body = bodyBuf ? bodyBuf.toString("utf8") : "";
          del.run(r.path);
          ins.run(r.path, row.entity || "", row.category || "", row.title || "", body);
          console.log(`  FTS5 index upserted for: ${r.path}`);
        }
        db.close();
        await putBuf(INDEX_KEY, readFileSync(tmpPath), "application/x-sqlite3");
        try { unlinkSync(tmpPath); } catch {}
        console.log(`[force-ocr] index.sqlite re-uploaded with ${touched} row(s) refreshed.`);
      } else {
        console.log(`[force-ocr] no existing index.sqlite found -- skipping FTS upsert (sidecars + catalog are authoritative).`);
      }
    } catch (e) {
      console.log(`[force-ocr] node:sqlite unavailable or FTS upsert failed (${e.message}) -- sidecars + catalog.jsonl already patched and are authoritative; FTS index will self-heal on next full reindex.`);
    }
  }

  console.log(`\n[force-ocr] SUMMARY:`);
  for (const r of results) {
    if (r.ok) {
      console.log(`  OK   ${r.path} -> ${r.chars} alnum chars via ${r.engine}`);
      console.log(`       preview: ${r.textPreview.replace(/\n/g, " ").slice(0, 200)}`);
    } else {
      console.log(`  FAIL ${r.path} -> ${r.reason}`);
    }
  }
  if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((e) => { console.error("[force-ocr] FATAL:", e.stack || e.message); process.exit(1); });

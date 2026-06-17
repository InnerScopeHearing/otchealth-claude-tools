#!/usr/bin/env node
// INND daily stock-price history for the CFO records.
// InnerScope Hearing Technologies, Inc. (OTC: INND) - a public company. This pulls
// PUBLIC market data only (published OTC prices) for INTERNAL CFO record-keeping. It
// is not investor-facing publishing or stock promotion (securities firewall safe).
//
// Source: Yahoo Finance daily OHLCV + adjusted close (free, covers INND from
// 2017-03-15 to present). True intraday VWAP and trade-count require a paid feed
// (e.g. Polygon); until then VWAP is the standard daily proxy = typical price
// (High+Low+Close)/3, clearly labeled.
//
// The canonical workbook lives in the CFO source-doc bucket (GCS) so it is one file
// that grows over time. `backfill` builds it from full history; `update` appends any
// new trading days (idempotent) - run `update` daily after the close.
//
// Creds (hydrated): GCP_CLAUDE_DRIVER_SA_JSON (GCS read/write to the cfo-store bucket).
//
// Usage:
//   node innd-stock.mjs backfill         # build the full-history workbook from scratch + upload
//   node innd-stock.mjs update           # fetch recent days, append new ones, re-upload (daily)
//   node innd-stock.mjs status           # show last date + row count in the stored workbook
//   node innd-stock.mjs local <file>     # write the full workbook to a local path (no upload)

import { createRequire } from "node:module";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// Lazy-install xlsx if missing (skill is dependency-light otherwise).
function loadXLSX() {
  const require = createRequire(import.meta.url);
  try { return require("xlsx"); }
  catch {
    console.error("installing xlsx ...");
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: HERE, stdio: "ignore" });
    return require("xlsx");
  }
}

const TICKER = "INND";
const COMPANY = "InnerScope Hearing Technologies, Inc.";
const BUCKET = process.env.CFO_SOURCE_BUCKET || "otchealth-cfo-source-docs";
const OBJECT = "innd-stock/INND-daily-stock-history.xlsx";
const START_EPOCH = 1451606400; // 2016-01-01 (Yahoo returns from the stock's first available day)

// ---- GCS (via the claude-driver SA) ---------------------------------------
function need(n){ const v=process.env[n]; if(!v){ console.error("Missing env "+n); process.exit(2);} return v; }
async function gcsToken(scope){
  const sa = JSON.parse(need("GCP_CLAUDE_DRIVER_SA_JSON"));
  const now = Math.floor(Date.now()/1000);
  const e = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({alg:"RS256",typ:"JWT"})}.${e({iss:sa.client_email,scope,aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600})}`;
  const s = crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key,"base64url");
  const r = await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(i+"."+s)}`});
  if(!r.ok) throw new Error("GCS auth "+r.status);
  return (await r.json()).access_token;
}
async function gcsDownload(tok){
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(OBJECT)}?alt=media`,{headers:{Authorization:`Bearer ${tok}`}});
  if(r.status===404) return null;
  if(!r.ok) throw new Error("GCS download "+r.status);
  return Buffer.from(await r.arrayBuffer());
}
async function gcsUpload(tok, buf){
  const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(OBJECT)}`,{method:"POST",headers:{Authorization:`Bearer ${tok}`,"Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},body:buf});
  if(!r.ok) throw new Error("GCS upload "+r.status+" "+(await r.text()).slice(0,160));
  return `gs://${BUCKET}/${OBJECT}`;
}

// ---- Yahoo Finance daily history ------------------------------------------
async function fetchYahoo(fromEpoch){
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${TICKER}?period1=${fromEpoch}&period2=${Math.floor(Date.now()/1000)}&interval=1d&includeAdjustedClose=true`;
  const r = await fetch(url,{headers:{"User-Agent":"Mozilla/5.0"}});
  if(!r.ok) throw new Error("Yahoo "+r.status);
  const j = await r.json();
  const res = j.chart?.result?.[0];
  if(!res) throw new Error("Yahoo: no result "+JSON.stringify(j.chart?.error));
  const ts = res.timestamp||[];
  const q = res.indicators?.quote?.[0]||{};
  const adj = res.indicators?.adjclose?.[0]?.adjclose||[];
  const rows = [];
  for(let i=0;i<ts.length;i++){
    const o=q.open?.[i], h=q.high?.[i], l=q.low?.[i], c=q.close?.[i], v=q.volume?.[i];
    if(o==null||c==null||h==null||l==null) continue; // skip halted/empty days
    rows.push({
      date: new Date(ts[i]*1000).toISOString().slice(0,10),
      open:o, high:h, low:l, close:c, adjClose: adj[i]!=null?adj[i]:c, volume: v||0,
    });
  }
  rows.sort((a,b)=> a.date<b.date?-1:1);
  return rows;
}

// ---- derive computed columns ----------------------------------------------
const HEADERS = ["Date","Open","High","Low","Close","Adj Close","Volume","VWAP (approx, (H+L+C)/3)","Daily Change ($)","Daily Change (%)","Dollar Volume (Close x Vol)","Day Range (H-L)","Press Release / Corporate Event","Source"];
function toRowArray(r, prevClose){
  const vwap = (r.high + r.low + r.close)/3;
  const chg = prevClose!=null ? r.close - prevClose : "";
  const chgPct = (prevClose!=null && prevClose!==0) ? ((r.close - prevClose)/prevClose)*100 : "";
  const dollarVol = r.close * (r.volume||0);
  return [ r.date, r.open, r.high, r.low, r.close, r.adjClose, r.volume||0, vwap, chg, chgPct, dollarVol, r.high - r.low, r.event||"", "Yahoo Finance (daily); VWAP=typical-price approx" ];
}

// ---- workbook build / merge -----------------------------------------------
function buildWorkbook(XLSX, rows){
  const aoa = [HEADERS];
  let prev=null;
  for(const r of rows){ aoa.push(toRowArray(r, prev)); prev=r.close; }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // column widths
  ws["!cols"] = [{wch:12},{wch:13},{wch:13},{wch:13},{wch:13},{wch:13},{wch:14},{wch:18},{wch:15},{wch:15},{wch:20},{wch:14},{wch:40},{wch:34}];
  // number formats (sub-penny prices need many decimals)
  const priceFmt="0.00000000", volFmt="#,##0", pctFmt="0.00", dollarFmt="#,##0.00";
  const ref = XLSX.utils.decode_range(ws["!ref"]);
  for(let R=1; R<=ref.e.r; R++){
    const set=(C,z)=>{ const a=XLSX.utils.encode_cell({r:R,c:C}); if(ws[a]) ws[a].z=z; };
    [1,2,3,4,5].forEach(C=>set(C,priceFmt));      // OHLC + adjclose
    set(6,volFmt);                                 // volume
    set(7,priceFmt);                               // vwap
    set(8,priceFmt);                               // change $
    set(9,pctFmt);                                 // change %
    set(10,dollarFmt);                             // dollar volume
    set(11,priceFmt);                              // range
  }
  ws["!freeze"] = { xSplit:0, ySplit:1 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "INND Daily");
  // About sheet
  const about = [
    ["INND Daily Stock Price History"],
    ["Company", COMPANY+"  (OTC: INND)"],
    ["Purpose", "Internal CFO record-keeping. Public market data only; not investor-facing / not stock promotion."],
    ["Price source", "Yahoo Finance daily OHLCV + adjusted close"],
    ["History available from", rows.length?rows[0].date:"-"],
    ["Through", rows.length?rows[rows.length-1].date:"-"],
    ["Trading days", String(rows.length)],
    ["Share-structure CAVEAT", "Prices are AS-TRADED and NOT on a constant share basis: INND has undergone reverse splits / share-structure changes, so early prices (e.g. ~$625 in 2017) are not share-for-share comparable to recent sub-penny prices. Yahoo's Adj Close does not carry INND's splits (Adj Close == Close here). Use within-period comparisons with care; ask the CTO for a split-adjusted series + share-count history if you need cross-period comparability."],
    ["VWAP note", "VWAP shown is the daily TYPICAL-PRICE approximation (High+Low+Close)/3. True intraday volume-weighted VWAP and per-day trade counts require a paid feed (e.g. Polygon); ask the CTO to wire it if needed."],
    ["Trade count", "Not available from the free source (would come from a paid feed)."],
    ["Press release / events", "Column reserved. INND is not an SEC/EDGAR filer; events come from OTC Markets / company IR and are added by the CTO."],
    ["Updated", "Run `innd-stock update` daily after the US market close; it appends only new trading days (idempotent)."],
    ["Generated (UTC)", new Date().toISOString()],
  ];
  const wsa = XLSX.utils.aoa_to_sheet(about); wsa["!cols"]=[{wch:24},{wch:90}];
  XLSX.utils.book_append_sheet(wb, wsa, "About");
  return wb;
}
function sheetToRows(XLSX, wb){
  const ws = wb.Sheets["INND Daily"]; if(!ws) return [];
  const aoa = XLSX.utils.sheet_to_json(ws,{header:1});
  const out=[];
  for(let i=1;i<aoa.length;i++){ const a=aoa[i]; if(!a||!a[0]) continue;
    out.push({date:String(a[0]).slice(0,10), open:+a[1],high:+a[2],low:+a[3],close:+a[4],adjClose:+a[5],volume:+a[6]||0, event:a[12]||""}); }
  return out;
}

// ---- main -----------------------------------------------------------------
const cmd = process.argv[2] || "status";
try {
  const XLSX = loadXLSX();

  if (cmd === "backfill" || cmd === "local") {
    const rows = await fetchYahoo(START_EPOCH);
    const wb = buildWorkbook(XLSX, rows);
    const buf = XLSX.write(wb, { type:"buffer", bookType:"xlsx" });
    if (cmd === "local") { const f=process.argv[3]||"INND-daily-stock-history.xlsx"; writeFileSync(f, buf); console.log(`wrote ${rows.length} trading days -> ${f} (${rows[0].date}..${rows[rows.length-1].date})`); }
    else { const tok=await gcsToken("https://www.googleapis.com/auth/devstorage.read_write"); const uri=await gcsUpload(tok, buf); console.log(`backfilled ${rows.length} trading days (${rows[0].date}..${rows[rows.length-1].date}) -> ${uri}`); }

  } else if (cmd === "update") {
    const tok = await gcsToken("https://www.googleapis.com/auth/devstorage.read_write");
    const existing = await gcsDownload(tok);
    let rows;
    if (!existing) { console.error("no existing workbook; running full backfill"); rows = await fetchYahoo(START_EPOCH); }
    else {
      const wb = XLSX.read(existing, { type:"buffer" });
      rows = sheetToRows(XLSX, wb);
      const have = new Set(rows.map(r=>r.date));
      // fetch the last ~30 days and append anything new
      const recent = await fetchYahoo(Math.floor(Date.now()/1000) - 60*86400);
      let added=0;
      for (const r of recent) if (!have.has(r.date)) { rows.push(r); have.add(r.date); added++; }
      rows.sort((a,b)=> a.date<b.date?-1:1);
      console.error(`appended ${added} new trading day(s); total ${rows.length}`);
    }
    const wb2 = buildWorkbook(XLSX, rows);
    const buf = XLSX.write(wb2, { type:"buffer", bookType:"xlsx" });
    const uri = await gcsUpload(tok, buf);
    console.log(`updated workbook -> ${uri} (through ${rows[rows.length-1].date}, ${rows.length} days)`);

  } else if (cmd === "status") {
    const tok = await gcsToken("https://www.googleapis.com/auth/devstorage.read_only");
    const existing = await gcsDownload(tok);
    if (!existing) { console.log("no workbook stored yet; run `backfill`"); }
    else { const wb=XLSX.read(existing,{type:"buffer"}); const rows=sheetToRows(XLSX,wb); console.log(`stored workbook: ${rows.length} trading days, ${rows[0]?.date}..${rows[rows.length-1]?.date} (gs://${BUCKET}/${OBJECT})`); }

  } else { console.error("commands: backfill | update | status | local <file>"); process.exit(2); }
} catch (e) { console.error("ERROR: "+e.message); process.exit(1); }

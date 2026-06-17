#!/usr/bin/env node
// INND daily stock-price history for the CFO records.
// InnerScope Hearing Technologies, Inc. (OTC: INND) - a public company. This pulls
// PUBLIC market data only (published OTC prices) for INTERNAL CFO record-keeping. It
// is not investor-facing publishing or stock promotion (securities firewall safe).
//
// Sources (HYBRID, best-of-both):
//   - Massive (a Polygon.io white-label; same API + flat-files surface). Daily OHLCV
//     with TRUE volume-weighted VWAP (`vw`), per-day TRADE COUNT (`n`), and the OTC
//     consolidated tape. The plan authorizes ~2 years of daily history (true VWAP +
//     trades for the most recent ~24 months and every new day going forward).
//   - Yahoo Finance daily OHLCV + adjusted close for the DEEP history before Massive's
//     2-year window (INND from 2017-03-15). VWAP there is the typical-price proxy
//     (High+Low+Close)/3, clearly labeled per-row in the Source column.
// The two are merged by date; Massive wins on the overlap (true VWAP + trades). If the
// Massive keys are absent or a call fails, the skill degrades gracefully to Yahoo-only.
//
// The canonical workbook lives in the CFO source-doc bucket (GCS) so it is one file
// that grows over time. `backfill` builds it from full history; `update` appends any
// new trading days (idempotent) - run `update` daily after the close.
//
// Creds (hydrated): GCP_CLAUDE_DRIVER_SA_JSON (GCS read/write to the cfo-store bucket);
//   MASSIVE_API_KEY (+ optional MASSIVE_API_KEY_2 for rate-limit failover).
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

// ---- Massive (Polygon white-label) daily history --------------------------
// True VWAP (vw) + trade count (n) + OTC consolidated tape, ~2-year plan window.
const MASSIVE_HOST = process.env.MASSIVE_HOST || "https://api.massive.com";
function massiveKeys(){
  return [process.env.MASSIVE_API_KEY, process.env.MASSIVE_API_KEY_2].filter(Boolean);
}
async function massiveGET(path){
  const keys = massiveKeys();
  let last;
  for(const k of keys){
    const u = `${MASSIVE_HOST}${path}${path.includes("?")?"&":"?"}apiKey=${k}`;
    const r = await fetch(u);
    const j = await r.json().catch(()=>({}));
    if(r.ok) return j;
    last = { status:r.status, msg:j.message };
    if(r.status!==429) break; // only fail over to the backup key on a rate-limit
  }
  const e = new Error(`Massive ${last?.status}: ${last?.msg}`); e.status=last?.status; throw e;
}
function ymd(d){ return d.toISOString().slice(0,10); }
// Pull INND daily bars for ~`maxDays` back. The plan caps history at ~2 years, so step
// the window down on a NOT_AUTHORIZED (403) until it is accepted. Returns [] (never
// throws) so a Massive outage just falls back to Yahoo.
async function fetchMassiveDaily(maxDays){
  if(massiveKeys().length===0){ console.error("Massive: no API key in env; using Yahoo only"); return []; }
  const today = new Date();
  const windows = [maxDays, 725, 365, 180].filter((v,i,a)=> v && a.indexOf(v)===i);
  for(const days of windows){
    const from = ymd(new Date(Date.now()-days*86400000)), to = ymd(today);
    try{
      const j = await massiveGET(`/v2/aggs/ticker/${TICKER}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=50000`);
      const rows = (j.results||[]).map(x=>({
        date: new Date(x.t).toISOString().slice(0,10),
        open:x.o, high:x.h, low:x.l, close:x.c, volume:x.v||0,
        adjClose:x.c, vwapTrue: x.vw!=null?x.vw:null, trades: x.n!=null?x.n:null,
        src:"massive",
      }));
      console.error(`Massive: ${rows.length} daily bars ${from}..${to} (true VWAP + trade counts)`);
      return rows;
    }catch(e){
      if(e.status===403){ console.error(`Massive: ${days}d window not authorized, stepping down`); continue; }
      console.error(`Massive: ${e.message}; falling back to Yahoo for this window`); return [];
    }
  }
  return [];
}

// ---- merge the two sources by date (Massive wins on overlap) --------------
function mergeByDate(baseRows, overlayRows){
  const map = new Map();
  for(const r of baseRows){ if(!map.has(r.date)) map.set(r.date, r); }
  for(const m of overlayRows){ const prev = map.get(m.date); map.set(m.date, { ...m, event: (prev&&prev.event)||m.event||"" }); }
  return [...map.values()].sort((a,b)=> a.date<b.date?-1:1);
}

// ---- derive computed columns ----------------------------------------------
const HEADERS = ["Date","Open","High","Low","Close","Adj Close","Volume","VWAP","Trades","Daily Change ($)","Daily Change (%)","Dollar Volume (Close x Vol)","Traded Value ($) (Vol x VWAP)","Day Range (H-L)","Press Release / Corporate Event","Source"];
function toRowArray(r, prevClose){
  const isMassive = r.src === "massive";
  // VWAP: true volume-weighted from Massive when available, else the typical-price proxy.
  const vwap = (isMassive && r.vwapTrue!=null) ? r.vwapTrue : (r.high + r.low + r.close)/3;
  const trades = (r.trades!=null) ? r.trades : "";
  const chg = prevClose!=null ? r.close - prevClose : "";
  const chgPct = (prevClose!=null && prevClose!==0) ? ((r.close - prevClose)/prevClose)*100 : "";
  const vol = r.volume||0;
  const dollarVol = r.close * vol;          // simple proxy (closing price x shares)
  const tradedValue = vwap * vol;           // the real money traded: shares x VWAP (the avg price each share traded at)
  const source = isMassive
    ? "Massive (Polygon): true VWAP + trade count, OTC consolidated"
    : "Yahoo Finance (daily); VWAP = typical-price proxy (H+L+C)/3";
  return [ r.date, r.open, r.high, r.low, r.close, r.adjClose, vol, vwap, trades, chg, chgPct, dollarVol, tradedValue, r.high - r.low, r.event||"", source ];
}

// ---- workbook build / merge -----------------------------------------------
function buildWorkbook(XLSX, rows){
  const aoa = [HEADERS];
  let prev=null;
  for(const r of rows){ aoa.push(toRowArray(r, prev)); prev=r.close; }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // column widths (Date,O,H,L,C,Adj,Vol,VWAP,Trades,Chg$,Chg%,$Vol,TradedValue,Range,PR,Source)
  ws["!cols"] = [{wch:12},{wch:13},{wch:13},{wch:13},{wch:13},{wch:13},{wch:14},{wch:14},{wch:9},{wch:15},{wch:12},{wch:20},{wch:22},{wch:14},{wch:40},{wch:52}];
  // number formats (sub-penny prices need many decimals)
  const priceFmt="0.00000000", volFmt="#,##0", pctFmt="0.00", dollarFmt="#,##0.00";
  const ref = XLSX.utils.decode_range(ws["!ref"]);
  for(let R=1; R<=ref.e.r; R++){
    const set=(C,z)=>{ const a=XLSX.utils.encode_cell({r:R,c:C}); if(ws[a]) ws[a].z=z; };
    [1,2,3,4,5].forEach(C=>set(C,priceFmt));      // OHLC + adjclose
    set(6,volFmt);                                 // volume
    set(7,priceFmt);                               // vwap
    set(8,volFmt);                                 // trades (integer count)
    set(9,priceFmt);                               // change $
    set(10,pctFmt);                                // change %
    set(11,dollarFmt);                             // dollar volume (close x vol)
    set(12,dollarFmt);                             // traded value (vol x vwap)
    set(13,priceFmt);                              // range
  }
  ws["!freeze"] = { xSplit:0, ySplit:1 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "INND Daily");
  // About sheet
  const about = [
    ["INND Daily Stock Price History"],
    ["Company", COMPANY+"  (OTC: INND)"],
    ["Purpose", "Internal CFO record-keeping. Public market data only; not investor-facing / not stock promotion."],
    ["Price sources", "Massive (Polygon white-label) for the most recent ~2 years (true VWAP + trade count + OTC consolidated tape); Yahoo Finance for the deep history before that. Merged by date; the Source column on every row says which fed that day."],
    ["History available from", rows.length?rows[0].date:"-"],
    ["Through", rows.length?rows[rows.length-1].date:"-"],
    ["Trading days", String(rows.length)],
    ["Massive (Polygon) coverage", `${rows.filter(r=>r.src==="massive").length} of ${rows.length} days carry TRUE VWAP + trade count (the rest use the Yahoo proxy).`],
    ["Share-structure CAVEAT", "Prices are AS-TRADED and NOT on a constant share basis: INND has undergone reverse splits / share-structure changes, so early prices (e.g. ~$625 in 2017, ~$0.50 in mid-2024) are not share-for-share comparable to recent sub-penny prices. Adj Close does not carry INND's splits (Adj Close == Close here). Use within-period comparisons with care; ask the CTO for a split-adjusted series + share-count history if you need cross-period comparability."],
    ["VWAP note", "For Massive (Polygon) rows the VWAP is the TRUE daily volume-weighted average price. For the older Yahoo rows it is the typical-price proxy (High+Low+Close)/3. The Source column flags each."],
    ["Trades note", "Trades = the day's number of executed transactions (Massive/Polygon). Blank for the older Yahoo-only history. A useful liquidity gauge for a thinly traded stock (some recent days have under 50 trades)."],
    ["Two dollar-value columns", "Dollar Volume (Close x Vol) = the simple proxy that prices the whole day's shares at the closing price. Traded Value (Vol x VWAP) = the REAL money that changed hands = shares traded x VWAP (the average price each share actually traded at). Neither is a native feed field; both are computed here. Traded Value is the accurate one (for Massive rows it uses the true VWAP)."],
    ["Press release / events", "Column reserved. INND is not an SEC/EDGAR filer; events come from OTC Markets / company IR and are added by the CTO."],
    ["Updated", "Run `innd-stock update` daily after the US market close; it appends only new trading days (idempotent) and refreshes the recent window from Massive."],
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
    const source = String(a[15]||"");
    const isMassive = /Massive/i.test(source);
    out.push({
      date:String(a[0]).slice(0,10), open:+a[1],high:+a[2],low:+a[3],close:+a[4],adjClose:+a[5],volume:+a[6]||0,
      vwapTrue: isMassive && a[7]!=null && a[7]!=="" ? +a[7] : null,
      trades: a[8]!=null && a[8]!=="" ? +a[8] : null,
      event:a[14]||"", src: isMassive ? "massive" : "yahoo",
    });
  }
  return out;
}

// ---- main -----------------------------------------------------------------
const cmd = process.argv[2] || "status";
try {
  const XLSX = loadXLSX();

  if (cmd === "backfill" || cmd === "local") {
    const yahoo = await fetchYahoo(START_EPOCH);            // deep history (2017->)
    const massive = await fetchMassiveDaily(730);           // recent ~2yr: true VWAP + trades
    const rows = mergeByDate(yahoo, massive);               // Massive wins on overlap
    const wb = buildWorkbook(XLSX, rows);
    const buf = XLSX.write(wb, { type:"buffer", bookType:"xlsx" });
    if (cmd === "local") { const f=process.argv[3]||"INND-daily-stock-history.xlsx"; writeFileSync(f, buf); console.log(`wrote ${rows.length} trading days -> ${f} (${rows[0].date}..${rows[rows.length-1].date})`); }
    else { const tok=await gcsToken("https://www.googleapis.com/auth/devstorage.read_write"); const uri=await gcsUpload(tok, buf); console.log(`backfilled ${rows.length} trading days (${rows[0].date}..${rows[rows.length-1].date}) -> ${uri}`); }

  } else if (cmd === "update") {
    const tok = await gcsToken("https://www.googleapis.com/auth/devstorage.read_write");
    const existing = await gcsDownload(tok);
    let rows;
    if (!existing) {
      console.error("no existing workbook; running full backfill");
      rows = mergeByDate(await fetchYahoo(START_EPOCH), await fetchMassiveDaily(730));
    } else {
      const wb = XLSX.read(existing, { type:"buffer" });
      const have = sheetToRows(XLSX, wb);
      const haveDates = new Set(have.map(r=>r.date));
      // fill any brand-new Yahoo days (deep-history gaps), then overlay the recent
      // Massive window (true VWAP + trades, refreshes the tail). Massive wins.
      const recentYahoo = await fetchYahoo(Math.floor(Date.now()/1000) - 90*86400);
      const newYahoo = recentYahoo.filter(r=>!haveDates.has(r.date));
      const recentMassive = await fetchMassiveDaily(120);
      rows = mergeByDate(have.concat(newYahoo), recentMassive);
      console.error(`update: +${newYahoo.length} new Yahoo day(s), refreshed ${recentMassive.length} Massive day(s); total ${rows.length}`);
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

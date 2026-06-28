#!/usr/bin/env node
/**
 * xero-run — budget-capped, self-tuning, resumable runner for the FY2021-2022 Xero posting + attachment
 * run. Keeps OTCHealth on the Xero Developer STARTER tier (1,000 API calls/day/org) AUTOMATICALLY.
 *
 * GOVERNOR: hard-caps DAILY_CAP (900) calls/org/day AND honors the live X-DayLimit-Remaining header,
 * stopping an org for the day at RESERVE (100 calls left for the CFO's reads). Self-tunes: if the live
 * remaining is lower than our counter expects, it trusts the header. Never exceeds 1,000 -> never forces
 * a paid-tier upgrade.
 *
 * QUEUE-DRIVEN + RESUMABLE: each org has a work queue (JSONL in GCS) of self-describing ops; a checkpoint
 * cursor records the next line. Daily cron drains up to the budget, checkpoints, exits; resumes next day
 * until the queue is done. Per-org state is independent (parallel-safe).
 *
 * CONFIG-GATED (safety): processes ONLY orgs the CFO has explicitly enabled in xero-run/config.json.
 * Default = nothing enabled -> the job is INERT until the CFO flips an org on AFTER the pilot+reconcile.
 * No blind auto-posting to the INND (public-company) books.
 *
 * OP TYPES (one queue line each = 1 Xero call):
 *   {"op":"post","endpoint":"ManualJournals","body":{"ManualJournals":[...<=50...]}}
 *   {"op":"attach","objectType":"Invoices","objectId":"<xeroGuid>","gcs":"path/in/cfo-store","filename":"x.pdf","contentType":"application/pdf"}
 *
 * STATE/IO (GCS bucket otchealth-cfo-source-docs): xero-run/queue/<org>.jsonl (CFO-produced),
 *   xero-run/state/<org>.json {date,used,cursor,lastRemaining}, xero-run/results/<org>-<date>.jsonl.
 * CREDS (GCP SM via claude-driver SA): xero-client-id/secret, xero-refresh-token-<org>.
 * ENV: DRYRUN=1 (no Xero writes; simulate budget/cursor), DAILY_CAP, RESERVE, ORGS (override config).
 * PHI/MNPI: INND/personal data internal-only.
 */
import crypto from "node:crypto"; import fs from "node:fs"; import os from "node:os";
const SM_PROJECT="otchealth-shared-prod"; const BUCKET="otchealth-cfo-source-docs";
const XTOKEN="https://identity.xero.com/connect/token"; const XCONN="https://api.xero.com/connections"; const XAPI="https://api.xero.com/api.xro/2.0";
const DAILY_CAP=parseInt(process.env.DAILY_CAP||"900",10); const RESERVE=parseInt(process.env.RESERVE||"100",10);
const DRY=process.env.DRYRUN==="1"; const ORGS_ALL=["otchealth","innd","hearingassist","personal"];
const b64url=(b)=>Buffer.from(b).toString("base64url"); const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const today=()=>new Date().toISOString().slice(0,10);
function loadSA(){ if(process.env.GCP_CLAUDE_DRIVER_SA_JSON){try{return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON);}catch{}} for(const p of [`${os.homedir()}/.gcp_claude_driver_sa.json`,"/agent/.gcp_claude_driver_sa.json"]){try{if(fs.existsSync(p))return JSON.parse(fs.readFileSync(p,"utf8"));}catch{}} throw new Error("no SA"); }
let _GT=null; async function gcp(){ if(_GT)return _GT; const sa=loadSA(); const now=Math.floor(Date.now()/1000); const cl={iss:sa.client_email,scope:"https://www.googleapis.com/auth/cloud-platform",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3500}; const i=`${b64url(JSON.stringify({alg:"RS256",typ:"JWT"}))}.${b64url(JSON.stringify(cl))}`; const s=crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key); const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:`${i}.${Buffer.from(s).toString("base64url")}`})}); return _GT=(await r.json()).access_token; }
async function sm(id){ const r=await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${id}/versions/latest:access`,{headers:{Authorization:`Bearer ${await gcp()}`}}); if(r.status!==200)return null; const j=await r.json(); return j.payload?Buffer.from(j.payload.data,"base64").toString("utf8").trim():null; }
async function smWrite(id,val){ const t=await gcp(); let e=await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${id}`,{headers:{Authorization:`Bearer ${t}`}}); if(e.status===404){await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets?secretId=${id}`,{method:"POST",headers:{Authorization:`Bearer ${t}`,"Content-Type":"application/json"},body:JSON.stringify({replication:{automatic:{}}})});} const r=await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${id}:addVersion`,{method:"POST",headers:{Authorization:`Bearer ${t}`,"Content-Type":"application/json"},body:JSON.stringify({payload:{data:Buffer.from(val,"utf8").toString("base64")}})}); return r.status; }
// ---- GCS helpers ----
async function gcsGet(name){ const r=await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}?alt=media`,{headers:{Authorization:`Bearer ${await gcp()}`}}); if(r.status===404)return null; if(!r.ok)throw new Error("gcsGet "+r.status); return Buffer.from(await r.arrayBuffer()); }
async function gcsPut(name,buf,ct){ const r=await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}`,{method:"POST",headers:{Authorization:`Bearer ${await gcp()}`,"Content-Type":ct||"application/octet-stream"},body:buf}); if(!r.ok)throw new Error("gcsPut "+r.status); }
async function gcsAppend(name,line){ const prev=await gcsGet(name); const buf=Buffer.concat([prev||Buffer.alloc(0),Buffer.from(line+"\n","utf8")]); await gcsPut(name,buf,"application/x-ndjson"); }
// ---- Xero auth (per-org refresh + re-persist; client creds self-hydrated) ----
async function xeroToken(org){
  const [cid,csec,rtok]=await Promise.all([sm("xero-client-id"),sm("xero-client-secret"),sm(`xero-refresh-token-${org}`)]);
  if(!cid||!csec||!rtok) throw new Error(`missing creds for ${org}`);
  const r=await fetch(XTOKEN,{method:"POST",headers:{Authorization:"Basic "+Buffer.from(`${cid}:${csec}`).toString("base64"),"Content-Type":"application/x-www-form-urlencoded"},body:`grant_type=refresh_token&refresh_token=${encodeURIComponent(rtok)}`});
  const j=await r.json(); if(!j.access_token) throw new Error(`token ${org}: ${JSON.stringify(j).slice(0,120)}`);
  if(j.refresh_token && j.refresh_token!==rtok) await smWrite(`xero-refresh-token-${org}`,j.refresh_token);
  const tid=(await (await fetch(XCONN,{headers:{Authorization:`Bearer ${j.access_token}`}})).json())[0]?.tenantId;
  return {access:j.access_token, tid};
}
// ---- per-op execution (returns {ok, status, remaining, info}) ----
async function execOp(op, ctx){
  if(DRY) return {ok:true,status:0,remaining:null,info:"dryrun"};
  const H={Authorization:`Bearer ${ctx.access}`,"Xero-Tenant-Id":ctx.tid};
  if(op.op==="post"){
    const r=await fetch(`${XAPI}/${op.endpoint}?summarizeErrors=false`,{method:"POST",headers:{...H,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify(op.body)});
    const rem=parseInt(r.headers.get("X-DayLimit-Remaining")||"NaN",10);
    const t=await r.text(); let j; try{j=JSON.parse(t);}catch{j={raw:t.slice(0,200)};}
    return {ok:r.ok,status:r.status,remaining:isNaN(rem)?null:rem,info:r.ok?`posted ${op.endpoint}`:JSON.stringify(j).slice(0,200)};
  }
  if(op.op==="attach"){
    const file=await gcsGet(op.gcs); if(!file) return {ok:false,status:0,remaining:null,info:"gcs file missing: "+op.gcs};
    const url=`${XAPI}/${op.objectType}/${op.objectId}/Attachments/${encodeURIComponent(op.filename)}`;
    const r=await fetch(url,{method:"PUT",headers:{...H,"Content-Type":op.contentType||"application/octet-stream",Accept:"application/json"},body:file});
    const rem=parseInt(r.headers.get("X-DayLimit-Remaining")||"NaN",10);
    return {ok:r.ok,status:r.status,remaining:isNaN(rem)?null:rem,info:r.ok?`attached ${op.filename}`:(await r.text()).slice(0,200)};
  }
  return {ok:false,status:0,remaining:null,info:"unknown op "+op.op};
}
// ---- per-org drain ----
async function runOrg(org){
  const stateName=`xero-run/state/${org}.json`; const queueName=`xero-run/queue/${org}.jsonl`;
  const qbuf=await gcsGet(queueName); if(!qbuf){ console.log(`[${org}] no queue (${queueName}) — skip`); return; }
  const lines=qbuf.toString("utf8").split(/\r?\n/).filter(Boolean);
  let st={date:today(),used:0,cursor:0,lastRemaining:null}; const sbuf=await gcsGet(stateName); if(sbuf){ try{st={...st,...JSON.parse(sbuf.toString("utf8"))};}catch{} }
  if(st.date!==today()){ st.date=today(); st.used=0; st.lastRemaining=null; } // daily reset
  if(st.cursor>=lines.length){ console.log(`[${org}] DONE: all ${lines.length} ops processed.`); return; }
  const ctx=DRY?{}:await xeroToken(org);
  const resName=`xero-run/results/${org}-${today()}.jsonl`;
  let did=0; const MIN_SPACING=1150; // <60/min
  console.log(`[${org}] start cursor=${st.cursor}/${lines.length} used=${st.used}/${DAILY_CAP} reserve=${RESERVE} ${DRY?"(DRYRUN)":""}`);
  while(st.cursor<lines.length){
    if(st.used>=DAILY_CAP){ console.log(`[${org}] daily cap ${DAILY_CAP} reached — stop (resume tomorrow).`); break; }
    if(st.lastRemaining!=null && st.lastRemaining<=RESERVE){ console.log(`[${org}] live X-DayLimit-Remaining ${st.lastRemaining}<=reserve — stop.`); break; }
    let op; try{ op=JSON.parse(lines[st.cursor]); }catch{ st.cursor++; continue; }
    const t0=Date.now();
    let res; try{ res=await execOp(op,ctx); }catch(e){ res={ok:false,status:0,remaining:null,info:(e.message||"").slice(0,160)}; }
    st.used++; st.cursor++; did++;
    if(res.remaining!=null) st.lastRemaining=res.remaining;
    if(!DRY) await gcsAppend(resName, JSON.stringify({cursor:st.cursor-1,ok:res.ok,status:res.status,info:res.info,ts:new Date().toISOString()}));
    if(did%10===0) await gcsPut(stateName,Buffer.from(JSON.stringify(st)),"application/json"); // checkpoint every 10
    const dt=Date.now()-t0; if(!DRY && dt<MIN_SPACING) await sleep(MIN_SPACING-dt);
  }
  await gcsPut(stateName,Buffer.from(JSON.stringify(st)),"application/json"); // final checkpoint
  console.log(`[${org}] ran ${did} ops this pass. cursor=${st.cursor}/${lines.length} used=${st.used}/${DAILY_CAP} lastRemaining=${st.lastRemaining}${st.cursor>=lines.length?" — QUEUE COMPLETE":""}`);
}
(async()=>{
  let cfg={orgs:{}}; const cbuf=await gcsGet("xero-run/config.json"); if(cbuf){ try{cfg=JSON.parse(cbuf.toString("utf8"));}catch{} }
  const override=process.env.ORGS?process.env.ORGS.split(","):null;
  const enabled=override||ORGS_ALL.filter(o=>cfg.orgs?.[o]?.enabled===true);
  console.log(`xero-run ${today()} | cap ${DAILY_CAP}/org reserve ${RESERVE} | enabled orgs: ${enabled.length?enabled.join(","):"(none — INERT; set xero-run/config.json)"}`);
  for(const org of enabled){ try{ await runOrg(org); }catch(e){ console.error(`[${org}] ERROR ${(e.message||"").slice(0,160)}`); } }
  console.log("xero-run pass complete.");
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});

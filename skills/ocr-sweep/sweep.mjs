#!/usr/bin/env node
/**
 * ocr-sweep — STANDING auto-OCR for the legal + financial document stores, so the CFO/CLO always have a
 * full text layer (_TEXT/ sidecars) for EVERY scanned PDF/image. Backfills + self-maintains.
 *
 * For each configured store/container: list blobs, find PDFs+images that lack a sidecar at
 * {dir}_TEXT/{name}.txt, OCR up to LIMIT (across all stores) via Azure Document Intelligence
 * (prebuilt-read, our in-tenant credit-funded service), and write the sidecar. Resumable + idempotent
 * (skips existing sidecars). FAIL-OPEN per doc. Bounded per run (LIMIT) so it fits a scheduled job;
 * re-runs drain the backlog, then steady-state only touches new uploads.
 *
 * PHI WALL: only the legal + cfo (finance) stores — NEVER MedReview/Companion (no BAA).
 * Creds (GCP SM via the claude-driver SA): azure-docintel-endpoint/key; azure-legal-storage-key;
 * azure-cfo-storage-account/container/key.  Run: node sweep.mjs   (env LIMIT, CONC, DRYRUN, STORES).
 */
import crypto from "node:crypto"; import fs from "node:fs"; import os from "node:os";
const PROJECT="otchealth-shared-prod"; const b64url=(b)=>Buffer.from(b).toString("base64url"); const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const DOCEXT=/\.(pdf|png|jpe?g|tiff?|bmp|docx|xlsx|pptx)$/i; // Doc Intelligence read accepts PDF, images, AND OOXML office
const CT={pdf:"application/pdf",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",tif:"image/tiff",tiff:"image/tiff",bmp:"image/bmp",
  docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx:"application/vnd.openxmlformats-officedocument.presentationml.presentation"};
function loadSA(){ if(process.env.GCP_CLAUDE_DRIVER_SA_JSON){try{return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON);}catch{}} for(const p of [`${os.homedir()}/.gcp_claude_driver_sa.json`,"/agent/.gcp_claude_driver_sa.json"]){try{if(fs.existsSync(p))return JSON.parse(fs.readFileSync(p,"utf8"));}catch{}} throw new Error("no SA"); }
async function gcpToken(){const sa=loadSA();const now=Math.floor(Date.now()/1000);const cl={iss:sa.client_email,scope:"https://www.googleapis.com/auth/cloud-platform",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3500};const i=`${b64url(JSON.stringify({alg:"RS256",typ:"JWT"}))}.${b64url(JSON.stringify(cl))}`;const s=crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key);const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:`${i}.${Buffer.from(s).toString("base64url")}`})});return (await r.json()).access_token;}
async function sm(tok,id){const r=await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${id}/versions/latest:access`,{headers:{Authorization:`Bearer ${tok}`}});if(r.status!==200)return null;const j=await r.json();return j.payload?Buffer.from(j.payload.data,"base64").toString("utf8").trim():null;}
function sas(account,key,perms){const sv="2022-11-02",ss="b",srt="sco",sp=perms,spr="https";const st=new Date(Date.now()-3e5).toISOString().replace(/\.\d{3}Z$/,"Z");const se=new Date(Date.now()+6*36e5).toISOString().replace(/\.\d{3}Z$/,"Z");const sts=[account,sp,ss,srt,st,se,"",spr,sv,""].join("\n")+"\n";const sig=crypto.createHmac("sha256",Buffer.from(key,"base64")).update(sts,"utf8").digest("base64");return new URLSearchParams({sv,ss,srt,sp,se,st,spr,sig}).toString();}
const xd=(s)=>s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&apos;/g,"'").replace(/&amp;/g,"&");
const enc=(p)=>encodeURIComponent(p).replace(/%2F/g,"/");
async function listAll(ep,container,q){ let marker="",out=[]; do{ const u=`${ep}/${container}?restype=container&comp=list&maxresults=5000${marker?`&marker=${encodeURIComponent(marker)}`:""}&${q}`; const r=await fetch(u); if(!r.ok) return out; const t=await r.text(); for(const m of t.matchAll(/<Name>([^<]+)<\/Name>/g)) out.push(xd(m[1])); const mm=t.match(/<NextMarker>([^<]*)<\/NextMarker>/); marker=mm&&mm[1]?mm[1]:""; }while(marker); return out; }
async function docintel(endpoint,key,buf,ct){ const url=`${endpoint.replace(/\/$/,"")}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30`; const r=await fetch(url,{method:"POST",headers:{"Ocp-Apim-Subscription-Key":key,"Content-Type":ct},body:buf}); if(r.status!==202) throw new Error("submit "+r.status); const op=r.headers.get("operation-location"); for(let i=0;i<60;i++){ await sleep(3000); const p=await fetch(op,{headers:{"Ocp-Apim-Subscription-Key":key}}); const j=await p.json(); if(j.status==="succeeded") return j.analyzeResult?.content||""; if(j.status==="failed") throw new Error("failed"); } throw new Error("timeout"); }
function sideFor(n){ const i=n.lastIndexOf("/"); const dir=i>=0?n.slice(0,i+1):""; const base=n.slice(i+1); return `${dir}_TEXT/${base}.txt`; }

(async()=>{
  const DRY=process.env.DRYRUN==="1"; const LIMIT=parseInt(process.env.LIMIT||"300",10); const CONC=parseInt(process.env.CONC||"6",10);
  const want=(process.env.STORES||"legal,cfo").split(",");
  const g=await gcpToken();
  const [endpoint,dkey]=await Promise.all([sm(g,"azure-docintel-endpoint"),sm(g,"azure-docintel-key")]);
  const stores=[];
  if(want.includes("legal")){ const k=await sm(g,"azure-legal-storage-key"); stores.push({name:"legal",account:"otchealthlegalstore",key:k,containers:["company","personal"]}); }
  if(want.includes("cfo")){ const acct=(await sm(g,"azure-cfo-storage-account"))||"otchealthcfodata", k=await sm(g,"azure-cfo-storage-key"); if(acct&&k) stores.push({name:"cfo",account:acct,key:k,containers:["cfo-source-docs"]}); } // funded finance data room (NOT innd-stock)
  // gather candidates across all stores
  let candidates=[]; const stats={};
  for(const st of stores){ const ep=`https://${st.account}.blob.core.windows.net`; const rsas=sas(st.account,st.key,"rl");
    for(const c of st.containers){ const names=await listAll(ep,c,rsas); const sides=new Set(names.filter(n=>/\/_TEXT\//.test(n)).map(n=>n.toLowerCase()));
      const docs=names.filter(n=>DOCEXT.test(n)&&!/\/_TEXT\//.test(n)); const todo=docs.filter(n=>!sides.has(sideFor(n).toLowerCase()));
      stats[`${st.name}/${c}`]={docs:docs.length,todo:todo.length}; todo.forEach(n=>candidates.push({store:st,ep,container:c,name:n})); } }
  console.log("scope:",JSON.stringify(stats)); console.log("total docs needing OCR:",candidates.length);
  if(DRY) return;
  const work=candidates.slice(0,LIMIT); let ok=0,fail=0; const wsasCache={};
  function wsas(st){ return wsasCache[st.account]||(wsasCache[st.account]=sas(st.account,st.key,"rcwl")); }
  let idx=0;
  async function worker(){ while(idx<work.length){ const it=work[idx++]; const {store,ep,container,name}=it; const ext=(name.split(".").pop()||"pdf").toLowerCase();
    try{ const dl=await fetch(`${ep}/${container}/${enc(name)}?${sas(store.account,store.key,"rl")}`); if(!dl.ok){fail++;continue;} const buf=Buffer.from(await dl.arrayBuffer());
      const text=await docintel(endpoint,dkey,buf,CT[ext]||"application/octet-stream");
      const put=await fetch(`${ep}/${container}/${enc(sideFor(name))}?${wsas(store)}`,{method:"PUT",headers:{"x-ms-blob-type":"BlockBlob","Content-Type":"text/plain; charset=utf-8"},body:text});
      if(put.status===201) ok++; else fail++;
    }catch(e){ fail++; }
    if((ok+fail)%25===0) console.log(`  ...${ok+fail}/${work.length} (ok ${ok}, fail ${fail})`);
  } }
  await Promise.all(Array.from({length:CONC},()=>worker()));
  console.log(`DONE this run: ${ok} sidecars written, ${fail} failed, of ${work.length} processed. Backlog remaining: ${Math.max(0,candidates.length-ok)}.`);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});

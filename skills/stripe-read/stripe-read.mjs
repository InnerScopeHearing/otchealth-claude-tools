#!/usr/bin/env node
/**
 * stripe-read.mjs — READ-ONLY Stripe scoreboard for the fleet (CRO/CFO), independent of the Stripe MCP
 * connector (which goes stale and needs OAuth re-auth). Reads the live key from GCP Secret Manager
 * (stripe-secret-key) via the claude-driver SA, so it works on BOTH engines through the kb-memory wrapper:
 *   bash /agent/workspace/skills/kb-memory/run.sh node skills/stripe-read/stripe-read.mjs [scoreboard|account|charges|payouts|balance]
 *
 * READ-ONLY by design: only GET calls. It never creates, charges, refunds, or modifies anything.
 */
import crypto from "node:crypto"; import fs from "node:fs"; import os from "node:os";
const P="otchealth-shared-prod"; const b=x=>Buffer.from(x).toString("base64url");
function loadSA(){ if(process.env.GCP_CLAUDE_DRIVER_SA_JSON){try{return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON);}catch{}} for(const p of [`${os.homedir()}/.gcp_claude_driver_sa.json`,"/agent/.gcp_claude_driver_sa.json"]){try{if(fs.existsSync(p))return JSON.parse(fs.readFileSync(p,"utf8"));}catch{}} throw new Error("no GCP SA"); }
async function gcp(){const s=loadSA();const n=Math.floor(Date.now()/1e3);const c={iss:s.client_email,scope:"https://www.googleapis.com/auth/cloud-platform",aud:"https://oauth2.googleapis.com/token",iat:n,exp:n+3500};const i=`${b(JSON.stringify({alg:"RS256",typ:"JWT"}))}.${b(JSON.stringify(c))}`;const g=crypto.createSign("RSA-SHA256").update(i).sign(s.private_key);const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:`${i}.${Buffer.from(g).toString("base64url")}`})});return (await r.json()).access_token;}
async function sm(t,id){const r=await fetch(`https://secretmanager.googleapis.com/v1/projects/${P}/secrets/${id}/versions/latest:access`,{headers:{Authorization:"Bearer "+t}});if(r.status!==200)throw new Error("SM "+id+" "+r.status);const j=await r.json();return Buffer.from(j.payload.data,"base64").toString("utf8").trim();}
async function S(key,path){const r=await fetch("https://api.stripe.com/v1/"+path,{headers:{Authorization:"Bearer "+key}});return {status:r.status,j:await r.json().catch(()=>({}))};}
const money=(c,cur)=>`${(c/100).toFixed(2)} ${(cur||"usd").toUpperCase()}`;
(async()=>{
  const cmd=(process.argv[2]||"scoreboard").toLowerCase();
  const key=await sm(await gcp(),"stripe-secret-key");
  const mode=/_live_/.test(key)?"LIVE":(/_test_/.test(key)?"TEST":"?");
  if(cmd==="account"||cmd==="scoreboard"){
    const a=await S(key,"account");const A=a.j;
    console.log(`STRIPE ${mode} | ${A.id} | charges_enabled=${A.charges_enabled} payouts_enabled=${A.payouts_enabled} details_submitted=${A.details_submitted}`);
    const req=A.requirements||{}; const due=[...(req.currently_due||[]),...(req.past_due||[])];
    if(due.length) console.log("  requirements due:",due.join(", ")); else console.log("  requirements: none outstanding");
    if(!A.payouts_enabled) console.log("  NOTE: payouts_enabled=false -> collected funds cannot pay out until a bank account is added/enabled (Stripe dashboard).");
  }
  if(cmd==="balance"||cmd==="scoreboard"){
    const bal=await S(key,"balance");
    if(bal.status===200){const av=(bal.j.available||[]).map(x=>money(x.amount,x.currency)).join(", ");const pe=(bal.j.pending||[]).map(x=>money(x.amount,x.currency)).join(", ");console.log(`BALANCE available=[${av||"0"}] pending=[${pe||"0"}]`);}
  }
  if(cmd==="charges"||cmd==="scoreboard"){
    const since=Math.floor(Date.now()/1000)-30*86400;
    const ch=await S(key,"charges?limit=100");
    const data=ch.j.data||[];
    const succ=data.filter(c=>c.status==="succeeded"&&!c.refunded);
    const gross30=succ.filter(c=>c.created>=since).reduce((s,c)=>s+c.amount,0);
    console.log(`CHARGES last ${data.length} fetched | succeeded(non-refunded)=${succ.length} | gross last 30d=${money(gross30)}`);
    for(const c of data.slice(0,6)) console.log(`  ${new Date(c.created*1000).toISOString().slice(0,10)} ${money(c.amount,c.currency)} ${c.status}${c.refunded?" REFUNDED":""} ${(c.description||"").slice(0,40)}`);
  }
  if(cmd==="payouts"||cmd==="scoreboard"){
    const po=await S(key,"payouts?limit=5");
    if(po.status===200){console.log(`PAYOUTS: ${(po.j.data||[]).length}`);for(const p of (po.j.data||[])) console.log(`  ${new Date(p.created*1000).toISOString().slice(0,10)} ${money(p.amount,p.currency)} ${p.status} arrival ${new Date((p.arrival_date||0)*1000).toISOString().slice(0,10)}`);}
  }
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});

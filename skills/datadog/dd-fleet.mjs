#!/usr/bin/env node
/**
 * dd-fleet — tiny, fail-open emitter of fleet agent-activity metrics to Datadog.
 * Called (throttled, env-gated) by kb-memory mem.mjs on each ledger write so the whole fleet's
 * agent activity auto-reports to Datadog. Submits ONE metric per call; never throws.
 * Args: <agent> <entryType> <ring> <engine> <shared0|1>
 * Reads datadog-api-key + datadog-site from GCP Secret Manager via the claude-driver SA (env
 * GCP_CLAUDE_DRIVER_SA_JSON, provided by the kb-memory run.sh wrapper). LOW CARDINALITY by design:
 * tags are agent/type/ring/engine/shared only — never ids/timestamps (protects the $100K credit).
 */
import crypto from "node:crypto"; import fs from "node:fs"; import os from "node:os";
const PROJECT="otchealth-shared-prod"; const b64url=(b)=>Buffer.from(b).toString("base64url");
function loadSA(){ if(process.env.GCP_CLAUDE_DRIVER_SA_JSON){try{return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON);}catch{}} for(const p of [`${os.homedir()}/.gcp_claude_driver_sa.json`,"/agent/.gcp_claude_driver_sa.json"]){try{if(fs.existsSync(p))return JSON.parse(fs.readFileSync(p,"utf8"));}catch{}} return null; }
async function gcpToken(sa){const now=Math.floor(Date.now()/1000);const cl={iss:sa.client_email,scope:"https://www.googleapis.com/auth/cloud-platform",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3500};const i=`${b64url(JSON.stringify({alg:"RS256",typ:"JWT"}))}.${b64url(JSON.stringify(cl))}`;const s=crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key);const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:`${i}.${Buffer.from(s).toString("base64url")}`})});return (await r.json()).access_token;}
async function sm(tok,id){const r=await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${id}/versions/latest:access`,{headers:{Authorization:`Bearer ${tok}`}});if(r.status!==200)return null;const j=await r.json();return j.payload?Buffer.from(j.payload.data,"base64").toString("utf8").trim():null;}
(async()=>{
  try{
    const [agent,type,ring,engine,shared]=[process.argv[2]||"unknown",process.argv[3]||"entry",process.argv[4]||"unknown",process.argv[5]||"unknown",process.argv[6]==="1"?"true":"false"];
    const sa=loadSA(); if(!sa) return;
    const tok=await gcpToken(sa); if(!tok) return;
    const [apiKey,site]=await Promise.all([sm(tok,"datadog-api-key"),sm(tok,"datadog-site")]);
    if(!apiKey) return;
    const host=`https://api.${site||"us3.datadoghq.com"}`;
    const now=Math.floor(Date.now()/1000);
    const tags=[`agent:${agent}`,`type:${type}`,`ring:${ring}`,`engine:${engine}`,`shared:${shared}`];
    const body={series:[{metric:"otc.fleet.ledger_flush",type:"count",points:[[now,1]],tags}]};
    await fetch(`${host}/api/v1/series`,{method:"POST",headers:{"DD-API-KEY":apiKey,"Content-Type":"application/json"},body:JSON.stringify(body)});
  }catch{ /* fail-open: telemetry must never affect a ledger write */ }
})();

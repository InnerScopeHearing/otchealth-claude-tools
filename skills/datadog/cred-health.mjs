#!/usr/bin/env node
/**
 * cred-health — emit credential-health (token age) metrics to Datadog so we get an EARLY WARNING
 * before a rotating OAuth token idle-expires (the Xero idle-expiry / dead-legacy-token lockout class).
 * This is BREAKAGE-PREVENTION (a token about to expire = the "broken" case), NOT a security-rotation
 * reminder — aligned with the CEO 30-day no-rotation-reminder directive.
 *
 * For each rotating secret: read its LATEST version createTime from GCP Secret Manager and emit
 * otc.fleet.token_age_hours{secret:<id>} (gauge). Run standalone or as a daily pass (token-keeper cron).
 * Reads creds from SM via the claude-driver SA (env GCP_CLAUDE_DRIVER_SA_JSON, provided by run.sh).
 * Fail-open per secret; never throws fatally. LOW-CARDINALITY (tag = secret id only).
 */
import crypto from "node:crypto"; import fs from "node:fs"; import os from "node:os";
const PROJECT="otchealth-shared-prod"; const b64url=(b)=>Buffer.from(b).toString("base64url");
// Rotating OAuth secrets whose age matters for idle-expiry. Static keys (PAT/SA/ASC) are excluded by design.
const ROTATING=[
  "xero-refresh-token-otchealth","xero-refresh-token-innd","xero-refresh-token-hearingassist","xero-refresh-token-personal",
  "quickbooks-refresh-token",
];
function loadSA(){ if(process.env.GCP_CLAUDE_DRIVER_SA_JSON){try{return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON);}catch{}} for(const p of [`${os.homedir()}/.gcp_claude_driver_sa.json`,"/agent/.gcp_claude_driver_sa.json"]){try{if(fs.existsSync(p))return JSON.parse(fs.readFileSync(p,"utf8"));}catch{}} return null; }
async function gcpToken(sa){const now=Math.floor(Date.now()/1000);const cl={iss:sa.client_email,scope:"https://www.googleapis.com/auth/cloud-platform",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3500};const i=`${b64url(JSON.stringify({alg:"RS256",typ:"JWT"}))}.${b64url(JSON.stringify(cl))}`;const s=crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key);const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:`${i}.${Buffer.from(s).toString("base64url")}`})});return (await r.json()).access_token;}
async function sm(tok,id){const r=await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${id}/versions/latest:access`,{headers:{Authorization:`Bearer ${tok}`}});if(r.status!==200)return null;const j=await r.json();return j.payload?Buffer.from(j.payload.data,"base64").toString("utf8").trim():null;}
async function latestVersionAgeHours(tok,id){
  const r=await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${id}/versions?pageSize=1`,{headers:{Authorization:`Bearer ${tok}`}});
  if(r.status!==200) return null; const j=await r.json(); const v=(j.versions||[])[0]; if(!v||!v.createTime) return null;
  return (Date.now()-new Date(v.createTime).getTime())/3600000;
}
(async()=>{
  const sa=loadSA(); if(!sa){ console.error("no SA"); process.exit(0); }
  const tok=await gcpToken(sa); if(!tok){ console.error("no gcp token"); process.exit(0); }
  const [apiKey,site]=await Promise.all([sm(tok,"datadog-api-key"),sm(tok,"datadog-site")]);
  const host=`https://api.${site||"us3.datadoghq.com"}`; const now=Math.floor(Date.now()/1000);
  const series=[]; const report=[];
  for(const id of ROTATING){
    try{ const age=await latestVersionAgeHours(tok,id); if(age==null){ report.push(`${id}: (absent)`); continue; }
      series.push({metric:"otc.fleet.token_age_hours",type:"gauge",points:[[now,Math.round(age*10)/10]],tags:[`secret:${id}`]});
      report.push(`${id}: ${Math.round(age*10)/10}h`);
    }catch(e){ report.push(`${id}: ERR ${e.message}`); }
  }
  if(apiKey && series.length){ try{ await fetch(`${host}/api/v1/series`,{method:"POST",headers:{"DD-API-KEY":apiKey,"Content-Type":"application/json"},body:JSON.stringify({series})}); }catch{} }
  console.log("cred-health emitted otc.fleet.token_age_hours for",series.length,"secrets:");
  console.log(report.map(r=>"  "+r).join("\n"));
})().catch(e=>{console.error("ERR",e.message);process.exit(0);});

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
import { kvSecret } from "../kb-memory/azure-secret.mjs";
const PROJECT="otchealth-shared-prod"; const b64url=(b)=>Buffer.from(b).toString("base64url");
// Rotating OAuth secrets whose age matters for idle-expiry. Static keys (PAT/SA/ASC) are excluded by design.
const ROTATING=[
  "xero-refresh-token-otchealth","xero-refresh-token-innd","xero-refresh-token-hearingassist","xero-refresh-token-personal",
  "quickbooks-refresh-token",
];
function loadSA(){ if(process.env.GCP_CLAUDE_DRIVER_SA_JSON){try{return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON);}catch{}} for(const p of [`${os.homedir()}/.gcp_claude_driver_sa.json`,"/agent/.gcp_claude_driver_sa.json"]){try{if(fs.existsSync(p))return JSON.parse(fs.readFileSync(p,"utf8"));}catch{}} return null; }
async function gcpToken(sa){const now=Math.floor(Date.now()/1000);const cl={iss:sa.client_email,scope:"https://www.googleapis.com/auth/cloud-platform",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3500};const i=`${b64url(JSON.stringify({alg:"RS256",typ:"JWT"}))}.${b64url(JSON.stringify(cl))}`;const s=crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key);const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:`${i}.${Buffer.from(s).toString("base64url")}`})});return (await r.json()).access_token;}
async function sm(tok,id){const r=await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${id}/versions/latest:access`,{headers:{Authorization:`Bearer ${tok}`}});if(r.status!==200)return null;const j=await r.json();return j.payload?Buffer.from(j.payload.data,"base64").toString("utf8").trim():null;}
async function latestVersionAgeHoursGcp(tok,id){
  const r=await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${id}/versions?pageSize=1`,{headers:{Authorization:`Bearer ${tok}`}});
  if(r.status!==200) return null; const j=await r.json(); const v=(j.versions||[])[0]; if(!v||!v.createTime) return null;
  return (Date.now()-new Date(v.createTime).getTime())/3600000;
}
// Azure Key Vault list-versions: the KV equivalent of the GCP call above. Each version's
// attributes.created is a Unix-epoch-seconds timestamp; walk every page and take the newest since KV
// (unlike GCP) does not document a guaranteed newest-first order. Fail-open (null), never throws.
async function kvVaultToken(){
  const t=process.env.AZURE_SP_TENANT_ID,c=process.env.AZURE_SP_CLIENT_ID,s=process.env.AZURE_SP_CLIENT_SECRET;
  if(!t||!c||!s) return null;
  try{
    const r=await fetch(`https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"client_credentials",client_id:c,client_secret:s,scope:"https://vault.azure.net/.default"})});
    const j=await r.json(); return j.access_token||null;
  }catch{ return null; }
}
async function latestVersionAgeHoursKv(id){
  const vault=process.env.AZURE_KEYVAULT_NAME||"kv-otc-55c84f6bef";
  const tok=await kvVaultToken(); if(!tok) return null;
  try{
    let url=`https://${vault}.vault.azure.net/secrets/${id}/versions?api-version=7.4&maxresults=25`; let maxCreated=null;
    while(url){
      const r=await fetch(url,{headers:{Authorization:`Bearer ${tok}`}}); if(!r.ok) break;
      const j=await r.json();
      for(const v of j.value||[]){ const c=v.attributes&&v.attributes.created; if(c!=null&&(maxCreated==null||c>maxCreated)) maxCreated=c; }
      url=j.nextLink||null;
    }
    return maxCreated==null?null:(Date.now()/1000-maxCreated)/3600;
  }catch{ return null; }
}
async function latestVersionAgeHours(sa,tokBox,id){
  // Azure Key Vault FIRST (fleet secret store; GCP Secret Manager retired). GCP fallback ONLY if a
  // claude-driver SA is actually present (guarded so a missing SA no longer short-circuits the run).
  const kv=await latestVersionAgeHoursKv(id);
  if(kv!=null) return kv;
  if(!sa) return null;
  if(!tokBox.tok) tokBox.tok=await gcpToken(sa);
  if(!tokBox.tok) return null;
  return latestVersionAgeHoursGcp(tokBox.tok,id);
}
(async()=>{
  // Azure Key Vault FIRST for the static Datadog creds too; GCP fallback ONLY if a claude-driver SA
  // is actually present/parseable. Guarded so a missing SA returns null/continues instead of the old
  // hard process.exit(0) before ever trying Azure.
  let apiKey=await kvSecret("datadog-api-key"), site=await kvSecret("datadog-site");
  const sa=loadSA();
  const tokBox={tok:null};
  if((!apiKey||!site) && sa){
    tokBox.tok=await gcpToken(sa);
    if(tokBox.tok){ apiKey=apiKey||await sm(tokBox.tok,"datadog-api-key"); site=site||await sm(tokBox.tok,"datadog-site"); }
  }
  const host=`https://api.${site||"us3.datadoghq.com"}`; const now=Math.floor(Date.now()/1000);
  const series=[]; const report=[];
  for(const id of ROTATING){
    try{ const age=await latestVersionAgeHours(sa,tokBox,id); if(age==null){ report.push(`${id}: (absent)`); continue; }
      series.push({metric:"otc.fleet.token_age_hours",type:"gauge",points:[[now,Math.round(age*10)/10]],tags:[`secret:${id}`]});
      report.push(`${id}: ${Math.round(age*10)/10}h`);
    }catch(e){ report.push(`${id}: ERR ${e.message}`); }
  }
  if(apiKey && series.length){ try{ await fetch(`${host}/api/v1/series`,{method:"POST",headers:{"DD-API-KEY":apiKey,"Content-Type":"application/json"},body:JSON.stringify({series})}); }catch{} }
  console.log("cred-health emitted otc.fleet.token_age_hours for",series.length,"secrets:");
  console.log(report.map(r=>"  "+r).join("\n"));
})().catch(e=>{console.error("ERR",e.message);process.exit(0);});

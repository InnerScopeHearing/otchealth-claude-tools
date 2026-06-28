#!/usr/bin/env node
/**
 * start.mjs — trigger an IMMEDIATE one-off execution of the xero-run Azure Container App Job (no waiting
 * for the daily cron). Reads azure-sp creds from GCP SM (no az CLI needed). Run via the kb-memory wrapper:
 *   bash skills/kb-memory/run.sh node skills/xero-run/start.mjs
 * The job processes whatever orgs are enabled in GCS xero-run/config.json, under the 900/day governor.
 */
import crypto from "node:crypto"; import fs from "node:fs"; import os from "node:os";
const PROJECT="otchealth-shared-prod"; const RG="rg-otchealth-apps-prod"; const JOB="xero-run"; const b64url=(b)=>Buffer.from(b).toString("base64url");
function loadSA(){ if(process.env.GCP_CLAUDE_DRIVER_SA_JSON){try{return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON);}catch{}} for(const p of [`${os.homedir()}/.gcp_claude_driver_sa.json`,"/agent/.gcp_claude_driver_sa.json"]){try{if(fs.existsSync(p))return JSON.parse(fs.readFileSync(p,"utf8"));}catch{}} throw new Error("no SA"); }
async function gcp(){const sa=loadSA();const now=Math.floor(Date.now()/1000);const cl={iss:sa.client_email,scope:"https://www.googleapis.com/auth/cloud-platform",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3500};const i=`${b64url(JSON.stringify({alg:"RS256",typ:"JWT"}))}.${b64url(JSON.stringify(cl))}`;const s=crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key);const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:`${i}.${Buffer.from(s).toString("base64url")}`})});return (await r.json()).access_token;}
async function sm(t,id){const r=await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${id}/versions/latest:access`,{headers:{Authorization:`Bearer ${t}`}});const j=await r.json();return Buffer.from(j.payload.data,"base64").toString("utf8").trim();}
async function az(t,c,s){const r=await fetch(`https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:c,client_secret:s,grant_type:"client_credentials",scope:"https://management.azure.com/.default"})});return (await r.json()).access_token;}
(async()=>{
  const g=await gcp(); const [t,c,s,sub]=await Promise.all([sm(g,"azure-sp-tenant-id"),sm(g,"azure-sp-client-id"),sm(g,"azure-sp-client-secret"),sm(g,"azure-subscription-id")]);
  const at=await az(t,c,s);
  const r=await fetch(`https://management.azure.com/subscriptions/${sub}/resourceGroups/${RG}/providers/Microsoft.App/jobs/${JOB}/start?api-version=2024-03-01`,{method:"POST",headers:{Authorization:`Bearer ${at}`,"Content-Type":"application/json"},body:"{}"});
  const j=await r.json().catch(()=>({}));
  console.log(`xero-run start: HTTP ${r.status} ${r.ok?"-> execution "+(j.name||j.id||"(started)"):JSON.stringify(j).slice(0,200)}`);
  console.log("track: bash skills/kb-memory/run.sh node skills/xero-run/status.mjs");
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});

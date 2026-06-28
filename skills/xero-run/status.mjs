#!/usr/bin/env node
/**
 * status.mjs — show recent xero-run job executions (Running/Succeeded/Failed). Run via kb-memory wrapper:
 *   bash skills/kb-memory/run.sh node skills/xero-run/status.mjs
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
  const r=await fetch(`https://management.azure.com/subscriptions/${sub}/resourceGroups/${RG}/providers/Microsoft.App/jobs/${JOB}/executions?api-version=2024-03-01`,{headers:{Authorization:`Bearer ${at}`}});
  const j=await r.json(); const runs=(j.value||[]).map(x=>({name:x.name,status:x.properties?.status,start:x.properties?.startTime,end:x.properties?.endTime})).sort((a,b)=>new Date(b.start)-new Date(a.start)).slice(0,8);
  console.log("xero-run recent executions:"); for(const x of runs) console.log(`  ${x.status?.padEnd(9)} ${x.name}  start ${x.start||"?"}${x.end?" end "+x.end:""}`);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});

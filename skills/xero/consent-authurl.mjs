import crypto from "node:crypto"; import fs from "node:fs";
const P="otchealth-shared-prod"; const b=x=>Buffer.from(x).toString("base64url");
function sa(){return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON||fs.readFileSync("/agent/.gcp_claude_driver_sa.json","utf8"));}
async function gt(){const s=sa();const n=Math.floor(Date.now()/1e3);const c={iss:s.client_email,scope:"https://www.googleapis.com/auth/cloud-platform",aud:"https://oauth2.googleapis.com/token",iat:n,exp:n+3500};const i=`${b(JSON.stringify({alg:"RS256",typ:"JWT"}))}.${b(JSON.stringify(c))}`;const g=crypto.createSign("RSA-SHA256").update(i).sign(s.private_key);const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:`${i}.${Buffer.from(g).toString("base64url")}`})});return (await r.json()).access_token;}
async function sm(t,id){const r=await fetch(`https://secretmanager.googleapis.com/v1/projects/${P}/secrets/${id}/versions/latest:access`,{headers:{Authorization:"Bearer "+t}});if(r.status!==200)return null;const j=await r.json();return Buffer.from(j.payload.data,"base64").toString("utf8").trim();}
(async()=>{const t=await gt();const cid=await sm(t,"xero-client-id");if(!cid){console.error("no client id");process.exit(1);}
 const REDIRECT="https://localhost/callback";
 // FULL-CAPABILITY REQUEST SET (2026-06-28, verified grantable — exactly the scopes Xero returned on a
 // successful consent). Rule: request the WRITE scope for every writable resource (write INCLUDES read) +
 // the READ scope only where no write twin exists (budgets, reports). Do NOT also request the .read mirror
 // of a write scope, and do NOT request app.connections alongside them: that redundant pairing is what
 // Xero rejects as "access_denied: Requested wrong apps scopes". This set grants the agent full read+write
 // on accounting, payroll, files, assets, projects, plus read on budgets + all 9 reports.
 // offline_access mandatory for refresh token; openid/profile/email for identity.
 const SCOPE="openid profile email offline_access accounting.settings accounting.contacts accounting.attachments accounting.invoices accounting.banktransactions accounting.payments accounting.manualjournals accounting.budgets.read accounting.reports.profitandloss.read accounting.reports.balancesheet.read accounting.reports.trialbalance.read accounting.reports.aged.read accounting.reports.banksummary.read accounting.reports.executivesummary.read accounting.reports.budgetsummary.read accounting.reports.taxreports.read accounting.reports.tenninetynine.read payroll.employees payroll.payruns payroll.payslip payroll.settings payroll.timesheets files assets projects";
 const u=new URLSearchParams({response_type:"code",client_id:cid,redirect_uri:REDIRECT,scope:SCOPE,state:"ha"});
 console.log("AUTHORIZE_URL:");
 console.log("https://login.xero.com/identity/connect/authorize?"+u.toString());
 console.log("\nredirect_uri used:",REDIRECT,"| scopes:",SCOPE);
})().catch(e=>console.error("ERR",e.message));

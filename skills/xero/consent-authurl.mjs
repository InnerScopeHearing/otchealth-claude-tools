import crypto from "node:crypto"; import fs from "node:fs";
import { kvSecret, kvSecretSet, requireSecrets } from "../kb-memory/azure-secret.mjs";
const P="otchealth-shared-prod"; const b=x=>Buffer.from(x).toString("base64url");
function sa(){return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON||fs.readFileSync("/agent/.gcp_claude_driver_sa.json","utf8"));}
async function gt(){const s=sa();const n=Math.floor(Date.now()/1e3);const c={iss:s.client_email,scope:"https://www.googleapis.com/auth/cloud-platform",aud:"https://oauth2.googleapis.com/token",iat:n,exp:n+3500};const i=`${b(JSON.stringify({alg:"RS256",typ:"JWT"}))}.${b(JSON.stringify(c))}`;const g=crypto.createSign("RSA-SHA256").update(i).sign(s.private_key);const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:`${i}.${Buffer.from(g).toString("base64url")}`})});return (await r.json()).access_token;}
async function sm(t,id){ const _kv = await kvSecret(id); if (_kv != null) return _kv;const r=await fetch(`https://secretmanager.googleapis.com/v1/projects/${P}/secrets/${id}/versions/latest:access`,{headers:{Authorization:"Bearer "+t}});if(r.status!==200)return null;const j=await r.json();return Buffer.from(j.payload.data,"base64").toString("utf8").trim();}
(async()=>{const t=await gt();const cid=await sm(t,"xero-client-id");if(!cid){console.error("no client id");process.exit(1);}
 const REDIRECT="https://localhost/callback";
 // FULL-CAPABILITY REQUEST SET (2026-06-28, verified grantable — exactly the scopes Xero returned on a
 // successful consent). Rule: request the WRITE scope for every writable resource (write INCLUDES read) +
 // the READ scope only where no write twin exists (budgets, reports). Do NOT also request the .read mirror
 // of a write scope, and do NOT request app.connections alongside them: that redundant pairing is what
 // Xero rejects as "access_denied: Requested wrong apps scopes". This set grants the agent full read+write
 // on accounting, payroll, files, assets, projects, plus read on budgets + all 9 reports.
 // offline_access mandatory for refresh token; openid/profile/email for identity.
 const BASE_SCOPE="openid profile email offline_access accounting.settings accounting.contacts accounting.attachments accounting.invoices accounting.banktransactions accounting.payments accounting.manualjournals accounting.budgets.read accounting.reports.profitandloss.read accounting.reports.balancesheet.read accounting.reports.trialbalance.read accounting.reports.aged.read accounting.reports.banksummary.read accounting.reports.executivesummary.read accounting.reports.budgetsummary.read accounting.reports.taxreports.read accounting.reports.tenninetynine.read payroll.employees payroll.payruns payroll.payslip payroll.settings payroll.timesheets files assets projects";

 // GET /Journals (the general-ledger journal feed) requires `accounting.journals.read`, which this
 // set has NEVER requested. `accounting.manualjournals` above is a DIFFERENT endpoint
 // (/ManualJournals, user-entered journals). That omission -- not a Xero cutoff -- is why
 // GET /Journals returns HTTP 401 AuthorizationUnsuccessful on every org (reproduced 2026-08-14 on
 // otchealth and hearingassist). The CFO needs that feed for the FY2022 close.
 //
 // OPT-IN, NOT DEFAULT, deliberately. Xero rejects the WHOLE consent with
 // "access_denied: Requested wrong apps scopes" when a set contains a scope this app cannot hold,
 // and re-consent is how CFO Xero access gets RESTORED -- so silently widening the default set
 // risks locking the CFO out of everything to gain one endpoint. The base set above is
 // empirically proven grantable; this flag is the experiment, run deliberately.
 //
 // By this file's own rule (write scope where a write twin exists, .read only where none does)
 // journals.read is the correct form: /Journals is read-only in Xero, so there is no write twin
 // to collide with. Expected to be granted -- but expected is not verified.
 //
 // IF Xero returns access_denied with this flag: re-run WITHOUT it to restore access immediately,
 // then treat journals-scope eligibility as an app-type question for the Xero Developer Portal
 // (see isGrandfatheredForJournals in otchealth-mcp-server, which deliberately refuses to guess).
 const WITH_JOURNALS = process.argv.includes("--with-journals");
 const SCOPE = WITH_JOURNALS ? `${BASE_SCOPE} accounting.journals.read` : BASE_SCOPE;
 const u=new URLSearchParams({response_type:"code",client_id:cid,redirect_uri:REDIRECT,scope:SCOPE,state:"ha"});
 console.log("AUTHORIZE_URL:");
 console.log("https://login.xero.com/identity/connect/authorize?"+u.toString());
 console.log("\nredirect_uri used:",REDIRECT,"| scopes:",SCOPE);
 console.log(WITH_JOURNALS
   ? "\nMODE: +accounting.journals.read (unlocks GET /Journals). If Xero answers access_denied, re-run WITHOUT --with-journals to restore the proven set."
   : "\nMODE: proven base set. GET /Journals will keep returning 401 -- re-run with --with-journals to request that scope.");
})().catch(e=>console.error("ERR",e.message));

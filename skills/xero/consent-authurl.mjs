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

 // GET /Journals (the general-ledger journal feed) requires `accounting.journals.read`. This set has
 // never requested it, AND it cannot be granted to this app (CORRECTION 2026-09-02, superseding the
 // 2026-08-14 note that called this a mere omission). Verified against Xero's own developer FAQ and
 // scopes docs three times (kb-memory 20260710-044, 20260729-012, 20260730-007): connections created
 // from 29 April 2026 use the granular scope set, which does not include journal access; /Journals
 // moved behind Xero's Advanced tier (1,445 AUD/month) plus use-case approval and an initial + annual
 // security assessment. Only a CUSTOM CONNECTION created before that date keeps the scope, and only
 // until Xero's broad-scope deprecation date, 13 September 2027 (developer.xero.com/faq, "Can I
 // access journals with a custom connection?"; developer.xero.com/changelog, entries of 4 March 2026
 // and 6 August 2026; both re-read 2026-09-02). This integration is a standard OAuth2 app
 // (refresh_token grant; see isGrandfatheredForJournals in otchealth-mcp-server, which deliberately
 // refuses to guess). RECOMMENDATION OF RECORD (CFO lane, 2026-07-29, reaffirmed 2026-07-30):
 // DECLINE the Advanced tier; the gateway's xero_gl_assemble was built on that basis. Every prior
 // instruction to "add accounting.journals.read and re-consent" is WITHDRAWN.
 // `accounting.manualjournals` above is a DIFFERENT endpoint (/ManualJournals, user-entered
 // journals) and is unaffected.
 //
 // Sanctioned substitutes, no scope change needed: the gateway's xero_gl_assemble (Xero's own
 // TrialBalance period movement per account per month, granted scopes only), direct document reads
 // (GET /BankTransactions/{id}, /CreditNotes/{id}, ... show Type + LineItems, which fix the posting
 // side), and the Xero web UI Journal Report / General Ledger export (org role, no API scope).
 //
 // `--with-journals` is kept ONLY as an explicitly labelled experiment and now REFUSES unless
 // XERO_JOURNALS_EXPERIMENT=1 is set, so no session repeats the withdrawn instruction by accident.
 // Requesting a scope this app cannot hold makes Xero reject the WHOLE consent
 // ("access_denied: Requested wrong apps scopes"). A failed authorize does not revoke existing
 // refresh tokens, but re-consent is how CFO Xero access gets RESTORED, so the default set is never
 // widened; if the experiment is ever run and fails, re-run WITHOUT the flag to restore the proven set.
 const WITH_JOURNALS = process.argv.includes("--with-journals");
 if (WITH_JOURNALS && process.env.XERO_JOURNALS_EXPERIMENT !== "1") {
   console.error("REFUSED: --with-journals requests accounting.journals.read, which this app cannot be granted (Xero granular-scope cutover 2026-04-29; /Journals is Advanced-tier plus a security assessment; recommendation of record = DECLINE, kb-memory 20260729-012 / 20260730-007; Xero FAQ and changelog re-read 2026-09-02). Use xero_gl_assemble, direct document reads (GET /BankTransactions/{id}), or the Xero UI General Ledger export instead. To run the experiment anyway set XERO_JOURNALS_EXPERIMENT=1; a failed authorize does not revoke existing tokens, and re-running without the flag restores the proven set.");
   process.exit(2);
 }
 const SCOPE = WITH_JOURNALS ? `${BASE_SCOPE} accounting.journals.read` : BASE_SCOPE;
 const u=new URLSearchParams({response_type:"code",client_id:cid,redirect_uri:REDIRECT,scope:SCOPE,state:"ha"});
 console.log("AUTHORIZE_URL:");
 console.log("https://login.xero.com/identity/connect/authorize?"+u.toString());
 console.log("\nredirect_uri used:",REDIRECT,"| scopes:",SCOPE);
 console.log(WITH_JOURNALS
   ? "\nMODE: +accounting.journals.read (unlocks GET /Journals). If Xero answers access_denied, re-run WITHOUT --with-journals to restore the proven set."
   : "\nMODE: proven base set. GET /Journals returns 401 by design (accounting.journals.read is not grantable to this app; see the header comment for the sanctioned substitutes).");
})().catch(e=>console.error("ERR",e.message));

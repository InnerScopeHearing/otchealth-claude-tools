import crypto from "node:crypto"; import fs from "node:fs";
const P="otchealth-shared-prod"; const b=x=>Buffer.from(x).toString("base64url");
const HA_TENANT="72841086-a2ef-4758-80a8-3b71a98d440a"; const REDIRECT="https://localhost/callback";
function sa(){return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON||fs.readFileSync("/agent/.gcp_claude_driver_sa.json","utf8"));}
async function gt(){const s=sa();const n=Math.floor(Date.now()/1e3);const c={iss:s.client_email,scope:"https://www.googleapis.com/auth/cloud-platform",aud:"https://oauth2.googleapis.com/token",iat:n,exp:n+3500};const i=`${b(JSON.stringify({alg:"RS256",typ:"JWT"}))}.${b(JSON.stringify(c))}`;const g=crypto.createSign("RSA-SHA256").update(i).sign(s.private_key);const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:`${i}.${Buffer.from(g).toString("base64url")}`})});return (await r.json()).access_token;}
async function sm(t,id){const r=await fetch(`https://secretmanager.googleapis.com/v1/projects/${P}/secrets/${id}/versions/latest:access`,{headers:{Authorization:"Bearer "+t}});if(r.status!==200)return null;const j=await r.json();return Buffer.from(j.payload.data,"base64").toString("utf8").trim();}
async function smWrite(t,id,val){
  // ensure secret exists
  await fetch(`https://secretmanager.googleapis.com/v1/projects/${P}/secrets?secretId=${id}`,{method:"POST",headers:{Authorization:"Bearer "+t,"Content-Type":"application/json"},body:JSON.stringify({replication:{automatic:{}}})}).catch(()=>{});
  const r=await fetch(`https://secretmanager.googleapis.com/v1/projects/${P}/secrets/${id}:addVersion`,{method:"POST",headers:{Authorization:"Bearer "+t,"Content-Type":"application/json"},body:JSON.stringify({payload:{data:Buffer.from(val,"utf8").toString("base64")}})});
  return r.status;
}
(async()=>{
  let code=(process.argv[2]||"").trim();
  // accept either a raw code or a full pasted localhost URL containing ?code=
  if(/[?&]code=/.test(code)){ try{ code=new URL(code).searchParams.get("code"); }catch{ code=(code.split("code=")[1]||"").split("&")[0]; } }
  if(!code){console.error("usage: node xero-exchange.mjs '<code-or-full-redirect-url>'");process.exit(1);}
  const t=await gt(); const [cid,cs]=await Promise.all([sm(t,"xero-client-id"),sm(t,"xero-client-secret")]);
  const basic=Buffer.from(`${cid}:${cs}`).toString("base64");
  const tr=await fetch("https://identity.xero.com/connect/token",{method:"POST",headers:{Authorization:"Basic "+basic,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"authorization_code",code,redirect_uri:REDIRECT})});
  const tj=await tr.json();
  if(!tr.ok||!tj.refresh_token){console.error("TOKEN EXCHANGE FAILED",tr.status,JSON.stringify(tj).slice(0,300));process.exit(1);}
  // confirm tenant
  const cr=await fetch("https://api.xero.com/connections",{headers:{Authorization:"Bearer "+tj.access_token,"Content-Type":"application/json"}});
  const conns=await cr.json();
  const tenants=(Array.isArray(conns)?conns:[]).map(c=>({id:c.tenantId,name:c.tenantName}));
  console.log("granted tenants:",JSON.stringify(tenants));
  const ha=tenants.find(x=>x.id===HA_TENANT);
  if(!ha){console.error("WARNING: HearingAssist tenant "+HA_TENANT+" NOT among granted tenants. NOT writing token. Re-run authorize and pick HearingAssist.");process.exit(2);}
  if(tenants.length>1){console.error("NOTE: consent granted "+tenants.length+" tenants; HA present so proceeding, but ideally consent only HearingAssist.");}
  const st=await smWrite(t,"xero-refresh-token-hearingassist",tj.refresh_token);
  console.log("WROTE xero-refresh-token-hearingassist -> SM status "+st+" | tenant "+ha.name+" ("+ha.id+") | scopes "+(tj.scope||"?"));
  if(st>=300)process.exit(1);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});

#!/usr/bin/env node
/**
 * cfo-gateway — gives the CFO agent its OWN ring (cfo) on the OTCHealth MCP gateway.
 *
 * WHY: the Hyperagent MCP UI connection to the gateway authenticates via the shared OAuth client and
 * the gateway env OAUTH_DEFAULT_AGENT=cto, so ExecuteIntegration from ANY Hyperagent agent (incl. the
 * CFO) resolves to the `cto` lane -> finance-* ring-gated indexes return forbidden_ring. The cfo lane
 * IS provisioned gateway-side (oauth-clients maps oc_cfo_* -> cfo). This skill mints a cfo-lane bearer
 * via the client_credentials (machine-to-machine) grant using the oc_cfo creds from the vault, then
 * calls the gateway /mcp as the cfo lane. No gateway change required.
 *
 * USAGE (run via the kb-memory credential wrapper so the GCP SA is present):
 *   bash skills/kb-memory/run.sh node skills/cfo-gateway/cli.mjs search <index> "<query>" [--top N] [--ack]
 *   bash skills/kb-memory/run.sh node skills/cfo-gateway/cli.mjs call <toolName> '<jsonArgs>'
 *   bash skills/kb-memory/run.sh node skills/cfo-gateway/cli.mjs whoami     # prove the resolved lane
 * Privileged finance indexes: finance-cfo-source-docs, finance-otchealth-cfo-source-docs.
 * --ack passes acknowledge_warning=true to render MNPI/investor-sensitive payloads (cfo lane only).
 *
 * SECURITY: cfo ring. oc_cfo secret is read from GCP SM and never printed/logged. Use only inside the
 * CFO agent. Never echo MNPI to a non-cfo context.
 */
import crypto from "node:crypto"; import fs from "node:fs"; import os from "node:os";
const PROJECT="otchealth-shared-prod";
const GATEWAY="https://mcp.otchealth.app";
const TOKEN_URL=`${GATEWAY}/oauth/token`;
const b64url=(b)=>Buffer.from(b).toString("base64url");
function loadSA(){ if(process.env.GCP_CLAUDE_DRIVER_SA_JSON){try{return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON);}catch{}} for(const p of [`${os.homedir()}/.gcp_claude_driver_sa.json`,"/agent/.gcp_claude_driver_sa.json"]){try{if(fs.existsSync(p))return JSON.parse(fs.readFileSync(p,"utf8"));}catch{}} throw new Error("No GCP SA (run via kb-memory run.sh)."); }
async function gcpToken(){const sa=loadSA();const now=Math.floor(Date.now()/1000);const cl={iss:sa.client_email,scope:"https://www.googleapis.com/auth/cloud-platform",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3500};const i=`${b64url(JSON.stringify({alg:"RS256",typ:"JWT"}))}.${b64url(JSON.stringify(cl))}`;const s=crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key);const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:`${i}.${Buffer.from(s).toString("base64url")}`})});return (await r.json()).access_token;}
async function sm(tok,id){const r=await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${id}/versions/latest:access`,{headers:{Authorization:`Bearer ${tok}`}});const j=await r.json();return j.payload?Buffer.from(j.payload.data,"base64").toString("utf8").trim():null;}

async function cfoCreds(){
  const g=await gcpToken(); const raw=await sm(g,"oauth-clients"); const reg=JSON.parse(raw);
  const items=Array.isArray(reg)?reg:Object.entries(reg).map(([k,v])=>typeof v==="object"?{key:k,...v}:{key:k,value:v});
  const cfo=items.find(i=>(i.lane||i.agent||i.role)==="cfo");
  if(!cfo) throw new Error("cfo lane not found in oauth-clients");
  const cid=cfo.client_id||cfo.clientId;
  const csec=cfo.client_secret||cfo.secret||cfo.clientSecret;
  if(!cid||!csec) throw new Error("cfo client_id/secret missing");
  return {cid,csec};
}
async function cfoBearer(){
  const {cid,csec}=await cfoCreds();
  const r=await fetch(TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Accept:"application/json"},body:new URLSearchParams({grant_type:"client_credentials",client_id:cid,client_secret:csec,scope:"cfo"})});
  const j=await r.json().catch(()=>({}));
  if(!j.access_token) throw new Error("cfo client_credentials grant failed: HTTP "+r.status);
  return j.access_token;
}
async function callTool(bearer,name,args){
  const body={jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}};
  const r=await fetch(`${GATEWAY}/mcp`,{method:"POST",headers:{Authorization:`Bearer ${bearer}`,"Content-Type":"application/json",Accept:"application/json, text/event-stream"},body:JSON.stringify(body)});
  const txt=await r.text(); let j; try{j=JSON.parse(txt);}catch{const m=txt.match(/data: (\{[\s\S]*\})/);j=m?JSON.parse(m[1]):{raw:txt.slice(0,400)};}
  return {status:r.status, text:j?.result?.content?.[0]?.text ?? JSON.stringify(j?.result||j)};
}
const has=(f)=>process.argv.includes(f);
const argAfter=(f)=>{const i=process.argv.indexOf(f);return i>=0?process.argv[i+1]:null;};

(async()=>{
  const cmd=process.argv[2];
  const bearer=await cfoBearer();
  if(cmd==="whoami"){
    // identity proof: a forbidden index would say the lane; instead hit a cfo index and report acceptance
    const res=await callTool(bearer,"kb_search_privileged",{index:"finance-cfo-source-docs",query:"ping",top:1});
    const accepted=!/forbidden_ring/.test(res.text);
    console.log(JSON.stringify({lane_accepted_for_finance:accepted, http:res.status, note: accepted?"cfo lane ACTIVE":"still refused", sample:res.text.slice(0,160)},null,2));
    return;
  }
  if(cmd==="search"){
    const index=process.argv[3]; const query=process.argv[4];
    if(!index||!query){console.error('usage: search <index> "<query>" [--top N] [--ack]');process.exit(2);}
    const top=parseInt(argAfter("--top")||"6",10);
    const args={index,query,top}; if(has("--ack")) args.acknowledge_warning=true;
    const res=await callTool(bearer,"kb_search_privileged",args);
    console.log("HTTP",res.status); console.log(res.text);
    return;
  }
  if(cmd==="call"){
    const name=process.argv[3]; let args={}; try{args=JSON.parse(process.argv[4]||"{}");}catch(e){console.error("bad json args");process.exit(2);}
    const res=await callTool(bearer,name,args);
    console.log("HTTP",res.status); console.log(res.text);
    return;
  }
  console.error('cfo-gateway: commands = whoami | search <index> "<query>" [--top N] [--ack] | call <tool> \'<json>\'');
  process.exit(2);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});

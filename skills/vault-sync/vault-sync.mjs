import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const REPO=resolve(dirname(fileURLToPath(import.meta.url)),'..','..');
const NV='2022-06-28';
const d=mkdtempSync(join(tmpdir(),'vault-'));
const sec=(id)=>{const f=join(d,id);execSync(`node ${REPO}/setup/get-secret.mjs ${id} ${f}`,{stdio:'ignore'});return readFileSync(f,'utf8').trim();};
const NK=sec('notion-api-key');
const DB=(process.env.VAULT_DB_ID||sec('notion-vault-db-id')).replace(/-/g,'');
const sa=JSON.parse(readFileSync(`${process.env.HOME}/.gcp_claude_driver_sa.json`,'utf8'));
async function gcp(){const h={alg:'RS256',typ:'JWT'},n=Math.floor(Date.now()/1000);const c={iss:sa.client_email,scope:'https://www.googleapis.com/auth/cloud-platform',aud:'https://oauth2.googleapis.com/token',iat:n,exp:n+3600};const e=o=>Buffer.from(JSON.stringify(o)).toString('base64url');const i=`${e(h)}.${e(c)}`;const s=crypto.createSign('RSA-SHA256').update(i).sign(sa.private_key,'base64url');const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${i}.${s}`});return (await r.json()).access_token;}
async function listSM(){const t=await gcp();let o=[],pt='';do{const r=await fetch(`https://secretmanager.googleapis.com/v1/projects/otchealth-shared-prod/secrets?pageSize=100${pt?`&pageToken=${pt}`:''}`,{headers:{Authorization:'Bearer '+t}});const j=await r.json();for(const s of (j.secrets||[]))o.push(s.name.split('/secrets/')[1]);pt=j.nextPageToken||'';}while(pt);return o.sort();}
function infer(id){
  const map=[['ebay','eBay'],['fourvault','FourVault'],['azure','Azure'],['acr-','Azure'],['asc-','Apple'],['apple-','Apple'],['amzn','Amazon'],['github','GitHub'],['graph-','Microsoft Graph'],['datadog','Datadog'],['depot','Depot'],['daytona','Daytona'],['cloudflare','Cloudflare'],['elevenlabs','ElevenLabs'],['openai','OpenAI'],['plaid','Plaid'],['qbo','QuickBooks'],['xero','Xero'],['revenuecat','RevenueCat'],['sentry','Sentry'],['netlify','Netlify'],['railway','Railway'],['replicate','Replicate'],['massive','Massive'],['n8n','n8n'],['make-','Make'],['miro','Miro'],['greptile','Greptile'],['context7','Context7'],['posthog','PostHog'],['plantid','PlantID'],['flatstick','Flatstick'],['companion','Companion'],['medreview','MedReview'],['govinfo','GovInfo'],['courtlistener','CourtListener'],['legal-courtlistener','CourtListener']];
  let service='Other'; for(const[p,s]of map){if(id.startsWith(p)){service=s;break;}} if(service==='Other')for(const[p,s]of map){if(id.includes(p)){service=s;break;}}
  let type;
  if(/refresh/.test(id))type='OAuth refresh token';
  else if(/cert-id$/.test(id))type='OAuth client secret';
  else if(/client-secret/.test(id))type='OAuth client secret';
  else if(/client-id$|app-id$/.test(id))type='OAuth client ID';
  else if(/-p8$|key-p8$/.test(id))type='p8 cert';
  else if(/password/.test(id))type='password';
  else if(/database-url|connection/.test(id))type='connection string';
  else if(/^plaid-access|access-token/.test(id))type='access token';
  else if(/verification-token|webhook/.test(id))type='webhook token';
  else if(/endpoint|region|server$|account$|bucket|deployment|version|-env$|site$|realm|base-url|host$|-user$|key-id$|issuer|team-id|installation-id|project-id|dev-id$|storage-container|-region$/.test(id))type='config non-secret';
  else if(/secret$|-key$|api-key$|token$|password/.test(id))type=/token$/.test(id)?'access token':'API key';
  else type='API key';
  const ring=/^medreview/.test(id)?'PHI-BAA':'non-PHI';
  const env=/sandbox/.test(id)?'sandbox':'prod';
  return {service,type,ring,env};
}
const N=(m,p,b)=>fetch(`https://api.notion.com/v1${p}`,{method:m,headers:{Authorization:'Bearer '+NK,'Notion-Version':NV,'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});
const propsFor=(id,m)=>({"Name":{title:[{text:{content:id}}]},"Secret Manager ID":{rich_text:[{text:{content:id}}]},"Service":{select:{name:m.service}},"Type":{select:{name:m.type}},"Environment":{select:{name:m.env}},"Ring":{select:{name:m.ring}}});
(async()=>{
  const chk=await N('GET',`/databases/${DB}`); if(!chk.ok){console.log('NO DB ACCESS',chk.status,(await chk.text()).slice(0,160));process.exit(3);}
  const rows={}; let cur;
  do{const r=await N('POST',`/databases/${DB}/query`,cur?{start_cursor:cur,page_size:100}:{page_size:100});const j=await r.json();for(const p of j.results){const id=p.properties?.['Secret Manager ID']?.rich_text?.[0]?.plain_text;if(id)rows[id]={pageId:p.id,type:p.properties.Type?.select?.name,service:p.properties.Service?.select?.name,ring:p.properties.Ring?.select?.name};}cur=j.has_more?j.next_cursor:null;}while(cur);
  const secrets=await listSM();
  let created=0,updated=0,ok=0,failed=0;
  for(const id of secrets){
    const m=infer(id), ex=rows[id];
    if(!ex){const r=await N('POST','/pages',{parent:{database_id:DB},properties:{...propsFor(id,m),"Status":{select:{name:'Active'}}}});r.ok?created++:(failed++,failed<=3&&console.log('create fail',id,r.status));continue;}
    if(ex.type!==m.type||ex.service!==m.service||ex.ring!==m.ring){const r=await N('PATCH',`/pages/${ex.pageId}`,{properties:propsFor(id,m)});r.ok?updated++:(failed++,failed<=3&&console.log('update fail',id,r.status));}
    else ok++;
  }
  const orphan=Object.keys(rows).filter(x=>!secrets.includes(x));
  console.log(`vault-sync: ${secrets.length} SM secrets | created=${created} updated=${updated} unchanged=${ok} failed=${failed}`);
  if(orphan.length)console.log('DRIFT (rows with no SM secret -> review/retire):',orphan.join(', ')); else console.log('no drift.');
})();

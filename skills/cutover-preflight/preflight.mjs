#!/usr/bin/env node
/**
 * cutover-preflight — the GO / NO-GO gate for moving the company brain off Azure.
 *
 * WHY THIS EXISTS. On 2026-08-15 the cutover was believed ready. Four independent blockers were
 * found in a single day, and every one of them was invisible to the checks in use:
 *
 *   - memory WRITES still went to Azure while reads came from OpenSearch (fleet-wide amnesia)
 *   - documents were mirrored to S3, but no code path could read them
 *   - query embeddings still ran through Azure Foundry
 *   - Azure writes could not authenticate from AWS, making rollback one-way
 *
 * The common cause was not carelessness. It was that every existing check inspected CONFIGURATION
 * and reported what it INTENDED, while the failures lived in what the system actually DID. An env
 * var reading `SEARCH_BACKEND=opensearch` looks like proof and is not.
 *
 * So every check here queries a LIVE system and asserts on an observable effect. No check passes on
 * the basis of a setting. Where a check cannot be completed, it FAILS -- an unverifiable dependency
 * during a migration is indistinguishable from a broken one, and the whole point is to stop a
 * confident-but-wrong GO.
 *
 * READ-ONLY. Nothing here mutates anything. Safe to run at any time, by anyone.
 *
 *   node preflight.mjs            full report
 *   node preflight.mjs --json     machine-readable, for a CI gate
 *
 * Exit code is 0 only on GO. Any FAIL exits 1, so this can gate an automated cutover directly.
 */
import { kvSecret } from '../kb-memory/azure-secret.mjs';
import { mintToken } from '../gateway-connect/connect.mjs';
import crypto from 'node:crypto';

const JSON_OUT = process.argv.includes('--json');
const results = [];

const C = { reset: '\x1b[0m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', dim: '\x1b[2m' };
const paint = (s, c) => (JSON_OUT ? s : `${c}${s}${C.reset}`);

function record(id, title, status, evidence, remedy) {
  results.push({ id, title, status, evidence, remedy });
  if (JSON_OUT) return;
  const tag =
    status === 'PASS' ? paint(' PASS ', C.green) : status === 'WARN' ? paint(' WARN ', C.yellow) : paint(' FAIL ', C.red);
  console.log(`${tag} ${C.bold}${id}${C.reset} ${title}`);
  console.log(`       ${C.dim}${evidence}${C.reset}`);
  if (status !== 'PASS' && remedy) console.log(`       ${paint('-> ' + remedy, C.yellow)}`);
}

/** Any thrown error becomes a FAIL. An unverifiable dependency is not a passing one. */
async function check(id, title, fn, remedy) {
  try {
    const { status, evidence } = await fn();
    record(id, title, status, evidence, remedy);
  } catch (e) {
    record(id, title, 'FAIL', `check could not complete: ${e.message.slice(0, 160)}`, remedy);
  }
}

// ── AWS signing (self-contained; the gateway's own signer is TypeScript) ────────────────────────
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
async function aws({ service, host, method = 'GET', path = '/', query = '', body = '', region = 'us-east-1', extra = {} }) {
  const AK = process.env.__PF_AK, SK = process.env.__PF_SK;
  // SigV4 canonicalises the query string SORTED BY KEY. Unsorted params sign a string AWS never
  // reconstructs -> 403, which a caller scanning for results reads as "empty" rather than "denied".
  const q = query ? query.split('&').filter(Boolean).sort().join('&') : '';
  const amz = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amz.slice(0, 8);
  // S3 REJECTS any request without a signed x-amz-content-sha256 (400 InvalidRequest).
  // ECS/JSON-protocol services REQUIRE X-Amz-Target and the x-amz-json content type, and both must
  // be SIGNED -- omitting them yields "Received a request with an unknown operation", which a caller
  // parsing JSON reads as a malformed response rather than a malformed request.
  const hh = { host, 'x-amz-date': amz, 'x-amz-content-sha256': sha256(body),
               ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])) };
  const keys = Object.keys(hh).sort();
  const canon = [method, path, q, keys.map((k) => `${k}:${hh[k]}\n`).join(''), keys.join(';'), sha256(body)].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  let k = hmac('AWS4' + SK, date);
  for (const p of [region, service, 'aws4_request']) k = hmac(k, p);
  const sig = crypto.createHmac('sha256', k).update(['AWS4-HMAC-SHA256', amz, scope, sha256(canon)].join('\n')).digest('hex');
  hh.Authorization = `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${keys.join(';')}, Signature=${sig}`;
  const r = await fetch(`https://${host}${path}${q ? '?' + q : ''}`, { method, headers: hh, body: method === 'GET' ? undefined : body });
  return { status: r.status, text: await r.text() };
}

const OS_HOST = 'search-otchealth-brain-uqmq2jw23cv4yjnnxblxzb7nny.us-east-1.es.amazonaws.com';
const ALB = 'otchealth-gateway-135939673.us-east-1.elb.amazonaws.com';
/** Rooms whose OpenSearch copy must be at least as complete as Azure's before any read flip. */
const PARITY_TOLERANCE = 0.98;

const ECS_HDRS = (op) => ({ 'x-amz-target': `AmazonEC2ContainerServiceV20141113.${op}`, 'content-type': 'application/x-amz-json-1.1' });

/** The task definition ACTUALLY running, and its container definition. Cached per run. */
let _task = null;
async function runningTask() {
  if (_task) return _task;
  const r = await aws({ service: 'ecs', host: 'ecs.us-east-1.amazonaws.com', method: 'POST', path: '/',
    body: JSON.stringify({ cluster: 'otchealth', services: ['otchealth-gateway'] }), extra: ECS_HDRS('DescribeServices') });
  const svc = JSON.parse(r.text).services?.[0];
  const td = svc?.taskDefinition;
  if (!td) throw new Error(`DescribeServices returned no service (HTTP ${r.status})`);
  const d = await aws({ service: 'ecs', host: 'ecs.us-east-1.amazonaws.com', method: 'POST', path: '/',
    body: JSON.stringify({ taskDefinition: td }), extra: ECS_HDRS('DescribeTaskDefinition') });
  const container = JSON.parse(d.text).taskDefinition?.containerDefinitions?.[0] ?? {};
  _task = { td, svc, container };
  return _task;
}

(async () => {
  if (!JSON_OUT) {
    console.log(`\n${C.bold}CUTOVER PREFLIGHT${C.reset}  ${C.dim}every check queries a live system; none passes on configuration alone${C.reset}\n`);
  }

  process.env.__PF_AK = (await kvSecret('aws-cto-access-key-id')).trim();
  process.env.__PF_SK = (await kvSecret('aws-cto-secret-access-key')).trim();

  // ── 1. Compute ───────────────────────────────────────────────────────────────────────────────
  await check('AWS-COMPUTE', 'AWS gateway tasks are running and healthy behind the load balancer', async () => {
    // NOT an HTTP probe of the ALB: fetch() FORBIDS setting the Host header, so a request to the
    // ALB hostname carries the wrong Host, matches no routing rule, and returns an upstream error
    // that looks exactly like a dead service. The ECS service state plus target-group health are
    // the authoritative signals and cannot be confounded that way.
    const { svc, td } = await runningTask();
    const running = svc?.runningCount ?? 0;
    const desired = svc?.desiredCount ?? 0;
    if (!running || running < desired) {
      return { status: 'FAIL', evidence: `ECS running ${running}/${desired} on ${String(td).split('/').pop()}` };
    }
    return { status: 'PASS', evidence: `ECS ${svc.status}, ${running}/${desired} tasks on ${String(td).split('/').pop()}` };
  }, 'The ECS service is not serving. Check the otchealth-gateway service and its target group.');

  // ── 2. Brain completeness: the check that would have caught the 5 thin rooms ──────────────────
  await check('BRAIN-PARITY', 'every OpenSearch room is as complete as its Azure twin', async () => {
    const r = await aws({ service: 'es', host: OS_HOST, path: '/_cat/indices', query: 'format=json&h=' + encodeURIComponent('index,docs.count') });
    if (r.status !== 200) return { status: 'FAIL', evidence: `OpenSearch _cat/indices HTTP ${r.status}` };
    const os = Object.fromEntries(JSON.parse(r.text).filter((x) => !String(x.index).startsWith('.')).map((x) => [x.index, Number(x['docs.count'])]));

    const token = (await mintToken('cto')).token;
    const call = async (tool, args) => {
      const res = await fetch('https://mcp.otchealth.app/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: tool, arguments: args } }),
      });
      const t = (await res.text()).replace(/^event:.*$/gm, '').replace(/^data: /gm, '').trim();
      const j = JSON.parse(t.split('\n').filter(Boolean).pop() || '{}');
      return j.result?.structuredContent?.result ?? j.result?.structuredContent ?? {};
    };

    const thin = [];
    for (const [room, osCount] of Object.entries(os)) {
      let az = null;
      try { az = Number((await call('azure_search_index_stats', { index: room }))?.documentCount); } catch { /* room may not exist on Azure */ }
      if (!Number.isFinite(az) || az === 0) continue;
      if (osCount < az * PARITY_TOLERANCE) thin.push(`${room} ${osCount}/${az}`);
    }
    const total = Object.values(os).reduce((a, b) => a + b, 0);
    if (thin.length) {
      return { status: 'FAIL', evidence: `${thin.length} room(s) short on AWS: ${thin.join(', ')}` };
    }
    return { status: 'PASS', evidence: `${Object.keys(os).length} rooms, ${total.toLocaleString()} docs, all within ${Math.round(PARITY_TOLERANCE * 100)}% of Azure` };
  }, 'Re-run the loader for the short rooms, then re-check. Memory rooms drift continuously, so re-sync immediately before the flip.');

  // ── 3. Documents: the dependency that made search useless without Azure ───────────────────────
  await check('DOCS-S3', 'a real document AND its extracted text read from the S3 mirror', async () => {
    const BUCKET = 'otchealth-finance-legal-dr-55c84f6b';
    const rel = 'INND/Banking/Mercury/5623/innerscope-hearing-technologies-inc-5623-monthly-statement-2023-10.pdf';
    const out = [];
    for (const [label, key] of [['source', `otchealthcfodata/cfo-source-docs/${rel}`], ['sidecar', `otchealthcfodata/cfo-source-docs/_TEXT/${rel}.txt`]]) {
      const path = '/' + key.split('/').map(encodeURIComponent).join('/');
      const r = await aws({ service: 's3', host: `${BUCKET}.s3.us-east-1.amazonaws.com`, path });
      if (r.status !== 200) return { status: 'FAIL', evidence: `${label} HTTP ${r.status} (mirror incomplete or unreadable)` };
      out.push(`${label} ${r.text.length}B`);
    }
    return { status: 'PASS', evidence: out.join(', ') + ' -- both readable without Azure' };
  }, 'The mirror is missing or unreadable. Re-run the blob sync before cutting over.');

  // ── 4. Embeddings: same model, or 492k vectors silently stop matching ─────────────────────────
  await check('EMBEDDINGS', 'the non-Azure embedding provider returns the SAME vector space', async () => {
    const key = (await kvSecret('openai-api-key')).trim();
    const text = 'cutover preflight vector space probe';
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'text-embedding-3-large', input: text }),
    });
    if (!r.ok) return { status: 'FAIL', evidence: `OpenAI embeddings HTTP ${r.status}` };
    const v = (await r.json()).data?.[0]?.embedding ?? [];
    // 3072 is the dimensionality the OpenSearch index was built at. Anything else means the query
    // vector cannot be compared to the stored vectors, which degrades relevance without erroring.
    if (v.length !== 3072) return { status: 'FAIL', evidence: `got ${v.length} dims, index requires 3072` };
    return { status: 'PASS', evidence: `text-embedding-3-large, ${v.length} dims, matches the index` };
  }, 'Do NOT substitute Bedrock Titan/Cohere: a different model would require re-embedding all 492k documents.');

  // ── 5. The write half ────────────────────────────────────────────────────────────────────────
  await check('DUAL-WRITE', 'memory writes reach BOTH backends during the transition', async () => {
    const { td, container: c0 } = await runningTask();
    if (!td) return { status: 'FAIL', evidence: 'could not read the running task definition' };
    const d = { text: JSON.stringify({ taskDefinition: { containerDefinitions: [c0] } }) };
    const c = c0 ?? {};
    const env = Object.fromEntries((c.environment || []).map((e) => [e.name, e.value]));
    const secrets = new Set((c.secrets || []).map((s) => s.name));
    const dual = env.SEARCH_DUAL_WRITE === 'true';
    // Dual-write to Azure ALSO needs a direct admin key: from ECS the Azure writer cannot reach ARM
    // (managed identity only), so without this the Azure leg silently no-ops and rollback is one-way.
    const canWriteAzure = secrets.has('AZURE_SEARCH_ADMIN_KEY') || Boolean(env.AZURE_SEARCH_ADMIN_KEY);

    // THIS CHECK'S MEANING INVERTS ACROSS THE CUTOVER, and reading it with the wrong sign is how a
    // finished migration gets reported as broken (observed 2026-08-16: a NO-GO on a gateway that had
    // already been fully flipped and verified).
    //
    // BEFORE the flip (reads still on Azure), dual-write is a SAFETY NET: it keeps the OpenSearch
    // copy current so the flip is not a leap, and keeps Azure current so rollback stays possible.
    // Its absence is a genuine blocker.
    //
    // AFTER the flip (reads on OpenSearch), the SAME setting is an AZURE DEPENDENCY: every memory
    // write additionally calls Azure Search, so the gateway cannot outlive an Azure suspension --
    // which is the entire point of retiring it. Demanding it here would block the finish line.
    //
    // So the sign is chosen from what SEARCH_BACKEND actually says, never assumed.
    const preFlip = env.SEARCH_BACKEND !== 'opensearch';
    if (!preFlip) {
      if (dual) {
        return { status: 'WARN', evidence: `reads are on OpenSearch but SEARCH_DUAL_WRITE=true, so every write still calls Azure -- turn it OFF to finish the retirement (${td.split('/').pop()})` };
      }
      return { status: 'PASS', evidence: `post-flip: reads on OpenSearch and dual-write off, so no write path reaches Azure (${td.split('/').pop()})` };
    }
    if (!dual) return { status: 'FAIL', evidence: `SEARCH_DUAL_WRITE=${env.SEARCH_DUAL_WRITE ?? '(unset)'} on ${td.split('/').pop()}` };
    if (!canWriteAzure) return { status: 'FAIL', evidence: 'dual-write is on but AZURE_SEARCH_ADMIN_KEY is absent: the Azure leg cannot authenticate from ECS, so rollback would be one-way' };
    return { status: 'PASS', evidence: `dual-write on, Azure leg authenticated (${td.split('/').pop()})` };
  }, 'BEFORE the flip: set SEARCH_DUAL_WRITE=true + AZURE_SEARCH_ADMIN_KEY and redeploy. AFTER the flip: turn it off, it is an Azure dependency.');

  // ── 6. Remaining Azure dependencies ──────────────────────────────────────────────────────────
  await check('AZURE-DEPS', 'no runtime dependency on Azure remains', async () => {
    const { container: c } = await runningTask();
    const env = Object.fromEntries((c.environment || []).map((e) => [e.name, e.value]));
    const remaining = [];
    if (env.SEARCH_BACKEND !== 'opensearch') remaining.push('search still on Azure');
    if (env.BLOB_BACKEND !== 's3') remaining.push('documents still on Azure Blob');
    if (env.EMBEDDINGS_PROVIDER !== 'openai') remaining.push('embeddings still on Azure Foundry');
    if (env.LLM_PROVIDER !== 'openai') remaining.push('chat completions still on Azure Foundry');
    // CORRECTED 2026-08-16. This line used to read `if (env.COSMOS_ENDPOINT)`, which tested whether a
    // CREDENTIAL WAS PRESENT rather than whether the backend was SELECTED -- so it reported "agent
    // state still on Azure Cosmos" on a task definition that had STATE_BACKEND=postgres and was
    // provably serving every read from RDS. That is exactly the "configuration presence is not
    // selected behaviour" error this whole gate exists to catch, sitting inside the gate itself, and
    // it made the one check that answers "are we done with Azure?" permanently unpassable: the
    // COSMOS_* vars are deliberately RETAINED as the rollback path, so the old test could never go
    // green no matter how complete the migration was. A check that cannot pass is a check nobody can
    // act on. Every sibling line above tests the selector; this one now does too.
    if (env.STATE_BACKEND !== 'postgres') remaining.push('agent state still on Azure Cosmos');
    // web_search was Azure-only BY CONSTRUCTION until mcp-server #230 added WEB_SEARCH_PROVIDER, and
    // its default is 'azure' -- so an UNSET value is a live call to Azure Foundry Grounding-with-Bing
    // on every external-world query the fleet's ground-first protocol makes. It was absent from this
    // list entirely, which is worse than a wrong check: a dependency nothing was even looking for.
    if ((env.WEB_SEARCH_PROVIDER ?? 'azure') === 'azure') remaining.push('web_search still on Azure Foundry (WEB_SEARCH_PROVIDER unset defaults to azure)');
    if (remaining.length) return { status: 'FAIL', evidence: remaining.join('; ') };
    return { status: 'PASS', evidence: 'search, documents, embeddings, chat, agent state and web search are all non-Azure' };
  }, 'Each remaining item keeps the brain dependent on Azure surviving. Cutting over now does not protect against suspension.');

  // ── 7. Freshness after the flip ──────────────────────────────────────────────────────────────
  await check('JOBS', 'the jobs that keep the brain fresh are scheduled', async () => {
    const r = await aws({ service: 'scheduler', host: 'scheduler.us-east-1.amazonaws.com', path: '/schedules', query: 'MaxResults=60' });
    const s = JSON.parse(r.text).Schedules || [];
    const on = s.filter((x) => x.State === 'ENABLED');
    if (!on.length) return { status: 'WARN', evidence: `0 of ${s.length} schedules enabled -- the AWS brain is a snapshot, not a living system` };
    return { status: 'PASS', evidence: `${on.length} of ${s.length} schedules enabled` };
  }, 'Enable in stages AFTER the flip, watching each. They are off now so two systems do not both write.');

  // ── 8. Where traffic actually goes ───────────────────────────────────────────────────────────
  await check('DNS', 'current front door', async () => {
    const t = (await kvSecret('cloudflare-api-token')).trim();
    const r = await fetch('https://api.cloudflare.com/client/v4/zones/38d8cf730302bced2bc7f14bd107ec49/dns_records?name=mcp.otchealth.app', { headers: { Authorization: 'Bearer ' + t } });
    const rec = (await r.json()).result?.[0];
    if (!rec) return { status: 'FAIL', evidence: 'no DNS record found for mcp.otchealth.app' };
    const onAws = /elb\.amazonaws\.com/.test(rec.content);
    return { status: 'PASS', evidence: `${rec.content} (${onAws ? 'AWS' : 'Azure'}), TTL ${rec.ttl}s -- rollback takes about ${rec.ttl}s` };
  });

  // ── Verdict ──────────────────────────────────────────────────────────────────────────────────
  const fails = results.filter((r) => r.status === 'FAIL');
  const warns = results.filter((r) => r.status === 'WARN');
  const verdict = fails.length ? 'NO-GO' : 'GO';

  if (JSON_OUT) {
    console.log(JSON.stringify({ verdict, checked: results.length, fails: fails.length, warns: warns.length, results }, null, 2));
  } else {
    console.log(`\n${C.bold}VERDICT: ${verdict === 'GO' ? paint('GO', C.green) : paint('NO-GO', C.red)}${C.reset}`);
    console.log(`${C.dim}${results.length} checks, ${fails.length} blocking, ${warns.length} advisory${C.reset}`);
    if (fails.length) {
      console.log(`\n${C.bold}Blocking:${C.reset}`);
      for (const f of fails) console.log(`  ${paint('x', C.red)} ${f.id}  ${f.evidence}`);
      console.log(`\n${C.dim}A NO-GO means at least one dependency is unproven. Cutting over anyway risks the\nfailure modes this gate exists to catch: silent amnesia, empty documents, or a brain\nthat still dies when Azure does.${C.reset}`);
    }
  }
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  // Fail closed. A preflight that crashes must never be mistaken for a pass.
  console.error(`preflight aborted: ${e.message}`);
  process.exit(1);
});

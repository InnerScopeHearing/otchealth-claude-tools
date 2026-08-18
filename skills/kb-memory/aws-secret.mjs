// aws-secret.mjs — AWS SSM Parameter Store access for the fleet secret resolver.
//
// WHY THIS EXISTS
// Every toolkit skill, and 16 of the 22 scheduled Fargate jobs, resolve their credentials through
// kvSecret() in azure-secret.mjs, which reads ONLY from Azure Key Vault. Its "three auth paths"
// (managed identity / SP / az-CLI) are three ways to authenticate TO AZURE, not three stores. So an
// Azure suspension does not merely degrade the brain -- it takes every job's credentials with it,
// and the jobs fail before they can do anything, including report why.
//
// All 444 fleet secrets are already mirrored into SSM under /otchealth/<name>, verified 2026-08-16
// byte-identical to Key Vault across a 10-secret sample (compared by hash; values never printed).
// Nothing read them. This module is the missing read path.
//
// THE DRIFT TRAP (why the write path matters as much as the read path)
// Nothing syncs Key Vault to SSM -- the mirror was a one-time bulk copy. If SSM becomes the primary
// read and a secret later rotates in Key Vault only, SSM keeps serving the OLD value. The read
// SUCCEEDS, so no fallback fires, and the failure surfaces far away as an unexplained auth error.
// That is the same silent-wrong-value shape as the four AWS-cutover defects. The mitigation is in
// azure-secret.mjs's kvSecretSet(), which DUAL-WRITES: a rotation must land in both stores or it is
// reported as a partial failure.
//
// CREDENTIAL BOOTSTRAP (an honest limitation)
// On ECS the task role supplies AWS credentials automatically via the container-credentials
// endpoint, so a job needs nothing from Azure to reach SSM -- which is exactly the case that has to
// survive an Azure outage. On a developer/agent seat with no AWS env credentials, the AWS keys
// themselves currently come FROM Key Vault, so that seat still bootstraps through Azure. That is a
// seat-convenience gap, not a production one, and it is called out rather than hidden.
//
// Dependency-free: hand-rolled SigV4, no aws-sdk.

import crypto from "node:crypto";

const REGION = process.env.AWS_REGION || "us-east-1";
const PREFIX = process.env.AWS_SSM_PREFIX || "/otchealth";

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();

/**
 * Resolve AWS credentials, preferring the ECS task role.
 *
 * Order matters: the task role is checked FIRST because it is the path that works with no Azure
 * involvement at all. Static env keys are the developer-seat fallback.
 */
async function awsCreds() {
  const rel = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  const full = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  if (rel || full) {
    try {
      const url = full || `http://169.254.170.2${rel}`;
      const headers = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN
        ? { Authorization: process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN }
        : {};
      const r = await fetch(url, { headers });
      if (r.ok) {
        const j = await r.json();
        if (j.AccessKeyId && j.SecretAccessKey) {
          return { ak: j.AccessKeyId, sk: j.SecretAccessKey, st: j.Token || null };
        }
      }
    } catch {
      // fall through to env creds
    }
  }
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    // The sandbox proxy injects a PLACEHOLDER key (prefix "prox"); it is not a usable credential and
    // signing with it produces a confusing 403 rather than an obvious "no credentials".
    if (!/^prox/i.test(process.env.AWS_ACCESS_KEY_ID)) {
      return {
        ak: process.env.AWS_ACCESS_KEY_ID,
        sk: process.env.AWS_SECRET_ACCESS_KEY,
        st: process.env.AWS_SESSION_TOKEN || null,
      };
    }
  }
  return null;
}

/** Signed SSM JSON-1.1 call. Returns { status, json } and never throws. */
async function ssmCall(target, body) {
  const creds = await awsCreds();
  if (!creds) return { status: 0, json: null, reason: "no-aws-credentials" };
  const host = `ssm.${REGION}.amazonaws.com`;
  const payload = JSON.stringify(body);
  const amz = new Date().toISOString().replace(/[:-]|\..{3}/g, "");
  const date = amz.slice(0, 8);
  const hh = {
    host,
    "x-amz-date": amz,
    "x-amz-target": `AmazonSSM.${target}`,
    "content-type": "application/x-amz-json-1.1",
    ...(creds.st ? { "x-amz-security-token": creds.st } : {}),
  };
  const keys = Object.keys(hh).sort();
  const canonH = keys.map((k) => `${k}:${String(hh[k]).trim()}\n`).join("");
  const signed = keys.join(";");
  const creq = ["POST", "/", "", canonH, signed, sha256(payload)].join("\n");
  const scope = `${date}/${REGION}/ssm/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", amz, scope, sha256(creq)].join("\n");
  let k = hmac("AWS4" + creds.sk, date);
  k = hmac(k, REGION);
  k = hmac(k, "ssm");
  k = hmac(k, "aws4_request");
  const sig = crypto.createHmac("sha256", k).update(sts).digest("hex");
  try {
    const r = await fetch(`https://${host}/`, {
      method: "POST",
      headers: {
        ...hh,
        Authorization: `AWS4-HMAC-SHA256 Credential=${creds.ak}/${scope}, SignedHeaders=${signed}, Signature=${sig}`,
      },
      body: payload,
    });
    const txt = await r.text();
    let json = null;
    try {
      json = txt ? JSON.parse(txt) : null;
    } catch {
      json = null;
    }
    return { status: r.status, json, reason: r.ok ? null : `http-${r.status}` };
  } catch (e) {
    return { status: 0, json: null, reason: `error-${String((e && e.message) || e)}` };
  }
}

/** True when SSM is reachable at all (credentials resolvable). Cheap, no network. */
export async function ssmAvailable() {
  return (await awsCreds()) !== null;
}

/** Read one secret from SSM Parameter Store. Returns the trimmed value or null. Never throws. */
export async function ssmSecret(name) {
  const res = await ssmCall("GetParameter", { Name: `${PREFIX}/${name}`, WithDecryption: true });
  if (res.status !== 200 || !res.json?.Parameter) return null;
  const v = res.json.Parameter.Value;
  return v == null ? null : String(v).trim() || null;
}

/**
 * Write one secret to SSM Parameter Store as a SecureString.
 *
 * Overwrite:true is required -- a rotation writes an existing name, and without it every rotation
 * would fail with ParameterAlreadyExists while looking like a permissions problem.
 */
export async function ssmSecretSet(name, value) {
  const res = await ssmCall("PutParameter", {
    Name: `${PREFIX}/${name}`,
    Value: String(value),
    Type: "SecureString",
    Overwrite: true,
  });
  if (res.status === 200) return true;
  console.error(`[aws-secret] SSM write failed for "${name}": ${res.reason || res.status}`);
  return false;
}

/** List every mirrored secret with its metadata: `[{ id, created }]`, id WITHOUT the prefix.
 *
 *  A sibling of ssmList() rather than an option on it, because ssmList()'s callers expect a
 *  `string[]` and silently changing that shape is the kind of change that type-checks fine and
 *  breaks a consumer at runtime.
 *
 *  NOTE ON `created`: SSM exposes LastModifiedDate, NOT a creation date -- the API does not return
 *  one on any enumeration verb. The field is named `created` to match what Key Vault's enumeration
 *  returns so the registry's downstream shape is identical across both stores, but for an SSM-sourced
 *  row it means LAST MODIFIED. For a credential registry that is arguably the more useful date (it
 *  is when the secret was last rotated), and calling it out here is better than a reader assuming a
 *  first-written date it is not. Values are NEVER read: DescribeParameters returns metadata only. */
export async function ssmListDetailed() {
  const out = [];
  let token = null;
  let page = 0;
  do {
    // GetParametersByPath, NOT DescribeParameters.
    //
    // These are DIFFERENT IAM ACTIONS, and "can read secrets" does not imply "can list them".
    // otchealthTaskRole (which every Fargate job runs as) holds ssm:GetParameter, ssm:GetParameters
    // and ssm:GetParametersByPath -- and NOT ssm:DescribeParameters. So the Describe form returned
    // AccessDenied inside the job while working fine from an operator seat using the broad aws-cto
    // key: the most misleading possible split, verified locally and dead in production. Observed
    // live 2026-08-16 as daily-digest exiting 3 with "AWS SSM returned nothing" even after the
    // SSM-first fix shipped and the image was rebuilt.
    //
    // GetParametersByPath enumerates the same set with a verb the role actually has, so this needs
    // no new privilege. WithDecryption is FALSE, which matters for more than cost: a SecureString
    // then comes back ENCRYPTED, so listing names never materialises a plaintext secret in the
    // job's memory. Only Name and LastModifiedDate are read; Value is ignored and never logged.
    // MaxResults caps at 10 here (vs DescribeParameters' 50), so ~450 parameters is ~45 pages --
    // which makes the partial-page handling below matter MORE, not less.
    const res = await ssmCall("GetParametersByPath", {
      Path: `${PREFIX}/`,
      MaxResults: 10,
      Recursive: true,
      WithDecryption: false,
      ...(token ? { NextToken: token } : {}),
    });
    // A PARTIAL LIST MUST NEVER BE RETURNED AS A COMPLETE ONE.
    //
    // The obvious `if (res.status !== 200) break;` looks defensive and is the opposite: it converts
    // "I could not finish enumerating" into "here is the complete answer". With ~450 parameters at
    // MaxResults 50 there are ~9 pages, so one transient failure on page 2 would return 50 of 450 --
    // and vault-registry's caller treats any non-empty array as success, so it would publish a
    // credential registry claiming 50 credentials exist. Downstream readers (and the brain that
    // indexes it) would then treat the other 400 as NONEXISTENT. Silently under-reporting a
    // credential inventory is strictly worse than failing to produce one.
    //
    // Throwing instead lets listSecretsSsm() catch and fall back to Key Vault, which is the correct
    // outcome: incomplete means do not publish. A FIRST-page failure (no AWS creds resolvable, the
    // ordinary case on a seat without them) is not an error condition -- it is "this store is not
    // reachable here" -- so it returns empty and lets the caller fall through, preserving the
    // existing contract. Only a genuine mid-pagination truncation throws.
    if (res.status !== 200) {
      if (page === 0) return [];
      throw new Error(`ssmListDetailed: pagination failed on page ${page + 1} after ${out.length} parameters (HTTP ${res.status}) -- refusing to return a partial inventory`);
    }
    page += 1;
    for (const p of res.json?.Parameters || []) {
      out.push({
        id: p.Name.slice(PREFIX.length + 1),
        created: p.LastModifiedDate ? new Date(p.LastModifiedDate * 1000).toISOString().slice(0, 10) : "",
      });
    }
    token = res.json?.NextToken || null;
  } while (token);
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Metadata-only freshness lookup for ONE named SSM parameter: returns its LastModifiedDate as
 *  epoch milliseconds (a real number, full precision -- unlike ssmListDetailed()'s `created` field,
 *  which is truncated to a YYYY-MM-DD string and therefore useless for an hours-resolution age
 *  metric).
 *
 *  ABSENT AND BROKEN ARE DIFFERENT ANSWERS, AND THIS FUNCTION REFUSES TO CONFLATE THEM. Returns
 *  null for one case ONLY -- the parameter genuinely does not exist (SSM's ParameterNotFound) --
 *  and THROWS for every other non-200: throttling, an expired credential, a 5xx, a network error.
 *  The first draft returned null for all of them, which reintroduced, through a different door, the
 *  exact bug the caller exists to fix: a transient SSM failure would be reported as "not found in
 *  SSM", skipped, and counted in a bucket that does NOT fail the run, so a total SSM outage would
 *  produce a green job that emitted zero metrics -- and the monitor would go back to reading "No
 *  Data" exactly as it did when nothing emitted the metric at all. A wrong number is worse than no
 *  number; a wrong SILENCE is worse still, because nothing is left to notice it.
 *
 *  WithDecryption is always false: the caller wants only WHEN this secret was last written, never
 *  its value, and GetParameter's Value field is ignored entirely below -- a SecureString parameter's
 *  plaintext is never materialized by this function, matching the same discipline
 *  ssmListDetailed()'s enumeration already documents (see its comment on WithDecryption). Uses plain
 *  GetParameter (not GetParametersByPath), the same IAM action ssmSecret() already relies on, so no
 *  new permission is required of the Fargate task role. The thrown message carries only the
 *  parameter NAME and the transport status, never a value. */
export async function ssmParamModifiedMs(name) {
  const res = await ssmCall("GetParameter", { Name: `${PREFIX}/${name}`, WithDecryption: false });
  if (res.status === 200 && res.json?.Parameter) {
    const lm = res.json.Parameter.LastModifiedDate;
    return typeof lm === "number" && Number.isFinite(lm) ? Math.round(lm * 1000) : null;
  }
  // SSM signals a genuinely missing parameter as HTTP 400 with __type ...#ParameterNotFound. That
  // is the ONLY status that may answer "absent" rather than "I could not tell you."
  const kind = String(res.json?.__type || res.json?.code || "");
  if (res.status === 400 && /ParameterNotFound/i.test(kind)) return null;
  throw new Error(
    `SSM GetParameter(${PREFIX}/${name}) failed: status=${res.status}` +
      `${kind ? ` type=${kind}` : ""}${res.reason ? ` reason=${res.reason}` : ""}`,
  );
}

/** List every mirrored secret name (without the prefix). Used by the drift check. */
export async function ssmList() {
  const names = [];
  let token = null;
  let page = 0;
  do {
    // GetParametersByPath, for the same IAM reason documented on ssmListDetailed() above: the
    // Fargate task role has ssm:GetParametersByPath but NOT ssm:DescribeParameters, so the Describe
    // form is AccessDenied in every job while succeeding from an operator seat.
    const res = await ssmCall("GetParametersByPath", {
      Path: `${PREFIX}/`,
      MaxResults: 10,
      Recursive: true,
      WithDecryption: false,
      ...(token ? { NextToken: token } : {}),
    });
    // Same partial-list hazard as ssmListDetailed() above -- this function had the original `break`
    // and the detailed variant inherited it by copy. Its caller (skills/kb-memory/secret-drift.mjs)
    // uses the result to decide WHICH secrets to drift-check, so a silently truncated list means the
    // missing ones are never checked and the drift report reads clean. See the full reasoning above.
    if (res.status !== 200) {
      if (page === 0) return [];
      throw new Error(`ssmList: pagination failed on page ${page + 1} after ${names.length} names (HTTP ${res.status}) -- refusing to return a partial list`);
    }
    page += 1;
    for (const p of res.json?.Parameters || []) names.push(p.Name.slice(PREFIX.length + 1));
    token = res.json?.NextToken || null;
  } while (token);
  return names;
}

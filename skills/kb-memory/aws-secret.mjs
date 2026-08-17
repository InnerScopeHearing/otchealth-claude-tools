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
 *  NOTE ON `created`: SSM's DescribeParameters exposes LastModifiedDate, NOT a creation date -- the
 *  API does not return one. The field is named `created` to match what Key Vault's enumeration
 *  returns so the registry's downstream shape is identical across both stores, but for an SSM-sourced
 *  row it means LAST MODIFIED. For a credential registry that is arguably the more useful date (it
 *  is when the secret was last rotated), and calling it out here is better than a reader assuming a
 *  first-written date it is not. Values are NEVER read: DescribeParameters returns metadata only. */
export async function ssmListDetailed() {
  const out = [];
  let token = null;
  do {
    const res = await ssmCall("DescribeParameters", {
      MaxResults: 50,
      ParameterFilters: [{ Key: "Name", Option: "BeginsWith", Values: [`${PREFIX}/`] }],
      ...(token ? { NextToken: token } : {}),
    });
    if (res.status !== 200) break;
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

/** List every mirrored secret name (without the prefix). Used by the drift check. */
export async function ssmList() {
  const names = [];
  let token = null;
  do {
    const res = await ssmCall("DescribeParameters", {
      MaxResults: 50,
      ParameterFilters: [{ Key: "Name", Option: "BeginsWith", Values: [`${PREFIX}/`] }],
      ...(token ? { NextToken: token } : {}),
    });
    if (res.status !== 200) break;
    for (const p of res.json?.Parameters || []) names.push(p.Name.slice(PREFIX.length + 1));
    token = res.json?.NextToken || null;
  } while (token);
  return names;
}

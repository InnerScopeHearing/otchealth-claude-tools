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
 *
 * EXPORTED (2026-08-18) so s3-blob.mjs (the kb-memory ledger's S3 backend) reuses this SAME
 * resolver instead of a fourth reimplementation of "how does this seat get AWS credentials". Every
 * caller of ssmSecret()/ssmSecretSet() already depends on this chain being correct; widening its
 * visibility changes nothing about its behavior.
 */
export async function awsCreds() {
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
  // OTC_-PREFIXED FALLBACK (2026-08-18, the Azure-loss recovery).
  //
  // WHY A SECOND PAIR OF NAMES EXISTS AT ALL. The agent sandbox injects its own placeholder into
  // AWS_ACCESS_KEY_ID (verified live: 14 characters, prefix "prox"), which the guard above correctly
  // refuses. That refusal is right -- signing with a placeholder yields a 403 that reads like a
  // permissions problem rather than "no credentials" -- but it also means an operator CANNOT reliably
  // hand this seat a real AWS credential through the standard variable: whether the operator's value
  // or the proxy's placeholder wins depends on injection order, which is not ours to control and not
  // something to guess about.
  //
  // That became load-bearing on 2026-08-18, when Azure went away permanently and took with it the
  // only path this seat had to AWS: aws-bootstrap.mjs resolves the AWS keys FROM Azure Key Vault, so
  // the fallback died together with the thing it was meant to fall back from. Every agent session was
  // left unable to read the 444-secret SSM store that was sitting there working the whole time.
  //
  // OTC_AWS_* is a name the proxy has no reason to touch, so an operator-set value survives
  // deterministically. Checked AFTER the standard names, so it changes nothing on ECS (task role wins)
  // or on any seat where the ordinary variables already hold a real key -- it can only ADD a path
  // where there was none. The same "prox" guard applies, so a placeholder cannot sneak in through the
  // new door either.
  if (process.env.OTC_AWS_ACCESS_KEY_ID && process.env.OTC_AWS_SECRET_ACCESS_KEY) {
    if (!/^prox/i.test(process.env.OTC_AWS_ACCESS_KEY_ID)) {
      return {
        ak: process.env.OTC_AWS_ACCESS_KEY_ID,
        sk: process.env.OTC_AWS_SECRET_ACCESS_KEY,
        st: process.env.OTC_AWS_SESSION_TOKEN || null,
      };
    }
  }
  return null;
}

/**
 * Cheap, SYNCHRONOUS, no-network presence check mirroring awsCreds()'s exact resolution order and
 * "prox"-placeholder guards, without actually calling it (no ECS metadata round trip). For a
 * DIAGNOSTIC message this matters: a caller building a "here is what's missing" banner must not
 * itself block on a network call to a metadata endpoint that may not exist in this environment.
 *
 * Exported (2026-08-18) so every caller that needs to REPORT credential state (not resolve one) shares
 * ONE implementation of these guards. Before this, mem.mjs's own s3CredsPresent() carried an
 * independent copy of the identical logic (see its own comment: "mirrors aws-secret.mjs's awsCreds()
 * resolution order ... without actually calling it") -- exactly the kind of duplicate reimplementation
 * this file's own header already calls out as a recurring bug class ("a fourth reimplementation of
 * how does this seat get AWS credentials"). mem.mjs now delegates to this function instead of keeping
 * its own copy; keep it that way rather than re-forking the guard logic a fifth time.
 */
export function awsCredsPresent() {
  const ecs = Boolean(process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI);
  const env = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && !/^prox/i.test(process.env.AWS_ACCESS_KEY_ID));
  const otc = Boolean(process.env.OTC_AWS_ACCESS_KEY_ID && process.env.OTC_AWS_SECRET_ACCESS_KEY && !/^prox/i.test(process.env.OTC_AWS_ACCESS_KEY_ID));
  return { ecs, env, otc, any: ecs || env || otc };
}

/** Signed SSM JSON-1.1 call. Returns { status, json } and never throws.
 *
 *  Exported (2026-08-28, for the AWS-native secrets-DR export) so a caller needing an SSM action this
 *  file does not already wrap one-off (GetParameter with WithDecryption for the passphrase-exists
 *  check, PutParameter with Tier/KeyId for a faithful restore) reuses THIS SigV4 implementation
 *  instead of a fifth reimplementation of "how does this seat sign an SSM call" — the exact
 *  duplication class this file's own header (awsCredsPresent()'s comment) already calls out. */
export async function ssmCall(target, body) {
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

/**
 * Read one secret from SSM, reporting WHY when there is no value.
 *
 * WHY THIS EXISTS (2026-09-02). ssmSecret() below collapsed three genuinely different answers into
 * one `null`: "this parameter does not exist" (ParameterNotFound), "you are not allowed to read it"
 * (AccessDeniedException), and "I could not even ask" (no resolvable AWS credentials). A caller --
 * and more importantly a human reading a log -- could not tell a missing secret from a missing IAM
 * grant. That is the same silent-failure shape as the legal-store S3 port, where a 403 read as "the
 * matter does not exist". Absence is a legitimate answer worth staying quiet about; a denial or an
 * unreachable store is an infrastructure fault that must be loud. They cannot share a return value.
 *
 * `outcome` is one of:
 *   found          -- `value` is the trimmed secret
 *   not-found      -- the store answered honestly: no such parameter (a normal, quiet result)
 *   denied         -- the store refused: an IAM grant is missing (never routine)
 *   no-credentials -- this seat could not resolve AWS credentials at all; the store was never asked
 *   error          -- anything else (HTTP/transport); `detail` carries the shape
 *
 * Never throws. ssmSecret() remains the thin value-or-null wrapper so every existing caller is
 * byte-for-byte unaffected.
 */
export async function ssmSecretDetailed(name) {
  const res = await ssmCall("GetParameter", { Name: `${PREFIX}/${name}`, WithDecryption: true });
  if (res.status === 200 && res.json?.Parameter) {
    const v = res.json.Parameter.Value;
    const trimmed = v == null ? null : String(v).trim() || null;
    // An empty/whitespace-only parameter is a real row that resolves to nothing usable. Report it as
    // not-found rather than found-with-null, so a caller can never receive outcome:"found", value:null.
    return trimmed === null
      ? { value: null, outcome: "not-found", detail: "parameter present but empty" }
      : { value: trimmed, outcome: "found", detail: null };
  }
  if (res.reason === "no-aws-credentials") return { value: null, outcome: "no-credentials", detail: res.reason };
  // AWS JSON-1.1 puts the error class in __type, e.g. "com.amazon.coral.service#ParameterNotFound".
  const type = String(res.json?.__type || "");
  if (/ParameterNotFound/i.test(type)) return { value: null, outcome: "not-found", detail: "ParameterNotFound" };
  if (/AccessDenied|UnrecognizedClient|InvalidSignature/i.test(type) || res.status === 403) {
    return { value: null, outcome: "denied", detail: type || `http-${res.status}` };
  }
  return { value: null, outcome: "error", detail: type || res.reason || `http-${res.status}` };
}

/** Read one secret from SSM Parameter Store. Returns the trimmed value or null. Never throws.
 *  Use ssmSecretDetailed() when you need to tell "absent" from "denied" from "could not ask". */
export async function ssmSecret(name) {
  return (await ssmSecretDetailed(name)).value;
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

// ── AWS-native secrets-DR export primitives (2026-08-28) ──────────────────────────────────────────
// These three exports exist ONLY for the disaster-recovery export role (a dedicated GitHub Actions
// OIDC role with ssm:DescribeParameters granted — see skills/fleet-backup/ssm-dr-export.mjs and its
// provisioning doc). The ordinary Fargate task role does NOT have ssm:DescribeParameters (see
// ssmListDetailed()'s own comment above), so nothing else in the toolkit should call
// ssmDescribeParametersAll() and expect it to work — it will legitimately AccessDenied there, by
// design, not by bug.

/** Every parameter's VALUE (decrypted) + declared Type, via GetParametersByPath?WithDecryption=true.
 *  Returns `[{ name, value, type }]`, name WITHOUT the /otchealth prefix. Same partial-list safety as
 *  ssmListDetailed()/ssmList() above: a first-page failure (no creds resolvable) returns [] so a
 *  caller with no AWS access degrades cleanly; a failure mid-pagination THROWS rather than silently
 *  handing back a partial export that could overwrite last night's complete recovery point. */
export async function ssmGetParametersByPathAllWithValues() {
  const out = [];
  let token = null;
  let page = 0;
  do {
    const res = await ssmCall("GetParametersByPath", {
      Path: `${PREFIX}/`,
      MaxResults: 10,
      Recursive: true,
      WithDecryption: true,
      ...(token ? { NextToken: token } : {}),
    });
    if (res.status !== 200) {
      if (page === 0) return [];
      throw new Error(`ssmGetParametersByPathAllWithValues: pagination failed on page ${page + 1} after ${out.length} parameters (HTTP ${res.status}) -- refusing to return a partial export`);
    }
    page += 1;
    for (const p of res.json?.Parameters || []) {
      out.push({ name: p.Name.slice(PREFIX.length + 1), value: p.Value, type: p.Type || "String" });
    }
    token = res.json?.NextToken || null;
  } while (token);
  return out;
}

/** Every parameter's Tier + KMS KeyId (never the value — DescribeParameters does not return one),
 *  via DescribeParameters filtered to this prefix's path. Returns `[{ name, tier, keyId }]`, name
 *  WITHOUT the /otchealth prefix. Needed because GetParametersByPath's response (above) carries Type
 *  but NOT Tier or KeyId — restoring a >4KB parameter (a service-account JSON, a .p8 key) without its
 *  real Tier="Advanced" silently fails the restore PutParameter call, and restoring a
 *  customer-CMK-encrypted parameter under the default AWS-managed key changes which principals can
 *  decrypt it. Same partial-list safety as the sibling functions in this file. */
export async function ssmDescribeParametersAll() {
  const out = [];
  let token = null;
  let page = 0;
  do {
    const res = await ssmCall("DescribeParameters", {
      ParameterFilters: [{ Key: "Path", Option: "Recursive", Values: [PREFIX] }],
      MaxResults: 50,
      ...(token ? { NextToken: token } : {}),
    });
    if (res.status !== 200) {
      if (page === 0) return [];
      throw new Error(`ssmDescribeParametersAll: pagination failed on page ${page + 1} after ${out.length} parameters (HTTP ${res.status}) -- refusing to return partial metadata`);
    }
    page += 1;
    for (const p of res.json?.Parameters || []) {
      out.push({ name: p.Name.slice(PREFIX.length + 1), tier: p.Tier || "Standard", keyId: p.KeyId || null });
    }
    token = res.json?.NextToken || null;
  } while (token);
  return out;
}

/** Write one SecureString parameter back with its ORIGINAL Type/Tier/KeyId (the restore-fidelity
 *  fix: a blanket `Type: SecureString, Tier: Standard` on every restored parameter (a) silently
 *  corrupts any parameter whose real Type was String/StringList (a consumer reading it WITHOUT
 *  WithDecryption then receives ciphertext instead of the plaintext it expects) and (b) fails
 *  outright, with no data loss but a confusing error, for any value over 4KB unless Tier=Advanced is
 *  set explicitly. `meta` is optional (an archive restored from before this field existed has none) —
 *  absent Type/Tier fall back to the safe SecureString/Standard defaults exactly like the original
 *  export always assumed, so an old archive still restores, just without this fidelity improvement.
 *
 *  BACKOFF (2026-08-28 design review finding): a full restore is ~450+ sequential PutParameter calls
 *  in a tight loop, which is exactly the shape that trips SSM's default (low) TPS limit for
 *  PutParameter. A ThrottlingException/TooManyUpdates on this call is retried with jittered
 *  exponential backoff (capped) rather than treated as a hard failure; any OTHER error propagates
 *  immediately (never retry-loop over a real AccessDenied or a malformed name).  */
export async function ssmPutParameterFull(name, value, meta = {}) {
  const type = meta.type === "String" || meta.type === "StringList" ? meta.type : "SecureString";
  const body = { Name: `${PREFIX}/${name}`, Value: String(value), Type: type, Overwrite: true };
  if (meta.tier === "Advanced" || meta.tier === "Intelligent-Tiering") body.Tier = meta.tier;
  // KeyId only applies to SecureString, and only when it names a CUSTOMER key -- passing the
  // AWS-managed alias back is harmless but unnecessary; omit it there so a restore never has to guess
  // whether the account's default alias is still named identically post-recovery.
  if (type === "SecureString" && meta.keyId && meta.keyId !== "alias/aws/ssm") body.KeyId = meta.keyId;

  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await ssmCall("PutParameter", body);
    if (res.status === 200) return { ok: true };
    const errType = res.json?.__type || "";
    const throttled = res.status === 400 && /Throttl|TooManyUpdates/i.test(errType);
    if (!throttled || attempt === MAX_ATTEMPTS) {
      return { ok: false, reason: res.reason || `http-${res.status}`, errType };
    }
    const backoffMs = Math.min(8000, 250 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200);
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  return { ok: false, reason: "unreachable" }; // never hit; satisfies control-flow analysis
}

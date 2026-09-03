// bedrock-client.mjs — minimal, dependency-free AWS Bedrock Runtime Converse API client (2026-08-28),
// the LLM adapter for deep-pass.mjs's port off dead Azure Foundry. Matches the fleet's established
// "built-in fetch + node:crypto, no vendor SDK" convention (opensearch-client.mjs, s3-blob.mjs,
// amazon-sp-api/sp-api.mjs).
//
// WHY BEDROCK, NOT OpenAI-DIRECT (unlike enrich.mjs's 2026-08-19 port): deep-pass.mjs sends full
// document TEXT plus page-image VISION calls for finance-cfo-source-docs and legal-company, both of
// which carry MNPI/attorney-privileged material. Bedrock in the fleet's own AWS account
// (900915535335, the same account the source documents already live in via the S3 storage mirror)
// introduces NO new data boundary; OpenAI-direct would. See otchealth-cto/CLAUDE.md's 2026-08-19
// "OPEN -- Matt's call before the big backfill" entry and FND-20260821-783d for the recorded decision
// this file implements. legal-personal (attorney-privileged, narrower than either) is EXCLUDED from
// ALL LLM enrichment categorically -- enforced in deep-pass.mjs, not here (this file has no room/ring
// awareness by design; it is a bare transport).
//
// SIGV4 ENCODING (read before touching this file): AWS's SigV4 spec requires the canonical request
// for every service EXCEPT S3 to be built from a DOUBLE percent-encoded path; S3 alone signs from a
// single encode. A Bedrock model id (e.g. "us.anthropic.claude-sonnet-4-5-20250929-v1:0") contains
// `.` and `:`, and `:` is exactly the character where single- vs double-encoding produce different
// bytes (`:` -> `%3A` on the wire, `%253A` inside the signed canonical request). Getting this
// backwards signs one string while sending another -- a guaranteed SignatureDoesNotMatch 403 on the
// very first live call. This file reuses opensearch-client.mjs's signer with `service: "bedrock"`
// (its new optional parameter, added alongside this file) rather than hand-rolling a fifth SigV4
// implementation; see that function's own doc comment for the double-encode mechanics.
//
// CREDENTIALS: awsCreds() from kb-memory/aws-secret.mjs (ECS task role first, then
// AWS_ACCESS_KEY_ID/SECRET, then OTC_AWS_ACCESS_KEY_ID/SECRET) -- the SAME resolver s3-blob.mjs uses
// for the storage side of this same port, so a deep-pass run authenticates to S3 and Bedrock through
// one consistent credential chain rather than two. Deliberately NOT the `aws-cto-access-key-id`/
// `-secret-access-key` static Key-Vault-fallback pair enrich.mjs's resolveOpenSearch() uses for
// OpenSearch: those exist for a developer/agent SEAT with no AWS env credentials, not for an ECS job,
// and this file is a job-context adapter first. Bedrock model-invocation permission (`bedrock:
// InvokeModel` on the chosen inference profile/foundation-model ARNs, and Anthropic model access
// being ENABLED in this account -- a separate account-level grant from merely being able to LIST
// models) is NOT verified by this file; that is a live pre-flight check for whoever runs the first
// real backfill (see the design doc's verify pass, REQUIRED FIX #3), not something to fake-check here.
//
// PRICES (updated 2026-09-03): the per-token rates in deep-pass.mjs's RATES table for Haiku 4.5 and
// Sonnet 5 are now MEASURED from this account's own billing (Cost Explorer gross cost divided by
// usage units, credits excluded) -- the `us.` cross-region profiles bill Anthropic's list price plus
// 10% -- not drawn from training-data knowledge or a price page. Model ids are live-verified ACTIVE
// on this account (`aws bedrock list-inference-profiles --region us-east-1`). When a model or profile
// changes, re-measure the same way before trusting a cost estimate or scheduling real spend.

import { awsCreds } from "../kb-memory/aws-secret.mjs";
import { signOpenSearchRequest } from "./opensearch-client.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAX_RETRIES = 6;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;
const DEFAULT_TIMEOUT_MS = 120000;

/** Exponential backoff with jitter, honoring a Retry-After header when Bedrock supplies one (it does
 *  not always). Bounded at `retryMaxMs` so a long string of throttles cannot itself blow a job's soft
 *  time budget one call at a time. `baseMs`/`retryMaxMs` default to the production constants; tests
 *  pass tiny values via converseJson's `_retryBaseMs`/`_retryMaxMs` seam (see its own comment). */
function backoffMs(attempt, retryAfterHeaderValue, baseMs = RETRY_BASE_MS, retryMaxMs = RETRY_MAX_MS) {
  const ra = parseInt(retryAfterHeaderValue || "0", 10);
  if (ra > 0) return ra * 1000 + Math.floor(Math.random() * 1000);
  const base = Math.min(retryMaxMs, baseMs * Math.pow(2, attempt));
  return base + Math.floor(Math.random() * 1000);
}

/** True for the HTTP statuses this client treats as transiently retryable: 429 (ThrottlingException),
 *  500, and 503 (ServiceUnavailable/ModelNotReady). Everything else (401/403/404/400/etc) is a
 *  configuration or request problem retrying will not fix, and is thrown immediately instead of
 *  burning through the retry budget on a call that can never succeed. */
function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 503;
}

async function bedrockFetch({ region, path, bodyStr, timeoutMs }) {
  const creds = await awsCreds();
  if (!creds) {
    // `nonRetryable` (checked in converseJson's retry loop below): missing credentials is a
    // CONFIGURATION problem, not a transient one -- retrying cannot make a credential appear that
    // was not there a moment ago. Without this marker every one of converseJson's default 6 attempts
    // (up to ~62s of real backoff) would be burned on a call that was never going to succeed,
    // exactly the "no attempt cap on a call that can never succeed" waste this file's own header
    // otherwise guards against for non-retryable HTTP statuses -- found live via this file's own
    // test suite, where a deliberately-uncredentialed test case took over 60 real seconds before
    // this fix.
    const err = new Error(
      "bedrock-client: AWS credentials unavailable (checked the ECS task role, " +
      "AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, and OTC_AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY)");
    err.nonRetryable = true;
    throw err;
  }
  const host = `bedrock-runtime.${region}.amazonaws.com`;
  const signed = signOpenSearchRequest({
    method: "POST",
    host,
    path,
    body: bodyStr,
    region,
    accessKeyId: creds.ak,
    secretAccessKey: creds.sk,
    sessionToken: creds.st || undefined,
    contentType: "application/json",
    service: "bedrock",
  });
  // Send the WIRE path the signer returned, never a separately-recomputed one -- see
  // signOpenSearchRequest's own doc comment for why re-deriving this is the exact bug class that has
  // bitten this fleet before.
  const url = `https://${host}${signed.path}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, { method: "POST", headers: signed.headers, body: bodyStr, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One Bedrock Converse call, with a tool forced so the model's answer arrives as an already-parsed
 * JS object (Bedrock parses the tool-use arguments for you; there is no `J()` regex-salvage class of
 * bug possible on this path the way there was on the old Azure chat-completions `response_format:
 * json_object` string). Deliberately tool-forced rather than prefilled: Converse has no
 * `response_format` knob, and an assistant-message prefill (the other common JSON-mode trick) returns
 * HTTP 400 on every Claude 4.6+/Sonnet 5-family model on Bedrock -- forced tool choice is the one
 * strategy that keeps working across a model upgrade.
 *
 * Returns `{ obj, usage: {prompt_tokens, completion_tokens}, stopReason }` on a response that
 * completed successfully. `obj` is `null` (not a throw) when the model answered but produced no
 * usable tool call -- a forced-tool refusal, or `stopReason === "max_tokens"` truncation before the
 * tool call closed. This is a CONTENT failure, categorically different from a THROW, which this
 * function reserves for TRANSPORT failure only (network error, non-retryable HTTP status, or
 * retries exhausted on a retryable one) -- see deep-pass.mjs's two-tier failure taxonomy, which this
 * distinction exists to serve. Never conflate the two: a caller that treats a null `obj` the same as
 * a throw (or vice versa) reintroduces exactly the flood bug this port was built to close.
 *
 * `cachePrefix` (2026-09-03, opt-in, default OFF -- also readable from env `BEDROCK_CACHE_PREFIX=1`
 * when the option itself is omitted; an explicit boolean always wins over the env value; any other
 * non-boolean value THROWS rather than being coerced, so a caller can never believe caching is on
 * while it silently fell back to an unset env flag): when `true`, inserts `{ cachePoint: { type: "default" } }` immediately after the system text block in
 * `system`, so a repeated, byte-identical system prompt (deep-pass.mjs's per-room prompt is static
 * across every document in a run) is served from Bedrock's prompt cache on subsequent calls instead
 * of being re-processed at full price. Live-verified on Sonnet 5: a first call with an identical
 * system+cache-point prefix reported `cacheWriteInputTokens`, a second call reported
 * `cacheReadInputTokens` for the same prefix. Below a model's minimum cacheable prefix (roughly 1,024
 * tokens on Sonnet, roughly 4,096 on Haiku 4.5) Bedrock simply does not cache and does not charge
 * anything extra for the marker -- so this is safe to enable even when a given system prompt happens
 * to fall under that floor. Does NOT change the forced-tool-use JSON-mode strategy above; the cache
 * point is additive content in `system` only.
 */
export async function converseJson({
  modelId, region, system, userContent, toolName, toolSchema, maxTokens = 900, temperature = 0.1, timeoutMs, cachePrefix,
  // Retry-timing overrides. NOT part of the stable public contract -- production callers (deep-pass.mjs)
  // never pass these and get the real MAX_RETRIES/RETRY_BASE_MS/RETRY_MAX_MS policy. They exist so a
  // test can prove "retries exhausted after N attempts" and "backoff escalates" without waiting out a
  // real ~60s worst-case retry window (5 real sleeps at the production backoff schedule) -- see
  // tests/bedrock-client.test.mjs for the one place these are actually passed.
  _maxRetries = MAX_RETRIES, _retryBaseMs = RETRY_BASE_MS, _retryMaxMs = RETRY_MAX_MS,
} = {}) {
  if (!modelId) throw new Error("bedrock-client: converseJson requires modelId");
  if (!toolName || !toolSchema) throw new Error("bedrock-client: converseJson requires toolName + toolSchema (forced tool-use is the only supported JSON-mode strategy)");
  if (cachePrefix !== undefined && typeof cachePrefix !== "boolean") {
    throw new Error(`bedrock-client: cachePrefix must be a boolean or omitted (got ${typeof cachePrefix} ${JSON.stringify(cachePrefix)}) -- a non-boolean value is never coerced, because "1" or "true" would otherwise fall back to the env flag and leave caching OFF while the caller believes it is ON`);
  }
  const reg = region || process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-1";
  const path = `/model/${modelId}/converse`;
  // Explicit true/false always wins over BEDROCK_CACHE_PREFIX; omitting `cachePrefix` entirely falls
  // back to the env flag, so a fleet-wide arm/disarm needs no per-call-site code change. Default OFF
  // (unset param, unset env) -- byte-identical `system` shape to before this option existed.
  const useCachePrefix = typeof cachePrefix === "boolean" ? cachePrefix : /^(1|true)$/i.test(String(process.env.BEDROCK_CACHE_PREFIX || "").trim());
  const systemBlocks = [{ text: system || "" }];
  if (useCachePrefix) systemBlocks.push({ cachePoint: { type: "default" } });
  const body = {
    system: systemBlocks,
    messages: [{ role: "user", content: userContent }],
    inferenceConfig: { maxTokens, temperature },
    toolConfig: {
      tools: [{ toolSpec: { name: toolName, description: `Record the ${toolName} result.`, inputSchema: { json: toolSchema } } }],
      toolChoice: { tool: { name: toolName } },
    },
  };
  const bodyStr = JSON.stringify(body);

  let lastErr = null;
  for (let attempt = 0; attempt < _maxRetries; attempt++) {
    let r;
    try {
      r = await bedrockFetch({ region: reg, path, bodyStr, timeoutMs });
    } catch (e) {
      if (e && e.nonRetryable) throw e; // a config problem (e.g. no AWS credentials) -- retrying cannot fix it
      // Network error or our own AbortController timeout firing -- retry with the same bounded
      // backoff policy as an explicit throttle response, since from the caller's point of view both
      // mean "this attempt did not get an answer", not "this request is malformed".
      lastErr = e;
      if (attempt === _maxRetries - 1) break;
      await sleep(backoffMs(attempt, null, _retryBaseMs, _retryMaxMs));
      continue;
    }
    if (isRetryableStatus(r.status)) {
      lastErr = new Error(`bedrock ${r.status} (${await r.text().catch(() => "").then((t) => t.slice(0, 160))})`);
      if (attempt === _maxRetries - 1) break;
      await sleep(backoffMs(attempt, r.headers.get("retry-after"), _retryBaseMs, _retryMaxMs));
      continue;
    }
    const text = await r.text();
    if (!r.ok) {
      // A non-retryable failure (401/403/404/400/validation) -- throw immediately rather than
      // burning the remaining retry budget on a request that can never succeed unmodified.
      throw new Error(`bedrock converse ${r.status}: ${text.slice(0, 300)}`);
    }
    let j;
    try { j = text ? JSON.parse(text) : {}; } catch { j = {}; }
    const usage = { prompt_tokens: j.usage?.inputTokens || 0, completion_tokens: j.usage?.outputTokens || 0 };
    const stopReason = j.stopReason || "";
    const blocks = j.output?.message?.content || [];
    const toolBlock = blocks.find((b) => b && b.toolUse);
    if (!toolBlock) return { obj: null, usage, stopReason };
    return { obj: toolBlock.toolUse.input ?? null, usage, stopReason };
  }
  throw new Error(`bedrock converse: retries exhausted after ${_maxRetries} attempts: ${lastErr ? String(lastErr.message || lastErr).slice(0, 200) : "unknown error"}`);
}

// Exported for tests only (not used by converseJson's own control flow above -- kept here so a test
// can assert the exact retry classification without duplicating the list).
export const _internal = { isRetryableStatus, backoffMs, MAX_RETRIES };

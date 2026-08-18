// redact.mjs — strip credential material out of an error string before it is PRINTED or PERSISTED.
//
// WHY (2026-08-18): mem.mjs's top-level catch does two things with `e.message`: it prints it to
// stderr, and it writes it into the durable local fallback file as the row's `error` field. The
// console half is transient and, on a Fargate job, lands in CloudWatch. The FALLBACK half is the
// one that actually matters: those rows are replayed into the memory ledger by a recovery pass, and
// a ledger row can be `share: true` -- so a secret that reached an error message would travel from
// a one-off stderr line into durable, cross-lane-visible brain content. That is the leak this
// closes. (CodeQL flags the console line specifically; the persisted path is the bigger exposure.)
//
// The error strings reaching here come from the credential chain itself (aws-secret.mjs -> SSM,
// Key Vault, Postgres state backend), which is precisely the code most likely to have a token, a
// signed URL, or a connection string in scope when it throws.
//
// DESIGN RULE, and the reason this is deliberately NOT an aggressive scrubber: this is a FAIL-LOUD
// error path whose entire job is telling a human what broke. A redactor that eats the diagnosis is
// a worse outcome than the one it prevents. So every rule here targets a shape that is
// unambiguously credential material, and each one keeps the KEY and drops only the VALUE
// (`sig=[REDACTED]`, not `[REDACTED]`), so the message stays readable and the reader can still see
// WHICH kind of secret was present. Broad entropy-style matching is intentionally avoided: it
// false-positives on hashes, ETags, request ids and commit SHAs, all of which are load-bearing
// diagnostic detail in exactly these errors.
const RULES = [
  // AWS access key ids. Fixed, unmistakable prefixes + 16 uppercase alnum; no false-positive risk.
  [/\b((?:AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16})\b/g, "[REDACTED-AWS-KEY-ID]"],
  // SigV4 Authorization headers, and the Credential= scope inside them.
  [/AWS4-HMAC-SHA256\s+Credential=[^\s,]+/gi, "AWS4-HMAC-SHA256 Credential=[REDACTED]"],
  [/\bSignature=[0-9a-f]{64}\b/gi, "Signature=[REDACTED]"],
  // Presigned-URL query params (AWS) and Azure SAS tokens. `sig=` covers Azure's signature; the
  // AWS X-Amz-* set covers a presigned S3/STS URL pasted whole into an error.
  [/([?&])(X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|sig)=[^&\s"']+/gi, "$1$2=[REDACTED]"],
  // Bearer tokens and bare JWTs (three base64url segments). A JWT's shape is specific enough to
  // match safely, and these carry lane identity on this fleet.
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[REDACTED-JWT]"],
  // Credentials embedded in a URL's userinfo -- the shape a Postgres/Redis connection string takes
  // when a driver echoes its DSN into an error. Host and scheme are kept: they are the diagnosis.
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@]+)@/gi, "$1$2:[REDACTED]@"],
  // Explicit key=value secrets, in a query string, a DSN, or prose. Bounded to the obvious names.
  // The optional `"?` after the key name matters: JSON writes `"password": "hunter2"`, so a closing
  // quote sits between the key and its separator, and a rule without it silently misses every
  // JSON-shaped config or request body echoed into an error -- the most likely shape of all.
  [/\b(password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|sas[_-]?token|connection[_-]?string)"?\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&"']+)/gi, "$1=[REDACTED]"],
];

/**
 * Redact credential material from a string. Never throws and never returns a non-string: this runs
 * inside a catch handler that is already the last line of defence, so it must not be able to turn a
 * reportable failure into an unreportable one.
 */
export function redactSecrets(s) {
  try {
    let out = typeof s === "string" ? s : String(s ?? "");
    for (const [re, to] of RULES) out = out.replace(re, to);
    return out;
  } catch {
    // A redaction bug must not cost the operator their error message entirely, but it also must not
    // let raw text through unchecked -- so degrade to naming the failure, not to printing the input.
    return "[kb-memory] error message withheld: redaction failed";
  }
}

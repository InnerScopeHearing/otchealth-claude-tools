// secret-gate.mjs -- fail-closed secret scan. PURE core: callers inject the live value set (layer B).
//
// Layer A: credential SHAPES (known secret prefixes + LABELED values). Gate on labels and known secret
//   prefixes, never on identifier shapes -- the CTO Library lesson (2026-09-01): a gate that matched
//   identifier PREFIXES withheld the most important documents (gateway OAuth client IDs `oc_<lane>_<hex>`
//   are the PUBLIC half). Publishable-by-design values are NOT secrets and must pass: PostHog phc_ project
//   keys, RevenueCat appl_/goog_ SDK keys, Stripe pk_live_/pk_test_, Sentry DSNs, oc_/occ_ client IDs,
//   ASC key/issuer/team ids, AWS account ids, the Amazon seller id.
// Layer B: live secret VALUES (SSM SecureStrings + secret-named env + credentials.env), substring match.
// Layer C: re-scan of stored OUTPUT (`brain-save audit --secrets`) with A + B.
//
// OUTPUT RULE: a hit names only the layer, the pattern name or the SSM parameter NAME, the part
// (raw/body/object) and the line number. It NEVER carries the matched value or surrounding text.
//
// Adjudication round 2 (2026-09-29) found live credentials passing both layers; the fixes are pinned by
// tests/secret-gate.test.mjs ("round 2" tests):
//   * labels: `\b` never matches after `_` (GRAPH_ONEDRIVE_REFRESH_TOKEN=...), bare token/secret/auth
//     token were not labels, and `**`/backtick/`|` between the label and `:` broke the match;
//   * looksLikeReference exempted ANY all-uppercase value (a real base32-style secret) and ANY value
//     containing a parenthesis (Pa55(word)...);
//   * layer B dropped letters-only secrets (RevenueCat keys) and every value over 512 chars (refresh
//     tokens, a PFX certificate), and PUBLIC_NAME_RE treated ebay-cert-id and *-database-url as public;
//   * connection-string-password and lineOf were quadratic on long inputs.
//
// Adjudication round 3 (same day) found more bypasses; the fixes are pinned by tests/round3-secret-gate:
//   * layer B matched exact substrings only: a value split by a newline, `\_`-escaped in Markdown, with a
//     zero-width space inside, percent-encoded in a URL, inside `Authorization: Basic base64(user:secret)`,
//     or a hex value in upper case all passed. Layer B now also scans a NORMALIZED copy (NFKC, invisible
//     characters removed, `\x` escapes reduced, percent-decoded), a whitespace-SQUASHED copy, hex needles
//     case-insensitively, and the decoded Basic / `curl -u` credentials;
//   * layer A missed `*_KEY=` env lines (STRIPE_KEY, MASTER_KEY, DD_APP_KEY), Basic/ApiKey/Token
//     authorization headers, `curl -u user:pass`, `rediss://:pw@`, table cells, "the API token is X",
//     JSON "privateKey", <meta name="api-key">, 8-11 char passwords, and the ElevenLabs / Tavily /
//     Perplexity / Sentry / Netlify / Hugging Face / GitLab / Google OAuth / Notion / Groq / Datadog
//     prefixes, PGP and PuTTY private keys; and PLACEHOLDER was tested against the whole match, so a
//     real password passed when the HOST said "fake". PLACEHOLDER now tests the captured value only;
//   * layer B needles included public identifiers (Twilio VA/MG SIDs, tenant UUIDs, subnet ids), which
//     refused legitimate runbooks with no override.

const PLACEHOLDER = /(CHANGE[_-]?ME|<[^>]{2,60}>|\$\{[^}]*\}|\$\{\{|example|placeholder|REDACTED|xxxx|\*\*\*\*|fake|dummy|\.\.\.|your[_-]?(api[_-]?)?(key|token|secret))/i;
const PUBLISHABLE_VALUE = /^(phc_|appl_|goog_|pk_(live|test)_|occ?_[a-z-]+_[0-9a-f]+$|https:\/\/[0-9a-f]{16,}@[^\s]*sentry)/i;

/** A lowercase word identifier -- an SSM parameter / Key Vault secret / file NAME such as
 *  oauth-lane-cro-secret, asc-api-key-p8 or graph_onedrive_refresh_token: two or more segments, each
 *  letters optionally ending in <= 2 digits. A random secret is never shaped like this (a UUID's
 *  segments start with digits or are all hex, so it is not exempt). */
export function isWordIdentifier(s) {
  return /^[a-z]+\d{0,2}(?:[-_./][a-z]+\d{0,2})+$/.test(String(s || ""));
}

/** A labeled value that is really a REFERENCE (env var name, template, SSM path, code expression). */
export function looksLikeReference(v) {
  const s = String(v || "");
  if (/^(process\.env|import\.meta\.env|env\.|os\.environ|secrets?\.|vars\.|config\.|\$|<|\{\{|%|ssm:|\/otchealth\/|\/flatstick\/|\/plantid\/|\/fourvault\/|arn:|https?:\/\/)/i.test(s)) return true;
  // A secret-store REFERENCE: Container Apps `secretref:<name>`, `op://`, `vault:`/`kv:`/`sm:` names.
  if (/^(secretref|keyvault|kv|vault|sm|gcp-sm|op|awssm|parameter|param):\/{0,2}[\w./-]+$/i.test(s)) return true;
  // A GCP Secret Manager version reference (`MY_SECRET:latest`, `name:3`) or a one-word template `{name}`.
  if (/^[A-Za-z][\w-]*:(latest|\d{1,3})$/.test(s) || /^\{[\w.-]+\}$/.test(s)) return true;
  // A file / file:line reference (`ledger.mjs:120-135`), an env assignment on the next word (`FOO_KEY=`).
  if (/^[\w./-]+\.(mjs|cjs|js|ts|tsx|py|sh|md|json|ya?ml|toml|txt|html|swift|go|rs|env)(:\d+(-\d+)?)?$/i.test(s) || /^[A-Z][A-Z0-9_]*=/.test(s)) return true;
  // `<store>/<name>`: the last path segment is a lowercase word identifier (kv-otc-.../cio-fly-...-token).
  if (s.includes("/") && isWordIdentifier(s.slice(s.lastIndexOf("/") + 1))) return true;
  // An env var NAME, not a value: uppercase with an underscore (OPENAI_API_KEY) or short (HOME). A 13+
  // char all-uppercase string with no underscore is a VALUE (an uppercase/base32 secret).
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(s) && (s.includes("_") || s.length <= 12)) return true;
  // A call expression `fn(...)` / `a.b(...)`, not any value that merely contains a parenthesis.
  if (/^[\w.$]+\(.*\)$/.test(s)) return true;
  if (/^[a-z_$][\w$]*(\.[a-z_$][\w$]*)+$/i.test(s) && !/\d/.test(s)) return true; // dotted identifier
  if (/^(true|false|null|none|undefined|string|number|boolean)$/i.test(s)) return true;
  // A regex literal in code (`SECRET_RE = /(api|secret|token)|.../i;`), not a value.
  if (/^\/.+\/[dgimsuvy]*[;,)]*$/.test(s) && /[|()[\]\\]/.test(s)) return true;
  return false;
}

/** Shannon entropy in bits per character. */
export function entropy(s) {
  const str = String(s || "");
  if (!str.length) return 0;
  const f = new Map();
  for (const c of str) f.set(c, (f.get(c) || 0) + 1);
  let h = 0;
  for (const n of f.values()) { const p = n / str.length; h -= p * Math.log2(p); }
  return h;
}

const CONN_PLACEHOLDER_PW = /^((my|your|the|some|new|old|test|demo|sample|example)[-_]?)?(pass(word)?|pwd|secret)\d{0,4}$|^(changeme|\*+|x+|\$\{?[A-Za-z_]+\}?|<[^>]*>|:?password)$/i;

// Labels whose VALUE is a secret. `(?<![A-Za-z0-9])` rather than `\b`: `\b` never matches between `_`
// and a letter, so SESSION_SECRET=..., GRAPH_ONEDRIVE_REFRESH_TOKEN=... slipped through. Order matters
// (JS alternation is first-match): the compound labels precede bare token/secret.
const SECRET_LABELS = [
  "client[ _-]?secret", "api[ _-]?key", "apikey", "access[ _-]?key", "secret[ _-]?key", "private[ _-]?key", "refresh[ _-]?token",
  "access[ _-]?token", "auth[ _-]?token", "password", "passwd", "token", "secret",
].join("|");
// Decoration allowed on either side of the separator: markdown bold/code (`**Secret key:**`,
// `` `client_secret`: ``), a table pipe, quotes, whitespace. Bounded, so no backtracking blow-up.
const DECOR = "[*`|\"' \\t]{0,12}"; // no newline: `KEY=` must not borrow the NEXT line as its value
// Separators: `:` / `=`, or prose " is " ("The API token is <v>"). Values from 8 chars: a password label
// accepts 8-11 (valueLooksSecret decides).
const LABELED_RE = new RegExp(`(?<![A-Za-z0-9])(${SECRET_LABELS})(?![A-Za-z0-9])(?:${DECOR}[:=]${DECOR}|[ \\t]+is[ \\t]+)([^\\s"'\`,;|]{8,})`, "gi");
// A Markdown TABLE row whose label cell is exactly a secret label: `| Client Secret | <v> |`. The label
// cell must hold nothing else (a bare `|` separator matched regex alternations and table cells such as
// "`n8n-api-key`" in the fleet corpus scan).
// Cells are space-padded (`| x | y |`); a regex alternation (`(a|secret|b)`) is not a table.
const TABLE_CELL_RE = new RegExp(`(?:^[ \\t]*|\\|[ \\t]+)[*_\`]*(${SECRET_LABELS})[*_\`]*[ \\t]+\\|[ \\t]+[*_\`"']*([^\\s|"'\`]{8,})[*_\`"']*[ \\t]*(?=\\|)`, "gim");

/** Shared value test for the labeled and env-assignment rules. */
export function valueLooksSecret(rawValue, { password = false, bare = false } = {}) {
  const raw = String(rawValue || "").replace(/^["'`]+/, "").replace(/["'`;,*|\\]+$/, "");
  // Trailing sentence punctuation / a closing bracket is not part of the value (`(GATEWAY_BEARER_TOKEN)`),
  // but a balanced call (`crypto.randomBytes(32)`) is: test the reference rules on both forms.
  const v = raw.replace(/[)\]}.:?!]+$/, "");
  if (v.length < (password ? 8 : 12)) return false;
  if (PLACEHOLDER.test(v)) return false;
  // A SHORT password (8-11) must look random: never a word identifier, entropy >= 2.5, and a digit, a real
  // symbol (not a word separator), or 3+ capitals after the first character ("hunter22", "Pa$sw0rd",
  // "aKxQzPmWnRt" count; UI words such as "Contrasena", "Passwort?", "Esqueceu-se" from a theme locale file,
  // and doc examples such as "MyPassword" do not).
  if (v.length < 12) {
    if (looksLikeReference(raw) || looksLikeReference(v) || isWordIdentifier(v) || CONN_PLACEHOLDER_PW.test(v) || entropy(v) < 2.5) return false;
    return /\d/.test(v) || /[^\p{L}\p{N}\s._'-]/u.test(v) || ((v.slice(1).match(/\p{Lu}/gu) || []).length >= 3 && /\p{Ll}/u.test(v));
  }
  if (looksLikeReference(raw) || looksLikeReference(v) || PUBLISHABLE_VALUE.test(v)) return false;
  // A lowercase word identifier is a NAME (an SSM parameter, a secret's Key Vault name), not a value.
  // Passwords are the exception: a passphrase can be lowercase words joined by hyphens.
  if (!password && isWordIdentifier(v)) return false;
  const e = entropy(v);
  if (e < 2.5) return false;
  // No digit at all: prose words, CamelCase names, ENV_NAMES. A digit-free SECRET (a RevenueCat key is
  // 32 random mixed-case letters) is long and high-entropy.
  if (!/\d/.test(v) && !(v.length >= 20 && e >= 3.5)) return false;
  // Bare "token"/"secret" labels are the noisiest: demand a clearly random value.
  if (bare && e < 3.0) return false;
  return true;
}

function labeledValueIsSecret(m, text) {
  const label = String(m[1] || "");
  if (!valueLooksSecret(m[2], { password: /pass(word|wd)/i.test(label), bare: /^(token|secret)$/i.test(label) })) return false;
  // Shopify labels an app's PUBLIC client ID "API key" ("client ID / API key: <32 hex>").
  if (/api[ _-]?key/i.test(label) && /client[ _-]?id\s*\/\s*$/i.test(text.slice(Math.max(0, m.index - 24), m.index))) return false;
  return true;
}

// [name, regex, optional validator(match, fullText) -> true when it is a real hit]
export const LAYER_A = Object.freeze([
  ["aws-access-key-id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["aws-secret-access-key-labeled", /aws_secret_access_key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/gi],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{22,}/g],
  ["openai-anthropic-key", /\bsk-(?:proj-|ant-(?:api\d+-)?|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ["private-key-pem", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g],
  ["posthog-personal-key", /\bphx_[A-Za-z0-9]{20,}/g],
  ["stripe-secret-key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["stripe-webhook-secret", /\bwhsec_[A-Za-z0-9]{16,}/g],
  ["shopify-token", /\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}\b/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["sendgrid-key", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g],
  ["twilio-api-key", /\bSK[0-9a-f]{32}\b/g],
  // Round 3 vendor prefixes (each a SECRET by construction: none of these vendors publishes these prefixes).
  ["elevenlabs-key", /\bsk_[0-9a-f]{48}\b/g],
  ["tavily-key", /\btvly-[A-Za-z0-9_-]{20,}/g],
  ["perplexity-key", /\bpplx-[A-Za-z0-9]{32,}/g],
  ["sentry-token", /\bsntry[su]_[A-Za-z0-9_=+/-]{30,}/g],
  ["netlify-token", /\bnfp_[A-Za-z0-9]{30,}/g],
  ["huggingface-token", /\bhf_[A-Za-z0-9]{30,}/g],
  ["gitlab-pat", /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ["google-oauth-access-token", /\bya29\.[A-Za-z0-9_-]{30,}/g],
  ["notion-token", /\bntn_[A-Za-z0-9]{30,}/g],
  ["groq-key", /\bgsk_[A-Za-z0-9]{40,}/g],
  ["datadog-pat", /\bddpat_[A-Za-z0-9_-]{20,}/g],
  ["wsec-secret", /\bwsec_[A-Za-z0-9_-]{20,}/g],
  ["pgp-private-key", /-----BEGIN PGP PRIVATE KEY BLOCK-----/g],
  ["putty-private-key", /\bPuTTY-User-Key-File-\d+:/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["azure-account-key", /AccountKey=[A-Za-z0-9+/=]{20,}/g],
  ["slack-webhook", /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+/g],
  ["bearer-header", /\bAuthorization["']?\s*:\s*["']?Bearer\s+([A-Za-z0-9._~+/=-]{20,})/gi, null, 1],
  // Basic / ApiKey / Token / Digest schemes (round 3). A Basic value must decode to user:password.
  ["authorization-header", /\bAuthorization["']?\s*:\s*["']?(Basic|Api-?Key|Token|Digest)\s+([A-Za-z0-9._~+/=:-]{12,})/gi,
    (m) => (/^basic$/i.test(m[1]) ? basicPasswordLooksReal(m[2]) : valueLooksSecret(m[2], { bare: true })), 2],
  // `curl -u user:password` / `--user user:password` (round 3).
  ["curl-user-password", /\bcurl\b[^\n]{0,400}?\s(?:-u|--user)[ =]+["']?([^\s:"'@]{1,128}):([^\s"']{1,256})/gi,
    (m) => { const pw = m[2].replace(/["']+$/, ""); return pw.length >= 8 && !CONN_PLACEHOLDER_PW.test(pw) && !looksLikeReference(pw) && entropy(pw) >= 2.5; }, 2],
  // Scheme and user are BOUNDED: the unbounded `[a-z0-9+.-]*` backtracked quadratically over any long
  // run of letters/digits/hyphens (a 129k-char kebab list took 3.9s; 400k chars ~78s). The user may be
  // EMPTY (round 3: `rediss://:<password>@host` passed).
  ["connection-string-password", /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/'"`]{0,128}:([^\s@/'"`]{4,256})@[^\s/'"`]+/gi,
    (m) => !CONN_PLACEHOLDER_PW.test(m[1]), 1],
  ["presigned-url", /X-Amz-(?:Signature|Credential)=[A-Za-z0-9%/_.-]{16,}/g],
  ["url-token-param", /[?&](?:token|access_token|sig|signature|key|api_key|apikey)=([A-Za-z0-9%._~+/-]{16,})/gi,
    (m) => !looksLikeReference(m[1]) && entropy(decodeURIComponentSafe(m[1])) >= 3.0, 1],
  ["labeled-secret-value", LABELED_RE, labeledValueIsSecret, 2],
  ["labeled-secret-value", TABLE_CELL_RE, labeledValueIsSecret, 2],
  // <meta name="api-key" content="..."> in either attribute order (round 3). CSRF tokens are per-session.
  ["html-meta-secret", /<meta\b[^>]*?\bname\s*=\s*["']?([\w.:-]*(?:api[-_]?key|token|secret|password|passwd|access[-_]?key|private[-_]?key)[\w.:-]*)["']?[^>]*?\bcontent\s*=\s*["']([^"']{8,})["']/gi,
    (m) => !/csrf|xsrf/i.test(m[1]) && valueLooksSecret(m[2], { password: /pass/i.test(m[1]) }), 2],
  ["html-meta-secret", /<meta\b[^>]*?\bcontent\s*=\s*["']([^"']{8,})["'][^>]*?\bname\s*=\s*["']?([\w.:-]*(?:api[-_]?key|token|secret|password|passwd|access[-_]?key|private[-_]?key)[\w.:-]*)["']?/gi,
    (m) => !/csrf|xsrf/i.test(m[2]) && valueLooksSecret(m[1], { password: /pass/i.test(m[2]) }), 1],
  // A .env / shell assignment whose NAME says secret (SECRET_ENV_NAME_RE, round 3: `*_KEY` names too):
  // FOO_SECRET_KEY=..., SESSION_SECRET=..., *_TOKEN=..., STRIPE_KEY=..., MASTER_KEY=..., DD_APP_KEY=...
  ["env-secret-assignment", /^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]{0,127})[ \t]*=[ \t]*(\S{8,})/gm,
    (m) => SECRET_ENV_NAME_RE.test(m[1]) && valueLooksSecret(m[2], { password: /PASS/.test(m[1]), bare: true }), 2],
]);

/** A Basic credential: base64 of "user:password" whose password is a real value (not a placeholder). */
function basicPasswordLooksReal(b64) {
  let d = "";
  try { d = Buffer.from(String(b64), "base64").toString("utf8"); } catch { return false; }
  const i = d.indexOf(":");
  if (i < 0 || /[\u0000-\u001f\ufffd]/.test(d)) return false;
  const pw = d.slice(i + 1);
  return pw.length >= 4 && !CONN_PLACEHOLDER_PW.test(pw) && !PLACEHOLDER.test(pw) && !looksLikeReference(pw);
}

function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }

/** Offsets of every line start, computed ONCE per text (lineOf used to rescan from 0 per hit: 13,000
 *  PEM headers took 7.8s). */
function lineStarts(text) {
  const offs = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) offs.push(i + 1);
  return offs;
}
function lineAt(offs, index) {
  let lo = 0, hi = offs.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offs[mid] <= index) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

/** Layer A over one text. Returns [{layer:"A", name, line}] -- never the value. One (the first
 *  confirmed) hit per pattern: the refusal only ever needs one, and it bounds validator work. */
export function scanLayerA(text) {
  const t = String(text || "");
  const hits = [];
  let offs = null;
  for (const [name, re, validate, valueGroup = 0] of LAYER_A) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of t.matchAll(g)) {
      // The CAPTURED VALUE is what must not be a placeholder (round 3: `postgres://app:<real>@fakeshop-db`
      // passed because the host contained "fake").
      if (PLACEHOLDER.test(m[valueGroup] ?? m[0])) continue;
      if (validate && !validate(m, t)) continue;
      offs ||= lineStarts(t);
      hits.push({ layer: "A", name, line: lineAt(offs, m.index) });
      break;
    }
  }
  return hits;
}

// ---------------- layer B text views (round 3) ----------------
// Zero-width / joiner / BOM / soft hyphen / bidi controls: invisible in a rendered doc, so a value with one
// inside it LOOKS identical to the secret and must match as the secret.
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g;
const decodePercentRuns = (s) => s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => { try { return decodeURIComponent(m); } catch { return m; } });
/** The normalized view layer B also searches: NFKC, invisible characters removed, `\x` escapes reduced to
 *  `x` (Markdown `\_`, JSON `\/`), percent-encoded runs decoded. Pure. */
export function normalizeForSecrets(text) {
  let s = String(text || "");
  try { s = s.normalize("NFKC"); } catch { /* keep as-is */ }
  s = s.replace(INVISIBLE, "").replace(/\\(.)/g, "$1");
  return decodePercentRuns(s);
}
/** Credentials that are ENCODED in a text (`Authorization: Basic <base64(user:pass)>`) or written as
 *  `curl -u user:pass`, decoded to plain "user:pass" strings. Pure. */
export function decodedCredentials(text) {
  const t = String(text || "");
  const out = [];
  for (const m of t.matchAll(/\bAuthorization["']?\s*:\s*["']?Basic\s+([A-Za-z0-9+/=_-]{8,})/gi)) {
    try { const d = Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); if (d.includes(":")) out.push({ text: d, index: m.index }); } catch { /* not base64 */ }
  }
  for (const m of t.matchAll(/\bcurl\b[^\n]{0,400}?\s(?:-u|--user)[ =]+["']?([^\s"']{3,400})/gi)) out.push({ text: m[1], index: m.index });
  return out;
}

const HEX_RE = /^[0-9a-f]+$/i;
const _needleViews = new WeakMap();
function needleViews(needles) {
  if (!Array.isArray(needles)) return [];
  let v = _needleViews.get(needles);
  if (!v) {
    v = needles.filter((n) => n && n.needle).map(({ name, needle }) => {
      const squashed = needle.replace(/\s+/g, "");
      const hex = HEX_RE.test(needle) && /[a-f]/i.test(needle);
      return { name, needle, squashed, lower: hex ? needle.toLowerCase() : "", lowerSquashed: hex ? squashed.toLowerCase() : "" };
    });
    _needleViews.set(needles, v);
  }
  return v;
}
// Adjudication round 4 (S4): a secret ENCODED before it is pasted (a base64 blob, a url-safe base64 token, a hex
// dump) matched no needle. Layer B now also searches, for every needle, its standard and url-safe base64
// encodings at ALL THREE byte alignments (the needle may start at any offset of a longer base64 stream, so
// the leading/trailing characters that depend on neighbouring bytes are dropped and only the clean middle is
// searched) and its lowercase hex encoding (matched case-insensitively, so upper-case hex is covered).
const MIN_ENCODED_FRAGMENT = 10;
const b64Fragments = (needle) => {
  const bytes = Buffer.from(needle, "utf8");
  const out = [];
  for (const [k, skip] of [[0, 0], [1, 2], [2, 3]]) {
    const enc = Buffer.concat([Buffer.alloc(k, 0x41), bytes]).toString("base64").replace(/=+$/, "");
    const drop = (k + bytes.length) % 3 !== 0 ? 1 : 0;
    const frag = enc.slice(skip, enc.length - drop);
    if (frag.length >= MIN_ENCODED_FRAGMENT) { out.push(frag); out.push(frag.replace(/\+/g, "-").replace(/\//g, "_")); }
  }
  return [...new Set(out)];
};
const _encodedViews = new WeakMap();
/** Per-needle encoded search strings (computed once per needle list, only when a text reaches the encoded pass). */
export function encodedNeedleViews(needles) {
  let v = _encodedViews.get(needles);
  if (!v) {
    v = needleViews(needles).map((n) => ({ name: n.name, b64: b64Fragments(n.needle), hex: Buffer.from(n.needle, "utf8").toString("hex") }));
    _encodedViews.set(needles, v);
  }
  return v;
}

/** Line (1-based) of the k-th non-whitespace character of `s`. */
function lineOfSquashedIndex(s, k) {
  let line = 1, seen = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 10) { line++; continue; }
    if (c === 32 || c === 9 || c === 13 || c === 11 || c === 12 || /\s/.test(s[i])) continue;
    if (seen === k) return line;
    seen++;
  }
  return line;
}

/** Layer B over one text: substring search of every needle in the text AS WRITTEN, in its normalized view,
 *  in its whitespace-squashed view (a value split across lines), case-insensitively for hex needles, and in
 *  decoded Basic / `curl -u` credentials. Returns [{layer:"B", name, line}] -- never the value. */
export function scanLayerB(text, needles) {
  const t = String(text || "");
  const hits = [];
  const views = needleViews(needles);
  if (!views.length) return hits;
  const seen = new Set();
  let offs = null;
  let norm = null, normOffs = null, squashed = null, lowerNorm = null, lowerSquashed = null, creds = null;
  const hit = (name, line) => { hits.push({ layer: "B", name, line }); seen.add(name); };
  for (const n of views) {
    if (seen.has(n.name)) continue;
    let i = t.indexOf(n.needle);
    if (i >= 0) { offs ||= lineStarts(t); hit(n.name, lineAt(offs, i)); continue; }
    norm ??= normalizeForSecrets(t);
    i = norm === t ? -1 : norm.indexOf(n.needle);
    if (i >= 0) { normOffs ||= lineStarts(norm); hit(n.name, lineAt(normOffs, i)); continue; }
    squashed ??= norm.replace(/\s+/g, "");
    i = squashed.indexOf(n.squashed);
    if (i >= 0) { hit(n.name, lineOfSquashedIndex(norm, i)); continue; }
    if (n.lower) {
      lowerNorm ??= norm.toLowerCase();
      i = lowerNorm.indexOf(n.lower);
      if (i >= 0) { normOffs ||= lineStarts(norm); hit(n.name, lineAt(normOffs, i)); continue; }
      lowerSquashed ??= squashed.toLowerCase();
      i = lowerSquashed.indexOf(n.lowerSquashed);
      if (i >= 0) { hit(n.name, lineOfSquashedIndex(norm, i)); continue; }
    }
    creds ??= [...decodedCredentials(t), ...(norm === t ? [] : decodedCredentials(norm))];
    const c = creds.find((x) => x.text.includes(n.needle));
    if (c) { offs ||= lineStarts(t); hit(n.name, lineAt(offs, Math.min(c.index, t.length - 1))); }
  }
  // Encoded pass (round 4, S4): base64 / url-safe base64 (3 alignments) and hex encodings of each needle.
  const enc = encodedNeedleViews(needles);
  if (enc.length) {
    norm ??= normalizeForSecrets(t);
    squashed ??= norm.replace(/\s+/g, "");
    let lowerSq = null;
    for (const e of enc) {
      if (seen.has(e.name)) continue;
      let i = -1;
      for (const frag of e.b64) { i = squashed.indexOf(frag); if (i >= 0) break; }
      if (i < 0 && e.hex.length >= MIN_ENCODED_FRAGMENT) { lowerSq ??= squashed.toLowerCase(); i = lowerSq.indexOf(e.hex); }
      if (i >= 0) hit(e.name, lineOfSquashedIndex(norm, i));
    }
  }
  return hits;
}

/** Scan named parts ({raw, body, object, ...}) with A and B. Deduped by (layer,name,part). */
export function scanParts(parts, needles) {
  const out = [];
  const seen = new Set();
  for (const [part, text] of Object.entries(parts || {})) {
    if (text == null) continue;
    for (const h of [...scanLayerA(text), ...scanLayerB(text, needles)]) {
      const k = `${h.layer}|${h.name}|${part}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ...h, part });
    }
  }
  return out;
}

/** Human-readable refusal lines. Only layer, pattern/parameter NAME, part and line: never a value. */
export function formatSecretHits(hits) {
  return (hits || []).map((h) => h.layer === "B"
    ? `  secret layer B: live value of SSM/env "${h.name}" found in ${h.part} at line ${h.line}`
    : `  secret layer A: ${h.name} shape in ${h.part} at line ${h.line}`);
}

// ---------------- layer B needle construction ----------------

/** Parameter NAMES that hold public identifiers / config, not secrets. `base-url` is ANCHORED: the
 *  unanchored form matched inside "database-url" and exempted every Neon connection string. */
export const PUBLIC_NAME_RE = /(-id$|_id$|key-id|issuer-id|team-id|client-id|app-id|account-id|project-id|(^|[-_])site($|[-_])|(^|[-_])url$|[-_]uri$|endpoint|(^|[-_])host|region|bucket|(^|[-_])base-url$|domain|email|(^|[-_])user(name)?$|(^|[-_])org($|[-_])|workspace|(^|[-_])index($|[-_])|model|deployment|version|public|publishable|dsn)/i;
/** A NAME carrying one of these words is never a public identifier, whatever else it matches: an eBay
 *  "Cert ID" is the client SECRET, and a database URL embeds its password. */
export const NEVER_PUBLIC_NAME_RE = /(cert|secret|password|passwd|token|private|database[-_]url)/i;
/** Parameter NAMES that hold public IDENTIFIERS or config snapshots despite being SecureStrings (round 3:
 *  their values refused legitimate runbooks with no override): the Twilio Verify service SID, the Xero
 *  tenant map (org UUIDs), and the scheduler job-guard backups (job names, subnet and security-group ids).
 *  Explicit, so they win over NEVER_PUBLIC_NAME_RE. */
export const PUBLIC_NAME_EXPLICIT_RE = /(^|[-_/])service-sid$|(^|[-_/])tenant-map$|(^|\/)job-guard\/|(^|\/)schedule-backups\//i;
export function isPublicName(name) {
  const n = String(name || "");
  if (PUBLIC_NAME_EXPLICIT_RE.test(n)) return true;
  return PUBLIC_NAME_RE.test(n) && !NEVER_PUBLIC_NAME_RE.test(n);
}

/** Needle VALUES that are public identifiers whatever parameter holds them (round 3): AWS subnet / security
 *  group / VPC ids, Twilio Verify (VA) and Messaging Service (MG) SIDs, and UUIDs -- except a UUID under a
 *  parameter whose NAME says it is a credential (some vendors issue UUID-shaped API keys). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREDENTIAL_NAME_RE = /(secret|token|password|passwd|api[-_]?key|private|cert|credential|signing|webhook)/i;
export function isPublicIdentifierNeedle(needle, name = "") {
  const v = String(needle || "");
  if (/^(subnet|sg|vpc|rtb|igw|eni|nat|acl)-[0-9a-f]{8,17}$/i.test(v)) return true;
  if (/^(VA|MG)[0-9a-f]{32}$/.test(v)) return true;
  if (UUID_RE.test(v) && !CREDENTIAL_NAME_RE.test(String(name || ""))) return true;
  return false;
}
export const SECRET_ENV_NAME_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|API_KEY|ACCESS_KEY|CREDENTIAL|_KEY$)/i;

function hasLetterAndDigit(s) { return /[A-Za-z]/.test(s) && /\d/.test(s); }

export const NEEDLE_MAX_WHOLE = 512;
export const SHINGLE_LEN = 48;
export const SHINGLE_STRIDE = 24; // any leaked run of >= SHINGLE_LEN + SHINGLE_STRIDE - 1 (71) chars contains a whole shingle

/** A value (or a run inside a multi-line value) worth matching as-is: letter+digit with entropy >= 3.0,
 *  or (letters-only / digits-only secrets such as RevenueCat keys) >= 20 chars with entropy >= 3.5. */
function isNeedleWorthy(s, minLen) {
  if (s.length < minLen || PUBLISHABLE_VALUE.test(s)) return false;
  const e = entropy(s);
  return (e >= 3.0 && hasLetterAndDigit(s)) || (s.length >= 20 && e >= 3.5);
}

/** Sliding SHINGLE_LEN-char windows (stride SHINGLE_STRIDE, plus the tail window) of a long value, so a
 *  PARTIAL leak of a refresh token / certificate / base64 blob still matches. */
function shingles(name, v, out) {
  if (PUBLISHABLE_VALUE.test(v)) return;
  for (let i = 0; ; i += SHINGLE_STRIDE) {
    const start = Math.min(i, v.length - SHINGLE_LEN);
    const sh = v.slice(start, start + SHINGLE_LEN);
    if (entropy(sh) >= 3.5) out.push({ name, needle: sh });
    if (start + SHINGLE_LEN >= v.length) break;
  }
}

/** Turn raw secret values into substring needles.
 *  Single-line: 12..512 chars (10+ for a *password* name) that pass isNeedleWorthy are needles as-is;
 *  a URL with userinfo also contributes its password; over 512 chars -> sliding shingles.
 *  Multi-line / JSON values (service-account JSON, PEM, .p8) contribute every [A-Za-z0-9+/=_.~-]{24,}
 *  run with a letter AND a digit and entropy >= 3.5 (shingled when a run exceeds 512) so a leaked
 *  PARTIAL key matches. */
export function needlesFromValue(name, value) {
  const v = String(value == null ? "" : value).trim();
  if (!v) return [];
  const out = [];
  const multi = v.includes("\n") || /^[{[]/.test(v);
  if (!multi) {
    if (v.length > NEEDLE_MAX_WHOLE) { shingles(name, v, out); return out; }
    const minLen = /pass(word|wd)/i.test(String(name || "")) ? 10 : 12;
    if (isNeedleWorthy(v, minLen)) out.push({ name, needle: v });
    const pw = v.match(/^[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/]{1,128}:([^\s@/]{8,256})@/i);
    if (pw && pw[1] !== v && entropy(pw[1]) >= 3.0 && !CONN_PLACEHOLDER_PW.test(pw[1])) out.push({ name, needle: pw[1] });
    return out;
  }
  // JSON-escaped newlines/tabs (a service-account JSON stores its PEM as "...-----\\nMIIE...") would
  // otherwise glue an "n" onto the front of every key line; split on them like real line breaks.
  const unescaped = v.replace(/\\[nrt]/g, "\n").replace(/\\\//g, "/");
  for (const m of unescaped.matchAll(/[A-Za-z0-9+/=_.~-]{24,}/g)) {
    const run = m[0];
    // Runs inside a JSON/PEM value keep the letter+digit requirement: a multi-line SecureString is often
    // CONFIG (a scheduler backup, the OAuth client table) whose letters-only runs are job and client NAMES,
    // and making those needles refused every doc that mentions a job (backfill dry run, round 2).
    if (run.length > NEEDLE_MAX_WHOLE) shingles(name, run, out);
    else if (entropy(run) >= 3.5 && hasLetterAndDigit(run) && !PUBLISHABLE_VALUE.test(run)) out.push({ name, needle: run });
  }
  return out;
}

/** Build the deduped needle list from [{name, value, type, origin}] entries. SSM entries count only when
 *  type is SecureString and the NAME is not a public-identifier name. Env/credentials.env entries count
 *  only when the NAME looks secret. */
export function buildNeedles(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries || []) {
    if (!e || e.value == null) continue;
    if (e.origin === "ssm") {
      if (e.type !== "SecureString") continue;
      if (isPublicName(e.name)) continue;
    } else if (!SECRET_ENV_NAME_RE.test(e.name)) continue;
    for (const n of needlesFromValue(e.name, e.value)) {
      if (seen.has(n.needle) || isPublicIdentifierNeedle(n.needle, e.name)) continue;
      seen.add(n.needle);
      out.push(n);
    }
  }
  return out;
}

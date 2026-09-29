// provenance.mjs -- identities, keys, and the provenance header every saved document carries. PURE.
//
// Storage layout (see SKILL.md):
//   _KNOWLEDGE/<kind>/<app>/<yyyy-mm-dd>-<slug>-<sha8>.md   searchable doc (header + normalized body)
//   _KNOWLEDGE-META/...                                     raw sources, registry, by-hash, audit (never indexed)
// <sha8> is the first 8 hex of the BODY's sha256 (header excluded), so every stored key is immutable:
// a changed document gets a new key, never an overwrite (the indexer's idempotency is by PATH, so an
// overwrite would leave the old chunks in the room forever).
import crypto from "node:crypto";

export const KNOWLEDGE_PREFIX = "_KNOWLEDGE/";
export const META_PREFIX = "_KNOWLEDGE-META/";
export const ARCHIVE_PREFIX = "_ARCHIVE/";
export const ROOM_INDEX = "commons-company-journal";
export const ROOM_ACCOUNT = "otchealthcommons";
export const ROOM_CONTAINER = "company-journal";
export const TOOL_VERSION = "brain-save 1";

export const KIND3 = Object.freeze({
  research: "RES", design: "DES", spec: "SPC", audit: "AUD", review: "REV", packet: "PKT", build: "BLD",
  deploy: "DEP", receipt: "RCP", runbook: "RUN", artifact: "ART", report: "RPT", decision: "DEC", doc: "DOC",
});
export const KINDS = Object.freeze(Object.keys(KIND3));

export const sha256 = (s) => crypto.createHash("sha256").update(typeof s === "string" ? Buffer.from(s, "utf8") : s).digest("hex");
export const sha1 = (s) => crypto.createHash("sha1").update(typeof s === "string" ? Buffer.from(s, "utf8") : s).digest("hex");

export function isKind(k) { return Object.prototype.hasOwnProperty.call(KIND3, String(k || "")); }
export function isAppSlug(a) { return /^[a-z0-9][a-z0-9-]{1,40}$/.test(String(a || "")); }

/** lowercase ASCII, non-alphanumerics to "-", collapsed, at most 60 chars cut at a word boundary. A title
 *  with letters/numbers but NO ASCII ones (Korean, Japanese, Arabic...) slugs to `u-<sha1[0,10]>`: it used
 *  to collapse to "untitled", so every such document shared one fallback identity. */
export function slugify(title, max = 60) {
  const t = String(title || "");
  let s = t.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!s && /[\p{L}\p{N}]/u.test(t)) return `u-${sha1(t.normalize("NFC").trim()).slice(0, 10)}`;
  if (s.length > max) {
    const cut = s.slice(0, max + 1);
    const i = cut.lastIndexOf("-");
    s = (i > 20 ? cut.slice(0, i) : s.slice(0, max)).replace(/-+$/, "");
  }
  return s || "untitled";
}

/** The body hash that defines a document version (header excluded, so dates never defeat idempotency). */
export function contentSha256(body) { return sha256(String(body || "")); }

/** Normalize a source reference to its IDENTITY: `repo@<sha>[+dirty]:path` -> `repo:path` (branch/sha
 *  dropped so a later commit of the same file is the same document); an http(s) URL without query/hash;
 *  anything else trimmed as-is. Empty -> "". */
export function sourceIdentity(source) {
  const s = String(source || "").trim();
  if (!s) return "";
  const m = s.match(/^([A-Za-z0-9._-]+)@[^:\s]+:(.+)$/);
  if (m) return `${m[1]}:${m[2].replace(/^\.?\//, "")}`;
  if (/^https?:\/\//i.test(s)) return s.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return s;
}

/** Identity precedence: --id > source identity > artifact URL > kind/app/slug. */
export function identityFor({ id, source, artifactUrl, kind, app, slug }) {
  if (id) return `id:${String(id).trim()}`;
  const src = sourceIdentity(source);
  if (src) return src;
  const art = sourceIdentity(artifactUrl);
  if (art) return art;
  return `${kind}/${app}/${slug}`;
}

/** Which rule produced the identity: "id" | "source" | "artifact" | "title" (kind/app/<title slug>). */
export function identityKindFor({ id, source, artifactUrl }) {
  if (id) return "id";
  if (sourceIdentity(source)) return "source";
  if (sourceIdentity(artifactUrl)) return "artifact";
  return "title";
}

/** Is a stored registry `identity` a TITLE identity (kind/app/<slug>)? Source ("repo:path", URLs) and
 *  "id:" identities always carry a ":" or a "."; a title identity never does. */
export function isTitleIdentity(identity) {
  const m = String(identity || "").match(/^([a-z]+)\/[a-z0-9][a-z0-9-]*\/[a-z0-9-]+$/);
  return Boolean(m && isKind(m[1]));
}

export function brainIdFor(kind, identity) {
  const k3 = KIND3[kind] || "DOC";
  return `KN-${k3}-${sha1(String(identity)).slice(0, 10)}`;
}

/** Strict shape of a stored key: `_KNOWLEDGE/<kind>/<app>/<yyyy-mm-dd>-<slug>-<sha8>.md`, every segment from the
 *  slug alphabet, so `..`, `//`, `.`, upper case and extra segments never match (adjudication round 4, N1).
 *  Returns { key, kind, app, date, slug, sha8 } or null. */
export function parseKnowledgeKey(name) {
  const m = String(name == null ? "" : name).match(/^_KNOWLEDGE\/([a-z]+)\/([a-z0-9][a-z0-9-]*)\/(\d{4}-\d{2}-\d{2})-([a-z0-9][a-z0-9-]*)-([0-9a-f]{8})\.md$/);
  return m && isKind(m[1]) ? { key: String(name), kind: m[1], app: m[2], date: m[3], slug: m[4], sha8: m[5] } : null;
}
/** A brain_id: `KN-<KIND3>-<10 hex>`. */
export const isBrainId = (v) => /^KN-[A-Z]{3}-[0-9a-f]{10}$/.test(String(v == null ? "" : v));

export function keyFor({ kind, app, date, slug, contentSha }) {
  return `${KNOWLEDGE_PREFIX}${kind}/${app}/${date}-${slug}-${String(contentSha).slice(0, 8)}.md`;
}

/** Raw-source key for non-.md inputs, stored under the never-indexed meta prefix. */
export function srcKeyFor(key, ext) {
  const stem = key.slice(KNOWLEDGE_PREFIX.length).replace(/\.md$/, "");
  return `${META_PREFIX}src/${stem}${ext}`;
}
export const registryKey = (brainId) => `${META_PREFIX}registry/${brainId}.json`;
export const byHashKey = (sha) => `${META_PREFIX}by-hash/${sha}.json`;
export const archiveKeyFor = (key) => `${ARCHIVE_PREFIX}${key}`;
export const sidecarKeyFor = (key) => `_TEXT/${key}.txt`;
/** The `path` value every chunk of a stored key carries in the room. */
export const roomPathFor = (key) => `${ROOM_ACCOUNT}/${ROOM_CONTAINER}/${key}`;

/** YAML double-quoted scalar: backslash escaped first, then quotes; newlines removed. */
export function yamlQuote(v) {
  return '"' + String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ") + '"';
}

export const HEADER_FIELDS = Object.freeze([
  "brain_id", "version", "title", "kind", "app", "source", "artifact_url", "author_agent", "session", "doc_date",
  "saved_at", "content_sha256", "key_ref", "supersedes", "ring", "ring_warnings", "ring_override", "tags", "saved_by",
]);

/** `key_ref`: a 40-hex token unique to one stored KEY (= its chunks' parent_id). It is the verify id query
 *  (named key_REF, not key_token: a header field labeled "token" would trip the secret gate's own label rule):
 *  content_sha256 is shared by every identity that saves the same body (`--id alpha` and `--id beta`), so
 *  the second one ranked 2 and was deleted as "not searchable" (adjudication round 2). */
export const keyRefFor = (key) => sha1(String(key || ""));

/** One visible line: control characters (a newline in --source injected a "# SYSTEM" heading into the
 *  stored doc) collapse to a space. */
export function oneLine(v) { return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim(); }

/** Build the header: YAML front matter, then the H1 and a one-line visible provenance note, so the
 *  metadata AND a human-readable citation both land in chunk 0. */
export function buildHeader(f) {
  const lines = ["---"];
  for (const k of HEADER_FIELDS) lines.push(`${k}: ${yamlQuote(f[k] == null ? "" : f[k])}`);
  lines.push("---");
  const title = oneLine(f.title);
  lines.push(`# ${title}`, "");
  const from = f.source ? ` from ${oneLine(f.source)}` : f.artifact_url ? ` from ${oneLine(f.artifact_url)}` : "";
  lines.push(`> Company brain doc ${oneLine(f.brain_id)} v${oneLine(f.version)} (${oneLine(f.kind)}, ${oneLine(f.app)}), saved ${oneLine(String(f.saved_at || "").slice(0, 10))} by ${oneLine(f.author_agent) || "unknown"}${from}.`, "");
  return lines.join("\n") + "\n";
}

/** The exact object stored at the key: header + normalized body. */
export function buildObject(header, body) { return header + String(body || ""); }

/** Parse a stored object's header back into fields (for list/audit/retract). */
export function parseHeader(text) {
  const m = String(text || "").match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*"((?:[^"\\]|\\.)*)"\s*$/);
    if (kv) out[kv[1]] = kv[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return out;
}

/** Split a stored object into { header fields, body } (body = everything after the provenance note). */
export function splitObject(text) {
  const fields = parseHeader(text);
  if (!fields) return { fields: null, body: String(text || "") };
  const afterFm = String(text).replace(/^---\n[\s\S]*?\n---\n/, "");
  const i = afterFm.indexOf("\n> Company brain doc ");
  let body = afterFm;
  if (i >= 0) {
    const j = afterFm.indexOf("\n", i + 1);
    body = j >= 0 ? afterFm.slice(j + 1).replace(/^\n/, "") : "";
  }
  return { fields, body };
}

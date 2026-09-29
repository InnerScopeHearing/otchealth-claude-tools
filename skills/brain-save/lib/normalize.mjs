// normalize.mjs -- turn one input file (.md .txt .html .htm .json) into the normalized Markdown body
// brain-save stores, plus the title/date/front-matter signals the pipeline needs. PURE.
import { basename, extname } from "node:path";
import { htmlToMarkdown, neutralizeUnclosedLt } from "./html-to-md.mjs";
import { BrainSaveError, EXIT } from "./errors.mjs";

/** The doc-indexer's MAXTEXT: the nightly indexer persists at most this many chars of a .md object,
 *  so the tool refuses to store more than that (tool and nightly then chunk identical text). */
export const MAX_OBJECT_CHARS = 400000;
export const SUPPORTED_EXTS = Object.freeze([".md", ".markdown", ".txt", ".html", ".htm", ".json"]);

/** BOM, CRLF, control characters (except \n and \t), runs of more than 2 blank lines, trailing space;
 *  always exactly one trailing newline. */
export function cleanText(s) {
  let t = String(s == null ? "" : s);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  t = t.replace(/\r\n?/g, "\n");
  // eslint-disable-next-line no-control-regex
  t = t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  t = t.split("\n").map((ln) => ln.replace(/[ \t]+$/, "")).join("\n");
  t = t.replace(/\n{4,}/g, "\n\n\n");
  t = t.replace(/^\n+/, "").replace(/\s+$/, "");
  return t + "\n";
}

const unquote = (v) => {
  const t = String(v || "").trim();
  if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith("'") && t.endsWith("'") && t.length >= 2)) return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return t;
};
/** Items of a YAML flow list / flow map (`[a, "b c"]`, `{k: v}`): each unquoted scalar (map: its values). */
function flowItems(v) {
  const inner = String(v).trim().replace(/^[[{]/, "").replace(/[\]}]$/, "");
  return inner.split(",").map((x) => unquote(x.includes(":") && String(v).trim().startsWith("{") ? x.slice(x.indexOf(":") + 1) : x)).filter(Boolean);
}
const addDecl = (fm, k, vals) => { const list = vals.filter((x) => x !== ""); if (!list.length) return; fm[k] = fm[k] == null ? (list.length === 1 ? list[0] : list) : [].concat(fm[k], list); };

/** Parse a leading YAML front-matter block. Returns { frontmatter: {k: v}, raw: "<yaml text>" | null, body }.
 *  Ordinary keys: top-level string scalars (quotes stripped); lists and maps are ignored. DECLARATION keys
 *  (ring / classification / confidentiality / phi / mnpi / privileged ...: see DECLARATION_KEYS) are read in
 *  every YAML form (adjudication round 3: `classification: [Attorney-Client Privileged]`, a `- item` block
 *  list, a value on the next indented line, and a declaration nested under another key all passed): flow
 *  lists and maps, block lists, block/next-line scalars, and indented (nested) keys. A declaration key that
 *  appears more than once, or holds a list, maps to an ARRAY of its values; the ring gate judges each. */
export function parseFrontmatter(md) {
  const s = String(md || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = s.match(/^---\n([\s\S]*?)\n---[ \t]*(\n|$)/);
  if (!m) return { frontmatter: {}, raw: null, body: s };
  const fm = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^(\s*)(?:-\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*:(?:\s+(.*)|\s*)$/);
    if (!kv) continue;
    const indent = kv[1].length;
    const key = kv[2].toLowerCase();
    let v = String(kv[3] || "").trim();
    const decl = DECLARATION_KEYS.test(key);
    if (!decl) {
      if (indent > 0 || /^-/.test(line.trim())) continue; // nested ordinary keys are not front matter
      if (!v || v === "|" || v === ">" || v.startsWith("[") || v.startsWith("{")) continue;
      fm[key] = unquote(v);
      continue;
    }
    if (v.startsWith("[") || v.startsWith("{")) { addDecl(fm, key, flowItems(v)); continue; }
    if (v && !/^[|>][-+]?$/.test(v)) { addDecl(fm, key, [unquote(v)]); continue; }
    // Value on the following lines: a `- item` block list, or an indented (block / next-line) scalar.
    const items = [];
    const scalar = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) continue;
      const lead = l.match(/^(\s*)/)[1].length;
      const item = l.match(/^\s*-\s+(.*)$/);
      if (item && lead >= indent && !/^[|>]/.test(v)) { items.push(unquote(item[1])); continue; }
      if (lead > indent) { scalar.push(l.trim()); continue; }
      break;
    }
    // A `- item` list: each item is its own value. A block / next-line scalar: one folded value.
    addDecl(fm, key, [...items, ...(scalar.length ? [unquote(scalar.join(" "))] : [])]);
    i = j - 1;
  }
  return { frontmatter: fm, raw: m[1], body: s.slice(m[0].length) };
}

/** First Markdown H1 ("# Title"), skipping fenced code. */
export function firstH1(md) {
  let inFence = false;
  for (const line of String(md || "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (m) return m[1].replace(/[*_`]/g, "").trim();
  }
  return "";
}

export function humanizeFilename(file) {
  const stem = basename(String(file || ""), extname(String(file || "")));
  return stem.replace(/^\d{2,4}[-_.]/, "").replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Title precedence: --title > front matter title > first H1 > HTML <title> > humanized filename. */
export function resolveTitle({ flag, frontmatter, h1, htmlTitle, file }) {
  const pick = [flag, frontmatter && frontmatter.title, h1, htmlTitle, humanizeFilename(file)]
    .map((v) => String(v || "").replace(/\s+/g, " ").trim()).find(Boolean);
  return (pick || "").slice(0, 200);
}

/** A document must carry at least this many non-whitespace characters of its OWN text (front matter
 *  excluded): an empty / whitespace-only / BOM-only file used to be "saved" on the strength of the
 *  provenance header alone (adjudication round 2). */
export const MIN_TEXT_CHARS = 16;

const MAGIC = [
  [[0x89, 0x50, 0x4e, 0x47], "a PNG image"], [[0xff, 0xd8, 0xff], "a JPEG image"], [[0x47, 0x49, 0x46, 0x38], "a GIF image"],
  [[0x25, 0x50, 0x44, 0x46], "a PDF (export it to text or Markdown first)"], [[0x50, 0x4b, 0x03, 0x04], "a ZIP/Office container (export it to text first)"],
  [[0xff, 0xfe], "UTF-16 text (re-save it as UTF-8)"], [[0xfe, 0xff], "UTF-16 text (re-save it as UTF-8)"],
];

/** Refuse (exit 1) raw bytes that are not a UTF-8 text document: a NUL byte, a binary magic number
 *  (PNG/JPEG/GIF/PDF/ZIP) or a UTF-16 BOM, or text that decodes to more than 1% U+FFFD replacement
 *  characters. Returns the decoded text. A PNG renamed .md used to be embedded as U+FFFD garbage. */
export function decodeTextInput(bytes, file = "input") {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes == null ? "" : bytes);
  for (const [sig, what] of MAGIC) if (b.length >= sig.length && sig.every((x, i) => b[i] === x)) throw new BrainSaveError(EXIT.ERROR, `${file} is ${what}, not a text document; brain-save stores text (.md .txt .html .json)`);
  if (b.includes(0)) throw new BrainSaveError(EXIT.ERROR, `${file} contains NUL bytes: it is binary, not a text document`);
  const text = b.toString("utf8");
  let bad = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0xfffd) bad++;
  if (text.length && bad / text.length > 0.01) throw new BrainSaveError(EXIT.ERROR, `${file} is not valid UTF-8 text (${bad} of ${text.length} characters are undecodable): it is binary or in another encoding`);
  return text;
}

/** Remove inline base64 data URIs (screenshots pasted into Markdown) -- the html path already drops
 *  them; in .md/.txt they embedded as pages of base64 noise. A payload WRAPPED across lines (76-char base64
 *  lines, adjudication round 3: 115 junk chunks) is removed too: each continuation line must be pure base64
 *  (16+ chars, nothing else on the line), so following prose is never eaten. */
export function stripDataUris(s) {
  return String(s || "").replace(/data:[a-z]+\/[a-z0-9.+-]+(?:;[a-z0-9=._-]+)*;base64,[ \t]*(?:\r?\n[ \t]*)?[A-Za-z0-9+/=%_-]*(?:\r?\n[ \t]*(?:[A-Za-z0-9+/=]{16,}(?=[ \t]*(?:\r?\n|\)|"|'|$))|[A-Za-z0-9+/=]{1,15}(?=[ \t]*(?:\)|"|'))))*/gi, "");
}

/** VISIBLE character count (the MIN_TEXT_CHARS measure): whitespace AND format characters (\p{Cf}: zero-width
 *  space/joiners, BOM, soft hyphen, bidi marks) are not text (a file of 40 zero-width spaces passed). */
export function textChars(s) { return String(s || "").replace(/[\s\p{Cf}]+/gu, "").length; }

/** Share of a text's visible characters that sit in base64-looking runs of >= 200 characters, counting a
 *  run that is wrapped across lines (each line nothing but base64) as one run. */
export const BASE64_RUN_MIN = 200;
export const MAX_BASE64_SHARE = 0.3;
export function base64Share(s) {
  const t = String(s || "");
  const total = textChars(t);
  if (!total) return 0;
  let inRuns = 0;
  for (const m of t.matchAll(/[A-Za-z0-9+/=_-]+(?:[ \t]*\r?\n[ \t]*[A-Za-z0-9+/=_-]+)*/g)) {
    const n = m[0].replace(/\s+/g, "").length;
    if (n >= BASE64_RUN_MIN) inRuns += n;
  }
  return inRuns / total;
}

const GENERIC = new Set(["readme", "index", "notes", "note", "untitled", "plan", "design", "draft", "doc", "document", "todo", "scratch", "temp", "tmp", "output", "report", "summary", "final", "new", "test", "handoff", "status", "changelog", "misc"]);

/** A title nobody can find by title is not saved in any useful sense: reject generic titles, and very
 *  short ones that carry no app/kind word. */
export function isGenericTitle(title, { app = "", kind = "" } = {}) {
  // Unicode letters/numbers, not [a-z0-9]: a Korean title ("청력 재활 연구 보고서") used to normalize to ""
  // and be rejected as generic even with an explicit --title (adjudication round 2).
  const norm = String(title || "").toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
  if (!norm) return true;
  if (GENERIC.has(norm)) return true;
  const words = norm.split(" ");
  if (words.length >= 3) return false;
  const appWords = String(app).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const kindWords = [String(kind).toLowerCase()].filter(Boolean);
  const specific = words.some((w) => appWords.includes(w) || kindWords.includes(w) || (!GENERIC.has(w) && /\p{N}/u.test(w)));
  return !specific;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;
export function validDate(s) {
  const m = String(s || "").match(DATE_RE);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== `${m[1]}-${m[2]}-${m[3]}`) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Doc date precedence: --date > front matter date / captured_at > today (UTC). */
export function resolveDate({ flag, frontmatter, now = new Date() }) {
  if (flag) {
    const v = validDate(flag);
    if (!v) throw new BrainSaveError(EXIT.ERROR, `--date must be YYYY-MM-DD (got "${flag}")`);
    return v;
  }
  const fm = frontmatter || {};
  return validDate(fm.date) || validDate(fm.captured_at) || validDate(fm.doc_date) || now.toISOString().slice(0, 10);
}

/** Ring-relevant declarations a document can carry OUTSIDE its visible text (adjudication round 2: both
 *  were ignored because <head> is dropped and JSON keys never reach front matter). Keys are lowercased;
 *  values are strings. The ring gate decides what they mean. */
export const DECLARATION_KEYS = /^(ring|classification|confidentiality|data[_-]?classification|sensitivity|privilege|audience|mnpi|contains[_-]?mnpi|phi|contains[_-]?phi|hipaa|privileged|contains[_-]?privileged|attorney[_-]?client)$/i;
export function htmlDeclarations(html) {
  const out = {};
  for (const m of neutralizeUnclosedLt(String(html || "")).matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const nm = (tag.match(/\b(?:name|property|http-equiv)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i) || []);
    const name = String(nm[2] ?? nm[3] ?? nm[4] ?? "").trim().toLowerCase();
    if (!name || !DECLARATION_KEYS.test(name)) continue;
    const c = tag.match(/\bcontent\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i) || [];
    addDecl(out, name, [String(c[2] ?? c[3] ?? c[4] ?? "").trim()]);
  }
  return out;
}
/** Declarations anywhere in a parsed JSON value: every object at ANY depth (arrays included, the root may
 *  be an array) whose key is a declaration key and whose value is a primitive or an array of primitives
 *  (adjudication round 3: only top-level keys of an object root were read, so `meta.ring`,
 *  `metadata.classification`, `flags.contains_phi` and an array root all passed). A key seen several times
 *  maps to an array of values. */
export function jsonDeclarations(v) {
  const out = {};
  const prim = (x) => typeof x === "string" || typeof x === "boolean" || typeof x === "number";
  let seen = 0;
  // Keys under a RULE context describe rings (a governance charter's `prohibited_actions[].classifier.ring`),
  // they do not declare this document's ring (round 3 corpus scan: three charters). Everything else, at any
  // depth, is a declaration.
  const RULE_CONTEXT = /^(classifiers?|rules?|polic(y|ies)|prohibited[_-]?actions|allowed[_-]?actions|filters?|conditions?|match(es|ers)?|patterns?|examples?|schema|properties|definitions|enum)$/i;
  const walk = (x, depth, ruleCtx) => {
    if (depth > 40 || x == null || typeof x !== "object" || ++seen > 200000) return;
    if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1, ruleCtx); return; }
    for (const [k, val] of Object.entries(x)) {
      if (DECLARATION_KEYS.test(k) && !ruleCtx) {
        if (prim(val)) addDecl(out, k.toLowerCase(), [String(val)]);
        else if (Array.isArray(val) && val.every(prim)) addDecl(out, k.toLowerCase(), val.map(String));
      }
      walk(val, depth + 1, ruleCtx || RULE_CONTEXT.test(k));
    }
  };
  walk(v, 0, false);
  return out;
}

/**
 * Normalize one input. Returns { body, frontmatter, h1, htmlTitle, description, format }.
 * `body` is cleaned Markdown (no brain-save header yet). Throws BrainSaveError(1) on invalid JSON or
 * an unsupported extension.
 */
export function normalizeInput({ ext, text, file = "" }) {
  const e = String(ext || extname(file) || "").toLowerCase();
  const raw = String(text == null ? "" : text);
  if (e === ".md" || e === ".markdown") {
    const { frontmatter, raw: fmRaw, body } = parseFrontmatter(stripDataUris(raw));
    let out = body;
    const own = textChars(body);
    if (fmRaw != null) out = out.replace(/\s+$/, "") + "\n\n## Original front matter\n\n```yaml\n" + fmRaw + "\n```\n";
    const cleaned = cleanText(out);
    return { body: cleaned, frontmatter, h1: firstH1(cleaned), htmlTitle: "", description: "", format: "md", textChars: own };
  }
  if (e === ".txt") {
    const cleaned = cleanText(stripDataUris(raw));
    return { body: cleaned, frontmatter: {}, h1: "", htmlTitle: "", description: "", format: "txt", textChars: textChars(cleaned) };
  }
  if (e === ".html" || e === ".htm") {
    const { markdown, title, description } = htmlToMarkdown(raw);
    // The page <title> is the Artifact's human-facing name: keep it searchable when the body does not
    // already say it (adjudication round 3: a <title> that differed from the H1 was never stored).
    const withTitle = title && !markdown.toLowerCase().includes(title.toLowerCase()) ? `${markdown}\n\nPage title: ${title}\n` : markdown;
    const cleaned = cleanText(withTitle);
    return { body: cleaned, frontmatter: htmlDeclarations(raw), h1: firstH1(cleaned), htmlTitle: title, description, format: "html", textChars: textChars(cleaned) };
  }
  if (e === ".json") {
    let v;
    try { v = JSON.parse(raw.replace(/^\ufeff/, "")); }
    catch (err) { throw new BrainSaveError(EXIT.ERROR, `invalid JSON in ${file || "input"}: ${String(err.message).slice(0, 120)}`); }
    const title = v && typeof v === "object" && !Array.isArray(v) && typeof v.title === "string" ? v.title : "";
    const pretty = JSON.stringify(v, null, 2);
    const cleaned = cleanText("```json\n" + pretty + "\n```\n");
    return { body: cleaned, frontmatter: { ...jsonDeclarations(v), ...(title ? { title } : {}) }, h1: "", htmlTitle: "", description: "", format: "json", textChars: textChars(pretty.replace(/[{}[\]",:]/g, "")), json: v };
  }
  throw new BrainSaveError(EXIT.ERROR, `unsupported file type "${e || "(none)"}" for ${file || "input"} (supported: ${SUPPORTED_EXTS.join(" ")})`);
}

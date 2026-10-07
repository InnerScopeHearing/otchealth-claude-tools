// ring-gate.mjs -- keep privileged / regulated content OUT of the commons room. PURE.
//
// WHY THIS LIVES IN THE TOOL: the commons-company-journal room is readable by EVERY gateway lane,
// including external ChatGPT/Perplexity connectors, and it has no ring wall at read time; the indexer's
// SKIP_PREFIXES is a crawl-time PATH deny, not a content check. The bar for "safe to save" is therefore
// "safe for an external connector to read".
//
// HARD signals (exit 2, never overridable): RING_DECLARED, PATH_DENY, BANNER, PHI_DATA.
// HEURISTIC signals (exit 2 unless --ring-override "<reason>", audited): FINANCE_LEDGER,
//   INND_SECURITIES, INND_IR_SOURCE, INND_EVENT, PERSONAL_LEGAL. The three INND codes are overridable
//   ONLY from the clo, capital or exec SEAT (KB_AGENT / .kb-agent, never the --agent flag alone).
// WARNINGS only (recorded in the header, never block): ring VOCABULARY in prose (MNPI, PHI, privileged,
//   attorney, Reg FD, securities) and a bare CONFIDENTIAL banner. The fleet's own CLAUDE.md files use all
//   of these words to STATE the rules; a vocabulary refusal would block the most useful engineering docs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decodeEntities, stripTagsLinear } from "./html-to-md.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let _denylist = null;
export function loadDenylist() {
  if (!_denylist) _denylist = JSON.parse(readFileSync(join(HERE, "..", "config", "ring-denylist.json"), "utf8"));
  return _denylist;
}

export const ROUTES = Object.freeze({
  finance: "CFO seat only: `node skills/cfo-store/store.mjs put <file> <object>` (the librarian-finance job indexes it into the ring-gated finance room), or the gateway `kb_ingest_drive_file` from an exec-ring lane for a OneDrive drop.",
  legal: "CLO seat: gateway `legal_blob_put` (container `company`, clo lane) into the ring-gated legal-company room. Anything INND-investor-facing also needs counsel and Matt.",
  "legal-personal": "CLO-personal seat only: `legal_blob_put` container `personal` via the clo-personal lane (writes currently need Matt's IAM grant). Never commons, never another lane.",
  phi: "Do not save. PHI stays inside the MedReview BAA environment. Save a PHI-free summary instead.",
  "innd-mnpi": "INND MNPI / investor-facing material: CLO seat + counsel + Matt (Reg FD). Never the commons room.",
  ledger: "Lane-private ledger prefix (_MEMORY/_HANDOFF/_DISPATCH/_JOURNAL/_VAULT): these are ring-scoped by design; use kb-memory (`mem.mjs`) or the owning lane's tooling, never the commons room.",
  restricted: "This document DECLARES a ring, classification or audience the commons room cannot honor (anything other than commons / public / internal / fleet ...). Remove the declaration if the content is genuinely commons-safe, or route it to the owning lane's own store; the commons room is readable by every lane, external connectors included.",
  secret: "Remove the value and reference the SSM parameter NAME (`/otchealth/<name>`), then re-run.",
});

// Declared rings (front matter, HTML <meta>, JSON top-level keys). Adjudication round 2: an ANCHORED
// exact-token match let "classification: Attorney-Client Privileged", "confidentiality: privileged and
// confidential" and "contains_phi: true" through. Values are now matched by CONTAINS (word-bounded so
// "philosophy" is not "phi"), and a PHI/MNPI/privilege FLAG key with any truthy value declares the ring.
const VALUE_KEYS = /^(ring|classification|confidentiality|data[_-]?classification|sensitivity|privilege|audience)$/i;
const FLAG_KEYS = /^(mnpi|contains[_-]?mnpi|phi|contains[_-]?phi|hipaa|privileged|contains[_-]?privileged|attorney[_-]?client)$/i;
const SAFE_DECLARED = /^(commons|public|internal|internal[- ]only|general|false|no|none|n\/?a|0|off)$/i;
// Adjudication round 4 (S3): for the VALUE keys above a deny-regex (RESTRICTED_VALUE) was the whole rule, so
// `ring: exec`, `sensitivity: high` and `audience: cfo only` passed (no restricted WORD in them). A declared
// ring / classification / audience value is now judged by an explicit SAFE ALLOWLIST: anything not on it is
// treated as a restriction the commons room cannot honor, and refused. Flag keys (phi: true ...) keep the
// old truthy rule.
const SAFE_RING_VALUE = /^(commons|public|internal|internal[- ]only|internal[- ]use|general|fleet|all|everyone|team|engineering|developers?|unclassified|low|normal|standard|false|no|none|n\/?a|0|off)$/i;
// `audience` is also an OAuth/JWT field in JSON documents ("audience": "https://api.example"): a URL is not a ring.
const URL_VALUE = /^https?:\/\/\S+$/i;
/** True when ONE declared value (already split) is explicitly safe for the commons room. */
function isSafeDeclaredValue(part, key) {
  const v = String(part).trim().replace(/^[\s"'`\[\(]+|[\s"'`\]\)\.]+$/g, "");
  if (!v) return true;
  if (SAFE_RING_VALUE.test(v)) return true;
  if (/^audience$/i.test(key) && URL_VALUE.test(v)) return true;
  // A NEGATED declaration ("non-PHI", "Non-PHI ring only", "no PHI"): safe unless a restricted word of a
  // DIFFERENT family remains after the negation and its commentary are stripped (see stripNegations).
  if (/^(?:(?:non|no|not|without|zero)[-_ ]+(?:phi|pii|hipaa|mnpi|privileged|legal|finance|financial)|(?:phi|pii|mnpi)[-_ ]+free)(?![a-z])/i.test(v)) return !RESTRICTED_VALUE.test(stripNegations(v));
  return false;
}
const NEGATION_LEAD = /^\s*(?:(?:non|no|not|without|zero)[-_ ]+(?:phi|pii|hipaa|mnpi|privileged|legal|finance|financial)|(?:phi|pii|mnpi)[-_ ]+free)(?![a-z])/i;
/** A declared string value is safe iff it is a negation-led sentence with no OTHER restricted family in it
 *  ("non-PHI (keeps it outside HIPAA; the PHI ring is a hard wall)"), or EVERY comma/semicolon/pipe-separated
 *  part is itself safe. */
function isSafeDeclared(v, key) {
  const s = String(v);
  if (NEGATION_LEAD.test(s)) return !RESTRICTED_VALUE.test(stripNegations(s));
  return s.split(/[,;|]/).every((part) => isSafeDeclaredValue(part, key));
}
const RESTRICTED_VALUE = /(?<![a-z])(privileg|attorney|legal|work[- ]?product|phi(?![a-z])|hipaa|mnpi|material non-?public|financ|cfo(?![a-z])|clo(?![a-z])|restricted|secret(?![a-z]))/i;
// A NEGATED declaration is the opposite of a restricted one: every app.manifest.json declares
// `"ring": "non-phi"` (found by the round-2 corpus scan: 10 manifests would have been refused).
const NEGATED = /(?<![a-z])(non|no|not|without|zero)[-_ ]+(phi|pii|hipaa|mnpi|privileged|legal|finance|financial)(?![a-z])|(?<![a-z])(phi|pii|mnpi)[-_ ]+free(?![a-z])/gi;
// A value that BEGINS with a negated declaration ("non-PHI (keeps it outside HIPAA; the PHI ring is a hard
// wall ...)") is commentary on that negation: words of the SAME family are not a restriction there (round 3
// corpus scan: an app portfolio assessment). Other families still count ("non-PHI; attorney-client
// privileged" is refused).
const NEG_FAMILIES = [
  [/^(phi|pii|hipaa)$/, /(?<![a-z])(phi|pii|hipaa|protected health( information)?)(?![a-z])/gi],
  [/^mnpi$/, /(?<![a-z])(mnpi|material non-?public( information)?)(?![a-z])/gi],
  [/^(privileged|legal)$/, /(?<![a-z])(privileg\w*|legal|attorney)(?![a-z])/gi],
  [/^(finance|financial)$/, /(?<![a-z])(financ\w*)(?![a-z])/gi],
];
function stripNegations(v) {
  const lead = String(v).match(/^\s*(?:(?:non|no|not|without|zero)[-_ ]+(phi|pii|hipaa|mnpi|privileged|legal|finance|financial)|(phi|pii|mnpi)[-_ ]+free)(?![a-z])/i);
  let out = String(v).replace(NEGATED, " ");
  if (lead) {
    const word = String(lead[1] || lead[2]).toLowerCase();
    for (const [fam, words] of NEG_FAMILIES) if (fam.test(word)) out = out.replace(words, " ");
  }
  return out;
}
function ringForDeclared(key, value = "") {
  const s = `${key}:${value}`.toLowerCase();
  if (/personal/.test(s)) return "legal-personal";
  if (/(?<![a-z])(phi|hipaa)(?![a-z])|protected health/.test(s)) return "phi";
  if (/mnpi|non-?public/.test(s)) return "innd-mnpi";
  if (/legal|clo|privileg|attorney|work[- ]?product/.test(s)) return "legal";
  if (/financ|cfo|ledger|books/.test(s)) return "finance";
  return "restricted";
}
/** RING_DECLARED signals from a declarations map ({key: value | value[]}, keys any case). A key may carry
 *  SEVERAL values (a YAML list, a key repeated at different JSON depths, several <meta> tags): each value
 *  is judged on its own, so one restricted value anywhere declares the ring (adjudication round 3: lists,
 *  next-line scalars and nested JSON keys used to be dropped before this point). Pure. */
export function declaredSignals(decl) {
  const out = [];
  for (const [rawKey, rawVal] of Object.entries(decl || {})) {
    const k = String(rawKey).toLowerCase();
    for (const one of Array.isArray(rawVal) ? rawVal : [rawVal]) {
      const v = String(one == null ? "" : one).trim();
      if (!v || SAFE_DECLARED.test(v)) continue;
      const restricted = (VALUE_KEYS.test(k) && !isSafeDeclared(v, k)) || FLAG_KEYS.test(k);
      if (restricted) out.push({ code: "RING_DECLARED", ring: ringForDeclared(k, v), detail: `declared ${k}: ${v.slice(0, 40)}` });
    }
  }
  return out;
}

function segments(p) { return String(p || "").split(/[\\/:]+/).filter(Boolean); }

/** Case- and separator-insensitive form for SUBSTRING matching ("CFO Outgoing" / "cfo_outgoing"). */
const normPath = (s) => String(s || "").toLowerCase().replace(/[-_ ]+/g, "-");
/** Separator-FREE, case-insensitive form of one path segment: "legal-personal", "legal.personal",
 *  "LegalPersonal" and "legal_personal" all become "legalpersonal" (adjudication round 3: only `-_ ` were
 *  folded, so `legalpersonal/`, `LegalPersonal/` and `legal.personal/` passed). A LEADING underscore is
 *  kept: the ledger prefix `_MEMORY` must never match an ordinary `memory/` folder. */
export const normSeg = (s) => { const t = String(s || "").toLowerCase(); return (t.startsWith("_") ? "_" : "") + t.replace(/[-_ .]+/g, ""); };
/** A segment's comparable forms: as-is and with its extension stripped (`legal-personal.md`). */
function segForms(seg) {
  const i = seg.lastIndexOf(".");
  return new Set([normSeg(seg), normSeg(i > 0 ? seg.slice(0, i) : seg)]);
}
/** Rings whose denylisted segments match as a SUBSTRING of a segment (`finance-cfo-source-docs/`,
 *  `my-legal-personal-notes/`); ledger prefixes and repo-like names (medreview) match a whole segment. */
const SUBSTRING_RINGS = new Set(["finance", "legal", "legal-personal"]);

/** The repository a source/URL names, or "": `repo@sha:path`, `repo:path`, a GitHub https URL, or an
 *  ssh remote `git@host:org/repo(.git)` (adjudication round 3: the URL and ssh forms of medreview passed). */
export function parseRepo(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  let m = t.match(/^https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/i);
  if (m) return m[1];
  m = t.match(/^[\w.-]+@[\w-]+(?:\.[\w-]+)+:(?:[\w.-]+\/)*([\w.-]+?)(?:\.git)?\/?$/);
  if (m) return m[1];
  m = t.match(/^([A-Za-z0-9._-]+)@[^:\s]*:/);
  if (m) return m[1];
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) { m = t.match(/^([A-Za-z0-9._-]+):(?![\\/])/); if (m) return m[1]; }
  return "";
}

/** Path/URL/repo/artifact denies from the reviewed denylist. Returns [{code, ring, detail}].
 *  `realPath` is the symlink-resolved local path (a link into a medreview checkout used to pass).
 *  The repo is ALSO parsed out of `source` (`repo@sha:path` or `repo:path`), not only taken from git:
 *  `--source medreview@abc:docs/x.md` used to pass. */
export function pathDenies({ source, localPath, realPath, artifactUrl, sourceRepo }, denylist = loadDenylist()) {
  const out = [];
  const repos = denylist.repos || {};
  const repoDeny = (name, how) => {
    const hit = Object.keys(repos).find((r) => r.toLowerCase() === String(name || "").toLowerCase());
    if (hit) out.push({ code: "PATH_DENY", ring: repos[hit], detail: `${how} "${hit}" is denylisted` });
  };
  if (sourceRepo) repoDeny(sourceRepo, "source repo");
  const where = [source, localPath, realPath, artifactUrl].filter(Boolean).map(String);
  const segDeny = Object.entries(denylist.pathSegments || {}).map(([seg, ring]) => [seg, normSeg(seg), ring]);
  for (const w of where) {
    const repo = parseRepo(w);
    if (repo) repoDeny(repo, "source repo");
    const segs = segments(w.replace(/^[A-Za-z0-9._-]+@[^:]+:/, ""));
    const whole = new Set(segs.map(normSeg));
    const forms = [];
    for (const sg of segs) forms.push(...segForms(sg));
    const stems = new Set(forms);
    for (const [seg, nseg, ring] of segDeny) {
      // Ledger prefixes (`_MEMORY`, `_JOURNAL`...) are DIRECTORY names: whole segment only, no extension
      // stripping (a drizzle `meta/_journal.json` is not the `_JOURNAL/` ledger).
      const hit = nseg.startsWith("_") ? whole.has(nseg)
        : stems.has(nseg) || (SUBSTRING_RINGS.has(ring) && forms.some((f) => f.includes(nseg)));
      if (hit) out.push({ code: "PATH_DENY", ring, detail: `path segment "${seg}"` });
    }
    const nw = normPath(w);
    for (const [sub, ring] of Object.entries(denylist.pathSubstrings || {})) if (nw.includes(normPath(sub))) out.push({ code: "PATH_DENY", ring, detail: `path contains "${sub}"` });
    for (const [id, meta] of Object.entries(denylist.artifactIds || {})) if (w.includes(id)) out.push({ code: "PATH_DENY", ring: meta.ring, detail: `denylisted Artifact ${id} (${meta.title})` });
  }
  const seen = new Set();
  return out.filter((d) => { const k = d.ring + "|" + d.detail; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Closed set of FULL-LINE banners (after stripping markdown decoration). A sentence that merely uses the
// words ("Attorney-client privileged material never goes to commons") is prose, not a banner.
// Adjudication round 2: the separator between banner parts may be a hyphen, EN or EM dash, colon, pipe,
// comma, slash, period or semicolon ("PRIVILEGED & CONFIDENTIAL \u2014 ATTORNEY-CLIENT COMMUNICATION",
// "... / Prepared at the direction of counsel"), and a standalone MNPI line ("MNPI", "MNPI - DO NOT
// DISTRIBUTE", "INND MNPI \u2014 INTERNAL ONLY") is a banner too. Tails stay a CLOSED set, so a heading
// such as "MNPI: what it is and how the fleet handles it" remains prose.
// Adjudication round 3: a separator may be REPEATED ("PRIVILEGED & CONFIDENTIAL // ATTORNEY-CLIENT"); every
// Unicode hyphen/dash (U+2010..U+2015, U+2212) folds to "-" first; "draft", "communication" and "for counsel
// review" are tails; a leading "CONFIDENTIAL -" / "DRAFT -" is accepted; "ATTORNEY-CLIENT COMMUNICATION",
// "PROTECTED HEALTH INFORMATION" and "NOT FOR DISTRIBUTION: MNPI" are banners on their own; and a bare
// PRIVILEGED / PHI line is a banner when it is shouted (all caps) or bold and is NOT a Markdown heading
// (the fleet's own docs have `## PHI` section headings, which are prose).
const SEP = "\\s*[-\u2013\u2014:|,/.;]{0,3}\\s*";
const TAILS = "(attorney[- ]client( (communication|privileged( communication)?))?|attorney work product|do not (forward|distribute|copy|share)|for settlement purposes only|prepared (at the direction of|by|for) counsel|for counsel review|(strictly )?confidential|internal( use)? only|restricted|not for (distribution|release)|draft|communication)";
const LEAD = `((confidential|draft)${SEP})?`;
const MNPI = "(mnpi|material non-?public information)";
const PHI_TAILS = `(do not forward|hipaa[- ]protected|restricted|${TAILS})`;
const banner = (src) => new RegExp(src, "i");
// [regex, ring, maxLen?, notHeading?]
const BANNERS = [
  [banner(`^${LEAD}privileged (and|&) confidential(${SEP}${TAILS})*$`), "legal"],
  [banner(`^${LEAD}attorney[- ]client (privileged|communication)((\\s*(and|&)\\s*confidential)|(${SEP}(communication|privileged|${TAILS})))*$`), "legal"],
  [banner(`^${LEAD}attorney work product(${SEP}(privileged( (and|&) confidential)?|${TAILS}))*$`), "legal"],
  [banner(`^${LEAD}contains (phi|protected health information)(${SEP}${PHI_TAILS})*$`), "phi"],
  [banner(`^${LEAD}protected health information(${SEP}${PHI_TAILS})*$`), "phi", 0, true],
  [banner(`^${LEAD}hipaa[- ]protected( (information|data|document|material))?(${SEP}${PHI_TAILS})*$`), "phi"],
  [banner(`^confidential\\b[^.]{0,60}\\b${MNPI}$`), "innd-mnpi"],
  [banner(`^${LEAD}not for (distribution|release)${SEP}(contains )?${MNPI}(${SEP}${TAILS})*$`), "innd-mnpi"],
  // Standalone MNPI banner (only when the whole line is short: a banner, never a paragraph).
  [banner(`^${LEAD}((innd|innerscope|contains) )?${MNPI}(${SEP}${TAILS})*$`), "innd-mnpi", 60],
];
const BARE_BANNERS = [[/^privileged$/i, "legal"], [/^phi$/i, "phi"]];
/** Fold every Unicode hyphen/dash (U+2010..U+2015, U+2212) to "-", then drop Markdown decoration. */
export function foldDashes(s) { return String(s || "").replace(/[\u2010-\u2015\u2212]/g, "-"); }
function stripDecoration(line) {
  return foldDashes(line).replace(/<!--|--!?>/g, " ").replace(/[#*>_`~]/g, " ").replace(/\s+/g, " ").trim().replace(/[.!:;]+$/, "").trim();
}
const isHeading = (line) => /^\s{0,3}#{1,6}(\s|$)/.test(String(line || ""));
export function bannerSignals(text) {
  const out = [];
  let lineNo = 0;
  for (const line of String(text || "").split("\n")) {
    lineNo++;
    const s = stripDecoration(line);
    if (!s || s.length > 120) continue;
    const heading = isHeading(line);
    let hit = null;
    for (const [re, ring, maxLen, notHeading] of BANNERS) if ((!maxLen || s.length <= maxLen) && !(notHeading && heading) && re.test(s)) { hit = ring; break; }
    if (!hit && !heading) {
      const t = foldDashes(line).trim().replace(/[.!:;]+$/, "");
      const shouted = s === s.toUpperCase() && /[A-Z]/.test(s);
      const bold = /^(\*\*|__)[^*_]+(\*\*|__)$/.test(t);
      if (shouted || bold) for (const [re, ring] of BARE_BANNERS) if (re.test(s)) { hit = ring; break; }
    }
    if (hit) out.push({ code: "BANNER", ring: hit, detail: `privilege/PHI/MNPI banner line ${lineNo}` });
  }
  return out;
}
export function bareConfidentialBanner(text) {
  return String(text || "").split("\n").some((l) => /^(strictly )?confidential( - internal( use)?( only)?)?$/i.test(stripDecoration(l)));
}

// ---------------- PHI / regulated personal data patterns ----------------
function validSsn(d) {
  const s = d.replace(/\D/g, "");
  if (s.length !== 9) return false;
  const area = s.slice(0, 3), group = s.slice(3, 5), serial = s.slice(5);
  if (area === "000" || area === "666" || area[0] === "9") return false;
  if (group === "00" || serial === "0000") return false;
  if (s === "123456789") return false;
  return true;
}
export function luhnValid(num) {
  const d = String(num).replace(/\D/g, "");
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return d.length >= 13 && d.length <= 19 && sum % 10 === 0;
}
function cardIin(d) {
  return /^4/.test(d) || /^5[1-5]/.test(d) || /^2(2[2-9][1-9]|[3-6]\d\d|7[01]\d|720)/.test(d) || /^3[47]/.test(d) || /^6(011|5|4[4-9])/.test(d) || /^35/.test(d) || /^3(0[0-5]|[68])/.test(d);
}
const TEST_PANS = new Set(["4242424242424242", "4000056655665556", "5555555555554444", "2223003122003222", "5200828282828210", "5105105105105100", "378282246310005", "371449635398431", "6011111111111117", "6011000990139424", "3056930009020004", "36227206271667", "3566002020360505", "6200000000000005", "4111111111111111", "4012888888881881", "4000000000000002", "4000000000009995", "4000000000000077", "5454545454545454"]);

export function phiSignals(text) {
  const t = String(text || "");
  const out = [];
  const add = (detail, ring = "phi") => out.push({ code: "PHI_DATA", ring, detail });
  // Labels (adjudication round 3): `SS#`, `Social:` and a table cell (`| SSN | ... |`) count; `\b` never
  // matched after "#", so the label is bounded by look-arounds instead.
  for (const m of t.matchAll(/(?<![A-Za-z0-9])(?:SSN|SS ?#|social security(?: number| no\.?| #)?|social\s*:|soc\.? ?sec\.?(?: no\.?)?)(?![A-Za-z0-9])[^\n\d]{0,20}(\d{3}[- ]?\d{2}[- ]?\d{4})\b/gi)) if (validSsn(m[1])) { add("labeled SSN"); break; }
  const unl = new Set();
  for (const m of t.matchAll(/\b(\d{3})-(\d{2})-(\d{4})\b/g)) if (validSsn(m[0])) unl.add(m[0]);
  if (unl.size >= 2) add(`${unl.size} distinct unlabeled SSN-shaped numbers`);
  // Dates: numeric, ISO, "March 3, 1962" / "March 3rd, 1962", and day-first "3 March 1962" / "3rd of March, 1962".
  const MON = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
  const DATE = `(\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|${MON} \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}|\\d{1,2}(?:st|nd|rd|th)?(?: of)? ${MON},? \\d{4})`;
  // A pipe separates a table label from its value (`| DOB | 03/03/1962 |`).
  const SEPV = "\\s*[:#=|-]?\\s*";
  if (new RegExp(`\\b(?:DOB|D\\.O\\.B\\.|date of birth|birth ?date)\\b${SEPV}${DATE}`, "i").test(t)) add("labeled date of birth");
  // "Born" is a label only with an explicit separator ("Born: 1962-03-03"): prose "born in 1962" is not.
  else if (new RegExp(`\\bborn\\s*[:#=|-]\\s*${DATE}`, "i").test(t)) add("labeled date of birth");
  // An MRN value carries a digit ("| MRN | Medical record number |" in a data dictionary is not one).
  if (new RegExp(`\\b(?:MRN|medical record (?:number|no\\.?|#))\\b${SEPV}(?=[A-Z0-9-]*\\d)[A-Z0-9][A-Z0-9-]{4,}`, "i").test(t)) add("labeled medical record number");
  if (/\b(?:MBI|medicare (?:beneficiary )?(?:id|identifier|number))\b\s*[:#=|-]?\s*[1-9][A-Za-z][A-Za-z0-9]\d-?[A-Za-z][A-Za-z0-9]\d-?[A-Za-z]{2}\d{2}\b/i.test(t)) add("labeled Medicare MBI");
  for (const m of t.matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)) {
    const d = m[0].replace(/\D/g, "");
    if (d.length < 13 || d.length > 19 || TEST_PANS.has(d) || !cardIin(d) || !luhnValid(d)) continue;
    add("Luhn-valid payment card number", "finance");
    break;
  }
  const acct = t.match(/\b(?:bank account(?: number| no\.?| #)?|account (?:number|no\.?|#)|acct\.? ?(?:no\.?|#))\s*[:#=-]?\s*(\d[\d -]{4,24}\d)\b/i);
  if (acct) { const d = acct[1].replace(/\D/g, ""); if (d.length >= 6 && d.length <= 17 && !/^(\d)\1+$/.test(d)) add("labeled bank account number", "finance"); }
  if (/\b(?:routing(?: number| no\.?| #)?|ABA(?: number| no\.?| #)?|RTN)\s*[:#=-]?\s*\d{9}\b/i.test(t)) add("labeled bank routing number", "finance");
  return out;
}

// ---------------- heuristics ----------------
// Any fleet entity name, however it is spelled (adjudication round 3: only "OTCHealth Inc." counted, so a
// ledger headed "OTCHealth", "OTC Health" or "Hearing Assist" passed).
const ENTITY_RE = /\b(OTC ?Health|Hearing ?Assist|InnerScope|INND)\b/g;
const ACCT_TERMS = ["general ledger", "trial balance", "journal entr", "chart of accounts", "reconciliation", "accounts payable", "accounts receivable", "balance sheet", "income statement", "p&l", "profit and loss", "cash flow statement", "accrual", "write-off", "write off", "intercompany", "gl account"];
// INND corporate EVENTS that are MNPI until announced (a draft 8-K, an earnings preview, a deal). Whole
// words, counted per PARAGRAPH that names INND/InnerScope: every fleet CLAUDE.md names INND in its persona
// block, and growth docs say "user acquisition" and "guidance", so a document-wide count would refuse them.
const EVENT_TERMS = [["8-K", "8-k"], ["definitive agreement", "definitive agreements?"], ["letter of intent", "letters? of intent|lois?"], ["merger", "mergers?"], ["acquisition", "acquisitions?|acquir(?:e|es|ed|ing)"], ["earnings", "earnings"], ["guidance", "guidance"], ["embargo", "embargo(?:ed|es)?"]];
// Personal (family) legal matters: routes to the legal-personal ring, never commons.
const PERSONAL_TERMS = [["superior court", "superior court"], ["family law", "family law"], ["custody", "custody"], ["dissolution", "dissolution"], ["spousal support", "spousal support"], ["child support", "child support"]];
const CAPTION_RE = /\b[A-Z][a-z]+ v\. [A-Z][a-z]+\b/;
function wordTerms(text, terms) {
  const found = new Set();
  for (const [label, src] of terms) if (new RegExp(`(^|[^a-z0-9])(?:${src})(?![a-z0-9])`, "i").test(text)) found.add(label);
  return found;
}
const DEAL_TERMS = ["reg d", "regulation d", "reg a", "regulation a", "reg cf", "regulation cf", "form d", "form c", "form 1-a", "cap table", "subscription agreement", "private placement", "pre-money", "post-money", "valuation cap", "convertible note", "safe note", "warrant", "term sheet", "ppm", "accredited investor", "offering circular"];
function distinctTerms(lower, terms) {
  const found = new Set();
  for (const term of terms) {
    const re = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    if (re.test(lower)) found.add(term.replace(/ entr$/, " entry"));
  }
  return found;
}
// Currency amounts: "$1,234.56", "1,234.56", and (adjudication round 2) BARE two-decimal amounts of
// 10.00 or more ("1234.56": a general ledger with plain decimals used to pass). A version string is not
// an amount ("v1.15", "1.15.3", "10.25.1" are excluded by the look-arounds), and neither is a one-digit
// metric ("0.33", "4.85": the fleet's own findings ledger is full of ratios and entropies).
const AMOUNT_RE = /\$\s?\d[\d,]*(?:\.\d{1,2})?\b|\b\d{1,3}(?:,\d{3})+\.\d{2}\b|(?<![\d.,vV$])\d{2,9}\.\d{2}(?![\d.])/g;
export function countAmounts(text) { return (String(text || "").match(AMOUNT_RE) || []).length; }

const JSON_AMOUNT_KEY = /^(debit|credit|amount|line[_-]?amount|unit[_-]?amount|balance|total|sub[_-]?total|net|gross|tax[_-]?amount|value)$/i;
/** Walk parsed JSON: numeric Debit/Credit/Amount-style fields (a Xero trial balance serializes 1234.5 and
 *  1000, which no text regex counts as currency), plus accounting terms implied by its KEYS. Pure. */
export function jsonFinanceSignals(v) {
  let amounts = 0;
  const keys = new Set();
  const walk = (x, depth) => {
    if (depth > 40 || x == null) return;
    if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1); return; }
    if (typeof x !== "object") return;
    for (const [k, val] of Object.entries(x)) {
      keys.add(k.toLowerCase().replace(/[_-]/g, ""));
      // Count only what AMOUNT_RE cannot see in the `key: value` view (integers, 1 or 3+ decimals), so a
      // field is never counted twice.
      const sv = typeof val === "number" || typeof val === "string" ? String(val).trim() : "";
      if (JSON_AMOUNT_KEY.test(k) && /^-?\d[\d,]*(\.\d+)?$/.test(sv) && !/\.\d{2}$/.test(sv)) amounts++;
      walk(val, depth + 1);
    }
  };
  walk(v, 0);
  const terms = new Set();
  if (keys.has("debit") && keys.has("credit")) terms.add("debit/credit columns");
  if (keys.has("accountcode") || keys.has("accountid") || keys.has("accountnumber")) terms.add("chart of accounts");
  if ([...keys].some((k) => k.includes("journal"))) terms.add("journal entry");
  if ([...keys].some((k) => k.includes("trialbalance"))) terms.add("trial balance");
  return { amounts, terms };
}

export const INND_EVENT_MIN_TERMS = 2;
export const PERSONAL_LEGAL_MIN_TERMS = 3;
// Markers that an INND event is NOT PUBLIC yet (a draft, an embargo, a preview, a future filing, holders
// not told). The corpus scan showed that event vocabulary alone ("acquisition accounting", "ASC guidance",
// how the IR team files an 8-K, public press releases) is ordinary fleet prose.
// "draft" counts only as a DRAFT filing / release (or a paragraph that opens with DRAFT), and "preview" only
// as an earnings / results / quarter preview: the corpus is full of "draft PRs", "draft financial
// statements" and "preview builds".
const NONPUBLIC_RE = /(^\s*draft\b|\bdraft(ed)? (of )?(the )?(form )?(8-k|10-[kq]|press release|announcement|earnings release)\b|\b(embargo(ed)?|unannounced|pre-?announcement)\b|\b(earnings|results|quarter(ly)?|q[1-4]|annual) preview\b|\bwill be (filed|announced|released|disclosed|published|made public)\b|\bnot yet (been )?(announced|public|disclosed|released|filed|told)\b|\bha(ve|s)(n't| not) (yet )?been (told|informed|announced|disclosed)\b|\b(do|does)(n't| not) know yet\b|\b(before|ahead of|prior to) (the )?(public )?(announcement|release|filing|disclosure)\b)/i;
export function heuristicSignals(text, { sourceRepo, extraAmounts = 0, extraTerms = null } = {}) {
  const t = String(text || "");
  const lower = t.toLowerCase();
  const out = [];
  const entityCount = (t.match(ENTITY_RE) || []).length;
  const innd = (t.match(/\b(INND|InnerScope)\b/g) || []).length;
  const acct = distinctTerms(lower, ACCT_TERMS);
  if (extraTerms) for (const x of extraTerms) acct.add(x);
  const amounts = countAmounts(t) + (Number(extraAmounts) || 0);
  if (entityCount >= 1 && acct.size >= 3 && amounts >= 20) out.push({ code: "FINANCE_LEDGER", ring: "finance", detail: `entity mention + ${acct.size} accounting terms + ${amounts} currency amounts` });
  const deal = distinctTerms(lower, DEAL_TERMS);
  if (innd >= 2 && deal.size >= 3) out.push({ code: "INND_SECURITIES", ring: "innd-mnpi", detail: `INND/InnerScope x${innd} + ${deal.size} securities-deal terms` });
  for (const para of t.split(/\n\s*\n/)) {
    if (!/\b(INND|InnerScope)\b/.test(para)) continue;
    const events = wordTerms(para, EVENT_TERMS);
    if (events.size < INND_EVENT_MIN_TERMS) continue;
    const np = para.replace(/material non-?public information/gi, " ").match(NONPUBLIC_RE);
    if (np) { out.push({ code: "INND_EVENT", ring: "innd-mnpi", detail: `a paragraph naming INND/InnerScope + ${events.size} corporate-event terms (${[...events].slice(0, 4).join(", ")}) + a not-yet-public marker ("${np[0].toLowerCase()}")` }); break; }
  }
  const personal = wordTerms(t, PERSONAL_TERMS);
  if (CAPTION_RE.test(t)) personal.add("case caption");
  if (personal.size >= PERSONAL_LEGAL_MIN_TERMS) out.push({ code: "PERSONAL_LEGAL", ring: "legal-personal", detail: `${personal.size} personal-legal terms (${[...personal].slice(0, 4).join(", ")})` });
  if (String(sourceRepo || "").toLowerCase() === "innd-website") out.push({ code: "INND_IR_SOURCE", ring: "innd-mnpi", detail: "source repo innd-website is investor-facing (Reg FD gated)" });
  return out;
}

// ---------------- raw views (adjudication round 2) ----------------
// The ring gate used to read ONLY the normalized body, while the raw input is persisted too (html/json
// raw originals under _KNOWLEDGE-META/src/, including --store-only): an SSN inside <script>, a
// PRIVILEGED banner in an HTML comment, or a JSON field never reached the gate.
/** Every text node, comment, script and style body of an HTML document, one piece per line. */
export function htmlRawView(html) {
  return decodeEntities(stripTagsLinear(String(html || "").replace(/<!--|--!?>/g, "\n"), "\n"));
}
/** Every primitive of a parsed JSON value as a `key: value` line (so "ssn: 219-09-9999" stays labeled). */
export function jsonRawView(v) {
  const lines = [];
  const walk = (x, key, depth) => {
    if (depth > 40 || lines.length > 200000) return;
    if (Array.isArray(x)) { for (const y of x) walk(y, key, depth + 1); return; }
    if (x && typeof x === "object") { for (const [k, val] of Object.entries(x)) walk(val, k, depth + 1); return; }
    if (x == null) return;
    lines.push(key ? `${key}: ${x}` : String(x));
  };
  walk(v, "", 0);
  return lines.join("\n");
}

export function vocabularyWarnings(text) {
  const t = String(text || "");
  const w = [];
  if (/\bMNPI\b|material non-?public/i.test(t)) w.push("mentions-mnpi-vocabulary");
  if (/\bPHI\b|protected health information/i.test(t)) w.push("mentions-phi-vocabulary");
  if (/\bprivileged\b|\battorney\b/i.test(t)) w.push("mentions-privilege-vocabulary");
  if (/\bReg(ulation)? FD\b|\bsecurities\b/i.test(t)) w.push("mentions-securities-vocabulary");
  if (bareConfidentialBanner(t)) w.push("confidential-banner");
  return w;
}

/** Minimum explanation length of a --ring-override reason, AFTER the signal codes it names are removed. */
export const OVERRIDE_MIN_REASON = 20;
/** INND MNPI heuristics are overridable only from these SEATS (KB_AGENT / .kb-agent): an override is a
 *  claim that the material is public, and only the lanes that own INND disclosure can make it
 *  (adjudication round 3: any agent, `--agent cro` included, cleared an INND Reg D refusal on itself). */
export const INND_OVERRIDE_CODES = Object.freeze(["INND_SECURITIES", "INND_IR_SOURCE", "INND_EVENT"]);
export const INND_OVERRIDE_SEATS = Object.freeze(["clo", "capital", "exec"]);

/** Is `reason` a valid override for `heuristic` signals? It must NAME every overridden code
 *  ("INND_SECURITIES: <why>") and explain itself in >= OVERRIDE_MIN_REASON characters ("ok" used to
 *  pass an INND Reg D / cap-table / warrant document). Returns { ok, problem }. Pure. */
export function checkOverrideReason(reason, heuristic, seat = "") {
  const r = String(reason || "").trim();
  if (!r) return { ok: false, problem: "" };
  const innd = (heuristic || []).map((s) => s.code).filter((c) => INND_OVERRIDE_CODES.includes(c));
  const who = String(seat || "").trim().toLowerCase();
  if (innd.length && !INND_OVERRIDE_SEATS.includes(who)) return { ok: false, problem: `${innd.join(", ")} can be overridden only from the ${INND_OVERRIDE_SEATS.join(", ")} seat (KB_AGENT / ~/.claude/.kb-agent; the --agent flag does not count); this seat is "${who || "unknown"}"` };
  const missing = (heuristic || []).map((s) => s.code).filter((c) => !new RegExp(`(^|[^A-Z0-9_])${c}([^A-Z0-9_]|$)`).test(r));
  if (missing.length) return { ok: false, problem: `the --ring-override reason must name every overridden signal code; missing: ${missing.join(", ")}` };
  const why = (heuristic || []).reduce((acc, s) => acc.split(s.code).join(" "), r).replace(/[\s:;,.+|/-]+/g, " ").trim();
  if (why.length < OVERRIDE_MIN_REASON) return { ok: false, problem: `the --ring-override reason must explain itself in at least ${OVERRIDE_MIN_REASON} characters besides the signal codes (got ${why.length})` };
  return { ok: true, problem: "" };
}

/**
 * Classify one document. Returns:
 *   { allowed, hard[], heuristic[], warnings[], overrideAccepted, overrideRejected, overrideProblem, routes[] }
 * `text` is the normalized body; `extraTexts` are raw views of the input (htmlRawView / jsonRawView) that
 * are scanned for banners, PHI and heuristics too. `frontmatter` is every declaration (front matter, HTML
 * meta, JSON top-level keys). `override` is the --ring-override reason (or ""): honored only when EVERY
 * refusing signal is a heuristic AND the reason names each code with a real explanation.
 */
export function classifyRing({ text, extraTexts = [], jsonFinance = null, frontmatter = {}, ringFlag = "commons", source = "", localPath = "", realPath = "", artifactUrl = "", sourceRepo = "", override = "", overrideSeat = "", denylist } = {}) {
  const hard = [];
  // The repo a --source names counts for the heuristics too (`--source innd-website@sha:path` outside git
  // never raised INND_IR_SOURCE, because sourceRepo came from git only).
  sourceRepo = sourceRepo || parseRepo(source);
  const flag = String(ringFlag || "commons").toLowerCase();
  if (flag !== "commons") hard.push({ code: "RING_DECLARED", ring: ringForDeclared("ring", flag), detail: `--ring ${flag} (v1 writes the commons room only)` });
  hard.push(...declaredSignals(frontmatter));
  hard.push(...pathDenies({ source, localPath, realPath, artifactUrl, sourceRepo }, denylist || loadDenylist()));
  const texts = [text, ...(extraTexts || [])].filter((t) => t != null && t !== "");
  for (const t of texts) { hard.push(...bannerSignals(t)); hard.push(...phiSignals(t)); }
  // Heuristics run per text (never on a concatenation: the raw view repeats the body's text, so joining
  // them would double every count). jsonFinance (numeric Debit/Credit/Amount fields + key-implied terms)
  // belongs to the JSON view, which the caller passes as the LAST extra text.
  const heuristic = [];
  texts.forEach((t, i) => {
    const extra = jsonFinance && i > 0 && i === texts.length - 1 ? { extraAmounts: jsonFinance.amounts, extraTerms: jsonFinance.terms } : {};
    for (const h of heuristicSignals(t, { sourceRepo, ...extra })) if (!heuristic.some((x) => x.code === h.code)) heuristic.push(h);
  });
  const dedup = (arr) => { const seen = new Set(); return arr.filter((d) => { const k = `${d.code}|${d.ring}|${d.detail}`; if (seen.has(k)) return false; seen.add(k); return true; }); };
  const hardU = dedup(hard);
  const warnings = vocabularyWarnings(text);
  const reason = String(override || "").trim();
  const ov = hardU.length ? { ok: false, problem: "" } : checkOverrideReason(reason, heuristic, overrideSeat);
  const overrideAccepted = !hardU.length && heuristic.length > 0 && ov.ok;
  const allowed = hardU.length === 0 && (heuristic.length === 0 || overrideAccepted);
  const rings = [...new Set([...hardU, ...(overrideAccepted ? [] : heuristic)].map((s) => s.ring))];
  return { allowed, hard: hardU, heuristic, warnings, overrideAccepted, overrideRejected: reason.length > 0 && !overrideAccepted && (hardU.length > 0 || heuristic.length > 0), overrideProblem: ov.problem, routes: rings.map((r) => ({ ring: r, route: ROUTES[r] || ROUTES.finance })) };
}

export function formatRingRefusal(res) {
  const lines = [];
  for (const s of res.hard) lines.push(`  ring HARD ${s.code}: ${s.detail} -> ${s.ring}`);
  if (!res.overrideAccepted) for (const s of res.heuristic) lines.push(`  ring HEURISTIC ${s.code}: ${s.detail} -> ${s.ring} (if this is a false positive: --ring-override "${s.code}: <why, ${OVERRIDE_MIN_REASON}+ chars>")`);
  if (res.overrideRejected && res.hard.length) lines.push("  --ring-override is ignored: a HARD signal is present (declared ring, path deny, banner, or PHI data are never overridable).");
  else if (res.overrideRejected && res.overrideProblem) lines.push(`  --ring-override rejected: ${res.overrideProblem}.`);
  for (const r of res.routes) lines.push(`  route (${r.ring}): ${r.route}`);
  return lines;
}

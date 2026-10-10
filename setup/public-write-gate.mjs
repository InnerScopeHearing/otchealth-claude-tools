#!/usr/bin/env node
// public-write-gate.mjs : a fail-closed gate in front of every tool that writes a finding, a ledger entry,
// a bulletin line, a task text or a diagnostic file into a PUBLIC repository.
//
// WHY THIS EXISTS (owner decision 2026-10-10, security review finding S-04). The public toolkit repo
// accumulated finance, legal and ring-private material because the writers below it had no ring gate and no
// check for inside information: they commit through the GitHub Contents API (or git) as the fleet App, which
// bypasses the gateway entirely.
// The existing entries are handled by the owner personally. This module only STOPS NEW WRITES.
//
// THE RULE. Only the cto and developer lanes may write to a public repo, and only technical findings. A write
// is refused when ANY of these is true:
//   * the lane is a ring lane (cfo, clo, clo-personal), or is any lane other than cto or developer;
//   * the lane, the session identity, the author, the category or the tags carry a sensitive label
//     (finance, legal, investor, deal, inside information, privileged, PHI, personal, or a confidential or
//     restricted marker);
//   * the free text names one of those classes;
//   * the lane is missing, or the metadata cannot be read safely (fail closed, never fail open).
// A refusal prints a plain message that points to the private alternative (the gateway Postgres ledger:
// memory_remember with type finding, or task_create), and the caller exits 2 without writing anything.
//
// HOW A WRITER USES IT.
//   import { assertPublicWriteAllowed } from "../../setup/public-write-gate.mjs";
//   const approval = assertPublicWriteAllowed({ lane, author, category, tags, text: { title, ... } }, "my writer");
//   // throws PublicWriteRefused when refused; otherwise returns an approval that the write helper requires.
// The approval is a capability: it lives in a module-private WeakSet, so a helper that demands one
// (ledger.mjs putFile does) cannot be reached by a caller that skipped the gate.
//
// WORKFLOWS call the CLI before any git push step:
//   node setup/public-write-gate.mjs files --lane cto --writer "<name>" <file>... || exit 1
//
// Dependency-free (node builtins only) so it can live in setup/ and be hydrated next to the installed skills.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The only lanes allowed to write to a public repository. */
export const ALLOWED_LANES = Object.freeze(["cto", "developer"]);
/** Ring lanes: their work is private by definition, whatever the entry says. */
export const RING_LANES = Object.freeze(["cfo", "clo", "clo-personal"]);
/** Exit code for a refusal, the same convention brain-save uses (2 means refused, nothing written). */
export const EXIT_REFUSED = 2;

/** Largest file the CLI will read when scanning a file about to be committed (anything bigger is refused). */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------
// Vocabulary. LABEL keys match the structured fields (lane, author, category, tags) on hyphen boundaries, so
// a caller that deliberately tags an entry "finance" or "cap-table" is refused. PHRASES match the free text;
// they are narrower on purpose (whole words or fixed phrases), so ordinary technical wording keeps flowing.
// ---------------------------------------------------------------------------------------------------------
const LABEL_KEYS = Object.freeze({
  privileged: ["privileged", "attorney-client"],
  "inside-information": ["material-non-public", "insider"],
  phi: ["phi", "hipaa", "patient", "medical", "health-record"],
  personal: ["personal", "personal-legal", "clo-personal", "pii"],
  restricted: ["confidential", "restricted", "sensitive", "ring-private", "ring-restricted", "internal-only"],
  finance: ["finance", "financial", "financials", "financing", "cfo", "accounting", "accountant", "bookkeeping", "treasury", "tax", "taxes", "payroll", "revenue", "banking", "invoice", "invoices", "cap-table", "captable", "valuation"],
  legal: ["legal", "law", "lawyer", "attorney", "counsel", "clo", "litigation", "lawsuit", "court", "subpoena", "settlement"],
  investor: ["investor", "investors", "investor-relations", "ir", "shareholder", "stockholder", "fundraising", "securities", "wefunder"],
  deal: ["deal", "deals", "m-a", "merger", "term-sheet", "due-diligence", "data-room", "dataroom", "loi"],
});

// Technical nouns that follow the word "privileged" in ordinary engineering text (privileged mode, a
// privileged port). Any other use of the bare word is treated as the legal sense and refused.
const PRIV_TECH = "mode|ports?|containers?|users?|access|escalation|instructions?|operations?|pods?|process(?:es)?|api|roles?|accounts?|identit(?:y|ies)|helpers?|endpoints?|shell|sockets?|namespaces?|capabilit(?:y|ies)|flags?|bits?|runners?|jobs?|steps?|permissions?|commands?";

// The inside-information class is the securities category. Its acronym is matched only by the word boundary
// pattern in this table (every structured label is scanned as text too, so a tag that spells it is refused all
// the same). It is deliberately not spelled out in a string, a key or a comment anywhere in this file: tools
// that publish to GitHub through the gateway hard-block that literal marker wherever it appears.
const PHRASES = Object.freeze({
  privileged: [
    /\battorney[- ]?(?:client|eyes only|work product)\b/i,
    /\bprivileged (?:and|&) confidential\b/i,
    /\blegally privileged\b/i,
    new RegExp(`\\bprivileged\\b(?![- ](?:${PRIV_TECH})\\b)`, "i"),
  ],
  "inside-information": [
    /\bmnpi\b/i,
    /\bmaterial non[- ]?public\b/i,
    /\bnon[- ]?public (?:material )?information\b/i,
    /\binsider (?:information|trading|list)\b/i,
  ],
  phi: [
    /\bphi\b/i,
    /\bhipaa\b/i,
    /\bprotected health information\b/i,
    /\b(?:patient (?:records?|data|names?|charts?|information|identifiers?)|medical records?|health records?)\b/i,
  ],
  personal: [
    /\bpersonal\b/i,
    /\bpii\b/i,
    /\bpersonally identifiable\b/i,
  ],
  restricted: [
    /\b(?:ring[- ]private|ring[- ]restricted|strictly confidential|confidential (?:and|&) proprietary|do not (?:forward|distribute|share))\b/i,
  ],
  finance: [
    /\bfinanc(?:e|es|ial|ials|ing)\b/i,
    /\bcap(?:ital)? ?tables?\b/i,
    /\b(?:general ledger|trial balance|chart of accounts|accounts (?:payable|receivable)|balance sheets?|income statements?|profit and loss|p ?& ?l)\b/i,
    /\b(?:payroll|bookkeep(?:ing|er)|accountants?|treasury|revenue|invoices?|ebitda|valuation)\b/i,
    /\b(?:bank (?:accounts?|statements?|balances?|transfers?)|wire transfers?|routing numbers?|iban)\b/i,
    /\btax(?:es)? (?:returns?|filings?|liabilit(?:y|ies)|documents?)\b/i,
  ],
  legal: [
    /\blegal(?:ly)?\b/i,
    /\b(?:attorneys?|lawyers?|counsel|litigation|law ?suits?|subpoenas?|depositions?|settlements?|plaintiffs?|defendants?)\b/i,
    /\b(?:court (?:orders?|filings?|dates?|hearings?|dockets?)|superior court|family law|docket numbers?|case numbers?)\b/i,
  ],
  investor: [
    /\binvestors?\b/i,
    /\b(?:shareholders?|stockholders?|fundrais(?:e|es|ing|er)|investor relations)\b/i,
    /\b(?:securities (?:laws?|offerings?|filings?|counsel|exchange)|regulation (?:d|a|cf|fd)|reg (?:cf|fd)|8-k|10-k|10-q)\b/i,
  ],
  deal: [
    /\bdeal (?:terms?|room|team|flow|structure|memo|pipeline|closing|docs?|documents?)\b/i,
    /\b(?:term sheets?|letters? of intent|due diligence|data ?rooms?|m ?& ?a|mergers?|definitive agreements?|purchase price|acquisition (?:targets?|offers?|price|agreements?))\b/i,
  ],
});

// "personal access token" is ordinary engineering vocabulary (a GitHub PAT), not the personal class. Only
// that exact phrase is removed before scanning, so it can never hide another use of the word.
const PAT_PHRASE = /\bpersonal[- ]access[- ]tokens?\b/gi;

/** Plain-English reason for each refusal class. No matched text is ever included, only the class. */
const REASONS = Object.freeze({
  finance: "it is marked as, or reads as, finance material",
  legal: "it is marked as, or reads as, legal material",
  investor: "it is marked as, or reads as, investor material",
  deal: "it is marked as, or reads as, deal material",
  "inside-information": "it is marked as, or reads as, inside information about a public company",
  privileged: "it is marked as, or reads as, privileged material",
  phi: "it is marked as, or reads as, protected health information",
  personal: "it is marked as, or reads as, personal material",
  restricted: "it carries a confidential, restricted or ring-private marker",
  "ring-lane": "it comes from a ring lane (cfo, clo or clo-personal)",
  "unknown-lane": "its lane is not allowed to write to a public repo (only cto and developer are)",
  "missing-metadata": "its lane is missing, so it cannot be classified",
  "malformed-metadata": "its metadata could not be read safely",
});

/** Every class id the gate can refuse with (tests iterate this). */
export const REFUSAL_CLASSES = Object.freeze(Object.keys(REASONS));

// ---------------------------------------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------------------------------------
const INVISIBLES = /[­​-‏⁠﻿]/g;

/** Hyphen-separated lowercase form of a label ("Cap Table" -> "cap-table"). Pure. */
function normLabel(s) {
  return String(s).normalize("NFKC").replace(INVISIBLES, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Free text prepared for phrase matching: compatibility-folded, invisibles removed, dashes folded to a plain
 *  hyphen, snake_case and camelCase split into words, whitespace collapsed. Pure. */
function foldText(s) {
  return String(s)
    .normalize("NFKC")
    .replace(INVISIBLES, "")
    .replace(/[‐-―−]/g, "-")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ");
}

// "privileged-container" as a tag is engineering vocabulary, the same way the phrase is in free text.
const PRIV_TECH_LABEL = new RegExp(`(^|-)privileged-(?:${PRIV_TECH})(?=-|$)`, "g");

function labelHits(norm, keys) {
  const hay = `-${norm.replace(PRIV_TECH_LABEL, "$1")}-`;
  return keys.some((k) => hay.includes(`-${k}-`));
}

function refuse(cls, field) {
  return { allowed: false, class: cls, field: field || null, reason: REASONS[cls] };
}

/** Class id of the first sensitive LABEL found in one structured field value, or null. */
function labelClass(value) {
  const norm = normLabel(value);
  if (!norm) return null;
  for (const [cls, keys] of Object.entries(LABEL_KEYS)) if (labelHits(norm, keys)) return cls;
  return null;
}

/** Class id of the first sensitive PHRASE found in free text, or null. */
function textClass(value) {
  const folded = foldText(value).replace(PAT_PHRASE, " ");
  for (const [cls, res] of Object.entries(PHRASES)) for (const re of res) if (re.test(folded)) return cls;
  return null;
}

// Fields that hold a path or a repo name rather than prose. Their segments are checked against the label
// vocabulary too, so a pointer such as docs/finance/plan.md or an owner-handled directory cannot slip through.
const PATH_FIELDS = new Set(["source_audit_doc", "source_doc", "source", "fix_repo", "repo", "path", "paths", "file", "files"]);
const OWNER_HANDLED_ROOTS = new Set(["projects"]);

/** Class id for a path-like value (first sensitive segment wins), or null. */
function pathClass(value) {
  const segments = String(value).split(/[\\/:]+/);
  for (let i = 0; i < segments.length; i += 1) {
    const n = normLabel(segments[i]);
    if (!n) continue;
    if (i === 0 && OWNER_HANDLED_ROOTS.has(n)) return "restricted";
    const cls = labelClass(segments[i]);
    if (cls) return cls;
  }
  return null;
}

function isRingLabel(norm) {
  const hay = `-${norm}-`;
  return RING_LANES.some((r) => hay.includes(`-${r}-`));
}

/** A field that may be a string or an array of strings (tags may also be one comma separated string). */
function listOf(value, name) {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  for (const v of raw) {
    if (typeof v !== "string") throw new TypeError(`${name} must be a string or an array of strings`);
    for (const part of v.split(/[,;\n]+/)) if (part.trim()) out.push(part.trim());
  }
  return out;
}

/** Free text may be a string, an array of strings, or a record of named strings. Returns [fieldName, text]. */
function textFields(text) {
  if (text === undefined || text === null) return [];
  if (typeof text === "string") return [["text", text]];
  if (Array.isArray(text)) return text.map((t, i) => {
    if (typeof t !== "string") throw new TypeError("text entries must be strings");
    return [`text[${i}]`, t];
  });
  if (typeof text === "object") {
    return Object.entries(text).flatMap(([k, v]) => {
      if (v === undefined || v === null) return [];
      if (typeof v === "string") return [[k, v]];
      if (typeof v === "number" || typeof v === "boolean") return [[k, String(v)]];
      throw new TypeError(`text.${k} must be a string`);
    });
  }
  throw new TypeError("text must be a string, an array of strings or a record of strings");
}

function evaluate(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return refuse("missing-metadata", null);

  // 1. The lane is required and must be a non-empty string.
  if (typeof entry.lane !== "string" || !normLabel(entry.lane)) return refuse("missing-metadata", "lane");
  const lane = normLabel(entry.lane);
  if (isRingLabel(lane)) return refuse("ring-lane", "lane");
  if (!ALLOWED_LANES.includes(lane)) return refuse("unknown-lane", "lane");

  // 2. The session identity (seats) must ALSO be an allowed lane, so a declared lane cannot paper over the
  //    seat the process really runs as. A ring seat is a ring-lane refusal; any other unlisted seat is unknown.
  for (const seat of listOf(entry.seats, "seats")) {
    const n = normLabel(seat);
    if (!n) continue;
    if (isRingLabel(n)) return refuse("ring-lane", "session identity");
    if (!ALLOWED_LANES.includes(n)) return refuse("unknown-lane", "session identity");
  }

  // 3. Author, category and tags: a ring lane named as author is a ring-lane refusal; every label is also
  //    checked against the sensitive vocabulary, as labels and as text.
  const labelFields = [["lane", [entry.lane]], ["author", listOf(entry.author, "author")], ["category", listOf(entry.category, "category")], ["tags", listOf(entry.tags, "tags")]];
  for (const [field, values] of labelFields) {
    for (const v of values) {
      const n = normLabel(v);
      if (!n) continue;
      if (field === "author" && isRingLabel(n)) return refuse("ring-lane", field);
      const byLabel = labelClass(v);
      if (byLabel) return refuse(byLabel, field);
      const byText = textClass(v);
      if (byText) return refuse(byText, field);
    }
  }

  // 4. Free text.
  for (const [field, value] of textFields(entry.text)) {
    const cls = textClass(value) || (PATH_FIELDS.has(field) ? pathClass(value) : null);
    if (cls) return refuse(cls, field);
  }

  return { allowed: true, class: null, field: null, reason: "technical entry from an allowed lane", lane };
}

/** Decide whether an entry may be written to a public repo. Pure. NEVER throws: any problem reading the
 *  entry is itself a refusal (fail closed). Returns { allowed, class, field, reason }; `field` names the
 *  field that tripped the gate, and the matched text is never echoed. */
export function evaluatePublicWrite(entry) {
  try {
    return evaluate(entry);
  } catch {
    return refuse("malformed-metadata", null);
  }
}

// ---------------------------------------------------------------------------------------------------------
// The approval capability and the refusal error
// ---------------------------------------------------------------------------------------------------------
const APPROVALS = new WeakSet();

/** Thrown by assertPublicWriteAllowed. `exitCode` is always 2, and `message` is the full plain-English text. */
export class PublicWriteRefused extends Error {
  constructor(decision, writer) {
    super(refusalMessage(decision, writer));
    this.name = "PublicWriteRefused";
    this.refused = true;
    this.exitCode = EXIT_REFUSED;
    this.decision = decision;
  }
}

/** The plain-English refusal text: the reason class, the private alternative, and "nothing was written". */
export function refusalMessage(decision, writer) {
  const who = writer ? String(writer) : "this writer";
  const reason = (decision && decision.reason) || REASONS["malformed-metadata"];
  const field = decision && decision.field ? ` Field checked: ${decision.field}.` : "";
  return [
    `REFUSED: ${who} will not write this to a public repository.`,
    `Reason: ${reason}.${field}`,
    "Finance, legal and personal findings never go to a public repo, and only the cto and developer lanes may write technical findings there.",
    "Record it in the private ledger instead: memory_remember with type finding (CTO gateway), or task_create for work to be done.",
    ...(decision && decision.class === "missing-metadata" && decision.field === "lane"
      ? ["If this is a technical finding from the cto or developer lane, declare it with --lane cto (or --lane developer), or run from a session whose identity is one of them."]
      : []),
    "Nothing was written.",
  ].join("\n");
}

/** Gate a write. Returns a frozen approval token when the entry is allowed; throws PublicWriteRefused when not. */
export function assertPublicWriteAllowed(entry, writer) {
  const decision = evaluatePublicWrite(entry);
  if (!decision.allowed) throw new PublicWriteRefused(decision, writer);
  const approval = Object.freeze({ approved: true, lane: decision.lane, writer: writer || null });
  APPROVALS.add(approval);
  return approval;
}

/** True only for a token minted by assertPublicWriteAllowed in this process. A write helper that calls this
 *  before touching the network cannot be reached by a caller that skipped the gate. */
export function isApproval(value) {
  return value !== null && typeof value === "object" && APPROVALS.has(value);
}

// ---------------------------------------------------------------------------------------------------------
// Ambient identity (used by CLI wrappers only, so the pure functions above stay hermetic)
// ---------------------------------------------------------------------------------------------------------
const MISSING_FILE = new Set(["ENOENT", "ENOTDIR"]);

/** Every identity this process could be running as: the session marker (~/.claude/.kb-agent), the repo marker
 *  (.kb-agent under CLAUDE_PROJECT_DIR) and the KB_AGENT variable. Each one that exists must be an allowed lane.
 *  A marker that exists but cannot be read is reported as an unlisted identity, which fails closed. */
export function ambientIdentities({ env = process.env, readFile = (p) => readFileSync(p, "utf8"), home, projectDir } = {}) {
  const out = [];
  const add = (v) => {
    const first = typeof v === "string" ? v.split(/\r?\n/).map((l) => l.trim()).find(Boolean) : "";
    if (first && !out.includes(first)) out.push(first);
  };
  const h = home || env.HOME || homedir();
  const p = projectDir || env.CLAUDE_PROJECT_DIR || ".";
  for (const file of [join(h, ".claude", ".kb-agent"), join(p, ".kb-agent")]) {
    try { add(readFile(file)); } catch (e) { if (!e || !MISSING_FILE.has(e.code)) add("unreadable-identity-marker"); }
  }
  add(env.KB_AGENT);
  return out;
}

/** Build the entry a CLI wrapper hands to the gate: the declared lane (a flag, else the ambient identity),
 *  plus the ambient identities as seats. Pure given its arguments. */
export function entryForCli({ lane, author, category, tags, text }, ambient) {
  const seats = Array.isArray(ambient) ? ambient : [];
  return { lane: lane || seats[0] || "", seats, author, category, tags, text };
}

// ---------------------------------------------------------------------------------------------------------
// CLI (used by workflows)
// ---------------------------------------------------------------------------------------------------------
function flagValues(argv, flag) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  return out;
}

function positionals(argv, valueFlags) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (valueFlags.includes(argv[i])) { i += 1; continue; }
    if (argv[i].startsWith("--")) continue;
    out.push(argv[i]);
  }
  return out;
}

const USAGE = [
  "usage: public-write-gate.mjs check --lane <lane> [--author <a>] [--category <c>] [--tags a,b] [--text <free text>] [--writer <name>]",
  "       public-write-gate.mjs files --lane <lane> [--writer <name>] <file>...",
].join("\n");

/** Run the CLI. Returns { code, stdout, stderr } so tests can drive it without spawning a process. */
export function runCli(argv, { env = process.env, readFile = (p) => readFileSync(p, "utf8"), fileSize = (p) => statSync(p).size, ambient } = {}) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const writer = flagValues(rest, "--writer").pop() || "this writer";
  const lanes = flagValues(rest, "--lane");
  const lane = lanes[lanes.length - 1] || "";
  const seats = ambient || ambientIdentities({ env });
  const refusedWith = (decision) => ({ code: EXIT_REFUSED, stdout: "", stderr: refusalMessage(decision, writer) + "\n" });
  // Two different --lane flags are ambiguous, and an ambiguous declaration is refused rather than guessed at.
  if (new Set(lanes.map(normLabel)).size > 1) return refusedWith(refuse("malformed-metadata", "lane"));
  const allowed = (what) => ({ code: 0, stdout: `[public-write-gate] ALLOWED: ${what} (lane ${normLabel(lane || seats[0] || "")}).\n`, stderr: "" });

  if (sub === "check") {
    const entry = entryForCli({
      lane,
      author: flagValues(rest, "--author").pop(),
      category: flagValues(rest, "--category"),
      tags: flagValues(rest, "--tags"),
      text: flagValues(rest, "--text"),
    }, seats);
    const decision = evaluatePublicWrite(entry);
    return decision.allowed ? allowed(writer) : refusedWith(decision);
  }

  if (sub === "files") {
    const files = positionals(rest, ["--lane", "--writer"]);
    // No files named means there is nothing to vet, so there is nothing safe to allow.
    if (!files.length) return refusedWith(refuse("missing-metadata", "files"));
    const text = {};
    for (const f of files) {
      try {
        if (fileSize(f) > MAX_FILE_BYTES) return refusedWith(refuse("malformed-metadata", f));
        text[f] = readFile(f);
      } catch {
        // A file that cannot be read cannot be vetted, so the write is refused.
        return refusedWith(refuse("malformed-metadata", f));
      }
    }
    const decision = evaluatePublicWrite(entryForCli({ lane, text }, seats));
    return decision.allowed ? allowed(`${files.length} file(s) for ${writer}`) : refusedWith(decision);
  }

  return { code: EXIT_REFUSED, stdout: "", stderr: `${USAGE}\n` };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const res = runCli(process.argv.slice(2));
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  process.exitCode = res.code;
}

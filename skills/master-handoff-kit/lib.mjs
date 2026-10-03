// lib.mjs -- master-handoff-kit core. Pure functions first (layout, ledger rules, gates, manifest,
// README), then a small set of fs/git helpers that take injectable runners so the tests never touch
// the network. Dependency-free Node 22+.
//
// REUSE, NOT DUPLICATION. The two gates are brain-save's own modules, imported unchanged:
//   skills/brain-save/lib/secret-gate.mjs (layer A credential shapes + layer B live SSM needles)
//   skills/brain-save/lib/ring-gate.mjs   (PHI, privileged, INND MNPI, finance ledgers)
// The sensitive-role set is sunset-protocol's SENSITIVE; the handoff doc renderer is sunset-protocol's
// renderHandoff; session-file discovery is the Stop hook's findScratchpads/scanFolder/candidateRepos/
// unsavedFiles; the media catalog helpers are app-media/lib.mjs. Nothing here re-implements them.
//
// FAIL-CLOSED. Every text file, ledger entry and binary passes the secret gate before it can enter the
// kit; a file that trips a gate is EXCLUDED and listed with its reason (rule NAMES only, never a value).
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep, posix } from "node:path";

import { scanParts, formatSecretHits, valueLooksSecret, entropy } from "../brain-save/lib/secret-gate.mjs";
import { classifyRing, formatRingRefusal } from "../brain-save/lib/ring-gate.mjs";
import { parseFrontmatter } from "../brain-save/lib/normalize.mjs";
import { SENSITIVE } from "../sunset-protocol/protocol.mjs";
import { groupCatalog } from "../app-media/lib.mjs";

export const TOOL_VERSION = "master-handoff-kit 1";
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_SESSION_IMAGES = 200;
export const IMAGE_EXTS = Object.freeze([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
export const TEXT_EXTS = Object.freeze([".md", ".markdown", ".txt", ".html", ".htm", ".json", ".jsonl", ".csv", ".yml", ".yaml", ".toml", ".xml", ".svg", ".mjs", ".js", ".ts", ".sh"]);
export const DEFAULT_REPO_DOCS = Object.freeze(["CLAUDE.md", "AGENTS.md", "HANDOFF.md", "README.md"]);
/** Roles whose ledger TEXT never leaves its ring (cfo MNPI, clo privileged, clo-personal, capital securities). */
export const SENSITIVE_ROLES = SENSITIVE;
/** Mirrors mem.mjs AGENTS (the lane -> store map). mem.mjs is a CLI with import-time side effects, so the
 *  few rows needed to read a lane's ledger are restated here; kb-memory/s3-blob.mjs MIRROR is the authority. */
export const LANE_STORE = Object.freeze({
  cfo: { account: "otchealthcfodata", container: "cfo-source-docs" },
  clo: { account: "otchealthlegalstore", container: "company" },
  "clo-personal": { account: "otchealthlegalstore", container: "personal" },
  exec: { account: "otchealthlegalstore", container: "exec" },
});
export const COMMONS_STORE = Object.freeze({ account: "otchealthcommons", container: "company-journal" });

export const sha256 = (v) => createHash("sha256").update(typeof v === "string" ? Buffer.from(v, "utf8") : v).digest("hex");

// ---------------------------------------------------------------- layout

export function normalizeRole(role) {
  const r = String(role || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(r)) throw new Error(`invalid --agent "${role}" (expected a role slug such as cto, developer, cfo)`);
  return r;
}
export const isSensitiveRole = (role) => SENSITIVE_ROLES.has(String(role || "").toLowerCase());
export const todayStamp = (d = new Date()) => d.toISOString().slice(0, 10);
export const kitFolderName = (role, date) => `${normalizeRole(role).toUpperCase()}-MASTER-HANDOFF-KIT-${date}`;
export const kitZipName = (role, date) => `${kitFolderName(role, date)}.zip`;

/** A kit path must be relative, forward-slashed, with no `..`, no NUL and no empty segment. */
export function safeKitPath(p) {
  const s = String(p == null ? "" : p).replace(/\\/g, "/");
  if (!s || s.includes("\0") || s.startsWith("/") || /^[A-Za-z]:/.test(s)) throw new Error(`unsafe kit path: ${JSON.stringify(String(p).slice(0, 80))}`);
  const norm = posix.normalize(s);
  if (norm === "." || norm.startsWith("../") || norm === ".." || norm.split("/").some((seg) => seg === "" || seg === "..")) throw new Error(`unsafe kit path: ${JSON.stringify(String(p).slice(0, 80))}`);
  return norm;
}

/** Relative path of `file` under `root`, forward-slashed, preserved exactly (session-files keeps structure). */
export function relPreserve(root, file) {
  const rel = relative(resolve(root), resolve(file)).split(sep).join("/");
  if (!rel || rel.startsWith("../") || rel === ".." || /^[A-Za-z]:/.test(rel)) throw new Error(`file ${file} is not under ${root}`);
  return rel;
}

export const pad2 = (n) => String(n).padStart(2, "0");

// ---------------------------------------------------------------- file classification (text vs binary)

export function isImageName(name) { return IMAGE_EXTS.includes(extname(String(name)).toLowerCase()); }

/** Binary allowlist: only small images. Anything else binary is refused (reason is returned, never silent). */
export function binaryDecision(name, bytes) {
  if (!isImageName(name)) return { ok: false, reason: `binary type not allowlisted (${extname(String(name)) || "no extension"}); the kit carries text and small images only` };
  if (bytes > MAX_IMAGE_BYTES) return { ok: false, reason: `image is ${bytes} bytes, over the ${MAX_IMAGE_BYTES} byte kit limit (graphics stay in the media library)` };
  return { ok: true };
}

/** text | image | rejected for an on-disk file buffer. NUL sniff decides unknown extensions. */
export function classifyFile(name, buf) {
  const ext = extname(String(name)).toLowerCase();
  if (isImageName(name)) { const d = binaryDecision(name, buf.length); return d.ok ? { type: "image" } : { type: "rejected", reason: d.reason }; }
  if (buf.length > MAX_TEXT_BYTES) return { type: "rejected", reason: `too large (${buf.length} bytes, limit ${MAX_TEXT_BYTES})` };
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return { type: "rejected", reason: `binary content (NUL bytes) in a ${ext || "extensionless"} file; not an allowlisted image` };
  if (!TEXT_EXTS.includes(ext) && ext) {
    // Unknown extension: accept only if it decodes as strict UTF-8.
    try { new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return { type: "rejected", reason: `unrecognized type ${ext} and not valid UTF-8 text` }; }
  }
  return { type: "text" };
}

// ---------------------------------------------------------------- gates (brain-save modules)

const ruleNames = (hits) => [...new Set(hits.map((h) => `${h.layer === "B" ? "layer-B" : "layer-A"}:${h.name}`))];

/** Secret gate over arbitrary text parts. Returns [] when clean, else findings naming only rules. */
export function secretFindings(parts, needles) {
  const hits = scanParts(parts, needles || []);
  if (!hits.length) return [];
  return [{ kind: "secret", rules: ruleNames(hits), detail: formatSecretHits(hits).join("; ") }];
}

/**
 * Full text gate (secret + ring) for one file. `ctx`: { relPath, localPath, realPath, source, sourceRepo, isHtml }.
 * Returns { ok, findings:[{kind:"secret"|"ring", rules, detail}] }. Detail never contains a value.
 */
export function gateText(text, ctx = {}, needles = []) {
  const findings = [...secretFindings({ file: text }, needles)];
  const { frontmatter } = parseFrontmatter(text);
  const res = classifyRing({
    text,
    frontmatter,
    source: ctx.source || "",
    sourceRepo: ctx.sourceRepo || "",
    localPath: ctx.localPath || ctx.relPath || "",
    realPath: ctx.realPath || "",
  });
  if (!res.allowed) findings.push({ kind: "ring", rules: [...res.hard, ...res.heuristic].map((s) => s.code), detail: formatRingRefusal(res).join("; ") });
  return { ok: findings.length === 0, findings };
}

/** Secret gate over a binary (latin1 view catches ASCII credentials embedded in metadata). */
export function gateBinary(buf, needles = []) {
  const findings = secretFindings({ file: Buffer.from(buf).toString("latin1") }, needles);
  return { ok: findings.length === 0, findings };
}

export const findingsReason = (findings) => findings.map((f) => `${f.kind} gate (${f.rules.join(", ")})`).join("; ");

// ---------------------------------------------------------------- kit accumulator

export class KitBuilder {
  constructor({ role, date }) {
    this.role = normalizeRole(role);
    this.date = date;
    this.files = [];      // { path, section, source, sha256, bytes, content, binary }
    this.excluded = [];   // { section, source, reason, rules }
    this.redactions = []; // ledger entries stubbed by the gates
    this.notes = [];      // informational lines for VERIFY.md
    this.scanned = { text: 0, binary: 0, entries: 0 };
    this.paths = new Set();
  }
  _uniquePath(path) {
    let p = safeKitPath(path);
    if (!this.paths.has(p)) return p;
    const ext = extname(p), stem = p.slice(0, p.length - ext.length);
    for (let i = 2; i < 1000; i++) { const q = `${stem}~${i}${ext}`; if (!this.paths.has(q)) return q; }
    throw new Error(`too many path collisions for ${p}`);
  }
  /** Add a text file that has ALREADY passed the gates (or needs none, e.g. generated docs). */
  add({ section, path, source, content, binary = false }) {
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const p = this._uniquePath(path);
    this.paths.add(p);
    this.files.push({ path: p, section, source: source || "generated", sha256: sha256(buf), bytes: buf.length, content: buf, binary });
    return p;
  }
  exclude({ section, source, reason, rules = [] }) { this.excluded.push({ section, source: String(source), reason, rules }); }
  note(line) { this.notes.push(line); }

  /** Gate + add a text document. Returns true when added. */
  addGatedText({ section, path, source, text, ctx = {}, needles }) {
    this.scanned.text++;
    const g = gateText(text, ctx, needles);
    if (!g.ok) { this.exclude({ section, source, reason: findingsReason(g.findings), rules: g.findings.flatMap((f) => f.rules) }); return false; }
    this.add({ section, path, source, content: text });
    return true;
  }
  /** Gate + add an allowlisted binary (image). Returns true when added. */
  addGatedBinary({ section, path, source, buf, needles }) {
    this.scanned.binary++;
    const d = binaryDecision(path, buf.length);
    if (!d.ok) { this.exclude({ section, source, reason: d.reason }); return false; }
    const g = gateBinary(buf, needles);
    if (!g.ok) { this.exclude({ section, source, reason: findingsReason(g.findings), rules: g.findings.flatMap((f) => f.rules) }); return false; }
    this.add({ section, path, source, content: buf, binary: true });
    return true;
  }
  countsBySection() {
    const out = {};
    for (const f of this.files) out[f.section] = (out[f.section] || 0) + 1;
    return out;
  }
  excludedBySection() {
    const out = {};
    for (const e of this.excluded) out[e.section] = (out[e.section] || 0) + 1;
    return out;
  }
}

// ---------------------------------------------------------------- ledger export

export const parseNdjson = (t) => String(t || "").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

export function ledgerCounts(rows) {
  const by = {};
  for (const r of rows) by[r.type || "unknown"] = (by[r.type || "unknown"] || 0) + 1;
  const ts = rows.map((r) => r.ts || "").filter(Boolean).sort();
  return { total: rows.length, by_type: by, first_ts: ts[0] || null, last_ts: ts[ts.length - 1] || null };
}

const clip = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").slice(0, n);

/** Latest value per entity key (entities superseded by a later row are dropped). */
export function latestValues(rows) {
  const superseded = new Set(rows.map((r) => r.supersedes).filter(Boolean));
  return rows.filter((r) => r.type === "entity" && !superseded.has(r.id)).sort((a, b) => String(a.ekey || "").localeCompare(String(b.ekey || "")));
}
export function corrections(rows) {
  return rows.filter((r) => r.type === "correction" || r.type === "correct").sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
}

/**
 * Export a ledger. SENSITIVE roles: counts only, never text (mirrors sunset-protocol). Other roles: every
 * entry through `entryGate(row) -> findings[]`; a tripped entry keeps id/ts/type and loses its content.
 * Returns { sensitive, counts, rows (gated), jsonl, md, redactions }.
 */
export function exportLedger({ role, rows, entryGate, generatedAt = new Date().toISOString() }) {
  const r = normalizeRole(role);
  const counts = ledgerCounts(rows);
  if (isSensitiveRole(r)) {
    return { sensitive: true, counts, rows: [], jsonl: null, md: renderCountsOnlyMd(r, counts, generatedAt), redactions: [] };
  }
  const kept = [], redactions = [];
  for (const row of rows) {
    const findings = entryGate ? entryGate(row) : [];
    if (findings.length) {
      const rules = [...new Set(findings.flatMap((f) => f.rules))];
      redactions.push({ id: row.id || null, ts: row.ts || null, type: row.type || null, kinds: [...new Set(findings.map((f) => f.kind))], rules });
      kept.push({ id: row.id, ts: row.ts, type: row.type, by: row.by, tags: [], text: `[WITHHELD by master-handoff-kit (${[...new Set(findings.map((f) => f.kind))].map((k) => `${k}-scan`).join("+")}; rule names ${rules.join(" ")}). The original entry ${row.id || "(no id)"} stays in the source ledger.]`, withheld: true });
    } else kept.push(row);
  }
  return { sensitive: false, counts, rows: kept, jsonl: kept.map((x) => JSON.stringify(x)).join("\n") + (kept.length ? "\n" : ""), md: renderLedgerMd(r, kept, counts, redactions, generatedAt), redactions };
}

export function renderCountsOnlyMd(role, counts, generatedAt) {
  return `# ${role.toUpperCase()} ledger: COUNTS ONLY (ring-protected)

Generated ${generatedAt} by ${TOOL_VERSION}.

The ${role.toUpperCase()} lane is a SENSITIVE ring (${role === "cfo" ? "finance / MNPI" : role === "capital" ? "securities" : "attorney-privileged"}).
Its ledger text is never exported into a handoff kit, exactly as the Sunset Transfer Protocol does not embed it
in the shared commons. This file carries counts and pointers only.

- entries: ${counts.total == null ? "unavailable from this seat" : counts.total}
- by type: ${counts.by_type ? Object.entries(counts.by_type).map(([k, v]) => `${k}=${v}`).join(", ") || "none" : "unavailable"}
- first entry: ${counts.first_ts || "n/a"}
- last entry: ${counts.last_ts || "n/a"}

## How the receiving agent gets the content
The ledger content stays home. The authorized ${role.toUpperCase()} seat reads its own ledger live
(\`mem.mjs pack --agent ${role}\` or the gateway \`memory_pack\` / \`memory_recall\` tools on the ${role} lane).
Do not ask any other seat or this kit for it.
`;
}

export function renderLedgerMd(role, rows, counts, redactions, generatedAt) {
  const fmt = (r) => `- [${String(r.ts || "").slice(0, 10)}] (${r.type || "?"}) ${String(r.text || "").replace(/\r?\n/g, " ")}${r.tags && r.tags.length ? `  _(#${r.tags.join(" #")})_` : ""}${r.source ? `  - ${r.source}` : ""}  \`${r.id}\``;
  const ent = latestValues(rows), cor = corrections(rows);
  const byTs = (a, b) => String(a.ts || "").localeCompare(String(b.ts || ""));
  let md = `# ${role.toUpperCase()} memory ledger: full export\n\n`;
  md += `> Generated ${generatedAt} by ${TOOL_VERSION}. This is a COMPLETE export of the ${role} ledger (${counts.total} entries; ${redactions.length} withheld by the secret/ring gate, see MANIFEST.md).\n`;
  md += `> The ledger is append-only and newest-wins: when two entries disagree, the later one is current. A \`correction\` records what was WRONG and what is RIGHT; keep both in mind. The machine-readable twin is \`${role}-ledger-full.jsonl\`.\n\n`;
  md += `Counts by type: ${Object.entries(counts.by_type).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}. First entry ${counts.first_ts || "n/a"}, last ${counts.last_ts || "n/a"}.\n\n`;
  md += `## LATEST VALUES (entities; latest wins per key)\n` + (ent.length ? ent.map((r) => `- \`${r.ekey}\` = ${r.evalue}${r.source ? `  (src: ${r.source})` : ""}  \`${r.id}\``).join("\n") : "- (none)") + "\n\n";
  md += `## CORRECTIONS (what was wrong vs what is right; newest first)\n` + (cor.length ? cor.map((r) => `- [${String(r.ts || "").slice(0, 10)}] WAS: ${r.was || "?"}  ->  NOW: ${r.text}${r.source ? `  - ${r.source}` : ""}  \`${r.id}\``).join("\n") : "- (none)") + "\n\n";
  md += `## ALL ENTRIES (chronological: id, date, type, text)\n` + (rows.length ? rows.slice().sort(byTs).map(fmt).join("\n") : "- (empty ledger)") + "\n";
  return md;
}

// ---------------------------------------------------------------- credential registry (names only)

/** Keep only the registry table from vault-registry's stdout (drop its trailing status lines). */
export function sanitizeRegistryOutput(stdout) {
  const s = String(stdout || "");
  const start = s.indexOf("# Credential Registry");
  if (start < 0) return "";
  const body = s.slice(start);
  const lines = body.split(/\r?\n/);
  const end = lines.findIndex((l) => /^\[vault-registry\]/.test(l) || /^\(dry:/.test(l));
  return (end >= 0 ? lines.slice(0, end) : lines).join("\n").trimEnd() + "\n";
}

/**
 * Assert the registry carries NAMES ONLY. Three independent checks, all must pass:
 *  1. secret gate layers A and B over the whole text (a live value, even inside a name cell, is caught here);
 *  2. every table row has exactly the 5 registry cells, the first being ONE backticked parameter NAME
 *     (letters, digits, / _ . -) and the other four short plain cells; no name segment is a long
 *     high-entropy run (a name is words, not a value);
 *  3. outside table rows, no 24+ char token that looks like a value.
 * Returns { ok, problems:[string] } (line numbers and rule names only, never a value).
 */
export function assertNamesOnly(text, needles = []) {
  const problems = [];
  for (const f of secretFindings({ registry: text }, needles)) problems.push(`secret gate: ${f.rules.join(", ")}`);
  const lines = String(text).split(/\r?\n/);
  const valueish = (tok) => tok.length >= 24 && !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(tok) && (valueLooksSecret(tok, { bare: true }) || (entropy(tok) >= 4.2 && /[0-9]/.test(tok) && /[A-Za-z]/.test(tok)));
  lines.forEach((line, i) => {
    const ln = i + 1;
    if (/^\|\s*-{3,}/.test(line)) return;                       // table separator
    if (/^\|/.test(line)) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.length !== 5) { problems.push(`malformed registry row on line ${ln}`); return; }
      if (/^SSM parameter name$|^Key Vault secret name$/.test(cells[0])) return; // header row
      const m = cells[0].match(/^`([A-Za-z0-9][A-Za-z0-9/_.-]{0,199})`$/);
      if (!m) { problems.push(`first cell on line ${ln} is not a single parameter NAME`); return; }
      if (m[1].split(/[/_.-]/).some((seg) => seg.length >= 28 && entropy(seg) >= 3.8)) problems.push(`value-looking name segment on line ${ln}`);
      if (cells.slice(1).some((c) => c.length > 40 || c.includes("`"))) problems.push(`unexpected cell content on line ${ln}`);
      return;
    }
    for (const mm of line.matchAll(/[A-Za-z0-9+/_=.-]{24,}/g)) if (valueish(mm[0]) && !/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(mm[0])) problems.push(`value-looking token on line ${ln}`);
  });
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------- media index

export function renderMediaIndex(catalog, { generatedAt = new Date().toISOString(), onedriveRoot = "5-Media/App Screenshots and Videos", s3Prefix = "_APP-MEDIA" } = {}) {
  const list = Array.isArray(catalog) ? catalog : [];
  const grouped = groupCatalog(list);
  const apps = Object.keys(grouped).sort();
  const L = [];
  L.push("# MEDIA INDEX (graphics are NOT in this kit)");
  L.push("");
  L.push(`Generated ${generatedAt} by ${TOOL_VERSION}. The binaries (screenshots, Device Farm videos, marketing renders) stay in the media library; this index tells you where each one lives.`);
  L.push("");
  L.push(`- OneDrive (human-facing): \`${onedriveRoot}/<app>/<version> (<build>)/<kind>/<filename>\``);
  L.push(`- S3 commons (machine-facing): \`${s3Prefix}/<app>/<version> (<build>)/<kind>/<filename>\`, machine catalog \`${s3Prefix}/catalog.json\`, rendered \`${s3Prefix}/INDEX.md\``);
  L.push(`- Add or re-archive media only through \`node skills/app-media/archive.mjs add ...\` (the single write path).`);
  L.push("");
  L.push(`Catalog total: ${list.length} file(s) across ${apps.length} app(s).`);
  L.push("");
  if (!list.length) L.push("(The catalog was empty or unavailable when this kit was built.)");
  for (const app of apps) {
    L.push(`## ${app}`);
    L.push("");
    for (const vf of Object.keys(grouped[app]).sort()) {
      L.push(`### ${vf}`);
      L.push("");
      for (const kind of Object.keys(grouped[app][vf]).sort()) {
        const files = grouped[app][vf][kind];
        L.push(`- **${kind}** (${files.length})`);
        for (const f of files.slice().sort((a, b) => String(a.filename).localeCompare(String(b.filename)))) {
          const od = `${onedriveRoot}/${app}/${vf}/${kind}/${f.filename}`;
          const s3 = f.s3Key || `${s3Prefix}/${app}/${vf}/${kind}/${f.filename}`;
          L.push(`  - ${f.filename} | OneDrive: ${od} | S3: ${s3}${f.sha256 ? ` | sha256: ${String(f.sha256).slice(0, 12)}` : ""}${f.source ? ` | source: ${f.source}` : ""}`);
        }
      }
      L.push("");
    }
  }
  return L.join("\n").replace(/[–—]/g, "-") + "\n";
}

// ---------------------------------------------------------------- repo docs (git show origin/main:<path>)

export function globToRegExp(glob) {
  let g = String(glob).trim().replace(/^\.\//, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { re += ".*"; i++; if (g[i + 1] === "/") i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export const repoName = (repoPath) => basename(resolve(repoPath));

/** Parse `--repo-docs repo:glob,repo:glob` into [{repo, glob}]. A glob may not contain a comma. */
export function parseRepoDocs(spec) {
  const out = [];
  for (const part of String(spec || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    if (i <= 0 || i === part.length - 1) throw new Error(`bad --repo-docs entry "${part}" (expected repo:path-or-glob)`);
    out.push({ repo: part.slice(0, i), glob: part.slice(i + 1) });
  }
  return out;
}

const defaultGit = (repoPath, args, opts = {}) => execFileSync("git", ["-C", repoPath, ...args], { encoding: opts.buffer ? "buffer" : "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

/** Resolve the ref a snapshot reads from: origin/main, else main. Returns { ref, sha } or null. NEVER the working tree. */
export function resolveMainRef(repoPath, git = defaultGit) {
  for (const ref of ["origin/main", "main"]) {
    try { const sha = String(git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim(); if (sha) return { ref, sha }; } catch { /* next */ }
  }
  return null;
}

/**
 * Collect repo-doc snapshots. Returns { docs:[{repo, path, sha, text}], missing:[{repo, pattern, reason}] }.
 * `repos` are local repo paths; `extra` is parseRepoDocs output (patterns added on top of the defaults).
 */
export function collectRepoDocs({ repos = [], extra = [], git = defaultGit } = {}) {
  const docs = [], missing = [];
  const byName = new Map(repos.map((p) => [repoName(p), p]));
  const patterns = new Map(); // repoName -> [pattern]
  for (const name of byName.keys()) patterns.set(name, [...DEFAULT_REPO_DOCS]);
  for (const { repo, glob } of extra) {
    const name = byName.has(repo) ? repo : repoName(repo);
    if (!byName.has(name)) { missing.push({ repo, pattern: glob, reason: "repo not in --repos" }); continue; }
    patterns.get(name).push(glob);
  }
  for (const [name, repoPath] of byName) {
    const ref = resolveMainRef(repoPath, git);
    if (!ref) { missing.push({ repo: name, pattern: "*", reason: "no origin/main or main ref in this clone" }); continue; }
    let tree = [];
    try { tree = String(git(repoPath, ["ls-tree", "-r", "--name-only", ref.ref])).split("\n").filter(Boolean); }
    catch (e) { missing.push({ repo: name, pattern: "*", reason: `cannot list ${ref.ref}: ${clip(e.message, 100)}` }); continue; }
    const seen = new Set();
    for (const pat of patterns.get(name)) {
      const re = globToRegExp(pat);
      const hit = tree.filter((f) => re.test(f));
      if (!hit.length) { if (!DEFAULT_REPO_DOCS.includes(pat)) missing.push({ repo: name, pattern: pat, reason: `no match on ${ref.ref}` }); continue; }
      for (const path of hit) {
        if (seen.has(path)) continue;
        seen.add(path);
        let buf;
        try { buf = git(repoPath, ["show", `${ref.ref}:${path}`], { buffer: true }); }
        catch (e) { missing.push({ repo: name, pattern: path, reason: `git show failed: ${clip(e.message, 100)}` }); continue; }
        docs.push({ repo: name, path, sha: ref.sha, ref: ref.ref, buf });
      }
    }
  }
  return { docs, missing };
}

// ---------------------------------------------------------------- session files (reuses the Stop hook)

/** Image files under a scratchpad root (depth <= 4), allowlisted types only, size-checked later by the gate. */
export function scanImages(root, { maxDepth = 4, limit = MAX_SESSION_IMAGES } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= limit) return;
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= limit) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (e.name === ".git" || e.name === "node_modules" || e.name.startsWith(".")) continue; if (existsSync(join(full, ".git"))) continue; walk(full, depth + 1); }
      else if (e.isFile() && isImageName(e.name)) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

// ---------------------------------------------------------------- manifest / verify docs

export function buildManifest({ role, date, builder, meta = {} }) {
  const folder = kitFolderName(role, date);
  const files = builder.files.map((f) => ({ path: f.path, section: f.section, source: f.source, sha256: f.sha256, bytes: f.bytes })).sort((a, b) => a.path.localeCompare(b.path));
  const excluded = builder.excluded.map((e) => ({ section: e.section, source: e.source, reason: e.reason, rules: e.rules || [] }));
  const json = {
    tool: TOOL_VERSION, kit: folder, role: normalizeRole(role), date, target_platform: meta.targetPlatform || null,
    generated_at: meta.generatedAt || new Date().toISOString(),
    self_describing_files: ["MANIFEST.md", "manifest.json"],
    counts: { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), excluded: excluded.length, withheld_ledger_entries: builder.redactions.length },
    sections: builder.countsBySection(),
    files, excluded, withheld_ledger_entries: builder.redactions,
  };
  return json;
}

/** Escape text for a Markdown table cell: backslash FIRST (so an existing backslash cannot swallow the next
 *  escape), then the pipe, then newlines. */
export function mdCell(v) {
  return String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderManifestMd(m) {
  const L = [];
  L.push(`# MANIFEST: ${m.kit}`);
  L.push("");
  L.push(`Generated ${m.generated_at} by ${m.tool}. Role: ${m.role}.${m.target_platform ? ` Target platform: ${m.target_platform}.` : ""}`);
  L.push(`${m.counts.files} file(s), ${m.counts.bytes} bytes. ${m.counts.excluded} source file(s) EXCLUDED. ${m.counts.withheld_ledger_entries} ledger entr${m.counts.withheld_ledger_entries === 1 ? "y" : "ies"} withheld.`);
  L.push("");
  L.push("`MANIFEST.md` and `manifest.json` are self-describing and are not hashed in the list below; every other file is. Verify with `node skills/master-handoff-kit/kit.mjs verify <zip>`.");
  L.push("");
  L.push("## Files");
  L.push("");
  L.push("| Kit path | Section | Source | sha256 | Bytes |");
  L.push("|---|---|---|---|---|");
  for (const f of m.files) L.push(`| \`${f.path}\` | ${f.section} | ${mdCell(f.source)} | \`${f.sha256}\` | ${f.bytes} |`);
  L.push("");
  L.push("## Excluded (nothing is dropped silently)");
  L.push("");
  if (!m.excluded.length) L.push("(none)");
  else {
    L.push("| Section | Source | Reason |");
    L.push("|---|---|---|");
    for (const e of m.excluded) L.push(`| ${e.section} | ${mdCell(e.source)} | ${mdCell(e.reason)} |`);
  }
  L.push("");
  L.push("## Ledger entries withheld by the gates");
  L.push("");
  if (!m.withheld_ledger_entries.length) L.push("(none)");
  else {
    // The gate column says "secret-scan" / "ring-scan" (not the bare word "secret") so this meta document can
    // never read as a labeled credential row to the very secret gate that verify re-runs over it.
    L.push("| Entry id | Date | Entry type | Scan | Rule names |");
    L.push("|---|---|---|---|---|");
    for (const r of m.withheld_ledger_entries) L.push(`| ${r.id || "?"} | ${String(r.ts || "").slice(0, 10)} | ${r.type || "?"} | ${(r.kinds || []).map((k) => `${k}-scan`).join("+")} | ${(r.rules || []).join(", ")} |`);
  }
  L.push("");
  return L.join("\n");
}

export function renderVerifyMd({ role, date, builder, needleCount, registry, ledger }) {
  const secretRefusals = builder.excluded.filter((e) => /secret gate/.test(e.reason)).length;
  const ringRefusals = builder.excluded.filter((e) => /ring gate/.test(e.reason)).length;
  const other = builder.excluded.length - builder.excluded.filter((e) => /(secret|ring) gate/.test(e.reason)).length;
  const L = [];
  L.push(`# VERIFY: ${kitFolderName(role, date)}`);
  L.push("");
  L.push(`Gate results for ${TOOL_VERSION}. Every text file, ledger entry and image passed brain-save's secret gate (layer A credential shapes + layer B live SSM secret values${needleCount ? `, ${needleCount} live needles` : ""}) and ring gate before entering this kit. Fail-closed: a tripped file is excluded and listed in MANIFEST.md.`);
  L.push("");
  L.push(`- text files scanned: ${builder.scanned.text}`);
  L.push(`- binary files scanned: ${builder.scanned.binary}`);
  L.push(`- ledger entries scanned: ${builder.scanned.entries}${ledger && ledger.sensitive ? " (sensitive role: counts only, no entry text exported)" : ""}`);
  L.push(`- refused by the secret gate: ${secretRefusals}`);
  L.push(`- refused by the ring gate: ${ringRefusals}`);
  L.push(`- excluded for other reasons (size, type, unreadable, missing): ${other}`);
  L.push(`- ledger entries withheld (content stubbed, id/date/type kept): ${builder.redactions.length}`);
  L.push(`- credential registry: ${registry && registry.ok ? "names only, asserted clean" : registry ? `NOT INCLUDED (${registry.reason})` : "not requested"}`);
  L.push("");
  if (builder.notes.length) { L.push("## Notes"); L.push(""); for (const n of builder.notes) L.push(`- ${n}`); L.push(""); }
  L.push("Re-run the check any time: `node skills/master-handoff-kit/kit.mjs verify <zip>`.");
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------- the README for the NEW agent

export function agentDescription(agentDefText) {
  const { frontmatter } = parseFrontmatter(agentDefText || "");
  return clip(frontmatter.description || "", 600);
}

export function renderReadme({ role, date, targetPlatform, builder, agentDef, hasHandoff, hasPlaybook, hasLedger, ledgerSensitive }) {
  const R = role.toUpperCase();
  const desc = agentDescription(agentDef);
  const sections = builder.countsBySection();
  const coreDocs = builder.files.filter((f) => f.section === "core").map((f) => f.path);
  const L = [];
  L.push(`# ${kitFolderName(role, date)}: START HERE`);
  L.push("");
  L.push(`You are the new **${R}** agent${targetPlatform ? ` on **${targetPlatform}**` : " on a new AI platform"}. Treat yourself as brand new: you have NO prior context and NO memory of this work. This kit is everything the previous ${R} seat knew, packaged so you can continue without asking Matt to re-explain. Nothing in it is a secret: credentials appear by NAME only, and every file passed a fail-closed secret and ring gate.`);
  L.push("");
  if (desc) { L.push(`**Your role, in one line:** ${desc}`); L.push(""); }
  L.push("## Reading order");
  L.push("");
  L.push("1. This file.");
  let n = 2;
  for (const p of coreDocs) L.push(`${n++}. \`${p}\` (core document supplied for this transfer)`);
  if (hasHandoff) L.push(`${n++}. \`handoff/\`: the Sunset handoff doc (who you are, ring, how to attach) and your agent definition.${hasPlaybook ? " The DEVELOPER-PLAYBOOK is your operating manual: read sections 1 and 2 first." : ""}`);
  L.push(`${n++}. \`memories/\`: ${hasLedger ? (ledgerSensitive ? "COUNTS ONLY (your lane is ring-protected; the content stays home, read it live from your own seat)" : "the complete memory ledger. Read the markdown (latest values and corrections first); the JSONL is the machine-readable twin. When two entries disagree, the later one wins.") : "ledger export was not requested or unavailable (see VERIFY.md)"}.`);
  L.push(`${n++}. \`repo-docs/<repo>/...\`: the standing operating docs of every repo you work in (CLAUDE.md, AGENTS.md, HANDOFF.md, README.md), read from origin/main, never a working tree. Each repo's HANDOFF.md "Next up" is the live to-do list.`);
  L.push(`${n++}. \`session-files/\`: documents the last session produced that were not yet in the company brain (specs, receipts, review packets), with their original relative paths.`);
  L.push(`${n++}. \`credentials/CREDENTIAL-REGISTRY-names-only.md\`: which credentials exist and where (names, never values).`);
  L.push(`${n++}. \`media/MEDIA-INDEX.md\`: where every screenshot, video and graphic lives (OneDrive and S3). The graphics themselves are not in this kit.`);
  L.push(`${n++}. \`MANIFEST.md\` / \`manifest.json\`: every file with its source, sha256 and size, plus every EXCLUDED file and why. \`VERIFY.md\`: the gate results.`);
  L.push("");
  L.push("## What is in this kit");
  L.push("");
  for (const [k, v] of Object.entries(sections).sort()) L.push(`- ${k}: ${v} file(s)`);
  L.push("");
  L.push("## How to reach the company brain and the gateway");
  L.push("");
  L.push("- **The OTCHealth MCP gateway** is the single connector for the whole stack: `https://mcp.otchealth.app/mcp` (health: `https://mcp.otchealth.app/health`). It speaks MCP over HTTP with OAuth 2.1. Connect it as a custom MCP connector in your platform; the connect flow shows a short one-time setup code page where Matt (or an already-connected CTO seat via `connector_setup_code_create`) provides the code that binds your connector to your role. Platforms with static seat tokens use a per-seat bearer in an environment variable, never inline in a config file. A token is a credential: it is NOT in this kit.");
  L.push("- **First calls once connected:** `wake` (your role, doctrine and pending work), `memory_pack` / `memory_recall` (your ledger), `brain_search` (the company brain, cited answers), `kb_search`, `catalog_list_tools` (everything the gateway can do for your lane), `checkpoint` (write your session state back).");
  L.push("- **Ground-first protocol:** for any question about the company, finances, legal matters, operations, product, people, customers or INND, call `brain_search` FIRST and answer only from retrieved results with citations. For public-world questions use `web_search`. Never send confidential, personal, legal, customer or PHI content to web search.");
  L.push("- **Where truth lives:** the memory ledger and company brain beat this kit; a source document or git commit beats a summary; the newest dated entry wins. This kit is a snapshot taken on " + date + ".");
  L.push("- **Secrets** live in AWS SSM Parameter Store under `/otchealth/*`. You get values only through the gateway or the credential path Matt grants your seat. Never paste a value into chat, a repo or a document; reference the NAME.");
  L.push("");
  L.push("## First-hour checklist");
  L.push("");
  L.push("1. Read this file, the core documents and `handoff/`, then the memory ledger (latest values and corrections first).");
  L.push("2. Connect the gateway connector for your role; call `wake`, then `brain_search` for \"current " + role + " state and what is pending\". Confirm the answers agree with this kit; if they conflict, the live brain wins and you record the correction.");
  L.push("3. Read each repo's `HANDOFF.md` (\"Next up\") and `CLAUDE.md` in `repo-docs/`. Rebuild your working checkout from the real repos; never edit from this snapshot.");
  L.push("4. Read `session-files/` for in-flight work that was not yet saved anywhere else, and save any you still need with `brain-save`.");
  L.push("5. Write through every fact, decision, correction and pitfall you learn the moment it happens (`memory_remember` / `checkpoint`). The chat is disposable; the ledger is the memory.");
  L.push("6. Report back to Matt with what you now understand, what you will do first, and any real conflicts you found. One short message, no technical homework for him.");
  L.push("");
  L.push("## The two standing mandates");
  L.push("");
  L.push("1. **Do all the work.** Matt is not a developer. Never hand him a command, file, setting, dashboard, build, merge or test. If you have the access or ability, do it end to end and report the verified result. Exhaust every route (gateway, APIs, skills, scripted flows) before calling anything blocked. Involve Matt only for decisions that are his (product, pricing, spend, claims, legal, investor-facing, production approvals) and physical or identity gates no agent can pass (his 2FA, a payment card or KYC, a legal e-signature, an OAuth consent only his account can approve). When he is needed, make it one tap: all prep done, one plain question with a recommendation. This never overrides the hard rules (no secrets in repos, no PHI on non-BAA runtimes, no unsanctioned INND/securities disclosure, no false claims, branch protection).");
  L.push("2. **Continuous improvement.** Do not just operate the function; make it better. For every action ask whether it could be faster, cheaper, more reliable, more provable, better looking or safer, and quantify any gain. Fix the bugs you hit, remove manual steps, add the verbs you keep wishing existed, and write each improvement back to the playbook or skill in a PR. Copying today's process unchanged is the minimum.");
  L.push("");
  L.push("## Ground rules that survive any platform");
  L.push("");
  L.push("- Branch discipline: `claude/*` or equivalent feature branches, draft PRs, never push main directly, no force-push.");
  L.push("- Rings: PHI never touches a non-BAA runtime; privileged, personal-legal, CFO and INND-investor content stays in its lane; do not export it anywhere shared.");
  L.push("- No em dashes or en dashes in published copy (use commas, periods or line breaks).");
  L.push("- No medical, treatment or FDA claims; no cure or dementia claims. Compliance gates in the repo docs apply.");
  L.push("");
  L.push(`_Built by ${TOOL_VERSION} on ${date}. Questions about the kit itself: re-run \`verify\` and read MANIFEST.md._`);
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------- zip + verify (fs / process helpers)

export function zipTool() {
  for (const bin of ["zip", "python3"]) { const r = spawnSync(bin, bin === "zip" ? ["-v"] : ["--version"], { stdio: "ignore" }); if (!r.error && r.status === 0) return bin; }
  throw new Error("neither the zip CLI nor python3 is available to create the archive");
}

/** Write every kit file under <parent>/<folder>/ and return the folder path. */
export function writeKitDir(parent, folder, files) {
  const root = join(parent, folder);
  for (const f of files) {
    const dest = join(root, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.content);
  }
  return root;
}

export function zipFolder(parent, folder, outZip) {
  const tool = zipTool();
  if (existsSync(outZip)) { try { writeFileSync(outZip, ""); } catch { /* overwritten below */ } }
  if (tool === "zip") {
    const r = spawnSync("zip", ["-r", "-X", "-q", resolve(outZip), folder], { cwd: parent, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`zip failed: ${clip(r.stderr || r.stdout, 200)}`);
  } else {
    const py = "import sys,os,zipfile\nout,parent,folder=sys.argv[1:4]\nz=zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED)\nfor d,_,fs in os.walk(os.path.join(parent,folder)):\n  for f in sorted(fs):\n    p=os.path.join(d,f); z.write(p, os.path.relpath(p,parent))\nz.close()\n";
    const r = spawnSync("python3", ["-c", py, resolve(outZip), parent, folder], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`python zip failed: ${clip(r.stderr, 200)}`);
  }
  return outZip;
}

export function unzipTo(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const u = spawnSync("unzip", ["-q", "-o", resolve(zipPath), "-d", destDir], { encoding: "utf8" });
  if (!u.error && u.status === 0) return destDir;
  const py = "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nz.extractall(sys.argv[2])\n";
  const r = spawnSync("python3", ["-c", py, resolve(zipPath), destDir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cannot extract ${zipPath}: ${clip(r.stderr || (u.stderr || ""), 200)}`);
  return destDir;
}

function walkFiles(root) {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) out.push(p); } };
  walk(root);
  return out;
}

/**
 * Verify an extracted kit directory: manifest present and well formed, every listed file present with a
 * matching sha256/size, no unlisted extra file, and the secret gate re-run over EVERY file (text via
 * layers A+B, binaries via the latin1 view). Returns { ok, checked, problems:[string] }.
 */
export function verifyKitDir(dir, needles = []) {
  const problems = [];
  const mpath = join(dir, "manifest.json");
  if (!existsSync(mpath)) return { ok: false, checked: 0, problems: ["manifest.json is missing"] };
  let m;
  try { m = JSON.parse(readFileSync(mpath, "utf8")); } catch { return { ok: false, checked: 0, problems: ["manifest.json is not valid JSON"] }; }
  if (!Array.isArray(m.files)) return { ok: false, checked: 0, problems: ["manifest.json has no files array"] };
  const listed = new Map(m.files.map((f) => [f.path, f]));
  const self = new Set(m.self_describing_files || ["MANIFEST.md", "manifest.json"]);
  const onDisk = walkFiles(dir).map((p) => relative(dir, p).split(sep).join("/"));
  for (const rel of onDisk) if (!listed.has(rel) && !self.has(rel)) problems.push(`unlisted file in the kit: ${rel}`);
  for (const [rel, f] of listed) {
    const full = join(dir, rel);
    if (!existsSync(full)) { problems.push(`manifest lists a missing file: ${rel}`); continue; }
    const buf = readFileSync(full);
    if (sha256(buf) !== f.sha256) problems.push(`sha256 mismatch: ${rel}`);
    if (buf.length !== f.bytes) problems.push(`size mismatch: ${rel}`);
  }
  let checked = 0;
  for (const rel of onDisk) {
    const buf = readFileSync(join(dir, rel));
    checked++;
    const isBin = isImageName(rel);
    const findings = isBin ? gateBinary(buf, needles).findings : secretFindings({ file: buf.toString("utf8") }, needles);
    for (const f of findings) problems.push(`secret gate tripped on ${rel}: ${f.rules.join(", ")}`);
  }
  return { ok: problems.length === 0, checked, problems, manifest: m };
}

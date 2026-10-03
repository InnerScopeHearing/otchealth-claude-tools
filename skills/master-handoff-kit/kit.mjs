#!/usr/bin/env node
// kit.mjs -- master-handoff-kit CLI. Builds the complete starter kit that moves an agent's knowledge,
// context, content, memories and pointers to a brand-new agent on a different AI platform, as one ZIP
// (and uploads it to OneDrive). Fail-closed: every file passes brain-save's secret + ring gates.
//
//   node skills/master-handoff-kit/kit.mjs build --agent <role> [--session-id <id>] [--scratch <dir>]
//        [--repos a,b] [--repo-docs repo:glob,...] [--include <file-or-dir> ...] [--target-platform <name>]
//        [--out <dir>] [--onedrive "CTO Incoming/<folder>"] [--dry-run] [--no-upload] [--cwd <dir>]
//   node skills/master-handoff-kit/kit.mjs verify <zip>
//   node skills/master-handoff-kit/kit.mjs help
//
// Exit codes: 0 ok, 1 error, 2 refused (the secret-value set could not be loaded, or verify found a leak).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  KitBuilder, TOOL_VERSION, LANE_STORE, normalizeRole, isSensitiveRole, kitFolderName, kitZipName, todayStamp, pad2, relPreserve,
  classifyFile, secretFindings, findingsReason, parseNdjson, exportLedger, sanitizeRegistryOutput, assertNamesOnly,
  renderMediaIndex, collectRepoDocs, parseRepoDocs, scanImages, buildManifest, renderManifestMd, renderVerifyMd, renderReadme, writeKitDir,
  zipFolder, unzipTo, verifyKitDir,
} from "./lib.mjs";
import { renderHandoff } from "../sunset-protocol/protocol.mjs";
import { loadSecretNeedles } from "../brain-save/lib/secret-values.mjs";
import { withTimeout, ssmTimeoutMs } from "../brain-save/lib/deadline.mjs";
import { classifyRing } from "../brain-save/lib/ring-gate.mjs";
import { findScratchpads, scanFolder, candidateRepos, unsavedFiles, stateDir, gitChanged, hookSeat } from "../brain-save/hooks/unsaved-reminder.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SESSION_SCAN_DEPTH = 8;
export const SESSION_SCAN_LIMIT = 5000;
/** Total bytes of session files one kit will carry; the rest are listed as excluded (graphics and bulk stay in their libraries). */
export const SESSION_BYTES_BUDGET = 150 * 1024 * 1024;
const TOOLKIT = resolve(HERE, "..", "..");

// ---------------------------------------------------------------- args

const BOOL_FLAGS = new Set(["--dry-run", "--no-upload", "--json", "--help", "-h"]);
const MULTI_FLAGS = new Set(["--include"]);

export function parseArgs(argv) {
  const out = { _: [], flags: {}, include: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) { out._.push(a); continue; }
    if (BOOL_FLAGS.has(a)) { out.flags[a] = true; continue; }
    const eq = a.indexOf("=");
    let name = a, val;
    if (eq > 0) { name = a.slice(0, eq); val = a.slice(eq + 1); }
    else { val = argv[i + 1]; if (val === undefined || (val.startsWith("--") && val.length > 2)) throw new Error(`${a} needs a value`); i++; }
    if (MULTI_FLAGS.has(name)) out.include.push(val); else out.flags[name] = val;
  }
  return out;
}
const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------- default (real) dependencies

async function defaultReadLedger(role, seat) {
  if (role === "clo-personal" && seat !== "clo-personal") return { rows: null, reason: "the clo-personal ledger is segregated in both directions: only the clo-personal seat may read it, even to count it" };
  let err = "";
  try {
    let text;
    if (LANE_STORE[role]) { const { getTextFromS3 } = await import("../kb-memory/s3-blob.mjs"); text = await getTextFromS3(LANE_STORE[role].account, LANE_STORE[role].container, `_MEMORY/${role}.jsonl`); }
    else { const { cGet } = await import("../kb-memory/commons-store.mjs"); text = await cGet(`_MEMORY/${role}.jsonl`); }
    if (text != null) return { rows: parseNdjson(text), source: "s3" };
    err = "no ledger object found";
  } catch (e) { err = String((e && e.message) || e).slice(0, 160); }
  if (!isSensitiveRole(role)) {
    const f = join(homedir(), ".claude", "kb-cache", `${role}.jsonl`);
    if (existsSync(f)) { try { return { rows: parseNdjson(readFileSync(f, "utf8")), source: "local-cache", warning: `used the local write-through cache because the store read failed (${err})` }; } catch { /* fall through */ } }
  }
  return { rows: null, reason: err };
}
async function defaultReadHandoff(role) { try { const { cGet } = await import("../kb-memory/commons-store.mjs"); return await cGet(`_HANDOFF/${role}.md`); } catch { return null; } }
async function defaultReadRegistry() {
  const r = spawnSync("node", [join(TOOLKIT, "skills", "vault-sync", "vault-registry.mjs"), "--dry", "--print"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
  if (r.status !== 0) return { text: null, reason: `vault-registry exited ${r.status}: ${String(r.stderr || "").slice(-160).replace(/\s+/g, " ")}` };
  return { text: r.stdout };
}
async function defaultReadMediaCatalog() {
  try { const { cGet } = await import("../kb-memory/commons-store.mjs"); const t = await cGet("_APP-MEDIA/catalog.json"); return t == null ? null : JSON.parse(t); } catch { return null; }
}
function readJsonl(file) { try { return parseNdjson(readFileSync(file, "utf8")); } catch { return []; } }
function toolkitDoc(rel) {
  // Prefer origin/main of the toolkit repo (never an edited working tree); fall back to the checkout.
  for (const ref of ["origin/main", "main"]) {
    try { return { text: execFileSync("git", ["-C", TOOLKIT, "show", `${ref}:${rel}`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }), source: `toolkit ${ref}:${rel}` }; } catch { /* next */ }
  }
  const f = join(TOOLKIT, rel);
  return existsSync(f) ? { text: readFileSync(f, "utf8"), source: `toolkit working tree:${rel}` } : null;
}

export async function realDeps() {
  const seat = hookSeat();
  return {
    seat,
    loadNeedles: async () => (await withTimeout(loadSecretNeedles(), ssmTimeoutMs(), "SSM secret-value enumeration")).needles,
    readLedger: (role) => defaultReadLedger(role, seat),
    readHandoff: defaultReadHandoff,
    readRegistry: defaultReadRegistry,
    readMediaCatalog: defaultReadMediaCatalog,
    toolkitDoc,
    receipts: () => readJsonl(join(stateDir(), "receipts.jsonl")),
    refusals: () => readJsonl(join(stateDir(), "refused.jsonl")),
    git: undefined,
    tmpRoot: "/tmp",
  };
}

// ---------------------------------------------------------------- assembly (pure orchestration; fakes inject in tests)

function walkDir(root, limit = 2000) {
  const out = [];
  const walk = (d) => {
    if (out.length >= limit) return;
    let ents = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return;
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile()) out.push(p);
    }
  };
  walk(root);
  return out;
}

function addDiskFile(builder, { section, kitPath, abs, needles, ctx = {} }) {
  let buf;
  try { buf = readFileSync(abs); } catch (e) { builder.exclude({ section, source: abs, reason: `unreadable (${String(e.code || e.message).slice(0, 60)})` }); return false; }
  const c = classifyFile(abs, buf);
  if (c.type === "rejected") { builder.exclude({ section, source: abs, reason: c.reason }); return false; }
  let real = abs; try { real = realpathSync(abs); } catch { /* keep */ }
  if (c.type === "image") return builder.addGatedBinary({ section, path: kitPath, source: abs, buf, needles });
  return builder.addGatedText({ section, path: kitPath, source: abs, text: buf.toString("utf8"), ctx: { localPath: abs, realPath: real, relPath: kitPath, ...ctx }, needles });
}

/** Gate for ONE ledger entry: secret (whole JSON row) + ring (its prose). Returns findings[]. */
export function gateLedgerEntry(row, role, needles) {
  const findings = [...secretFindings({ row: JSON.stringify(row) }, needles)];
  const prose = [row.text, row.was, row.evalue].filter(Boolean).join("\n");
  if (prose) {
    const res = classifyRing({ text: prose, localPath: `memories/${role}-ledger` });
    if (!res.allowed) findings.push({ kind: "ring", rules: [...res.hard, ...res.heuristic].map((s) => s.code), detail: "ring signal in entry text" });
  }
  return findings;
}

/** Session documents not yet in the brain. Reuses the Stop hook's discovery functions unchanged. */
export function collectSessionItems({ sessionId, cwd, scratchDirs = [], repos = [], tmpRoot = "/tmp", receipts = [], refusals = [], gitChangedFn = gitChanged }) {
  const notes = [];
  const roots = [...new Set([...scratchDirs.map((d) => resolve(d)), ...(sessionId ? findScratchpads(sessionId, tmpRoot) : [])])].filter((d) => existsSync(d));
  if (sessionId && !roots.length && !scratchDirs.length) notes.push(`no scratchpad found for session ${sessionId} under ${tmpRoot}/claude-*`);
  const docCandidates = new Map(); // abs -> rel
  const images = new Map();
  for (const root of roots) {
    const found = scanFolder(root, { maxDepth: SESSION_SCAN_DEPTH, limit: SESSION_SCAN_LIMIT });
    if (found.length >= SESSION_SCAN_LIMIT) notes.push(`scratchpad ${root} hit the ${SESSION_SCAN_LIMIT}-file scan cap; later files were not considered (raise SESSION_SCAN_LIMIT or use --scratch on a narrower folder)`);
    for (const f of found) docCandidates.set(f, relPreserve(root, f));
    for (const f of scanImages(root)) images.set(f, relPreserve(root, f));
  }
  return (async () => {
    const repoSet = [...new Set([...(cwd ? candidateRepos(cwd) : []), ...repos.map((r) => resolve(r))])];
    const changed = await Promise.all(repoSet.map((r) => Promise.resolve(gitChangedFn(r)).then((l) => ({ repo: r, files: l || [] })).catch(() => ({ repo: r, files: [] }))));
    for (const { repo, files } of changed) for (const f of files) if (!docCandidates.has(f)) docCandidates.set(f, `${basename(repo)}/${relPreserve(repo, f)}`);
    const all = [...docCandidates.keys()];
    const unsaved = new Set(unsavedFiles(all, receipts, refusals));
    const skipped = all.length - unsaved.size;
    if (skipped > 0) notes.push(`${skipped} candidate document(s) were skipped: already saved to the brain (receipt match), refused by design, or outside the 200 byte to 2 MB window`);
    const items = [...unsaved].map((abs) => ({ abs, rel: docCandidates.get(abs), kind: "doc" }));
    for (const [abs, rel] of images) items.push({ abs, rel, kind: "image" });
    return { items, notes };
  })();
}

/**
 * Assemble the kit in memory. Returns { builder, files (incl. MANIFEST.md + manifest.json), manifest, summary }.
 * Nothing is written to disk and nothing is uploaded here.
 */
export async function assembleKit(opts, deps) {
  const role = normalizeRole(opts.role);
  const date = opts.date || todayStamp();
  const generatedAt = (opts.now || new Date()).toISOString();
  const needles = await deps.loadNeedles();
  const builder = new KitBuilder({ role, date });
  const sensitive = isSensitiveRole(role);

  // --- 01..N core docs (--include, in the given order) ---
  let n = 0;
  for (const inc of opts.includes || []) {
    const abs = resolve(inc);
    let st; try { st = statSync(abs); } catch { builder.exclude({ section: "core", source: inc, reason: "path does not exist" }); continue; }
    n++;
    if (st.isDirectory()) {
      const dname = `${pad2(n)}-${basename(abs)}`;
      for (const f of walkDir(abs)) addDiskFile(builder, { section: "core", kitPath: `${dname}/${relPreserve(abs, f)}`, abs: f, needles });
    } else addDiskFile(builder, { section: "core", kitPath: `${pad2(n)}-${basename(abs)}`, abs, needles });
  }

  // --- memories ---
  const led = await deps.readLedger(role);
  const rows = led && Array.isArray(led.rows) ? led.rows : null;
  if (led && led.warning) builder.note(led.warning);
  let ledgerInfo;
  if (rows) {
    builder.scanned.entries = sensitive ? 0 : rows.length;
    // Fast path: if the whole ledger text is secret-clean, per-entry secret findings are all empty (ring still runs per entry).
    const ex = exportLedger({ role, rows, entryGate: (row) => gateLedgerEntry(row, role, needles), generatedAt });
    builder.redactions.push(...ex.redactions);
    ledgerInfo = { sensitive: ex.sensitive, counts: ex.counts };
    const out = [];
    if (ex.sensitive) out.push([`memories/${role}-ledger-COUNTS-ONLY.md`, ex.md]);
    else { out.push([`memories/${role}-ledger-full.jsonl`, ex.jsonl]); out.push([`memories/${role}-ledger.md`, ex.md]); }
    for (const [path, content] of out) {
      builder.scanned.text++;
      const f = secretFindings({ file: content }, needles); // belt and braces over the assembled files
      if (f.length) builder.exclude({ section: "memories", source: path, reason: findingsReason(f), rules: f.flatMap((x) => x.rules) });
      else builder.add({ section: "memories", path, source: `ledger _MEMORY/${role}.jsonl (${led.source || "store"})`, content });
    }
  } else {
    const counts = { total: null, by_type: null, first_ts: null, last_ts: null };
    builder.exclude({ section: "memories", source: `_MEMORY/${role}.jsonl`, reason: `ledger unavailable: ${led && led.reason ? led.reason : "unknown"}` });
    if (sensitive) { const ex = exportLedger({ role, rows: [], generatedAt }); builder.add({ section: "memories", path: `memories/${role}-ledger-COUNTS-ONLY.md`, source: "generated", content: ex.md.replace(/- entries: 0/, "- entries: unavailable from this seat") }); }
    ledgerInfo = { sensitive, counts };
  }

  // --- handoff ---
  const hText = await deps.readHandoff(role);
  let handoffText = hText, handoffSource = `commons _HANDOFF/${role}.md`;
  if (!handoffText) { handoffText = renderHandoff(role, rows || [], 0); handoffSource = "generated by sunset-protocol renderHandoff (no commons handoff found)"; }
  const hAdded = builder.addGatedText({ section: "handoff", path: `handoff/HANDOFF-${role}.md`, source: handoffSource, text: handoffText, ctx: { relPath: `handoff/HANDOFF-${role}.md` }, needles });
  const agentDoc = deps.toolkitDoc(`dream-team/agents/${role}.md`);
  let agentDefText = "";
  if (agentDoc) { if (builder.addGatedText({ section: "handoff", path: `handoff/AGENT-DEFINITION-${role}.md`, source: agentDoc.source, text: agentDoc.text, ctx: { relPath: `handoff/AGENT-DEFINITION-${role}.md` }, needles })) agentDefText = agentDoc.text; }
  else builder.note(`no agent definition at dream-team/agents/${role}.md (the role may not have a card); the handoff doc and ledger still describe the seat`);
  let hasPlaybook = false;
  if (role === "developer") {
    const pb = deps.toolkitDoc("dream-team/DEVELOPER-PLAYBOOK.md");
    if (pb) hasPlaybook = builder.addGatedText({ section: "handoff", path: "handoff/DEVELOPER-PLAYBOOK.md", source: pb.source, text: pb.text, ctx: { relPath: "handoff/DEVELOPER-PLAYBOOK.md" }, needles });
    else builder.exclude({ section: "handoff", source: "dream-team/DEVELOPER-PLAYBOOK.md", reason: "not found in the toolkit" });
  }

  // --- credential registry (names only) ---
  let registry = null;
  const reg = await deps.readRegistry();
  if (reg && reg.text) {
    const clean = sanitizeRegistryOutput(reg.text);
    builder.scanned.text++;
    const a = clean ? assertNamesOnly(clean, needles) : { ok: false, problems: ["registry output was empty or malformed"] };
    if (a.ok) { builder.add({ section: "credentials", path: "credentials/CREDENTIAL-REGISTRY-names-only.md", source: "skills/vault-sync/vault-registry.mjs --dry --print", content: clean }); registry = { ok: true }; }
    else { builder.exclude({ section: "credentials", source: "vault-registry --dry --print", reason: `names-only assertion failed: ${a.problems.join("; ")}` }); registry = { ok: false, reason: a.problems.join("; ") }; }
  } else { builder.exclude({ section: "credentials", source: "vault-registry --dry --print", reason: `registry unavailable: ${(reg && reg.reason) || "no output"}` }); registry = { ok: false, reason: (reg && reg.reason) || "unavailable" }; }

  // --- repo docs (git show origin/main:<path>, never the working tree) ---
  const repos = opts.repos || [];
  if (repos.length) {
    const { docs, missing } = collectRepoDocs({ repos, extra: parseRepoDocs(opts.repoDocs || ""), git: deps.git });
    for (const d of docs) {
      const kitPath = `repo-docs/${d.repo}/${d.path}`;
      const source = `${d.repo}@${d.sha.slice(0, 7)} (${d.ref}):${d.path}`;
      const c = classifyFile(d.path, d.buf);
      if (c.type === "rejected") { builder.exclude({ section: "repo-docs", source, reason: c.reason }); continue; }
      if (c.type === "image") { builder.addGatedBinary({ section: "repo-docs", path: kitPath, source, buf: d.buf, needles }); continue; }
      builder.addGatedText({ section: "repo-docs", path: kitPath, source, text: d.buf.toString("utf8"), ctx: { source: `${d.repo}@${d.sha.slice(0, 7)}:${d.path}`, sourceRepo: d.repo, localPath: `${d.repo}/${d.path}`, relPath: kitPath }, needles });
    }
    for (const m of missing) builder.exclude({ section: "repo-docs", source: `${m.repo}:${m.pattern}`, reason: m.reason });
  }

  // --- session files ---
  if (opts.sessionId || (opts.scratch && opts.scratch.length)) {
    const sess = await collectSessionItems({ sessionId: opts.sessionId, cwd: opts.cwd, scratchDirs: opts.scratch || [], repos, tmpRoot: deps.tmpRoot || "/tmp", receipts: deps.receipts ? deps.receipts() : [], refusals: deps.refusals ? deps.refusals() : [], gitChangedFn: deps.gitChanged || gitChanged });
    sess.notes.forEach((x) => builder.note(x));
    let sessionBytes = 0;
    for (const it of sess.items) {
      let size = 0; try { size = statSync(it.abs).size; } catch { /* addDiskFile reports unreadable */ }
      if (sessionBytes + size > (opts.sessionBytesBudget || SESSION_BYTES_BUDGET)) { builder.exclude({ section: "session-files", source: it.abs, reason: `kit size budget reached (${opts.sessionBytesBudget || SESSION_BYTES_BUDGET} bytes of session files); this file was not included` }); continue; }
      if (addDiskFile(builder, { section: "session-files", kitPath: `session-files/${it.rel}`, abs: it.abs, needles })) sessionBytes += size;
    }
  }

  // --- media index ---
  const catalog = await deps.readMediaCatalog();
  builder.scanned.text++;
  const mediaMd = renderMediaIndex(catalog || [], { generatedAt });
  const mf = secretFindings({ file: mediaMd }, needles);
  if (mf.length) builder.exclude({ section: "media", source: "app-media catalog", reason: findingsReason(mf), rules: mf.flatMap((x) => x.rules) });
  else builder.add({ section: "media", path: "media/MEDIA-INDEX.md", source: catalog ? "app-media _APP-MEDIA/catalog.json" : "app-media catalog unavailable (empty index)", content: mediaMd });
  if (!catalog) builder.note("the app-media catalog was unavailable or empty; MEDIA-INDEX.md says so");

  // --- VERIFY.md and the README (generated, root) ---
  builder.add({ section: "root", path: "VERIFY.md", source: "generated", content: renderVerifyMd({ role, date, builder, needleCount: needles.length, registry, ledger: ledgerInfo }) });
  builder.add({ section: "root", path: "00-README-START-HERE.md", source: "generated", content: renderReadme({ role, date, targetPlatform: opts.targetPlatform, builder, agentDef: agentDefText, hasHandoff: hAdded, hasPlaybook, hasLedger: Boolean(rows), ledgerSensitive: sensitive }) });

  // --- MANIFEST ---
  const manifest = buildManifest({ role, date, builder, meta: { targetPlatform: opts.targetPlatform, generatedAt } });
  const manifestMd = renderManifestMd(manifest);
  const files = [...builder.files, { path: "MANIFEST.md", section: "root", content: Buffer.from(manifestMd, "utf8") }, { path: "manifest.json", section: "root", content: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8") }];
  // The kit's own meta documents must pass the same gate verify re-runs (a manifest that lists "secret"
  // rows as table cells once tripped it). A hit here is a tool bug: fail loudly rather than ship an
  // archive that `verify` would reject.
  for (const f of files.filter((x) => ["MANIFEST.md", "manifest.json", "VERIFY.md", "00-README-START-HERE.md"].includes(x.path))) {
    const hits = secretFindings({ file: f.content.toString("utf8") }, needles);
    if (hits.length) throw new Error(`internal: generated ${f.path} trips the secret gate (${hits.flatMap((h) => h.rules).join(", ")}); this is a master-handoff-kit bug`);
  }
  const bytes = files.reduce((s, f) => s + f.content.length, 0);
  const sections = { ...builder.countsBySection() }; sections.root = (sections.root || 0) + 2;
  return { builder, files, manifest, summary: { role, date, folder: kitFolderName(role, date), zip: kitZipName(role, date), files: files.length, bytes, sections, excluded: builder.excluded, withheld: builder.redactions.length, withheldDetail: builder.redactions, notes: builder.notes, needles: needles.length } };
}

// ---------------------------------------------------------------- upload (cto-onedrive mkdir/ls + app-media resumable upload)

function ctoOnedrive(args) {
  const r = spawnSync("node", [join(HERE, "..", "cto-onedrive", "cto-onedrive.mjs"), ...args], { encoding: "utf8", timeout: 180000 });
  return { status: r.status, out: String(r.stdout || ""), err: String(r.stderr || "") };
}

export async function uploadToOneDrive({ folderPath, localFiles, uploader, lister = ctoOnedrive, mkdir = (p) => ctoOnedrive(["mkdir", p]) }) {
  const mk = mkdir(folderPath);
  if (mk.status !== 0) throw new Error(`OneDrive mkdir "${folderPath}" failed: ${(mk.err || mk.out).slice(0, 200)}`);
  const ctype = (name) => (name.endsWith(".zip") ? "application/zip" : name.endsWith(".md") ? "text/markdown; charset=utf-8" : "application/octet-stream");
  for (const f of localFiles) {
    const buf = readFileSync(f.path);
    await uploader(`${folderPath}/${f.name}`, buf, ctype(f.name));
  }
  // verify: list the folder and compare name + size for every uploaded file
  const ls = lister(["ls", folderPath]);
  if (ls.status !== 0) throw new Error(`OneDrive ls "${folderPath}" failed: ${(ls.err || ls.out).slice(0, 200)}`);
  const seen = new Map();
  for (const line of ls.out.split(/\r?\n/)) { const m = line.match(/^\s+-\s+(\d+)\s+\S*\s+(.+?)\s*$/); if (m) seen.set(m[2], Number(m[1])); }
  const problems = [];
  for (const f of localFiles) {
    const want = statSync(f.path).size;
    if (!seen.has(f.name)) problems.push(`${f.name}: missing from the OneDrive folder listing`);
    else if (seen.get(f.name) !== want) problems.push(`${f.name}: OneDrive size ${seen.get(f.name)} != local ${want}`);
  }
  if (problems.length) throw new Error(`OneDrive verification failed: ${problems.join("; ")}`);
  return { folderPath, files: localFiles.map((f) => ({ name: f.name, bytes: statSync(f.path).size })) };
}

// ---------------------------------------------------------------- commands

function printSummary(s, { dry }) {
  console.log(`[master-handoff-kit] ${dry ? "DRY RUN " : ""}${s.role} ${s.date}  (${TOOL_VERSION})`);
  console.log(`  kit folder: ${s.folder}`);
  console.log(`  zip:        ${s.zip}`);
  console.log(`  files: ${s.files}  bytes: ${s.bytes}  (live secret needles armed: ${s.needles})`);
  console.log(`  files per section: ${Object.entries(s.sections).sort().map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
  console.log(`  withheld ledger entries: ${s.withheld}`);
  for (const w of s.withheldDetail || []) console.log(`    - ledger entry ${w.id} (${String(w.ts || "").slice(0, 10)}, ${w.type}) withheld: ${w.kinds.join("+")} gate (${w.rules.join(", ")})`);
  console.log(`  excluded source files: ${s.excluded.length}`);
  for (const e of s.excluded) console.log(`    - [${e.section}] ${e.source}: ${e.reason}`);
  for (const nline of s.notes) console.log(`  note: ${nline}`);
}

async function cmdBuild(args, deps) {
  const f = args.flags;
  const role = normalizeRole(f["--agent"] || process.env.KB_AGENT || "");
  const dry = Boolean(f["--dry-run"]);
  const opts = {
    role,
    sessionId: f["--session-id"] || "",
    scratch: f["--scratch"] ? [f["--scratch"]] : [],
    repos: list(f["--repos"]).map((p) => resolve(p)),
    repoDocs: f["--repo-docs"] || "",
    includes: args.include,
    targetPlatform: f["--target-platform"] || "",
    cwd: f["--cwd"] ? resolve(f["--cwd"]) : process.cwd(),
  };
  let res;
  try { res = await assembleKit(opts, deps); }
  catch (e) {
    if (e && e.exit === 2) { console.error(`REFUSED: ${e.message}`); return 2; }
    throw e;
  }
  printSummary(res.summary, { dry });
  if (dry) { console.log("\n(dry run: no zip written, nothing uploaded)"); return 0; }

  const out = resolve(f["--out"] || join(tmpdir(), "master-handoff-kit"));
  mkdirSync(out, { recursive: true });
  const stage = mkdtempSync(join(tmpdir(), "mhk-stage-"));
  try {
    writeKitDir(stage, res.summary.folder, res.files);
    const zipPath = join(out, res.summary.zip);
    zipFolder(stage, res.summary.folder, zipPath);
    // Re-verify the real artifact: extract the zip fresh and re-run the manifest + secret checks.
    const vdir = mkdtempSync(join(tmpdir(), "mhk-verify-"));
    try {
      unzipTo(zipPath, vdir);
      const v = verifyKitDir(join(vdir, res.summary.folder), await deps.loadNeedles());
      if (!v.ok) { console.error(`SELF-VERIFY FAILED:\n  ${v.problems.join("\n  ")}`); return 2; }
      console.log(`\nself-verify: ok (${v.checked} files re-scanned, manifest matches)`);
    } finally { rmSync(vdir, { recursive: true, force: true }); }
    console.log(`local zip: ${zipPath} (${statSync(zipPath).size} bytes)`);

    if (f["--no-upload"] || !f["--onedrive"]) { console.log(f["--no-upload"] ? "(--no-upload: not uploaded)" : "(no --onedrive path given: not uploaded)"); return 0; }
    const folderPath = String(f["--onedrive"]).replace(/^\/+|\/+$/g, "");
    const readme = join(stage, res.summary.folder, "00-README-START-HERE.md");
    const manifestMd = join(stage, res.summary.folder, "MANIFEST.md");
    const uploader = deps.uploader || (await import("../app-media/onedrive-upload.mjs")).uploadFileToOneDrive;
    const up = await uploadToOneDrive({ folderPath, localFiles: [{ name: res.summary.zip, path: zipPath }, { name: "00-README-START-HERE.md", path: readme }, { name: "MANIFEST.md", path: manifestMd }], uploader, ...(deps.lister ? { lister: deps.lister, mkdir: deps.mkdir } : {}) });
    console.log(`OneDrive: ${up.folderPath}/  (${up.files.map((x) => `${x.name} ${x.bytes}b`).join(", ")}) verified by listing`);
    return 0;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

async function cmdVerify(args, deps) {
  const zip = args._[1];
  if (!zip) { console.error("usage: kit.mjs verify <zip>"); return 1; }
  if (!existsSync(zip)) { console.error(`not found: ${zip}`); return 1; }
  let needles;
  try { needles = await deps.loadNeedles(); } catch (e) { console.error(`REFUSED: cannot arm the secret gate (${String(e.message).slice(0, 160)}); verification would be unverified.`); return 2; }
  const dir = mkdtempSync(join(tmpdir(), "mhk-verify-"));
  try {
    unzipTo(zip, dir);
    const tops = readdirSync(dir);
    if (tops.length !== 1 || !statSync(join(dir, tops[0])).isDirectory()) { console.error(`the zip must hold exactly one top-level kit folder (found: ${tops.join(", ") || "nothing"})`); return 1; }
    const v = verifyKitDir(join(dir, tops[0]), needles);
    console.log(`[master-handoff-kit] verify ${basename(zip)}: ${v.checked} file(s) re-scanned by the secret gate (${needles.length} live needles); manifest ${v.manifest ? `lists ${v.manifest.files.length} file(s)` : "unreadable"}`);
    if (v.ok) { console.log("RESULT: PASS"); return 0; }
    for (const p of v.problems) console.log(`  PROBLEM: ${p}`);
    console.log("RESULT: FAIL");
    return v.problems.some((p) => /secret gate tripped/.test(p)) ? 2 : 1;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const HELP = `master-handoff-kit: move an agent's full work and memories to a new agent on a new platform.

  node skills/master-handoff-kit/kit.mjs build --agent <role> [options]
    --session-id <id>        include documents this session produced that are not yet in the brain
    --scratch <dir>          an explicit scratchpad folder to include (relative paths preserved)
    --repos a,b              local repo paths whose CLAUDE.md/AGENTS.md/HANDOFF.md/README.md are snapshotted from origin/main
    --repo-docs repo:glob,.. extra repo files or globs (repo = a name or path from --repos)
    --include <file|dir>     a core document (repeatable; placed first, in order, as 01-, 02-, ...)
    --target-platform <name> the platform the new agent runs on (named in the README)
    --out <dir>              where the zip is written (default: <tmp>/master-handoff-kit)
    --onedrive "<folder>"    upload the zip + README + MANIFEST to this OneDrive folder (e.g. "CTO Incoming/<name>")
    --dry-run                run every gate and print the counts; write and upload nothing
    --no-upload              build and verify the zip locally only
    --cwd <dir>              directory whose git repos are scanned for unsaved documents (default: cwd)
  node skills/master-handoff-kit/kit.mjs verify <zip>
  node skills/master-handoff-kit/kit.mjs help
`;

export async function main(argv, depsIn) {
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(e.message); return 1; }
  const cmd = args._[0];
  if (!cmd || cmd === "help" || args.flags["--help"] || args.flags["-h"]) { console.log(HELP); return cmd || args.flags["--help"] || args.flags["-h"] ? 0 : 1; }
  const deps = depsIn || (await realDeps());
  if (cmd === "build") return cmdBuild(args, deps);
  if (cmd === "verify") return cmdVerify(args, deps);
  console.error(`unknown command "${cmd}"\n${HELP}`);
  return 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL((() => { try { return realpathSync(process.argv[1]); } catch { return process.argv[1]; } })()).href;
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
    if (e && e.exit === 2) { console.error(`REFUSED: ${e.message}`); process.exit(2); }
    console.error(`master-handoff-kit ERROR: ${e && e.message ? e.message : e}`);
    process.exit(1);
  });
}

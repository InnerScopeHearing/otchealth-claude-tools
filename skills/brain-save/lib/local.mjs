// local.mjs -- local-machine helpers: git provenance, file collection, agent identity, receipts.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, dirname, extname, basename, resolve } from "node:path";
import { SUPPORTED_EXTS } from "./normalize.mjs";

export function stateDir() { return process.env.BRAIN_SAVE_STATE_DIR || join(homedir(), ".claude", "brain-save"); }

const defaultGit = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();

/** Git provenance for a file inside a work tree: { repo, sha, dirty, relPath, source } or null.
 *  source = `repo@<sha>[+dirty]:<relpath>`. `git` is injectable for tests. */
export function gitInfo(file, git = defaultGit) {
  const dir = dirname(resolve(file));
  let top;
  try { top = git(dir, ["rev-parse", "--show-toplevel"]); } catch { return null; }
  if (!top) return null;
  let repo = basename(top);
  try {
    const url = git(top, ["config", "--get", "remote.origin.url"]);
    const m = url.match(/([^/:]+?)(?:\.git)?\/?$/);
    if (m) repo = m[1];
  } catch { /* no remote: keep the directory name */ }
  let sha = "";
  try { sha = git(top, ["rev-parse", "--short=12", "HEAD"]); } catch { sha = "nohead"; }
  const relPath = relative(top, resolve(file)).split("\\").join("/");
  let dirty = false;
  try { dirty = git(top, ["status", "--porcelain", "--", relPath]).length > 0; } catch { dirty = false; }
  return { repo, sha, dirty, relPath, top, source: `${repo}@${sha}${dirty ? "+dirty" : ""}:${relPath}` };
}

/** Minimal glob -> RegExp (`**` any path, `*` within a segment, `?` one char). Relative to the folder root. */
export function globToRegExp(glob) {
  let g = String(glob).trim().replace(/^\.\//, "");
  const dirOnly = g.endsWith("/");
  if (dirOnly) g = g.slice(0, -1);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { re += ".*"; i++; if (g[i + 1] === "/") i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const anchored = g.includes("/") ? `^${re}` : `(^|/)${re}`;
  return new RegExp(`${anchored}(/|$)`);
}

function loadIgnore(root) {
  const f = join(root, ".brain-save-ignore");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map(globToRegExp);
}

function isGitWorkTree(dir) { return existsSync(join(dir, ".git")); }

/** Expand paths (files and folders) into supported files. Folders recurse, skipping .git,
 *  node_modules, nested git work trees (scratch repo copies) and `.brain-save-ignore` globs. */
export function collectFiles(paths, { maxDepth = 12 } = {}) {
  const out = [];
  const skipped = [];
  for (const p of paths) {
    const abs = resolve(p);
    let st;
    try { st = statSync(abs); } catch { skipped.push({ path: p, reason: "not found" }); continue; }
    if (st.isFile()) { out.push(abs); continue; }
    if (!st.isDirectory()) continue;
    const ignore = loadIgnore(abs);
    const walk = (dir, depth) => {
      if (depth > maxDepth) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        const rel = relative(abs, full).split("\\").join("/");
        if (ignore.some((re) => re.test(rel))) continue;
        if (e.isDirectory()) {
          if (e.name === ".git" || e.name === "node_modules") continue;
          if (depth > 0 || full !== abs) { if (isGitWorkTree(full)) { skipped.push({ path: full, reason: "nested git work tree" }); continue; } }
          walk(full, depth + 1);
        } else if (e.isFile()) {
          if (e.name.startsWith(".") ) continue;
          if (SUPPORTED_EXTS.includes(extname(e.name).toLowerCase())) out.push(full);
        } else if (e.isSymbolicLink()) {
          // Never followed inside a folder walk (it could point anywhere, e.g. into a ring-private
          // checkout), but never SILENTLY dropped either: put the target explicitly if it is wanted.
          if (!e.name.startsWith(".")) skipped.push({ path: full, reason: "symlink not followed (put its target explicitly)" });
        }
      }
    };
    walk(abs, 0);
  }
  return { files: [...new Set(out)].sort(), skipped };
}

export function resolveAgent(flag) {
  if (flag) return String(flag);
  return resolveSeat() || "unknown";
}

/** The SEAT this process runs as: KB_AGENT, else ~/.claude/.kb-agent. Never the --agent flag: a flag is a
 *  label any caller can type, so every privilege decision (who may override an INND MNPI signal, which
 *  seats may write the open room) reads the seat as well as the flag (adjudication round 3: `--agent clo`
 *  used to clear an INND Reg D refusal from any seat). "" when unknown. */
export function resolveSeat() {
  if (process.env.KB_AGENT) return String(process.env.KB_AGENT).trim();
  try { const a = readFileSync(join(homedir(), ".claude", ".kb-agent"), "utf8").trim(); if (a) return a; } catch { /* none */ }
  return "";
}

/** Seats whose own work product is ring-private by default. clo-personal NEVER writes the open commons
 *  room (a hard refusal, not overridable); cfo / clo / capital may, but only with an explicit --share that
 *  says "this document is non-privileged", the same acknowledgment kb-memory asks for (`mem.mjs --share`). */
export const NEVER_COMMONS_SEATS = Object.freeze(["clo-personal"]);
export const SHARE_REQUIRED_SEATS = Object.freeze(["cfo", "clo", "capital"]);
const seatName = (a) => String(a || "").trim().toLowerCase();

/** Seat gate for a write. Checks BOTH the flag agent and the process seat (fail-closed: either one being a
 *  privileged seat applies). Returns null (allowed) or { code, message }. Pure. */
export function seatGate({ agent, seat, share = false }) {
  const who = [seatName(agent), seatName(seat)].filter(Boolean);
  const never = who.find((a) => NEVER_COMMONS_SEATS.includes(a));
  if (never) return { code: "SEAT_NEVER_COMMONS", message: `the ${never} seat never writes the open commons room (every gateway lane, external connectors included, reads it). Route: CLO-personal seat only, \`legal_blob_put\` container \`personal\` via the clo-personal lane. Not overridable.` };
  const gated = who.find((a) => SHARE_REQUIRED_SEATS.includes(a));
  if (gated && !share) return { code: "SEAT_SHARE_REQUIRED", message: `the ${gated} seat's work product is ring-private by default. If THIS document is non-privileged and safe for every lane (external connectors included) to read, re-run with --share; otherwise save it to the ${gated} ring store (${gated === "cfo" ? "`cfo-store put`" : gated === "clo" ? "`legal_blob_put` container `company`" : "the capital lane's private kb-memory (`mem.mjs` without --share); INND investor material goes through the CLO seat + counsel + Matt"}).` };
  return null;
}

export function resolveSession(flag) {
  return String(flag || process.env.BRAIN_SAVE_SESSION || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || process.env.WORKFLOW_RUN_ID || "");
}

function appendJsonl(name, rec) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    appendFileSync(join(stateDir(), name), JSON.stringify(rec) + "\n");
  } catch { /* receipts are a convenience for the Stop-hook reminder; never fail a save over them */ }
}
/** local_path -> the file's OWN identity (brain_id) at its most recent successful save on this seat
 *  (receipts.jsonl). Used to tell an update / retitle of the SAME file from a different file that shares a
 *  title or a body. `own_brain_id` is the file's own identity; `brain_id` is where its content lives (an
 *  alias points at ANOTHER document, which must never be superseded on this file's behalf). Older receipts
 *  carry only brain_id. */
export function receiptBrainIds() {
  const map = new Map();
  try {
    for (const line of readFileSync(join(stateDir(), "receipts.jsonl"), "utf8").split("\n")) {
      if (!line) continue;
      try { const r = JSON.parse(line); const id = r.own_brain_id || r.brain_id; if (r.local_path && id) map.set(r.local_path, id); } catch { /* skip */ }
    }
  } catch { /* no receipts yet */ }
  return map;
}

/** Local receipt (no content): lets the Stop-hook reminder know a file is in the brain. */
export function writeReceipt(rec) { appendJsonl("receipts.jsonl", rec); }
/** Local refusal record (no content, no matched text): refused-by-design files are not nagged about. */
export function writeRefusal(rec) { appendJsonl("refused.jsonl", rec); }

#!/usr/bin/env node
// unsaved-reminder.mjs -- Stop hook: a QUIET, FAST, FAIL-OPEN, NEVER-BLOCKING nudge when documents this
// session produced are not in the brain yet (Matt directive 2026-09-29).
//
// Registered USER-scope by setup/install-octools-hook.mjs (the project-scope hook does not fire in the
// multi-repo seat rooted at /home/user -- the 2026-09-02 credentials.env lesson).
//
// Contract: reads the Stop hook stdin JSON ({session_id, cwd, stop_hook_active}); prints NOTHING and
// exits 0 when stop_hook_active is true, BRAIN_SAVE_REMINDER=0, the input is malformed, or on ANY error.
// Self-imposed 1.2s deadline; no network, no AWS, no git fetch. Output (only when there are unsaved
// files AND the set differs from the last reminder this session) is ONE JSON object with a
// `systemMessage` naming at most 5 files -- never file contents, never a `decision` field, so it can
// never block stopping.
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, extname, relative, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";

const DEADLINE_MS = 1200;
const MIN_BYTES = 200;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 400;
const EXTS = new Set([".md", ".html"]);

export function stateDir() { return process.env.BRAIN_SAVE_STATE_DIR || join(homedir(), ".claude", "brain-save"); }

function readJsonl(file) {
  try { return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}

function globRe(glob) {
  let g = String(glob).trim().replace(/^\.\//, "").replace(/\/$/, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { re += ".*"; i++; if (g[i + 1] === "/") i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${g.includes("/") ? "^" : "(^|/)"}${re}(/|$)`);
}

/** Locate this session's scratchpad: /tmp/claude-* /<project>/<session_id>/scratchpad. */
export function findScratchpads(sessionId, tmpRoot = "/tmp") {
  const out = [];
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return out;
  let tops = [];
  try { tops = readdirSync(tmpRoot).filter((n) => n.startsWith("claude-")); } catch { return out; }
  for (const t of tops) {
    let projects = [];
    try { projects = readdirSync(join(tmpRoot, t)); } catch { continue; }
    for (const p of projects) {
      const sp = join(tmpRoot, t, p, sessionId, "scratchpad");
      if (existsSync(sp)) out.push(sp);
    }
  }
  return out;
}

/** Walk a folder (depth <= 4) for candidate docs, skipping .git, node_modules, git work trees, ignores. */
export function scanFolder(root, { maxDepth = 4, limit = MAX_FILES } = {}) {
  const out = [];
  let ignore = [];
  try { ignore = readFileSync(join(root, ".brain-save-ignore"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map(globRe); } catch { /* none */ }
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= limit) return;
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= limit) return;
      const full = join(dir, e.name);
      const rel = relative(root, full).split("\\").join("/");
      if (ignore.some((re) => re.test(rel))) continue;
      if (e.isDirectory()) {
        if (e.name === ".git" || e.name === "node_modules" || e.name.startsWith(".")) continue;
        if (existsSync(join(full, ".git"))) continue; // a repo copy, not session output
        walk(full, depth + 1);
      } else if (e.isFile() && EXTS.has(extname(e.name).toLowerCase())) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

function gitChanged(repo, timeoutMs = 300) {
  return new Promise((res) => {
    execFile("git", ["-C", repo, "status", "--porcelain", "--untracked-files=all"], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return res([]);
      const files = [];
      for (const line of String(stdout).split("\n")) {
        const p = line.slice(3).trim().replace(/^"|"$/g, "");
        if (!p || p.includes(" -> ")) continue;
        if (EXTS.has(extname(p).toLowerCase())) files.push(join(repo, p));
      }
      res(files);
    });
  });
}

/** Git repos to check: cwd if it is one, plus repos one level below it (max 20). */
export function candidateRepos(cwd) {
  const repos = [];
  if (!cwd) return repos;
  if (existsSync(join(cwd, ".git"))) repos.push(cwd);
  try {
    for (const e of readdirSync(cwd, { withFileTypes: true })) {
      if (repos.length >= 20) break;
      if (e.isDirectory() && !e.name.startsWith(".") && existsSync(join(cwd, e.name, ".git"))) repos.push(join(cwd, e.name));
    }
  } catch { /* unreadable cwd */ }
  return repos;
}

function fileSha(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

/** Filter candidates to the unsaved ones: a receipt matches by (path+size+mtime) fast path, else by
 *  sha256 of the bytes; refused-by-design files are excluded. */
export function unsavedFiles(candidates, receipts, refusals) {
  const fast = new Set(receipts.map((r) => `${r.local_path}|${r.size}|${r.mtime_ms}`));
  const hashes = new Set(receipts.map((r) => r.raw_sha256).filter(Boolean));
  const refusedHashes = new Set(refusals.map((r) => r.raw_sha256).filter(Boolean));
  const out = [];
  for (const f of candidates) {
    let st;
    try { st = statSync(f); } catch { continue; }
    if (!st.isFile() || st.size < MIN_BYTES || st.size > MAX_BYTES) continue;
    if (fast.has(`${f}|${st.size}|${st.mtimeMs}`)) continue;
    let h = "";
    try { h = fileSha(f); } catch { continue; }
    if (hashes.has(h)) continue;
    if (refusedHashes.has(h)) continue; // refused by design and unchanged since: do not nag
    out.push(f);
  }
  return out;
}

export function fingerprint(files) { return createHash("sha256").update(files.slice().sort().join("\n")).digest("hex").slice(0, 16); }

export function buildMessage(files) {
  const names = files.slice(0, 5).map((f) => basename(f));
  const more = files.length > 5 ? ` and ${files.length - 5} more` : "";
  return `brain-save: ${files.length} document(s) from this session are not in the brain yet: ${names.join(", ")}${more}. Save with: node /tmp/octools/skills/brain-save/brain-save.mjs put <paths> --kind <kind> --app <app>`;
}

/** Seats that must never be nudged toward the open commons room (adjudication round 3: the reminder told
 *  the clo-personal seat to save its documents to commons). clo-personal never writes commons; cfo, clo and
 *  capital keep their work product in their own ring stores unless they explicitly --share a document. */
export const SILENT_SEATS = Object.freeze(["clo-personal", "cfo", "clo", "capital"]);
export function hookSeat() {
  if (process.env.KB_AGENT) return String(process.env.KB_AGENT).trim().toLowerCase();
  try { return readFileSync(join(homedir(), ".claude", ".kb-agent"), "utf8").trim().toLowerCase(); } catch { return ""; }
}

export async function run(stdinText, { tmpRoot = "/tmp" } = {}) {
  if (process.env.BRAIN_SAVE_REMINDER === "0") return null;
  if (SILENT_SEATS.includes(hookSeat())) return null;
  let input;
  try { input = JSON.parse(stdinText || ""); } catch { return null; }
  if (!input || typeof input !== "object" || input.stop_hook_active) return null;
  const sessionId = String(input.session_id || "");
  const cwd = typeof input.cwd === "string" ? input.cwd : "";
  let candidates = [];
  for (const sp of findScratchpads(sessionId, tmpRoot)) candidates.push(...scanFolder(sp));
  const repoLists = await Promise.all(candidateRepos(cwd).map((r) => gitChanged(r)));
  for (const l of repoLists) candidates.push(...l);
  candidates = [...new Set(candidates)].slice(0, MAX_FILES);
  if (!candidates.length) return null;
  const dir = stateDir();
  const unsaved = unsavedFiles(candidates, readJsonl(join(dir, "receipts.jsonl")), readJsonl(join(dir, "refused.jsonl")));
  if (!unsaved.length) return null;
  const fp = fingerprint(unsaved);
  const stateFile = join(dir, "reminder-state.json");
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch { state = {}; }
  if (state[sessionId] === fp) return null;
  state[sessionId] = fp;
  const keys = Object.keys(state);
  if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete state[k];
  try { mkdirSync(dir, { recursive: true }); writeFileSync(stateFile, JSON.stringify(state)); } catch { /* throttle is best-effort */ }
  return { systemMessage: buildMessage(unsaved) };
}

// Entry-point test through the symlink-resolved, percent-encoded URL (a plain `file://${argv[1]}` compare
// never matched through a symlinked directory or a path with a space, so the hook silently did nothing).
function isEntryPoint() { try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } }

if (isEntryPoint()) {
  const timer = setTimeout(() => process.exit(0), DEADLINE_MS);
  timer.unref?.();
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { buf += d; if (buf.length > 1e6) process.exit(0); });
  process.stdin.on("error", () => process.exit(0));
  process.stdin.on("end", async () => {
    try {
      const out = await run(buf);
      if (out) process.stdout.write(JSON.stringify(out) + "\n");
    } catch { /* fail open */ }
    process.exit(0);
  });
}

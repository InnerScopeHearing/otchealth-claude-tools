#!/usr/bin/env node
// agent-dispatch — directed, loop-safe work hand-off between fleet agents. Agent A addresses a TASK to
// agent B; the dispatch lands in B's inbox; B is auto-woken (Tier B: repository_dispatch -> claude -p)
// to do it and dispatch a reply back. The bus is GitHub-native (per-recipient append-only inbox files),
// so even a least-privilege unattended run can use it with just the repo GITHUB_TOKEN (no Secret Manager).
// See dream-team/AGENT-DISPATCH-SYSTEM.md for the full architecture.
//
// Verbs:
//   dispatch send  --from <a> --to <b> --task "..." [--thread <id>] [--ttl 6] [--ring non-phi] [--hub <dir>] [--commit]
//   dispatch reply --from <b> --to <a> --re <id> --task "..." [--hub <dir>] [--commit]   (inherits thread, hops+1)
//   dispatch inbox --agent <a> [--all] [--hub <dir>]            # list OPEN dispatches addressed to <a>
//   dispatch ack   --agent <a> --id <id> [--note "..."] [--hub <dir>]   # mark handled (idempotent wake guard)
//   dispatch schema                                            # print the envelope schema
//
// Loop-safety is layered: addressee routing (a writer can only target its RECIPIENT's inbox, never its
// own), a hop cap (hops >= ttl -> STOP + escalate, never wake again), idempotent ack, and the ring wall
// (PHI / INND-securities / clo-personal are NEVER allowed on the wire). Pure logic is exported for tests.
import { readFileSync, appendFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (f) => argv.includes(f);

// ---- pure protocol logic (exported, unit-tested in tests/dispatch.test.mjs; no I/O) ----------------

// Rings that must NEVER travel in a dispatch body. A dispatch carries a task + metadata, not regulated
// data. PHI/BAA, INND securities (MNPI), and Matt's privileged personal-legal lane are refused here.
const BLOCKED_RINGS = new Set(["phi", "medreview", "innd", "securities", "mnpi", "clo-personal", "personal"]);
export function ringAllowed(ring) {
  if (ring == null || ring === "") return true; // default = non-phi
  return !BLOCKED_RINGS.has(String(ring).trim().toLowerCase());
}

// Sanitize an agent id into a filesystem- and route-safe token. Prevents a hostile `to`/`from` value
// (e.g. "../../etc/passwd") from escaping the hub directory or smuggling path separators.
export function agentSafe(name) {
  const s = String(name == null ? "" : name).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  if (!s) throw new Error("invalid agent id: " + JSON.stringify(name));
  return s;
}

export const inboxPath = (hub, agent) => join(hub, `${agentSafe(agent)}.inbox.jsonl`);
export const handledPath = (hub, agent) => join(hub, `${agentSafe(agent)}.handled.jsonl`);

// time-ordered, collision-resistant id (sortable prefix + random suffix). No external deps.
export function newId() {
  return Date.now().toString(36) + "-" + crypto.randomBytes(5).toString("hex");
}

// Build a validated dispatch envelope. Required: from, to, task. from !== to (no self-dispatch).
export function buildEnvelope({ from, to, task, thread, reply_to = null, hops = 0, ttl = 6, ring = "non-phi", ts, id } = {}) {
  const f = agentSafe(from), t = agentSafe(to);
  if (f === t) throw new Error("cannot dispatch to yourself (from === to): " + f);
  if (!task || !String(task).trim()) throw new Error("a dispatch needs a --task");
  if (!ringAllowed(ring)) throw new Error(`ring '${ring}' may not travel in a dispatch (PHI/INND/personal stay off the wire)`);
  const _id = id || newId();
  return {
    id: _id,
    thread: thread || _id,           // a new dispatch opens its own thread
    from: f, to: t,
    task: String(task).trim(),
    reply_to: reply_to || null,
    hops: Number.isFinite(+hops) ? +hops : 0,
    ttl: Number.isFinite(+ttl) ? +ttl : 6,
    ring: ring || "non-phi",
    ts: ts || new Date().toISOString(),
    status: "open",
  };
}

// True once a thread has bounced too many times. At/over the cap we STOP waking and escalate to Matt.
export const loopExceeded = (env) => (+env.hops || 0) >= (+env.ttl || 0);

// Construct a reply to an existing dispatch: same thread, hops+1, reply_to = the original id, and the
// recipient is the original SENDER (so the reply routes back to whoever asked). Direction is enforced.
export function nextReply(orig, { from, to, task, ring }) {
  if (!orig || !orig.id) throw new Error("nextReply needs the original envelope");
  return buildEnvelope({
    from, to, task,
    thread: orig.thread || orig.id,
    reply_to: orig.id,
    hops: (+orig.hops || 0) + 1,
    ttl: +orig.ttl || 6,
    ring: ring || orig.ring || "non-phi",
  });
}

// ---- I/O layer (GitHub-native bus: append-only per-recipient inbox files) ---------------------------

function readJsonl(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").map(s => s.trim()).filter(Boolean).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}
function hub() { const h = val("--hub", process.env.DISPATCH_HUB || "dispatch"); if (!existsSync(h)) mkdirSync(h, { recursive: true }); return h; }
function maybeCommit(h, files, msg) {
  if (!has("--commit")) return;
  try {
    execFileSync("git", ["add", ...files], { cwd: process.cwd(), stdio: "ignore" });
    execFileSync("git", ["commit", "-m", msg], { cwd: process.cwd(), stdio: "ignore" });
    console.error("  committed (push to fire the wake): " + msg);
  } catch (e) { console.error("  (commit skipped: " + e.message.split("\n")[0] + ")"); }
}
// best-effort cross-link into the shared memory ledger (only if kb-memory + SM creds are present)
function memoryLog(env, verb) {
  try {
    const mem = join(import.meta.dirname, "..", "kb-memory", "mem.mjs");
    if (!existsSync(mem) || !process.env.GCP_CLAUDE_DRIVER_SA_JSON) return;
    execFileSync("node", [mem, "remember", `dispatch ${verb}: ${env.from} -> ${env.to} [${env.thread}] ${env.task.slice(0, 140)}`, "--agent", env.from], { stdio: "ignore" });
  } catch {}
}

function send(replyMode) {
  const h = hub();
  let env;
  if (replyMode) {
    const re = val("--re", ""); if (!re) { console.error("reply needs --re <original-id>"); process.exit(2); }
    const me = val("--from", ""); // the replier's inbox is where the original landed
    const orig = readJsonl(inboxPath(h, me)).find(e => e.id === re) || readJsonl(handledPath(h, me)).find(e => e.id === re);
    if (!orig) { console.error(`original dispatch ${re} not found in ${agentSafe(me)}'s inbox/handled`); process.exit(2); }
    env = nextReply(orig, { from: val("--from", ""), to: val("--to", orig.from), task: val("--task", ""), ring: val("--ring", "") });
    if (loopExceeded(env)) {
      console.error(`LOOP CAP: thread ${env.thread} reached ${env.hops}/${env.ttl} hops. NOT waking; escalate to Matt.`);
      const esc = inboxPath(h, "matt"); appendFileSync(esc, JSON.stringify({ ...env, to: "matt", status: "escalated-loop-cap" }) + "\n");
      maybeCommit(h, [esc], `dispatch: loop-cap escalation on thread ${env.thread} [skip-dispatch]`);
      process.exit(3);
    }
  } else {
    env = buildEnvelope({ from: val("--from", ""), to: val("--to", ""), task: val("--task", ""), thread: val("--thread", ""), ttl: val("--ttl", "6"), ring: val("--ring", "non-phi") });
  }
  const p = inboxPath(h, env.to);
  appendFileSync(p, JSON.stringify(env) + "\n");
  memoryLog(env, replyMode ? "reply" : "send");
  console.log(JSON.stringify({ delivered: p, ...env }, null, 2));
  maybeCommit(h, [p], `dispatch: ${env.from} -> ${env.to} [${env.thread}] ${env.task.slice(0, 60)}`);
  console.error(`\nDelivered to ${env.to}'s inbox. ${has("--commit") ? "Pushed commit fires the wake." : "Commit+push dispatch/ to fire the auto-wake (or run with --commit)."}`);
}

function inbox() {
  const h = hub(); const a = val("--agent", ""); if (!a) { console.error("inbox needs --agent <id>"); process.exit(2); }
  const handled = new Set(readJsonl(handledPath(h, a)).map(e => e.id));
  const items = readJsonl(inboxPath(h, a)).filter(e => has("--all") || !handled.has(e.id));
  console.log(`# ${agentSafe(a)} inbox - ${items.length} ${has("--all") ? "total" : "open"} dispatch(es)\n`);
  for (const e of items) console.log(`[${handled.has(e.id) ? "done" : "OPEN"}] ${e.id}  from ${e.from}  thread ${e.thread}  hop ${e.hops}/${e.ttl}\n  ${e.task}\n`);
}

function ack() {
  const h = hub(); const a = val("--agent", ""); const id = val("--id", "");
  if (!a || !id) { console.error("ack needs --agent <id> --id <dispatch-id>"); process.exit(2); }
  const rec = { id, agent: agentSafe(a), handled_ts: new Date().toISOString(), note: val("--note", "") };
  const p = handledPath(h, a); appendFileSync(p, JSON.stringify(rec) + "\n");
  console.log(`acked ${id} for ${agentSafe(a)}`);
  maybeCommit(h, [p], `dispatch: ${agentSafe(a)} acked ${id} [skip-dispatch]`);
}

function schema() {
  console.log(`agent-dispatch envelope (one JSON object per line in dispatch/<to>.inbox.jsonl):
  { id, thread, from, to, task, reply_to, hops, ttl, ring, ts, status }
Routing: by ADDRESSEE (the inbox filename) -> a writer can only target its recipient, never itself.
Loop-safety: hops>=ttl STOPS (escalates to matt); ack -> handled.jsonl makes a re-wake idempotent.
Rings blocked on the wire: ${[...BLOCKED_RINGS].join(", ")}.`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    if (cmd === "send") send(false);
    else if (cmd === "reply") send(true);
    else if (cmd === "inbox") inbox();
    else if (cmd === "ack") ack();
    else if (cmd === "schema") schema();
    else { console.error('usage: dispatch send|reply|inbox|ack|schema  (see skills/agent-dispatch/SKILL.md)'); process.exit(2); }
  } catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
}

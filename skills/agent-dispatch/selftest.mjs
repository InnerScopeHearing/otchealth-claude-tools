#!/usr/bin/env node
// agent-dispatch selftest: a full LOCAL round-trip on a temp hub (no network, no creds). Proves the bus:
// send -> inbox -> reply (routes back, hops+1) -> ack (idempotent) -> loop-cap escalation to matt.
// Run: node skills/agent-dispatch/selftest.mjs   (also run by run-tests.sh).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "dispatch.mjs");
const hub = mkdtempSync(join(tmpdir(), "dispatch-selftest-"));
// Scrub the SA so the skill's best-effort memory cross-link never touches the REAL ledger during a test.
const childEnv = { ...process.env, GCP_CLAUDE_DRIVER_SA_JSON: "" };
const run = (args) => execFileSync("node", [CLI, ...args, "--hub", hub], { encoding: "utf8", env: childEnv });

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.error("  FAIL: " + m)); };

try {
  // 1. send cto -> plantid
  const env = JSON.parse(run(["send", "--from", "cto", "--to", "plantid", "--task", "Rebuild screenshots and re-run R4."]));
  ok(env.from === "cto" && env.to === "plantid", "send returns a cto->plantid envelope");
  ok(existsSync(join(hub, "plantid.inbox.jsonl")), "delivered to plantid's inbox");
  ok(!existsSync(join(hub, "cto.inbox.jsonl")), "sender's own inbox untouched (no self-wake)");

  // 2. plantid sees it open
  const inbox1 = run(["inbox", "--agent", "plantid"]);
  ok(/1 open/.test(inbox1) && inbox1.includes(env.id), "plantid inbox shows the open dispatch");

  // 3. plantid replies -> routes back to cto, thread inherited, hops+1
  const reply = JSON.parse(run(["reply", "--from", "plantid", "--to", "cto", "--re", env.id, "--task", "R4 = 9.1/9.0/9.2, PR #NN"]));
  ok(reply.to === "cto" && reply.from === "plantid", "reply routes back to the original sender");
  ok(reply.thread === env.thread && reply.reply_to === env.id && reply.hops === 1, "reply inherits thread + hops+1");
  ok(existsSync(join(hub, "cto.inbox.jsonl")), "reply delivered to cto's inbox");

  // 4. ack makes a re-wake idempotent
  run(["ack", "--agent", "plantid", "--id", env.id]);
  ok(/0 open/.test(run(["inbox", "--agent", "plantid"])), "after ack, plantid has 0 open");

  // 5. loop cap: a reply that would reach hops>=ttl escalates to matt instead of waking (nonzero exit)
  const near = { id: "seed-" + Date.now().toString(36), thread: "t-loop", from: "a", to: "b", task: "ping",
    reply_to: null, hops: 5, ttl: 6, ring: "non-phi", ts: new Date().toISOString(), status: "open" };
  appendFileSync(join(hub, "b.inbox.jsonl"), JSON.stringify(near) + "\n");
  let escalated = false;
  try { run(["reply", "--from", "b", "--to", "a", "--re", near.id, "--task", "pong"]); }
  catch { escalated = true; }
  ok(escalated, "a reply at the hop cap exits nonzero (does not wake)");
  ok(existsSync(join(hub, "matt.inbox.jsonl")), "loop-cap escalates to matt's inbox");
} finally {
  rmSync(hub, { recursive: true, force: true });
}

console.log(`agent-dispatch selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

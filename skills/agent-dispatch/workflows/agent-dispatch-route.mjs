#!/usr/bin/env node
// agent-dispatch ROUTER logic (template; deploy to the HUB repo's .github/scripts/agent-dispatch-route.mjs).
// Called by agent-dispatch-router.yml. Reads the envelope lines ADDED in this push and repository_dispatches
// each to its recipient's repo (from dispatch/agents.json). Node 20+ (global fetch). Loop-safe + budget-capped.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const { BEFORE, AFTER, FLEET_DISPATCH_TOKEN, BUDGET = "40" } = process.env;
if (!FLEET_DISPATCH_TOKEN) { console.log("no FLEET_DISPATCH_TOKEN; routing disabled"); process.exit(0); }
const agents = existsSync("dispatch/agents.json") ? JSON.parse(readFileSync("dispatch/agents.json", "utf8")) : {};

// the lines ADDED to any inbox file in this push = the new dispatches
let diff = "";
try { diff = execFileSync("git", ["diff", "--no-color", "-U0", `${BEFORE}`, `${AFTER}`, "--", "dispatch/*.inbox.jsonl"], { encoding: "utf8" }); }
catch { diff = execFileSync("git", ["show", "--no-color", "-U0", `${AFTER}`, "--", "dispatch/*.inbox.jsonl"], { encoding: "utf8" }); }
const added = diff.split("\n").filter(l => l.startsWith("+{")).map(l => l.slice(1));

let count = 0;
for (const line of added) {
  let env; try { env = JSON.parse(line); } catch { continue; }
  const to = String(env.to || "").replace(/[^a-z0-9_-]/gi, "");
  if (!to || !env.id) continue;
  const repo = agents[to];
  if (!repo) { console.log(`no repo mapping for '${to}' in dispatch/agents.json - skipping ${env.id}`); continue; }
  if (++count > +BUDGET) { console.log(`::warning::daily wake budget ${BUDGET} exceeded; ${to} dispatch ${env.id} QUEUED not woken`); continue; }
  const body = { event_type: "agent-dispatch", client_payload: { to, id: env.id, thread: env.thread, task: String(env.task || "").slice(0, 4000) } };
  const r = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${FLEET_DISPATCH_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(`${r.ok ? "woke" : `FAILED(${r.status})`} ${repo} for dispatch ${env.id} -> ${to}`);
}
console.log(`routed ${count} dispatch(es).`);

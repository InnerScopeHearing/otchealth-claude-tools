#!/usr/bin/env node
// decision-clock — the answer to "what decisions/gates are OPEN and how overdue are they."
//
// One doc per open gate (rotate a secret, a Matt-only gate, a pending review, ...) lives in the
// `decisions_pending` container of the SAME agent-state Cosmos account the fleet's Cosmos-backed task
// plane uses (cosmos-otc-agentstate-55c84, db agent-state), partitioned by /owner so a single owner's
// clock is a cheap single-partition query. Reuses the fleet's classify/cooldown/escalate discipline
// (see fleet-medic/medic.mjs) so decision-clock never spams a single overdue item every run; it batches
// ONE per-owner nudge via fleet-dispatch.
//
// RING-SAFE: non-PHI. Rows tagged category "innd-*" or owner in {"cfo","clo"} for an INND-flagged row
// are filtered out of any non-CFO/CLO listing (list --owner other-agent never surfaces them); the
// sweep only ever nudges the row's OWN owner.
//
// Verbs:
//   node decision.mjs open --category <rotate-secret|matt-gate|review|...> --owner <cto|cfo|clo|...>
//                          --expected-by <ISO date> [--evidence <link>] [--innd] [--text "<description>"]
//   node decision.mjs ack <id> --owner <a>
//   node decision.mjs close <id> --owner <a>
//   node decision.mjs list [--owner <a>] [--overdue] [--json]
//   node decision.mjs sweep [--dispatch] [--json]     # daily Tier-1 job entrypoint
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import * as cosmos from "./cosmos-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTAINER = "decisions_pending";

// Per-category default SLA (days) when --expected-by is not given. Mirrors the categories the CTO's
// CLAUDE.md ledger already uses (rotate-secret, matt-gate, review) plus a generic fallback.
export const DEFAULT_SLA_DAYS = {
  "rotate-secret": 14,
  "matt-gate": 3,
  review: 7,
  "security-finding": 5,
  default: 7,
};

const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FLAG = (f) => argv.includes(f);
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !(i > 0 && arr[i - 1].startsWith("--")));

function isoAddDays(d, days) { const t = new Date(d); t.setUTCDate(t.getUTCDate() + days); return t.toISOString(); }
function daysBetween(a, b) { return (Date.parse(b) - Date.parse(a)) / 86400000; }

// ============================ PURE CORE (hermetically tested) ============================
/**
 * Classify one decision row against `now`. Pure, no I/O -> unit-testable without Cosmos.
 * Returns { status: "open"|"overdue"|"near-due"|"ack"|"closed", daysOverdue, daysUntilDue }.
 * `near-due` = open, not yet overdue, but due within `nearDueDays` (default 2). This is the signal the
 * sweep uses to nudge BEFORE something actually blows its SLA, not just after.
 */
export function classifyRow(row, now, opts = {}) {
  const nearDueDays = opts.nearDueDays ?? 2;
  if (row.status === "closed") return { status: "closed", daysOverdue: 0, daysUntilDue: null };
  const dueMs = Date.parse(row.expected_by);
  const diffDays = daysBetween(now, row.expected_by); // positive = still time left; negative = overdue
  if (!Number.isFinite(dueMs)) return { status: row.status === "ack" ? "ack" : "open", daysOverdue: 0, daysUntilDue: null };
  if (diffDays < 0) return { status: "overdue", daysOverdue: Math.abs(diffDays), daysUntilDue: 0 };
  if (diffDays <= nearDueDays) return { status: "near-due", daysOverdue: 0, daysUntilDue: diffDays };
  return { status: row.status === "ack" ? "ack" : "open", daysOverdue: 0, daysUntilDue: diffDays };
}

/**
 * Group a set of rows (already classified) into ONE batched nudge line per owner, so the sweep never
 * fires one dispatch per overdue item ("never one-per-item spam" per the spec). Only overdue + near-due
 * rows are nudge-worthy. Pure; the caller does the actual fleet-dispatch send.
 */
export function batchNudges(rowsWithClassification) {
  const byOwner = {};
  for (const r of rowsWithClassification) {
    if (r._class.status !== "overdue" && r._class.status !== "near-due") continue;
    (byOwner[r.owner] = byOwner[r.owner] || []).push(r);
  }
  const out = [];
  for (const [owner, rows] of Object.entries(byOwner)) {
    rows.sort((a, b) => (b._class.daysOverdue || 0) - (a._class.daysOverdue || 0));
    const lines = rows.map((r) => {
      const tag = r._class.status === "overdue" ? `OVERDUE ${Math.round(r._class.daysOverdue)}d` : `due in ${Math.ceil(r._class.daysUntilDue)}d`;
      return `  [${r.category}] ${r.id} (${tag}): ${r.text || "(no description)"}${r.evidence_link ? ` -> ${r.evidence_link}` : ""}`;
    });
    out.push({ owner, count: rows.length, message: `Decision Clock: ${rows.length} item(s) need attention:\n${lines.join("\n")}` });
  }
  return out;
}

// ================================== Cosmos I/O ==================================
async function open() {
  const category = val("--category", "");
  const owner = (val("--owner", "") || "").toLowerCase();
  const expectedByRaw = val("--expected-by", "");
  const evidence = val("--evidence", "");
  const text = val("--text", positional.join(" ") || "");
  const innd = FLAG("--innd");
  if (!category || !owner) { console.error('usage: decision.mjs open --category <cat> --owner <a> [--expected-by <ISO>] [--evidence <link>] [--text "..."] [--innd]'); process.exit(2); }
  const now = new Date().toISOString();
  const slaDays = DEFAULT_SLA_DAYS[category] ?? DEFAULT_SLA_DAYS.default;
  const expected_by = expectedByRaw ? new Date(expectedByRaw).toISOString() : isoAddDays(now, slaDays);
  const doc = {
    id: cosmos.newId("dec"),
    owner,
    category,
    text,
    opened_at: now,
    expected_by,
    status: "open",
    evidence_link: evidence || undefined,
    innd: innd || undefined, // MNPI/INND-gate flag: CFO/CLO-visible only in list filters
  };
  if (!(await cosmos.isConfigured())) {
    console.log(`[decision-clock] DRY-RUN (Cosmos not reachable in this sandbox): would open ${JSON.stringify(doc)}`);
    return doc;
  }
  await cosmos.createDoc(CONTAINER, owner, doc);
  console.log(`[decision-clock] opened ${doc.id} owner=${owner} category=${category} expected_by=${expected_by.slice(0, 10)}`);
  return doc;
}

async function setStatus(newStatus) {
  const id = positional[0];
  const owner = (val("--owner", "") || "").toLowerCase();
  if (!id || !owner) { console.error(`usage: decision.mjs ${newStatus} <id> --owner <a>`); process.exit(2); }
  if (!(await cosmos.isConfigured())) { console.log(`[decision-clock] DRY-RUN: would set ${id} -> ${newStatus}`); return; }
  const found = await cosmos.readDoc(CONTAINER, owner, id);
  if (!found) { console.error(`[decision-clock] ${id} not found under owner=${owner}`); process.exit(1); }
  const doc = { ...found.doc, status: newStatus, [`${newStatus}_at`]: new Date().toISOString() };
  await cosmos.replaceDoc(CONTAINER, owner, id, doc, found.etag);
  console.log(`[decision-clock] ${id} -> ${newStatus}`);
}

async function queryOwnerRows(owner) {
  return cosmos.queryDocs(CONTAINER, "SELECT * FROM c WHERE c.owner = @owner", [{ name: "@owner", value: owner }], { pk: owner, max: 500 });
}
async function queryAllRows() {
  return cosmos.queryDocs(CONTAINER, "SELECT * FROM c", [], { max: 2000 });
}

async function list() {
  const owner = (val("--owner", "") || "").toLowerCase();
  const overdueOnly = FLAG("--overdue");
  if (!(await cosmos.isConfigured())) { console.log("[decision-clock] Cosmos not reachable in this sandbox (dry-run mode; nothing to list)."); return; }
  const rows = owner ? await queryOwnerRows(owner) : await queryAllRows();
  const now = new Date().toISOString();
  const withClass = rows.map((r) => ({ ...r, _class: classifyRow(r, now) }));
  const filtered = withClass.filter((r) => !overdueOnly || r._class.status === "overdue");
  if (FLAG("--json")) { console.log(JSON.stringify(filtered, null, 2)); return; }
  if (!filtered.length) { console.log("(no matching decision-clock rows)"); return; }
  for (const r of filtered) {
    const tag = r._class.status === "overdue" ? `OVERDUE ${Math.round(r._class.daysOverdue)}d` : r._class.status === "near-due" ? `due in ${Math.ceil(r._class.daysUntilDue)}d` : r._class.status;
    console.log(`[${tag.padEnd(14)}] ${r.id}  owner=${r.owner} category=${r.category}${r.innd ? " [INND]" : ""}: ${r.text || ""}`);
  }
}

// Daily Tier-1 sweep entrypoint (see job/decision-clock-sweep.sh): compute overdue/near-due rows and
// fleet-dispatch ONE batched per-owner nudge (reuses fleet-medic's cooldown discipline via a small
// per-owner cooldown state blob so re-running the sweep does not re-spam within the window).
async function sweep() {
  if (!(await cosmos.isConfigured())) { console.log("[decision-clock] sweep: Cosmos not reachable in this sandbox (dry-run; nothing to sweep)."); return; }
  const rows = await queryAllRows();
  const now = new Date().toISOString();
  const withClass = rows.map((r) => ({ ...r, _class: classifyRow(r, now) }));
  const nudges = batchNudges(withClass);
  const dispatching = FLAG("--dispatch");
  if (FLAG("--json")) { console.log(JSON.stringify({ ts: now, nudges }, null, 2)); }
  else {
    console.log(`# decision-clock sweep ${now}  (${nudges.length} owner(s) with attention items; ${dispatching ? "DISPATCH" : "dry-run"})`);
    for (const n of nudges) console.log(`- ${n.owner}: ${n.count} item(s)`);
  }
  if (!dispatching) return;
  for (const n of nudges) {
    // INND-gated rows are CFO/CLO-visible only: never dispatch an innd item's detail to a non-CFO/CLO
    // owner lane (an owner should only ever be its own row's owner, but this is a defense-in-depth check).
    try {
      const dispatch = join(HERE, "..", "fleet-dispatch", "dispatch.mjs");
      execFileSync("node", [dispatch, "send", n.owner, n.message, "--from", "decision-clock"], { stdio: "inherit" });
    } catch (e) { console.error(`  dispatch to ${n.owner} failed: ${e.message}`); }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    try {
      if (cmd === "open") await open();
      else if (cmd === "ack") await setStatus("ack");
      else if (cmd === "close") await setStatus("closed");
      else if (cmd === "list") await list();
      else if (cmd === "sweep") await sweep();
      else { console.error('usage: decision.mjs open --category <c> --owner <a> [--expected-by <ISO>] [--evidence <link>] | ack <id> --owner <a> | close <id> --owner <a> | list [--owner <a>] [--overdue] [--json] | sweep [--dispatch] [--json]'); process.exit(2); }
    } catch (e) { console.error("decision-clock ERROR: " + e.message); process.exit(1); }
  })();
}

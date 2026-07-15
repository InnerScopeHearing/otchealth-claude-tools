#!/usr/bin/env node
// legal-deadline-pager — reads the CLO's legal docket (skills/legal/legal.mjs docket due --json) and
// PAGES a human on tight-window, VERIFIED deadlines. Wielded by the CLO / CTO.
//
// SHIPS DISARMED BY DEFAULT: `sweep` with no flags is a pure read + report (logs what it WOULD page,
// writes nothing, sends nothing). `--commit` arms the TRACKING side (decision-clock sync for
// company-namespace rows, the personal cooldown store, the heartbeat marker). Actually SENDING an email
// additionally requires the environment variable LEGAL_PAGER_ENABLED=1 -- a second, independent gate on
// top of --commit. Neither this file nor its job/ wrapper ever sets that env var, so merging + deploying
// this skill pages nobody; a human sets LEGAL_PAGER_ENABLED=1 on the deployed job as a deliberate,
// separate arm step.
//
// WHY a direct email instead of leaning on decision-clock's own sweep: decision-clock's sweep already
// picks up any row synced here (category "legal-deadline", owner "clo") and will fleet-dispatch it to
// the CLO inbox on its own daily cadence -- see skills/decision-clock/decision.mjs. But decision-clock's
// tier system (TIER_BY_CATEGORY, default tier 2) exists to keep routine backlog out of a human's live
// inbox by batching it into the daily digest instead. A legal deadline inside the tight window is urgent
// enough to warrant an immediate page, not a batched digest line, so this pager ALSO sends a direct
// graph_send_email (gateway tool, cto lane only -- see governance.ts in otchealth-mcp-server) for
// anything inside the tight window, independent of decision-clock's own tiering.
//
// RING SAFETY (hard constraint, never relax): company-namespace rows may sync into decision-clock
// storage (Cosmos decisions_pending, shared with the rest of the fleet) and may ride decision-clock's
// own fleet-dispatch nudge. PERSONAL-namespace rows (Matt's confidential CA matters) NEVER touch
// decisions_pending, fleet-dispatch, commons-journal, or memory-exec -- they are paged ONLY via the
// direct graph_send_email channel, and their cooldown state lives ONLY inside the CLO's own
// access-controlled `personal` Azure Blob container (skills/legal-deadline-pager/personal-store.mjs),
// keyed by an opaque hash so not even the cooldown blob carries cleartext case detail.
//
// Only VERIFIED rows page. legal.mjs's normalizeDocketRow() already defaults a row with neither
// `source` nor `verified` to manual/verified:true (a human typed it in); the extraction/watcher pipeline
// (skills/legal/deadline-extract.mjs, skills/legal/courtlistener-watch.mjs) stages candidates as
// verified:false until a human confirms them with `docket verify`, and this pager will never page an
// unconfirmed row.
//
// Usage:
//   node pager.mjs sweep [--commit] [--json] [--window-days N] [--due-days N] [--cooldown-hours N]
//                        [--recipient <email>]
//   node pager.mjs heartbeat [--json]     # read-only: last sweep run + staleness (>48h = outage signal)
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import * as cosmos from "../decision-clock/cosmos-client.mjs";
import { mintToken } from "../gateway-connect/connect.mjs";
import { getPersonalCooldown as _getPersonalCooldown, putPersonalCooldown as _putPersonalCooldown } from "./personal-store.mjs";
import { normalizeDocketRow } from "../legal/legal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LEGAL_MJS = join(HERE, "..", "legal", "legal.mjs");
const DECISION_CONTAINER = "decisions_pending"; // the ONLY container cosmos-client.mjs allows; reused as-is, no new container.
const GATEWAY_MCP = "https://mcp.otchealth.app/mcp";
const HEARTBEAT_ID = "legal-pager-heartbeat";

export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_DUE_DAYS = 30;
export const DEFAULT_COOLDOWN_HOURS = 24;
export const DEFAULT_RECIPIENT = "matthew@innd.com"; // legal-entity address per CLO-BOOTSTRAP.md; graph_send_email sends AS coo@otchealthmart.com.
export const DEFAULT_HEARTBEAT_MAX_AGE_H = 48;

// ============================ PURE CORE (hermetically tested, no I/O) ============================

/** Days between `now` and a docket row's YYYY-MM-DD date, at UTC day granularity. Negative = overdue.
 *  Pure; returns null if the row has no usable date. */
export function daysUntil(row, nowIso) {
  if (!row || !row.date) return null;
  const due = new Date(`${row.date}T00:00:00Z`);
  if (Number.isNaN(due.getTime())) return null;
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) return null;
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return (due.getTime() - todayUtc) / 86400000;
}

/** Apply the source/verified default rule. Delegates to legal.mjs's own normalizeDocketRow() (the
 *  single source of truth for this rule -- see skills/legal/legal.mjs, Phase 7b/7d) rather than
 *  maintaining a second, independently-drifting copy of the same logic. legal.mjs is safely importable
 *  (its CLI dispatch is isMain-guarded; importing it never touches the network or exits the process).
 *  Pure (normalizeDocketRow itself does no I/O); null-guarded beyond what normalizeDocketRow does on
 *  its own, since this pager may be handed a malformed row from an untrusted source. */
export function resolveSourceVerified(row) {
  if (!row) return { source: "manual", verified: true };
  const n = normalizeDocketRow(row);
  return { source: n.source, verified: n.verified };
}

/** True when a row is due within `windowDays` of now, INCLUDING already-overdue rows (a missed legal
 *  deadline stays urgent, not less urgent, the longer it is ignored -- no lower bound is applied). Pure. */
export function isTightWindow(row, nowIso, windowDays = DEFAULT_WINDOW_DAYS) {
  const d = daysUntil(row, nowIso);
  return d !== null && Number.isFinite(d) && d <= windowDays;
}

/** Stable, OPAQUE dedupe/cooldown key for a docket row: a sha256 hash, never the cleartext content. Safe
 *  to persist even in the confidential personal store (defense in depth: no case detail in the key
 *  itself). Pure. */
export function rowKey(row) {
  const basis = `${(row && row.ns) || ""}|${(row && row.id) || ""}|${(row && row.date) || ""}|${(row && row.what) || ""}`;
  return "leg_" + crypto.createHash("sha256").update(basis).digest("hex").slice(0, 24);
}

/** Full pure classification of raw docket rows (as returned by `legal.mjs docket due --json`): applies
 *  the verified default, computes the tight-window test, and splits pageable rows by namespace. Rows
 *  failing either test land in `skipped` with a `_reason` (never silently dropped). Pure. */
export function classifyDocketRows(rows, nowIso, opts = {}) {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const out = { pageable: [], company: [], personal: [], skipped: [] };
  for (const raw of rows || []) {
    const { source, verified } = resolveSourceVerified(raw);
    const tight = isTightWindow(raw, nowIso, windowDays);
    const row = { ...raw, source, verified, _key: rowKey(raw), _tight: tight };
    if (verified && tight) {
      out.pageable.push(row);
      (row.ns === "personal" ? out.personal : out.company).push(row);
    } else {
      out.skipped.push({ ...row, _reason: !verified ? "unverified" : "out-of-window" });
    }
  }
  return out;
}

/** True when enough time has elapsed since the last page to allow another one. No prior page (null/
 *  undefined) always counts as elapsed. Pure. */
export function cooldownElapsed(lastPagedAtIso, nowIso, cooldownHours = DEFAULT_COOLDOWN_HOURS) {
  if (!lastPagedAtIso) return true;
  const ms = Date.parse(nowIso) - Date.parse(lastPagedAtIso);
  if (!Number.isFinite(ms)) return true;
  return ms >= cooldownHours * 3600 * 1000;
}

/** The SECOND, independent arm gate for actually sending email (the first is the --commit CLI flag).
 *  Only the exact string "1" arms it -- "true"/"yes"/unset all stay disarmed. Env is injected (not read
 *  from process.env directly) so this stays a pure, hermetically-testable function. */
export function isPagerEnabled(env = process.env) {
  return env.LEGAL_PAGER_ENABLED === "1";
}

/** True when the last recorded sweep run is older than maxAgeHours (default 48h) -- the outage signal.
 *  No prior run at all also counts as stale. Pure. */
export function isHeartbeatStale(lastRunAtIso, nowIso, maxAgeHours = DEFAULT_HEARTBEAT_MAX_AGE_H) {
  if (!lastRunAtIso) return true;
  const ms = Date.parse(nowIso) - Date.parse(lastRunAtIso);
  if (!Number.isFinite(ms)) return true;
  return ms > maxAgeHours * 3600 * 1000;
}

/** Plain-text page body for one namespace's batch. Pure (given `now`). No em/en dashes. */
export function formatPageBody(rows, ns, nowIso) {
  const lines = [];
  lines.push(
    ns === "personal"
      ? "CONFIDENTIAL: the following personal legal matter deadline(s) fall within the pager alert window."
      : "The following company legal matter deadline(s) fall within the pager alert window.",
  );
  lines.push("");
  for (const r of rows) {
    const d = daysUntil(r, nowIso);
    const tag = d !== null && d < 0 ? `OVERDUE by ${Math.abs(Math.round(d))} day(s)` : `due in ${Math.max(0, Math.round(d ?? 0))} day(s)`;
    lines.push(`- ${r.date} (${tag}) - matter ${r.id} - ${r.what}`);
  }
  lines.push("");
  lines.push("Source: legal-deadline-pager. Verified deadlines only; unverified or unconfirmed extractions are never paged.");
  return lines.join("\n");
}

// ============================ I/O: default implementations (real Cosmos/Blob/gateway) ============================

async function defaultGetCompanyDoc(key) {
  if (!(await cosmos.isConfigured())) return null;
  const found = await cosmos.readDoc(DECISION_CONTAINER, "clo", key);
  return found ? found.doc : null;
}

async function defaultUpsertCompanyDoc(doc) {
  if (!(await cosmos.isConfigured())) { console.log("[legal-deadline-pager] decision-clock storage not reachable in this environment (company sync skipped)."); return; }
  await cosmos.upsertDoc(DECISION_CONTAINER, "clo", doc);
}

async function defaultWriteHeartbeat(info) {
  if (!(await cosmos.isConfigured())) { console.log("[legal-deadline-pager] decision-clock storage not reachable in this environment (heartbeat skipped)."); return; }
  const doc = {
    id: HEARTBEAT_ID, owner: "clo", category: "legal-pager-heartbeat", status: "closed",
    text: `legal-deadline-pager last ran ${info.ts} mode=${info.mode}`,
    opened_at: info.ts, expected_by: info.ts, closed_at: info.ts,
    last_run_at: info.ts, last_run_mode: info.mode,
    rows_seen: info.rows_seen, pageable_company: info.pageable_company, pageable_personal: info.pageable_personal,
    emails_sent: info.emails_sent,
  };
  await cosmos.upsertDoc(DECISION_CONTAINER, "clo", doc);
}

async function readHeartbeat() {
  if (!(await cosmos.isConfigured())) return null;
  const found = await cosmos.readDoc(DECISION_CONTAINER, "clo", HEARTBEAT_ID);
  return found ? found.doc : null;
}

async function callGatewayTool(lane, name, args) {
  const { token } = await mintToken(lane);
  const r = await fetch(GATEWAY_MCP, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch { const m = txt.match(/data: (\{[\s\S]*\})/); j = m ? JSON.parse(m[1]) : { raw: txt.slice(0, 400) }; }
  const isError = !!(j && j.result && j.result.isError);
  return { status: r.status, ok: r.ok && !isError, text: (j && j.result && j.result.content && j.result.content[0] && j.result.content[0].text) ?? JSON.stringify((j && j.result) || j) };
}

/** Send one page via the gateway's graph_send_email tool (cto lane -- the only lane that tool's
 *  governance rule permits; see otchealth-mcp-server src/catalog/governance.ts). Never throws; a
 *  failure is reported as `{ sent: false, error }` so the sweep degrades instead of crashing. */
async function defaultSendEmail({ recipient, subject, body }) {
  try {
    const res = await callGatewayTool("cto", "graph_send_email", { to: recipient, subject, body, body_type: "Text" });
    return { sent: res.ok, status: res.status, detail: String(res.text || "").slice(0, 300) };
  } catch (e) {
    console.log(`[legal-deadline-pager] email send failed (${e.message}); not sent.`);
    return { sent: false, error: e.message };
  }
}

// ============================ orchestration (dependency-injected for hermetic tests) ============================

/**
 * runSweep(rows, nowIso, opts) -> summary
 *
 * rows: raw docket rows as returned by `legal.mjs docket due --json` (each has ns/id/date/what and
 *   optionally source/verified/overdue/added).
 * opts.commit (default false): arms ALL writes (company decision-clock sync, personal cooldown store,
 *   heartbeat) and is a PREREQUISITE for sending email. Without it this is a pure read + report: zero
 *   writes, zero sends, and cooldown state is never even looked up (every pageable row is reported as
 *   "would page" -- the safe, informative upper bound for a dry run).
 * opts.enabled (default false): the SECOND gate, required in addition to commit, for actually calling
 *   sendEmail. In cto/company terms: commit alone lets the CTO verify the tracking mechanics (decision-
 *   clock rows appear correctly) without ever paging anyone.
 * opts.{getCompanyDoc,upsertCompanyDoc,getPersonalCooldown,putPersonalCooldown,sendEmail,writeHeartbeat}:
 *   injectable I/O implementations; default to the real Cosmos/Blob/gateway calls. Tests pass mocks so
 *   this function never needs live Cosmos/graph/KV/SA credentials.
 */
export async function runSweep(rows, nowIso, opts = {}) {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const cooldownHours = opts.cooldownHours ?? DEFAULT_COOLDOWN_HOURS;
  const recipient = opts.recipient || DEFAULT_RECIPIENT;
  const commit = !!opts.commit;
  const enabled = !!opts.enabled;
  const getCompanyDoc = opts.getCompanyDoc || defaultGetCompanyDoc;
  const upsertCompanyDoc = opts.upsertCompanyDoc || defaultUpsertCompanyDoc;
  const getPersonalCooldown = opts.getPersonalCooldown || _getPersonalCooldown;
  const putPersonalCooldown = opts.putPersonalCooldown || _putPersonalCooldown;
  const sendEmail = opts.sendEmail || defaultSendEmail;
  const writeHeartbeat = opts.writeHeartbeat || defaultWriteHeartbeat;

  const classified = classifyDocketRows(rows, nowIso, { windowDays });

  // ---- company (may use decision-clock storage; a SHARED, fleet-queryable store -- fine for company matters) ----
  const companyToEmail = [];
  for (const row of classified.company) {
    let lastPagedAt = null;
    if (commit) {
      const existing = await getCompanyDoc(row._key).catch(() => null);
      lastPagedAt = (existing && existing.last_paged_at) || null;
    }
    const due = cooldownElapsed(lastPagedAt, nowIso, cooldownHours);
    if (due) companyToEmail.push(row);
    if (commit) {
      await upsertCompanyDoc({
        id: row._key,
        owner: "clo",
        category: "legal-deadline",
        text: row.what,
        opened_at: nowIso,
        expected_by: row.date,
        status: "open",
        legal_matter: row.id,
        legal_ns: "company",
        source: row.source,
        verified: row.verified,
        // last_paged_at is advanced only once the email actually sends (see below); this initial
        // upsert keeps the row's tracking fields current every sweep regardless of send outcome.
        last_paged_at: lastPagedAt || undefined,
      });
    }
  }

  // ---- personal (NEVER decision-clock/fleet-dispatch/commons-journal/memory-exec; the private Blob
  //      cooldown store ONLY, keyed by an opaque hash -- see rowKey()) ----
  const personalToEmail = [];
  let personalCooldownMap = {};
  if (classified.personal.length) {
    personalCooldownMap = commit ? await getPersonalCooldown().catch(() => ({})) : {};
    for (const row of classified.personal) {
      const lastPagedAt = (personalCooldownMap[row._key] && personalCooldownMap[row._key].last_paged_at) || null;
      const due = commit ? cooldownElapsed(lastPagedAt, nowIso, cooldownHours) : true;
      if (due) personalToEmail.push(row);
    }
  }

  // ---- send: requires BOTH commit AND enabled (the two independent arm gates) ----
  const emails = [];
  if (commit && enabled) {
    if (companyToEmail.length) {
      const subject = `Legal deadline alert: ${companyToEmail.length} company matter deadline(s) within ${windowDays}d`;
      const body = formatPageBody(companyToEmail, "company", nowIso);
      const res = await sendEmail({ namespace: "company", recipient, subject, body, rows: companyToEmail });
      emails.push({ namespace: "company", recipient, ...res });
      if (res && res.sent) {
        for (const row of companyToEmail) {
          await upsertCompanyDoc({
            id: row._key, owner: "clo", category: "legal-deadline", text: row.what,
            opened_at: nowIso, expected_by: row.date, status: "open",
            legal_matter: row.id, legal_ns: "company", source: row.source, verified: row.verified,
            last_paged_at: nowIso,
          });
        }
      }
    }
    if (personalToEmail.length) {
      const subject = `CONFIDENTIAL: personal legal deadline alert (${personalToEmail.length} within ${windowDays}d)`;
      const body = formatPageBody(personalToEmail, "personal", nowIso);
      const res = await sendEmail({ namespace: "personal", recipient, subject, body, rows: personalToEmail });
      emails.push({ namespace: "personal", recipient, ...res });
      if (res && res.sent) {
        for (const row of personalToEmail) personalCooldownMap[row._key] = { last_paged_at: nowIso };
        await putPersonalCooldown(personalCooldownMap).catch(() => {});
      }
    }
  }

  if (commit) {
    await writeHeartbeat({
      ts: nowIso,
      mode: enabled ? "commit+enabled" : "commit",
      rows_seen: (rows || []).length,
      pageable_company: classified.company.length,
      pageable_personal: classified.personal.length,
      emails_sent: emails.filter((e) => e.sent).length,
    }).catch(() => {});
  }

  return {
    now: nowIso,
    commit,
    enabled,
    windowDays,
    cooldownHours,
    recipient,
    rows_seen: (rows || []).length,
    pageable_company: classified.company.length,
    pageable_personal: classified.personal.length,
    skipped: classified.skipped.length,
    company_to_email: companyToEmail.map((r) => r._key),
    personal_to_email: personalToEmail.map((r) => r._key),
    emails,
  };
}

// ============================ CLI ============================

function fetchDocketRowsSync(dueDays) {
  try {
    const out = execFileSync("node", [LEGAL_MJS, "docket", "due", String(dueDays), "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rows = JSON.parse(out);
    return { ok: true, rows: Array.isArray(rows) ? rows : [] };
  } catch (e) {
    const detail = (e && (e.stderr ? e.stderr.toString() : e.message)) || "unknown error";
    return { ok: false, reason: detail };
  }
}

async function heartbeatCmd() {
  const now = new Date().toISOString();
  const doc = await readHeartbeat();
  if (!doc) {
    console.log("[legal-deadline-pager] no heartbeat recorded yet in this environment (the sweep has never run with --commit here, or decision-clock storage is unreachable).");
    if (process.argv.includes("--json")) console.log(JSON.stringify({ ok: false, last_run_at: null }, null, 2));
    process.exitCode = 1;
    return;
  }
  const stale = isHeartbeatStale(doc.last_run_at, now);
  const out = {
    last_run_at: doc.last_run_at,
    last_run_mode: doc.last_run_mode,
    stale,
    rows_seen: doc.rows_seen,
    pageable_company: doc.pageable_company,
    pageable_personal: doc.pageable_personal,
    emails_sent: doc.emails_sent,
  };
  if (process.argv.includes("--json")) console.log(JSON.stringify(out, null, 2));
  else console.log(`[legal-deadline-pager] last run ${doc.last_run_at} (mode=${doc.last_run_mode}) ${stale ? "STALE (>48h, sweep may be down)" : "fresh"} -- rows_seen=${doc.rows_seen} pageable(company=${doc.pageable_company},personal=${doc.pageable_personal}) emails_sent=${doc.emails_sent}`);
  if (stale) process.exitCode = 1;
}

async function sweepCmd() {
  const argv = process.argv.slice(2);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const dueDays = parseInt(val("--due-days", String(DEFAULT_DUE_DAYS)), 10);
  const windowDays = parseInt(val("--window-days", String(DEFAULT_WINDOW_DAYS)), 10);
  const cooldownHours = parseInt(val("--cooldown-hours", String(DEFAULT_COOLDOWN_HOURS)), 10);
  const recipient = val("--recipient", process.env.LEGAL_PAGER_RECIPIENT || DEFAULT_RECIPIENT);
  const commit = argv.includes("--commit");
  const enabled = commit && isPagerEnabled(process.env);
  const asJson = argv.includes("--json");
  const now = new Date().toISOString();

  const fetched = fetchDocketRowsSync(dueDays);
  if (!fetched.ok) {
    console.log(`[legal-deadline-pager] docket read unavailable in this environment (dry-run; nothing to page). detail: ${String(fetched.reason).slice(0, 200)}`);
    if (asJson) console.log(JSON.stringify({ now, ok: false, reason: fetched.reason }, null, 2));
    return;
  }

  const summary = await runSweep(fetched.rows, now, { windowDays, cooldownHours, recipient, commit, enabled });

  if (asJson) { console.log(JSON.stringify(summary, null, 2)); return; }
  console.log(`# legal-deadline-pager sweep ${now} (mode=${commit ? (enabled ? "COMMIT+ARMED" : "commit-tracking-only") : "DRY-RUN"})`);
  console.log(`  rows seen: ${summary.rows_seen}, skipped (unverified/out-of-window): ${summary.skipped}`);
  console.log(`  pageable: company=${summary.pageable_company} personal=${summary.pageable_personal}`);
  console.log(`  would email now: company=${summary.company_to_email.length} personal=${summary.personal_to_email.length}`);
  if (!commit) console.log("  (dry-run: nothing written, nothing sent. Pass --commit to sync tracking state; also set env LEGAL_PAGER_ENABLED=1 to actually send email.)");
  else if (!enabled) console.log("  (tracking synced; email DISARMED -- set env LEGAL_PAGER_ENABLED=1 to arm sending.)");
  for (const e of summary.emails) console.log(`  email[${e.namespace}]: sent=${e.sent}${e.status ? ` http=${e.status}` : ""}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const cmd = process.argv[2];
    try {
      if (cmd === "sweep") await sweepCmd();
      else if (cmd === "heartbeat") await heartbeatCmd();
      else {
        console.error("usage: pager.mjs sweep [--commit] [--json] [--window-days N] [--due-days N] [--cooldown-hours N] [--recipient <email>] | heartbeat [--json]");
        process.exit(2);
      }
    } catch (e) {
      console.error("legal-deadline-pager ERROR: " + e.message);
      process.exit(1);
    }
  })();
}

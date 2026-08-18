#!/usr/bin/env node
// cfo-reconstruction -- advances the CFO's multi-year financial-reconstruction ANALYSIS on a Tier-1
// nightly cadence, so it keeps rolling forward between Matt/CFO check-ins instead of sitting idle
// while the turn-based CFO agent waits for its next Claude Chat/Cowork turn. READ-ONLY, ANALYSIS
// ONLY: this file (and everything it imports) never posts, writes, or otherwise changes an entity's
// books. Every Xero call goes through xero-readonly.mjs's hardcoded allowlist (see that file's
// header for the full rationale, including why the posting skill/job are deliberately never named
// by their literal path in this skill's own source); the actual posting workflow is a SEPARATE,
// already-existing, Matt-gated system that this skill never touches, imports, or shells out to.
//
// TWO analysis kinds, run every sweep, both bounded/resumable/idempotent:
//   (A) xero-snapshot   -- self-bootstrapping. Pulls a read-only TrialBalance + BalanceSheet
//       snapshot per entity (otchealth | innd | hearingassist | personal), diffs its content hash
//       against the last staged snapshot, and reports CHANGED/UNCHANGED. Needs no external input,
//       so the job is never a no-op even before anyone stages a manifest -- it keeps a rolling
//       drift signal fresh across all four entities on its own.
//   (B) manifest-drain  -- optional. If skills/cfo-reconstruction (or the CFO, by hand) has staged
//       an externally-produced work queue in the data room at
//       reconstruction-analysis/manifest/<org>.jsonl (one JSON object per line, status:"pending"),
//       this drains up to --batch-size of them per run and runs a read-only verification per item
//       (currently: kind "attachment-check" -- does the Xero record actually carry the attachment
//       the reconstruction claims, and does the matching source doc exist in the data room).
//
// Every sweep that finds something writes ONE staged batch artifact (JSON, with evidence) to the
// CFO data room (cfo-store, the authoritative copy) and mirrors it to CFO OneDrive "CFO Incoming"
// (the human-facing copy Matt/CFO actually look at), then best-effort opens a decision-clock review
// gate and logs a status line to the CFO's memory ledger. Nothing here ever emails, pages, or sends
// content externally; everything stays inside the CFO's own non-PHI, INND-MNPI-aware data room.
//
// Usage:
//   node reconstruct.mjs sweep [--dry-run] [--json] [--batch-size N] [--max-minutes N]
//                               [--stale-hours N] [--orgs otchealth,innd,hearingassist,personal]
//   node reconstruct.mjs status [--json]     # read-only: last snapshot per org, from the cursor
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { callXeroReadOnly, cfoBearer } from "./xero-readonly.mjs";

export { callXeroReadOnly, cfoBearer };

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE_MJS = join(HERE, "..", "cfo-store", "store.mjs");
const ONEDRIVE_MJS = join(HERE, "..", "cfo-onedrive", "onedrive.mjs");
const DECISION_MJS = join(HERE, "..", "decision-clock", "decision.mjs");
const MEM_MJS = join(HERE, "..", "kb-memory", "mem.mjs");

// Deliberately a SEPARATE namespace from the existing posting job's own queue/state/results prefix
// in the data room (see runbooks/cfo-reconstruction-job.md "Separation from the posting job" for
// its exact name) -- this skill never reads or writes anywhere under that prefix, so there is zero
// shared mutable state between this read-only analysis job and the write-capable posting job.
const STATE_OBJECT = "reconstruction-analysis/state/cursor.json";
const MANIFEST_PREFIX = "reconstruction-analysis/manifest"; // + /<org>.jsonl
const STAGED_PREFIX = "reconstruction-analysis/staged"; // + /<batchId>.json

export const ORG_KEYS = Object.freeze(["otchealth", "innd", "hearingassist", "personal"]);
export const DEFAULT_STALE_HOURS = 20; // a snapshot is due again once older than this
export const DEFAULT_BATCH_SIZE = 25; // manifest items drained per run (mirrors the CFO's own "1 file/call" staging convention)
export const DEFAULT_MAX_MINUTES = 20; // soft time budget, mirrors doc-indexer's CU_MAX_MINUTES pattern

// ============================ PURE CORE (hermetically tested, no I/O) ============================

/** sha256 hex digest of a string. Pure. */
export function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

/** Stable id for one unit of analysis work, so the SAME logical item always gets the SAME id across
 *  runs (idempotency building block). Pure. */
export function computeItemId(item) {
  const basis = `${item.org || ""}|${item.kind || ""}|${item.ref ?? ""}|${item.period ?? ""}|${item.endpoint ?? ""}|${item.guid ?? ""}`;
  return "cfr_" + sha256Hex(basis).slice(0, 20);
}

/** Stable batch id: a content hash of the sorted item ids plus the UTC calendar date. Re-running
 *  with the SAME unresolved set of items on the SAME day always yields the SAME batch id, so
 *  re-staging after a crash/retry is a safe overwrite of the same object name, never a duplicate.
 *  A genuinely different item set, or a new day, yields a different id. Pure. */
export function computeBatchId(itemIds, dateStr) {
  const sorted = [...itemIds].sort();
  return "batch_" + sha256Hex(`${dateStr}|${sorted.join(",")}`).slice(0, 16);
}

/** Which of the four entities are due for a fresh xero-snapshot: never snapshotted yet, or the last
 *  staged snapshot is older than staleHours. Pure (state/now are both injected values, no clock or
 *  I/O read inside). */
export function dueOrgsForSnapshot(state, nowIso, staleHours = DEFAULT_STALE_HOURS) {
  const snaps = (state && state.last_snapshot) || {};
  const nowMs = Date.parse(nowIso);
  return ORG_KEYS.filter((org) => {
    const at = snaps[org] && snaps[org].staged_at;
    if (!at) return true;
    const ageMs = nowMs - Date.parse(at);
    return !Number.isFinite(ageMs) || ageMs > staleHours * 3600 * 1000;
  });
}

/** True when a newly computed content hash differs from the previously staged one (or there was no
 *  previous one, which always counts as changed). Pure. */
export function hasMaterialChange(prevHash, newHash) {
  return prevHash !== newHash;
}

/** Select up to `n` pending manifest items, in stable file order. This is the batch-selection
 *  helper: it never reorders by anything other than file order (so the same manifest always drains
 *  in the same sequence run to run) and never returns more than `n`, keeping every run bounded.
 *  Pure. */
export function selectPendingManifestItems(items, n) {
  const pending = (items || []).filter((it) => it && it.status === "pending");
  return pending.slice(0, Math.max(0, n | 0));
}

/** Robustly count attachments from a parsed xero_attachments response, tolerant of the plausible
 *  wrapper shapes (a bare array, {Attachments:[...]}, {attachments:[...]}). Unrecognized shapes
 *  count as zero rather than throwing, so a shape surprise degrades to "flag for human review"
 *  (MISSING_XERO_ATTACHMENT) instead of crashing the whole batch. Pure. */
export function countAttachments(parsed) {
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && Array.isArray(parsed.Attachments)) return parsed.Attachments.length;
  if (parsed && Array.isArray(parsed.attachments)) return parsed.attachments.length;
  return 0;
}

/** Decide the verdict for one attachment-check item given already-fetched read-only facts. Pure --
 *  callers fetch xeroHasAttachment / sourceDocExists first via I/O, then classify. */
export function classifyAttachmentVerdict({ xeroHasAttachment, sourceDocExists }) {
  if (xeroHasAttachment && sourceDocExists) return "MATCHED";
  if (!xeroHasAttachment && !sourceDocExists) return "MISSING_BOTH";
  if (!xeroHasAttachment) return "MISSING_XERO_ATTACHMENT";
  return "MISSING_SOURCE_DOC";
}

/** Assemble the staged-batch envelope: the actual JSON artifact written to the CFO data room. Pure
 *  (batchId/mode/items/nowIso are all inputs; no clock or I/O read inside). The note field is
 *  deliberately explicit and repeated in the runbook + PR description -- a human opening this file
 *  cold, with no other context, should not be able to misread it as something that already posted. */
export function buildStagedBatch({ batchId, mode, items, nowIso }) {
  return {
    batch_id: batchId,
    generated_at: nowIso,
    job: "cfo-reconstruction-nightly",
    mode,
    item_count: items.length,
    items,
    posting_performed: false,
    sign_off_required: true,
    note:
      "READ-ONLY ANALYSIS ONLY. This batch was produced by a Tier-1 nightly job that reads Xero " +
      "(via the gateway's read-only tools) and stages findings here for human review. It never " +
      "posts, writes, or otherwise changes any ledger. Any correction implied by an item below is " +
      "actioned manually, or through the CFO's existing Matt-gated posting workflow, never " +
      "automatically by this job.",
  };
}

// ============================ I/O: default implementations (shell to the sanctioned skills) ============================
// Every default here shells out to the EXISTING, sanctioned CLI for that store (cfo-store,
// cfo-onedrive, decision-clock, kb-memory) via execFileSync rather than re-implementing Azure
// Blob/Graph/Cosmos auth in a third place -- the same pattern skills/legal-deadline-pager/pager.mjs
// uses to read the legal docket. All are dependency-injectable (see runSweep's opts) so tests never
// need live Azure/Cosmos/Graph credentials.

function tmpFile(name) {
  const dir = mkdtempSync(join(tmpdir(), "cfo-recon-"));
  return join(dir, name);
}
function cleanup(f) { try { rmSync(dirname(f), { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }

async function defaultGetState() {
  const f = tmpFile("cursor.json");
  try {
    execFileSync("node", [STORE_MJS, "--s3", "get", STATE_OBJECT, f], { stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    // Not found yet (first run ever) or the store is unreachable in this environment -- either way
    // the caller falls back to a fresh cursor. A REAL credential problem still surfaces loudly,
    // because the subsequent putStagedBatch()/putState() calls are not caught this way (see below).
    return null;
  } finally { cleanup(f); }
}

async function defaultPutState(state) {
  const f = tmpFile("cursor.json");
  writeFileSync(f, JSON.stringify(state, null, 2));
  try { execFileSync("node", [STORE_MJS, "--s3", "put", f, STATE_OBJECT], { stdio: ["ignore", "pipe", "pipe"] }); }
  finally { cleanup(f); }
}

async function defaultGetManifest(org) {
  const f = tmpFile(`${org}.jsonl`);
  try {
    execFileSync("node", [STORE_MJS, "--s3", "get", `${MANIFEST_PREFIX}/${org}.jsonl`, f], { stdio: ["ignore", "pipe", "pipe"] });
    return readFileSync(f, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return []; // no manifest staged for this org yet -- that is a normal, expected state, not an error
  } finally { cleanup(f); }
}

async function defaultPutManifest(org, items) {
  const f = tmpFile(`${org}.jsonl`);
  writeFileSync(f, items.map((it) => JSON.stringify(it)).join("\n") + (items.length ? "\n" : ""));
  try { execFileSync("node", [STORE_MJS, "--s3", "put", f, `${MANIFEST_PREFIX}/${org}.jsonl`], { stdio: ["ignore", "pipe", "pipe"] }); }
  finally { cleanup(f); }
}

/** Existence check for a source-doc path in the data room: a real `get` (not a prefix `list`) so a
 *  document whose name happens to be a prefix of another does not register as a false match. */
async function defaultSourceDocExists(objectName) {
  const f = tmpFile("probe");
  try {
    execFileSync("node", [STORE_MJS, "--s3", "get", objectName, f], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  } finally { cleanup(f); }
}

async function defaultPutStagedBatch(batchId, batch) {
  const objectName = `${STAGED_PREFIX}/${batchId}.json`;
  const f = tmpFile(`${batchId}.json`);
  writeFileSync(f, JSON.stringify(batch, null, 2));
  try {
    execFileSync("node", [STORE_MJS, "--s3", "put", f, objectName], { stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, path: `s3://otchealthcfodata/cfo-source-docs/${objectName}` };
  } finally { cleanup(f); }
}

async function defaultDeliverToOneDrive(batchId, batch) {
  const f = tmpFile(`${batchId}.json`);
  writeFileSync(f, JSON.stringify(batch, null, 2));
  const destName = `Reconstruction Analysis ${String(batch.generated_at).slice(0, 10)} ${batchId}.json`;
  try {
    execFileSync("node", [ONEDRIVE_MJS, "deliver", f, destName], { stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, path: `CFO Incoming/${destName}` };
  } finally { cleanup(f); }
}

/** Best-effort: opens a decision-clock "review" gate pointing at the staged batch, so "ready for
 *  Matt/CFO sign-off" is durably tracked rather than only ever existing as a file in a folder.
 *  decision-clock itself degrades to a logged dry-run if Cosmos is unreachable in this environment
 *  (see cosmos.isConfigured() in decision-clock/cosmos-client.mjs), so this never blocks the run. */
async function defaultOpenReviewGate(batch, evidenceLink, innd) {
  const args = [
    DECISION_MJS, "open", "--category", "review", "--owner", "cfo",
    "--text", `Reconstruction analysis batch ${batch.batch_id}: ${batch.item_count} item(s) staged, ready for sign-off (mode=${batch.mode}).`,
  ];
  if (evidenceLink) args.push("--evidence", evidenceLink);
  if (innd) args.push("--innd");
  const out = execFileSync("node", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: true, detail: out.trim().slice(0, 300) };
}

/** Best-effort: publishes one status line to the CFO's shared kb-memory ledger (per the fleet's
 *  "the ledger is the source of truth, not the chat" convention), so any agent/Matt running
 *  mem.mjs tail/team sees this job's nightly progress without opening the data room. */
async function defaultLogStatus(text) {
  const out = execFileSync("node", [MEM_MJS, "remember", text, "--agent", "cfo", "--share"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: true, detail: out.trim().slice(0, 300) };
}

// ============================ orchestration (dependency-injected for hermetic tests) ============================

/**
 * runSweep(opts) -> summary
 *
 * The Container Apps Job entrypoint's actual work. Runs kind (A) xero-snapshot for every entity due
 * a refresh, then kind (B) manifest-drain for up to opts.batchSize pending items per entity, both
 * bounded by opts.maxMinutes. If anything was found, assembles ONE staged batch and (unless
 * opts.dryRun) writes it to the data room, mirrors it to OneDrive, advances the resumable cursor,
 * and best-effort opens a review gate + logs a status line.
 *
 * Every I/O touchpoint is dependency-injectable via opts (getBearer, xeroCall, getState, putState,
 * getManifest, putManifest, sourceDocExists, putStagedBatch, deliverToOneDrive, openReviewGate,
 * logStatus) and defaults to the real implementations above. Tests pass in-memory fakes so this
 * function never needs live gateway/Azure credentials to be exercised.
 *
 * Ordering matters for resumability: putStagedBatch() (the authoritative write) happens FIRST; the
 * cursor and manifest "staged" markers are only advanced AFTER it succeeds. A crash before that
 * point simply recomputes and re-writes the identical batch id next run (safe overwrite). A crash
 * between the batch write and finishing every putManifest() call can leave a handful of manifest
 * items re-processed (and re-staged, under a new batch id) on the next run -- a documented,
 * acceptable limitation for a read-only analysis job (redundant staging is a minor human-review
 * nuisance, never a safety problem, unlike a posting job would be).
 */
export async function runSweep(opts = {}) {
  const nowIso = opts.nowIso || new Date().toISOString();
  const dryRun = !!opts.dryRun;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const staleHours = opts.staleHours ?? DEFAULT_STALE_HOURS;
  const maxMinutes = opts.maxMinutes ?? DEFAULT_MAX_MINUTES;
  // Array.isArray (not a truthy/length check) so an EXPLICITLY empty array means "no orgs this run"
  // rather than silently falling back to every org -- only "not provided at all" (undefined/null,
  // what the CLI's parseCsv returns when --orgs is omitted) defaults to ORG_KEYS.
  const orgs = Array.isArray(opts.orgs) ? opts.orgs : ORG_KEYS;
  const deadline = Date.now() + maxMinutes * 60000;

  const getBearer = opts.getBearer || cfoBearer;
  const xeroCall = opts.xeroCall || callXeroReadOnly; // (bearer, toolName, args) -> parsed JSON
  const getState = opts.getState || defaultGetState;
  const putState = opts.putState || defaultPutState;
  const getManifest = opts.getManifest || defaultGetManifest;
  const putManifest = opts.putManifest || defaultPutManifest;
  const sourceDocExists = opts.sourceDocExists || defaultSourceDocExists;
  const putStagedBatch = opts.putStagedBatch || defaultPutStagedBatch;
  const deliverToOneDrive = opts.deliverToOneDrive || defaultDeliverToOneDrive;
  const openReviewGate = opts.openReviewGate || defaultOpenReviewGate;
  const logStatus = opts.logStatus || defaultLogStatus;

  const state = (await getState()) || { last_snapshot: {}, updated_at: null };
  const bearer = await getBearer();

  const items = [];
  const newSnapshotState = { ...state.last_snapshot };

  // ---- kind A: xero-snapshot (self-bootstrapping, no external input needed) ----
  const due = dueOrgsForSnapshot(state, nowIso, staleHours).filter((o) => orgs.includes(o));
  for (const org of due) {
    if (Date.now() > deadline) break;
    const base = { org, kind: "xero-snapshot" };
    const id = computeItemId(base);
    try {
      const asAt = nowIso.slice(0, 10);
      const [trialBalance, balanceSheet] = await Promise.all([
        xeroCall(bearer, "xero_report", { org, report: "TrialBalance", date: asAt }),
        xeroCall(bearer, "xero_report", { org, report: "BalanceSheet", date: asAt }),
      ]);
      const evidence = { as_at: asAt, trialBalance, balanceSheet };
      // Content hash covers ONLY the financial data (trialBalance/balanceSheet), never as_at: the
      // as-at date is requested fresh every run (it is always "today"), so including it would make
      // every run past midnight report CHANGED regardless of whether the underlying figures moved,
      // defeating the entire point of the CHANGED/UNCHANGED drift signal. as_at still rides along in
      // the evidence payload (useful context for the human reviewer), just not in what decides the
      // verdict.
      const contentHash = sha256Hex(JSON.stringify({ trialBalance, balanceSheet }));
      const prevHash = state.last_snapshot[org] && state.last_snapshot[org].content_hash;
      const changed = hasMaterialChange(prevHash, contentHash);
      items.push({
        ...base, id,
        verdict: changed ? "CHANGED" : "UNCHANGED",
        content_hash: contentHash,
        prev_content_hash: prevHash || null,
        evidence: changed ? evidence : undefined, // an unchanged snapshot does not need to repeat the full payload
      });
      newSnapshotState[org] = { content_hash: contentHash, staged_at: nowIso };
    } catch (e) {
      items.push({ ...base, id, verdict: "ERROR", error: String((e && e.message) || e) });
      // deliberately do NOT update newSnapshotState[org] on error, so a failed org is retried next run
    }
  }

  // ---- kind B: manifest-drain (optional, externally staged) ----
  const manifestUpdates = {}; // org -> full updated items array, only persisted after a successful batch write
  for (const org of orgs) {
    if (Date.now() > deadline) break;
    const manifestItems = (await getManifest(org)) || [];
    const batch = selectPendingManifestItems(manifestItems, batchSize);
    if (!batch.length) continue;
    const updated = [...manifestItems];
    for (const raw of batch) {
      if (Date.now() > deadline) break;
      const item = { ...raw, org: raw.org || org, id: raw.id || computeItemId({ ...raw, org: raw.org || org }) };
      try {
        if (item.kind === "attachment-check") {
          const attachments = await xeroCall(bearer, "xero_attachments", { org, endpoint: item.endpoint, guid: item.guid });
          const xeroHasAttachment = countAttachments(attachments) > 0;
          const docExists = item.expectedDoc ? await sourceDocExists(item.expectedDoc) : true;
          const verdict = classifyAttachmentVerdict({ xeroHasAttachment, sourceDocExists: docExists });
          items.push({ ...item, verdict, evidence: { attachments, expectedDoc: item.expectedDoc || null, sourceDocExists: docExists } });
        } else {
          items.push({ ...item, verdict: "SKIPPED_UNKNOWN_KIND" });
        }
      } catch (e) {
        items.push({ ...item, verdict: "ERROR", error: String((e && e.message) || e) });
      }
      const idx = updated.findIndex((u) => (u.id || computeItemId({ ...u, org: u.org || org })) === item.id);
      if (idx >= 0) updated[idx] = { ...updated[idx], status: "staged", staged_at: nowIso };
    }
    manifestUpdates[org] = updated;
  }

  if (!items.length) {
    return { now: nowIso, dryRun, staged: false, reason: "nothing due: no stale snapshots and no pending manifest items", batch: null };
  }

  const dateStr = nowIso.slice(0, 10);
  const batchId = computeBatchId(items.map((i) => i.id), dateStr);
  const involvesInnd = items.some((i) => i.org === "innd" || i.org === "hearingassist");
  const kinds = new Set(items.map((i) => i.kind));
  const mode = kinds.size === 1 ? [...kinds][0] : "mixed";
  const staged = buildStagedBatch({ batchId, mode, items, nowIso });

  if (dryRun) {
    return { now: nowIso, dryRun: true, staged: false, batch: staged };
  }

  // The authoritative write. Everything after this point is best-effort/derivative.
  const store = await putStagedBatch(batchId, staged);

  let onedrive = null;
  try { onedrive = await deliverToOneDrive(batchId, staged); }
  catch (e) { onedrive = { ok: false, error: String((e && e.message) || e) }; }

  await putState({ last_snapshot: newSnapshotState, updated_at: nowIso });
  for (const [org, updated] of Object.entries(manifestUpdates)) await putManifest(org, updated);

  let gate = null;
  try { gate = await openReviewGate(staged, store && store.path, involvesInnd); }
  catch (e) { gate = { ok: false, error: String((e && e.message) || e) }; }

  try { await logStatus(`cfo-reconstruction nightly: staged batch ${batchId} (${items.length} item(s), mode=${mode}) for sign-off.`); }
  catch { /* best-effort: a memory-ledger hiccup never fails the run */ }

  return { now: nowIso, dryRun: false, staged: true, batch_id: batchId, item_count: items.length, mode, store, onedrive, gate };
}

// ============================ CLI ============================

function parseCsv(v) { return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null; }

async function sweepCmd() {
  const argv = process.argv.slice(2);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const dryRun = argv.includes("--dry-run");
  const asJson = argv.includes("--json");
  const batchSize = parseInt(val("--batch-size", String(DEFAULT_BATCH_SIZE)), 10);
  const maxMinutes = parseInt(val("--max-minutes", String(DEFAULT_MAX_MINUTES)), 10);
  const staleHours = parseInt(val("--stale-hours", String(DEFAULT_STALE_HOURS)), 10);
  const orgs = parseCsv(val("--orgs", null));

  const summary = await runSweep({ dryRun, batchSize, maxMinutes, staleHours, orgs });

  if (asJson) { console.log(JSON.stringify(summary, null, 2)); return; }
  console.log(`# cfo-reconstruction sweep ${summary.now} (${dryRun ? "DRY-RUN" : "live"})`);
  if (!summary.staged && !summary.batch) { console.log(`  ${summary.reason}`); return; }
  const b = summary.batch || { batch_id: summary.batch_id, item_count: summary.item_count, mode: summary.mode };
  console.log(`  batch ${b.batch_id}: ${b.item_count} item(s), mode=${b.mode}`);
  for (const it of b.items || []) console.log(`    [${it.verdict}] org=${it.org} kind=${it.kind}${it.error ? ` error=${it.error}` : ""}`);
  if (dryRun) { console.log("  (dry-run: nothing written anywhere. Re-run without --dry-run to stage for real.)"); return; }
  console.log(`  staged -> ${summary.store && summary.store.path}`);
  console.log(`  onedrive -> ${summary.onedrive && summary.onedrive.ok ? summary.onedrive.path : `delivery failed: ${summary.onedrive && summary.onedrive.error}`}`);
  console.log(`  decision-clock review gate: ${summary.gate && summary.gate.ok ? "opened" : `failed (non-fatal): ${summary.gate && summary.gate.error}`}`);
}

async function statusCmd() {
  const state = (await defaultGetState()) || { last_snapshot: {} };
  if (process.argv.includes("--json")) { console.log(JSON.stringify(state, null, 2)); return; }
  console.log("# cfo-reconstruction state (reconstruction-analysis/state/cursor.json)");
  for (const org of ORG_KEYS) {
    const s = state.last_snapshot[org];
    console.log(`  ${org.padEnd(14)} ${s ? `last snapshot ${s.staged_at}` : "never snapshotted"}`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const cmd = process.argv[2];
    try {
      if (cmd === "sweep") await sweepCmd();
      else if (cmd === "status") await statusCmd();
      else {
        console.error("usage: reconstruct.mjs sweep [--dry-run] [--json] [--batch-size N] [--max-minutes N] [--stale-hours N] [--orgs csv] | status [--json]");
        process.exit(2);
      }
    } catch (e) {
      console.error("cfo-reconstruction ERROR: " + e.message);
      process.exit(1);
    }
  })();
}

#!/usr/bin/env node
// ledger-archive.mjs -- moves genuinely superseded/stale/contradicted kb-memory entries OUT of an
// agent's ACTIVE ledger and INTO a same-format, same-account, same-container archive file, so stale
// beliefs stop surfacing in wake/tail/recall/team while the full audit history is never destroyed.
//
// WHY ARCHIVE, NOT DELETE: kb-memory is explicitly append-only by design (mem.mjs's own header:
// "durable, append-only WORKING MEMORY"). There is no delete verb in mem.mjs, on purpose. This mirrors
// the fleet's own established precedent for retiring stale content (the 67,645-doc otchealth-brain
// index was archived to Blob FIRST, then deleted from the live search index -- the record survives,
// only what actively surfaces changes). A permanent hard-delete of financial (cfo, MNPI) or legal
// (clo, clo-personal, attorney-privileged) ledger history would risk destroying an audit trail or
// litigation-relevant record for a tidiness benefit; archiving gets the same practical outcome
// (stale info stops being recalled/surfaced) with zero destruction risk.
//
// STORAGE (ported to S3, 2026-08-27): every ledger this file touches used to live in Azure Blob,
// account-SAS'd directly in this file, across THREE separate Azure storage accounts (otchealthcfodata,
// otchealthlegalstore, otchealthcommons). All three died with the Azure subscription deletion
// (2026-08-13). This is the ONLY one of the S3-ported skills that is genuinely multi-ring (a single
// process may touch the CFO's finance bucket, the CLO's shared or PERSONAL legal bucket, or the shared
// commons brain bucket, depending on --agent), so it does NOT route through the single-account
// commons-store.mjs facade the other five ported skills share -- it calls skills/kb-memory/s3-blob.mjs
// directly with the (account, container) pair looked up from AGENTS below, exactly mirroring the old
// per-agent (account, container) shape, and lets s3-blob.mjs's own MIRROR table (the fleet's ring
// boundary of record) pick the correct bucket. AGENTS below intentionally carries NO secret references
// any more -- s3-blob.mjs resolves AWS credentials once, internally, the same way regardless of which
// bucket a given call lands in; ring separation is enforced by the MIRROR table, never by which secret
// this file happened to fetch.
//
// SAFETY MODEL:
//   - list: read-only, always safe.
//   - find-superseded: read-only, prints CANDIDATES with reasoning. Never mutates.
//   - archive --ids <comma-separated ids>: DRY-RUN BY DEFAULT (prints what would move, touches
//     nothing). Requires --commit to actually write. Uses the SAME optimistic-concurrency
//     conditional-PUT pattern mem.mjs's commitAppend already uses (read ETag, compute new state,
//     conditional PUT, reload+retry on a 409/412 conflict) so a concurrent writer's append is never
//     silently clobbered. S3 supports the SAME If-Match/If-None-Match conditional-write headers
//     Azure's SAS-signed PUT did (AWS's August-2024 conditional-writes release), so this pattern
//     survives the storage swap unchanged in shape.
//
// Usage:
//   node ledger-archive.mjs list --agent <a>                     # dump the full active ledger, indexed
//   node ledger-archive.mjs find-superseded --agent <a>           # flag entries another entry's
//                                                                  # `supersedes` field points at (the
//                                                                  # one unambiguous, structural signal)
//   node ledger-archive.mjs archive --agent <a> --ids <id,id,...> [--commit] [--reason "..."]
import { getTextMetaFromS3, putObjectToS3 } from "./s3-blob.mjs";
import { parseNdjson, serializeNdjson, isConflict, condHeaders } from "./blobwrite.mjs";

// (account, container) only -- no secret references. Every pair below has a verified row in
// s3-blob.mjs's MIRROR table; that table, not this map, is what decides which physical bucket (and
// therefore which ring) a ledger actually lands in.
const AGENTS = {
  cfo:            { account: "otchealthcfodata",    container: "cfo-source-docs" },
  clo:            { account: "otchealthlegalstore", container: "company" },
  "clo-personal": { account: "otchealthlegalstore", container: "personal" },
  exec:           { account: "otchealthlegalstore", container: "exec" },
  commons:        { account: "otchealthcommons",    container: "company-journal" },
};

const argv = process.argv.slice(2);
const cmd = argv[0];
const takeVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const AGENT = (takeVal("--agent", "") || "").toLowerCase();
const A = AGENTS[AGENT] || (AGENT ? { ...AGENTS.commons, _file: AGENT } : null);
const IDS = new Set((takeVal("--ids", "") || "").split(",").map((s) => s.trim()).filter(Boolean));
const COMMIT = argv.includes("--commit");
const REASON = takeVal("--reason", "");

let KEYBASE, JSONL, ARCHIVE_JSONL;
function initStore() {
  if (!A) { console.error("need --agent <cfo|clo|clo-personal|exec|commons|... (any commons-hosted agent id)>"); process.exit(2); }
  KEYBASE = A._file || AGENT;
  JSONL = `_MEMORY/${KEYBASE}.jsonl`;
  ARCHIVE_JSONL = `_MEMORY/${KEYBASE}.archive.jsonl`;
}

// {text, etag} shim over s3-blob.mjs's getTextMetaFromS3, matching the pre-port fetchRetry-based
// getTextMeta()'s exact return shape (both null on a genuine 404; loud throw on anything else --
// getTextMetaFromS3 already has that contract natively, so this is now a one-line pass-through).
async function getTextMeta(name) { return getTextMetaFromS3(A.account, A.container, name); }

// putObjectToS3 THROWS on any non-2xx (412/409 conflict included, with err.status set -- see
// s3-blob.mjs's own contract note). The pre-port putTextCond() returned the raw Response object
// (never threw; cmdArchive() itself branched on `.ok`/`.status`), so this shim converts the new
// throw-based contract back into that same {ok, status} duck-typed shape rather than changing
// cmdArchive()'s retry logic, which already correctly treats a conflict as "reload and retry" and
// anything else as "fail loud".
async function putTextCond(name, body, etag) {
  try {
    const { etag: newEtag } = await putObjectToS3(A.account, A.container, name, body, "application/x-ndjson", condHeaders(etag));
    return { ok: true, status: 200, etag: newEtag };
  } catch (e) {
    return { ok: false, status: e.status, error: e.message };
  }
}

export function preview(text, n = 100) { return String(text || "").replace(/\s+/g, " ").slice(0, n); }

// Pure, testable core of `find-superseded`: given the parsed rows of a ledger, return every row that
// SOME OTHER row's `supersedes` field names, paired with that successor. This is the one unambiguous,
// structural staleness signal (an explicit --supersedes link some past write set); it is NOT exhaustive
// -- most historical corrections in this fleet's ledgers were written without --supersedes, so a zero
// result here does not mean a ledger has no stale content, only that nothing is explicitly linked.
export function findSuperseded(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const supersededIds = new Set(rows.map((r) => r.supersedes).filter(Boolean));
  return rows
    .filter((r) => supersededIds.has(r.id))
    .map((old) => ({ old, successor: rows.find((s) => s.supersedes === old.id) }));
}

async function cmdList() {
  initStore();
  const { text } = await getTextMeta(JSONL);
  const rows = parseNdjson(text);
  console.log(`ledger '${AGENT}' (${A.account}/${A.container}/${JSONL}): ${rows.length} active entries\n`);
  rows.forEach((r, i) => {
    console.log(`[${i}] id=${r.id} kind=${r.kind} ${r.created_at || r.at || ""}`);
    console.log(`     text: ${preview(r.text, 160)}`);
    if (r.was) console.log(`     was:  ${preview(r.was, 160)}`);
    if (r.supersedes) console.log(`     supersedes: ${r.supersedes}`);
  });
}

async function cmdFindSuperseded() {
  initStore();
  const { text } = await getTextMeta(JSONL);
  const rows = parseNdjson(text);
  const pairs = findSuperseded(rows);
  const candidates = pairs.map((p) => p.old);
  console.log(`ledger '${AGENT}': ${rows.length} active entries, ${candidates.length} structurally-superseded candidate(s) (another entry's 'supersedes' field points at them)\n`);
  for (const r of candidates) {
    const successor = pairs.find((p) => p.old.id === r.id).successor;
    console.log(`CANDIDATE id=${r.id} kind=${r.kind}`);
    console.log(`  old:  ${preview(r.text, 160)}`);
    console.log(`  superseded by id=${successor?.id}: ${preview(successor?.text, 160)}`);
  }
  if (candidates.length === 0) console.log("(none found via the structural 'supersedes' signal -- this does not mean the ledger has no stale content, only that nothing is EXPLICITLY linked; a semantic read-through is needed to find the rest.)");
}

async function cmdArchive() {
  if (IDS.size === 0) { console.error("archive requires --ids <id1,id2,...>"); process.exit(2); }
  initStore();
  for (let attempt = 0; attempt < 6; attempt++) {
    const { text, etag } = await getTextMeta(JSONL);
    const rows = parseNdjson(text);
    const toArchive = rows.filter((r) => IDS.has(r.id));
    const toKeep = rows.filter((r) => !IDS.has(r.id));
    const missing = [...IDS].filter((id) => !rows.some((r) => r.id === id));
    if (missing.length) console.error(`WARNING: id(s) not found in the active ledger (already archived, or a typo): ${missing.join(", ")}`);
    if (toArchive.length === 0) { console.log("nothing to archive (no matching ids in the active ledger)."); return; }

    console.log(`${COMMIT ? "ARCHIVING" : "DRY RUN (pass --commit to actually move these)"} ${toArchive.length} entr${toArchive.length === 1 ? "y" : "ies"} from '${AGENT}':`);
    for (const r of toArchive) console.log(`  id=${r.id} kind=${r.kind} :: ${preview(r.text, 140)}`);
    if (!COMMIT) return;

    const stamped = toArchive.map((r) => ({ ...r, archived_at: new Date().toISOString(), archive_reason: REASON || "superseded/stale, flagged by ledger-archive.mjs" }));
    const { text: archText, etag: archEtag } = await getTextMeta(ARCHIVE_JSONL);
    const archRows = parseNdjson(archText).concat(stamped);
    const archPut = await putTextCond(ARCHIVE_JSONL, serializeNdjson(archRows), archEtag);
    if (!archPut.ok && !isConflict(archPut.status)) throw new Error(`archive-file put failed: ${archPut.status} ${archPut.error || ""}`.trim());
    if (isConflict(archPut.status)) { await new Promise((s) => setTimeout(s, 150 * (attempt + 1))); continue; } // retry whole op

    const activePut = await putTextCond(JSONL, serializeNdjson(toKeep), etag);
    if (activePut.ok) {
      console.log(`done: ${toArchive.length} archived to ${ARCHIVE_JSONL}, ${toKeep.length} remain active.`);
      return;
    }
    if (isConflict(activePut.status)) { await new Promise((s) => setTimeout(s, 150 * (attempt + 1))); continue; }
    throw new Error(`active-ledger put failed: ${activePut.status} ${activePut.error || ""}`.trim());
  }
  throw new Error("ledger-archive: lost the optimistic-concurrency race after 6 attempts; NOTHING was written (safe failure, re-run)");
}

// Only run the CLI when executed directly (`node ledger-archive.mjs ...`), never on import -- so
// `import { findSuperseded, preview } from "./ledger-archive.mjs"` in a test is side-effect-free
// instead of hitting the "no command" branch's process.exit(2) and killing the test runner.
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (cmd === "list") await cmdList();
  else if (cmd === "find-superseded") await cmdFindSuperseded();
  else if (cmd === "archive") await cmdArchive();
  else { console.error("usage: ledger-archive.mjs list|find-superseded|archive --agent <a> [--ids id,id] [--commit] [--reason \"...\"]"); process.exit(2); }
}

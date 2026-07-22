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
// SAFETY MODEL:
//   - list: read-only, always safe.
//   - find-superseded: read-only, prints CANDIDATES with reasoning. Never mutates.
//   - archive --ids <comma-separated ids>: DRY-RUN BY DEFAULT (prints what would move, touches
//     nothing). Requires --commit to actually write. Uses the SAME optimistic-concurrency
//     conditional-PUT pattern mem.mjs's commitAppend already uses (read ETag, compute new state,
//     conditional PUT, reload+retry on a 409/412 conflict) so a concurrent writer's append is never
//     silently clobbered.
//
// Usage:
//   node ledger-archive.mjs list --agent <a>                     # dump the full active ledger, indexed
//   node ledger-archive.mjs find-superseded --agent <a>           # flag entries another entry's
//                                                                  # `supersedes` field points at (the
//                                                                  # one unambiguous, structural signal)
//   node ledger-archive.mjs archive --agent <a> --ids <id,id,...> [--commit] [--reason "..."]
import crypto from "node:crypto";
import { kvSecret } from "./azure-secret.mjs";
import { parseNdjson, serializeNdjson, isConflict, condHeaders } from "./blobwrite.mjs";

const AGENTS = {
  cfo:            { account: "otchealthcfodata",    accountSecret: "azure-cfo-storage-account",    keySecret: "azure-cfo-storage-key",    container: "cfo-source-docs" },
  clo:            { account: "otchealthlegalstore", accountSecret: "azure-legal-storage-account",  keySecret: "azure-legal-storage-key",  container: "company" },
  "clo-personal": { account: "otchealthlegalstore", accountSecret: "azure-legal-storage-account",  keySecret: "azure-legal-storage-key",  container: "personal" },
  exec:           { account: "otchealthlegalstore", accountSecret: "azure-legal-storage-account",  keySecret: "azure-legal-storage-key",  container: "exec" },
  commons:        { account: "otchealthcommons",    accountSecret: "azure-commons-storage-account", keySecret: "azure-commons-storage-key", container: "company-journal" },
};

const argv = process.argv.slice(2);
const cmd = argv[0];
const takeVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const AGENT = (takeVal("--agent", "") || "").toLowerCase();
const A = AGENTS[AGENT] || (AGENT ? { ...AGENTS.commons, _file: AGENT } : null);
const IDS = new Set((takeVal("--ids", "") || "").split(",").map((s) => s.trim()).filter(Boolean));
const COMMIT = argv.includes("--commit");
const REASON = takeVal("--reason", "");

async function sm(id) { return kvSecret(id); }

const encPath = (name) => name.split("/").map(encodeURIComponent).join("/");
function buildSas(acct, key) {
  const sv = "2021-12-02", sp = "rwlc", ss = "b", srt = "co";
  const st = new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19) + "Z";
  const se = new Date(Date.now() + 12 * 3600 * 1000).toISOString().slice(0, 19) + "Z";
  const sts = [acct, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
}

let ACCT, AKEY, AZ_SAS, KEYBASE, JSONL, ARCHIVE_JSONL;
async function initStore() {
  if (!A) { console.error("need --agent <cfo|clo|clo-personal|exec|commons|... (any commons-hosted agent id)>"); process.exit(2); }
  ACCT = await sm(A.accountSecret);
  AKEY = await sm(A.keySecret);
  if (!ACCT || !AKEY) { console.error(`Missing storage creds for ledger '${AGENT}'.`); process.exit(2); }
  AZ_SAS = buildSas(ACCT, AKEY);
  KEYBASE = A._file || AGENT;
  JSONL = `_MEMORY/${KEYBASE}.jsonl`;
  ARCHIVE_JSONL = `_MEMORY/${KEYBASE}.archive.jsonl`;
}
const url = (name) => `https://${ACCT}.blob.core.windows.net/${A.container}/${encPath(name)}?${AZ_SAS}`;
const RETRYABLE = new Set([403, 408, 429, 500, 502, 503, 504]);
async function fetchRetry(u, opts, tries = 4) {
  let last;
  for (let a = 0; a < tries; a++) {
    try { const r = await fetch(u, opts); if (r.status === 404 || r.ok || !RETRYABLE.has(r.status) || a === tries - 1) return r; last = r; }
    catch (e) { last = e; if (a === tries - 1) throw e; }
    await new Promise((s) => setTimeout(s, 300 * Math.pow(2, a)));
  }
  return last;
}
async function getTextMeta(name) { const r = await fetchRetry(url(name)); if (r.status === 404) return { text: null, etag: null }; if (!r.ok) throw new Error("get " + r.status); return { text: await r.text(), etag: r.headers.get("etag") }; }
async function putTextCond(name, body, etag) { return fetchRetry(url(name), { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": "application/x-ndjson", ...condHeaders(etag) }, body }); }

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
  await initStore();
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
  await initStore();
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
  await initStore();
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
    if (!archPut.ok && !isConflict(archPut.status)) throw new Error(`archive-file put failed: ${archPut.status}`);
    if (isConflict(archPut.status)) { await new Promise((s) => setTimeout(s, 150 * (attempt + 1))); continue; } // retry whole op

    const activePut = await putTextCond(JSONL, serializeNdjson(toKeep), etag);
    if (activePut.ok) {
      console.log(`done: ${toArchive.length} archived to ${ARCHIVE_JSONL}, ${toKeep.length} remain active.`);
      return;
    }
    if (isConflict(activePut.status)) { await new Promise((s) => setTimeout(s, 150 * (attempt + 1))); continue; }
    throw new Error(`active-ledger put failed: ${activePut.status}`);
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

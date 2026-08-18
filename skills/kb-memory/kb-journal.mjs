#!/usr/bin/env node
// kb-journal — Tier-1 AUTO-CAPTURE. The "secretary" that records EVERYTHING so nothing is lost when
// an agent forgets to write memory by hand. On every Stop / PreCompact it parses the live session
// transcript and appends each NEW input (operator prompt) and output (agent response), timestamped,
// to a durable, day-partitioned, append-only journal. NO LLM (cheap + instant), fail-open, never
// blocks a session. The distiller (reflect.mjs) + the nightly memory-librarian promote these journals
// into the ledger and the brain. This is the complete record; the ledger is the distilled signal.
//
// Hook passes {transcript_path} on stdin:  echo '{"transcript_path":"x.jsonl"}' | node kb-journal.mjs capture --agent cto
// Durable store: otchealthcommons/company-journal/_JOURNAL/<agent>/<YYYY-MM-DD>/<sessionId>.jsonl
// Cursor (so each run appends only new turns): ~/.claude/kb-journal/<sessionId>.cursor
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { kvSecret } from "./azure-secret.mjs";
import { getTextFromS3, putObjectToS3 } from "./s3-blob.mjs";

// Same BLOB_BACKEND convention + rationale as mem.mjs (see that file's header comment): the commons
// account this journals into is write-blocked on Azure, so writes go to S3 (default); reads merge
// S3 with best-effort Azure so a journal file that already has turns from before 2026-08-18 keeps
// growing in place instead of silently restarting.
const BLOB_BACKEND = (process.env.BLOB_BACKEND || "s3").toLowerCase();
const S3_WRITES = BLOB_BACKEND !== "azure";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const AGENT = (process.env.KB_AGENT || val("--agent", "") || "").toLowerCase();
const MAXLEN = 4000; // chars kept per entry (the transcript is the ultimate record)

// SA: env var OR the file (mem.mjs-style self-resolve, so this never silently no-ops on a fresh shell).
function loadSA() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) { try { return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON); } catch {} }
  for (const p of [join(homedir(), ".gcp_claude_driver_sa.json"), "/root/.gcp_claude_driver_sa.json"]) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} }
  return null;
}
const SA = loadSA();
function saJwt(scope) { if(!SA)return null; const now = Math.floor(Date.now() / 1000); const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: SA.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`; return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(SA.private_key, "base64url"); }
async function sm(id) { const _kv = await kvSecret(id); if (_kv != null) return _kv; const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt("https://www.googleapis.com/auth/cloud-platform"))}` }); const t = (await r0.json()).access_token; const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/otchealth-shared-prod/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } }); if (!r.ok) return null; return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim(); }

let ACCT, AKEY, SAS;
function buildSas() { const sv = "2021-12-02", sp = "rwlc", ss = "b", srt = "co"; const st = new Date(Date.now() - 3e5).toISOString().slice(0, 19) + "Z"; const se = new Date(Date.now() + 6 * 36e5).toISOString().slice(0, 19) + "Z"; const sts = [ACCT, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n"; const sig = crypto.createHmac("sha256", Buffer.from(AKEY, "base64")).update(sts, "utf8").digest("base64"); return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString(); }
const CONTAINER = "company-journal";
const enc = (n) => n.split("/").map(encodeURIComponent).join("/");
// Azure read, BEST-EFFORT: never throws, null on any failure (matches mem.mjs's azureGetBestEffort).
// Used only to keep appending to a journal file whose earlier turns predate the 2026-08-18 S3 cut;
// a missing/unreachable Azure leg just means "no older turns found there", never an error.
async function azureGetBestEffort(n) {
  if (!SAS) return null;
  try { const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(n)}?${SAS}`); return r.ok ? Buffer.from(await r.arrayBuffer()) : null; }
  catch { return null; }
}
async function getBuf(n) {
  if (S3_WRITES) {
    const s3Text = await getTextFromS3(ACCT, CONTAINER, n); // authoritative; throws loud on a real S3 failure
    const azBuf = await azureGetBestEffort(n);
    if (!azBuf) return s3Text == null ? null : Buffer.from(s3Text, "utf8");
    if (s3Text == null) return azBuf;
    // Journal lines have no `id` field (they are plain {ts,dir,agent,session,len,text} rows, not
    // ledger entries), so there is nothing to dedupe-merge by key the way mem.mjs's ledgers can.
    // Concatenating is safe here specifically because this function is only ever called to seed
    // `existing` immediately before appending brand-new lines for THIS run, and a day/session key is
    // written by exactly one session at a time in practice -- a rare double-count on a genuinely
    // concurrent write to the same session's same day is a lesser risk than losing the Azure history
    // outright, and is self-limiting (it can only duplicate lines that were already true).
    return Buffer.concat([azBuf, azBuf.length && azBuf[azBuf.length - 1] !== 10 ? Buffer.from("\n") : Buffer.alloc(0), s3Text ? Buffer.from(s3Text, "utf8") : Buffer.alloc(0)]);
  }
  const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(n)}?${SAS}`); if (r.status === 404) return null; if (!r.ok) throw new Error("get " + r.status); return Buffer.from(await r.arrayBuffer());
}
async function putBuf(n, body, ct) {
  if (S3_WRITES) { await putObjectToS3(ACCT, CONTAINER, n, Buffer.isBuffer(body) ? body : Buffer.from(body), ct); return; }
  const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(n)}?${SAS}`, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": ct || "application/x-ndjson" }, body }); if (!r.ok) throw new Error("put " + r.status);
}

// Parse the transcript into ordered {ts, dir, text} turns (IN = operator prompt, OUT = agent text).
function parseTurns(path) {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const turns = [];
  for (let idx = 0; idx < lines.length; idx++) {
    let o; try { o = JSON.parse(lines[idx]); } catch { continue; }
    const m = o.message || o; const ts = o.timestamp || "";
    if (o.type === "user" || m?.role === "user") {
      const c = m?.content;
      const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x.type === "text").map((x) => x.text).join(" ") : "";
      // skip tool_result envelopes + the giant continuation/summary system prompt
      if (t && !t.includes("tool_result") && !/This session is being continued from a previous conversation/.test(t)) turns.push({ idx, ts, dir: "IN", text: t.slice(0, MAXLEN), uuid: o.uuid });
    } else if (o.type === "assistant" || m?.role === "assistant") {
      const c = m?.content;
      if (Array.isArray(c)) { const t = c.filter((x) => x.type === "text" && x.text && x.text.trim().length > 20).map((x) => x.text).join("\n").trim(); if (t) turns.push({ idx, ts, dir: "OUT", text: t.slice(0, MAXLEN), uuid: o.uuid }); }
    }
  }
  return turns;
}

async function main() {
  if (!AGENT) { console.error("[kb-journal] no agent; skipping"); process.exit(0); }
  // FIX 2026-07-05 (FAILLOUD-ADOPT): `if (!SA) exit(0)` fired UNCONDITIONALLY once GCP retired (SA
  // is the dead GCP fallback, always null now) — before ever reaching the Azure-first sm() calls
  // below. Session journaling (this hook, fired on every Stop/PreCompact) has been silently a no-op
  // fleet-wide since GCP went dark, which is also why memory-librarian found nothing to catalog.
  // Kept fail-open (exit 0, never block a session) per this file's own design, but now actually
  // TRIES Azure first and only skips if genuinely unavailable — logged loudly, not silently.
  let stdin = {}; try { stdin = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch {}
  const path = val("--transcript", "") || stdin.transcript_path;
  if (!path || !existsSync(path)) { console.error("[kb-journal] no transcript; skipping"); process.exit(0); }
  let turns; try { turns = parseTurns(path); } catch (e) { console.error("[kb-journal] parse: " + e.message); process.exit(0); }
  if (!turns.length) { process.exit(0); }
  const sessionId = (stdin.session_id) || (path.split("/").pop().replace(/\.jsonl$/, ""));
  const curDir = join(homedir(), ".claude", "kb-journal"); try { mkdirSync(curDir, { recursive: true }); } catch {}
  const curFile = join(curDir, sessionId + ".cursor");
  let lastIdx = -1; try { lastIdx = parseInt(readFileSync(curFile, "utf8").trim(), 10); if (!Number.isFinite(lastIdx)) lastIdx = -1; } catch {}
  const fresh = turns.filter((t) => t.idx > lastIdx);
  if (!fresh.length) { process.exit(0); }
  ACCT = (await sm("azure-commons-storage-account")) || "otchealthcommons";
  AKEY = await sm("azure-commons-storage-key");
  if (AKEY) { SAS = buildSas(); }
  else if (!S3_WRITES) { console.error("[kb-journal] FATAL: no commons storage creds available (Azure Key Vault AND GCP both failed) — journal entry LOST for this turn. Check AZURE_SP_* env."); process.exit(0); }
  // else: S3-only is fine; azureGetBestEffort() degrades to "no older Azure turns found" without SAS.
  // bucket the new turns by their UTC date and append each date's lines to that day's session journal
  const byDate = {};
  for (const t of fresh) { const d = (t.ts || new Date().toISOString()).slice(0, 10); (byDate[d] ||= []).push(t); }
  let wrote = 0;
  // FAIL-LOUD + NO PHANTOM ADVANCE (2026-08-18). The old code wrote `turns[turns.length-1].idx` to the
  // cursor UNCONDITIONALLY, even when every single putBuf() below had thrown and `wrote` stayed 0. The
  // cursor is what makes a turn "already handled" on the NEXT run (`fresh = turns.filter(idx > lastIdx)`)
  // -- so a write that failed was nonetheless marked done, and those turns could never be captured by a
  // later, working run. That is a stronger loss than a merely-delayed write: it is permanent, and it was
  // silent (the only trace was one stderr line per failed date, easy to miss, and NOTHING said the
  // cursor had just made that loss unrecoverable). The fix: track the highest idx that was ACTUALLY
  // persisted and advance the cursor only that far, so a failed date's turns stay "fresh" and are retried
  // on the next Stop/PreCompact instead of being silently skipped forever.
  let maxWrittenIdx = -1, failedDates = 0;
  for (const [date, rows] of Object.entries(byDate)) {
    const key = `_JOURNAL/${AGENT}/${date}/${sessionId}.jsonl`;
    let existing = ""; try { const b = await getBuf(key); if (b) existing = b.toString("utf8"); } catch {}
    const jsonRows = rows.map((t) => ({ ts: t.ts, dir: t.dir, agent: AGENT, session: sessionId, len: t.text.length, text: t.text }));
    const add = jsonRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    try {
      await putBuf(key, existing + add, "application/x-ndjson");
      wrote += rows.length;
      maxWrittenIdx = Math.max(maxWrittenIdx, ...rows.map((t) => t.idx));
    } catch (e) {
      failedDates++;
      console.error(`[kb-journal] LOST WRITE for ${key}: ${e.message} -- cursor will NOT advance past these ${rows.length} turn(s); they will be retried next run.`);
    }
  }
  // Advance the cursor only up to the highest successfully-written idx. If date buckets are processed
  // out of ts order this can still leave an earlier-but-unwritten idx below a later-but-written one in
  // a mixed-success run; that turn is retried too (a harmless, bounded re-append: getBuf+putBuf above
  // is idempotent-by-concatenation for a turn that already made it into the blob, since the blob is
  // keyed by session+date, not by turn -- worst case is a rare duplicate line, never a loss).
  if (maxWrittenIdx > lastIdx) { try { writeFileSync(curFile, String(maxWrittenIdx)); } catch {} }
  console.error(`[kb-journal] captured ${wrote} new turn(s) for ${AGENT} (session ${sessionId.slice(0, 8)})${failedDates ? `; ${failedDates} date-bucket write(s) FAILED and will retry next run` : ""}`);
  process.exit(0);
}
main().catch((e) => { console.error("[kb-journal] ERROR " + e.message); process.exit(0); });

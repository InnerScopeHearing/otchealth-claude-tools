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
function saJwt(scope) { const now = Math.floor(Date.now() / 1000); const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: SA.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`; return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(SA.private_key, "base64url"); }
async function sm(id) { const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt("https://www.googleapis.com/auth/cloud-platform"))}` }); const t = (await r0.json()).access_token; const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/otchealth-shared-prod/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } }); if (!r.ok) return null; return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim(); }

let ACCT, AKEY, SAS;
function buildSas() { const sv = "2021-12-02", sp = "rwlc", ss = "b", srt = "co"; const st = new Date(Date.now() - 3e5).toISOString().slice(0, 19) + "Z"; const se = new Date(Date.now() + 6 * 36e5).toISOString().slice(0, 19) + "Z"; const sts = [ACCT, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n"; const sig = crypto.createHmac("sha256", Buffer.from(AKEY, "base64")).update(sts, "utf8").digest("base64"); return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString(); }
const CONTAINER = "company-journal";
const enc = (n) => n.split("/").map(encodeURIComponent).join("/");
async function getBuf(n) { const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(n)}?${SAS}`); if (r.status === 404) return null; if (!r.ok) throw new Error("get " + r.status); return Buffer.from(await r.arrayBuffer()); }
async function putBuf(n, body, ct) { const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(n)}?${SAS}`, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": ct || "application/x-ndjson" }, body }); if (!r.ok) throw new Error("put " + r.status); }

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
  if (!SA) { console.error("[kb-journal] no claude-driver SA; skipping (journal off)"); process.exit(0); }
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
  ACCT = await sm("azure-commons-storage-account"); AKEY = await sm("azure-commons-storage-key");
  if (!ACCT || !AKEY) { console.error("[kb-journal] no commons storage creds; skipping"); process.exit(0); }
  SAS = buildSas();
  // bucket the new turns by their UTC date and append each date's lines to that day's session journal
  const byDate = {};
  for (const t of fresh) { const d = (t.ts || new Date().toISOString()).slice(0, 10); (byDate[d] ||= []).push({ ts: t.ts, dir: t.dir, agent: AGENT, session: sessionId, len: t.text.length, text: t.text }); }
  let wrote = 0;
  for (const [date, rows] of Object.entries(byDate)) {
    const key = `_JOURNAL/${AGENT}/${date}/${sessionId}.jsonl`;
    let existing = ""; try { const b = await getBuf(key); if (b) existing = b.toString("utf8"); } catch {}
    const add = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    try { await putBuf(key, existing + add, "application/x-ndjson"); wrote += rows.length; } catch (e) { console.error("[kb-journal] put " + key + ": " + e.message); }
  }
  try { writeFileSync(curFile, String(turns[turns.length - 1].idx)); } catch {}
  console.error(`[kb-journal] captured ${wrote} new turn(s) for ${AGENT} (session ${sessionId.slice(0, 8)})`);
  process.exit(0);
}
main().catch((e) => { console.error("[kb-journal] ERROR " + e.message); process.exit(0); });

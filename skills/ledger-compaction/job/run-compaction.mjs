#!/usr/bin/env node
// ledger-compaction / job/run-compaction.mjs - scheduled runner glue.
//
// This is the ONLY part of ledger-compaction that touches Azure Blob storage. It mirrors the same
// self-resolving-SA + SAS + fetch pattern used throughout skills/kb-memory (mem.mjs, index-one.mjs,
// memory-librarian.mjs): resolve the claude-driver SA, mint a JWT, pull the agent's storage account
// and key from Secret Manager, build an account SAS, then read/write blobs with plain fetch.
//
// For each agent's ledger (_MEMORY/<agent>.jsonl), it:
//   1) reads the ledger blob (the SAME path kb-memory's mem.mjs reads/writes),
//   2) runs the PURE compact.mjs against the in-memory rows (never touches the source blob),
//   3) writes the compacted markdown to a SEPARATE blob, next to the ledger, in the same container
//      kb-memory already uses for its own derived artifact (_MEMORY/<agent>.md): here that is
//      _MEMORY/<agent>.compacted.md, so a human reading the agent's memory folder finds the
//      compacted summary right next to the live ledger and its rendered view, never overwriting
//      either.
//
// Fail-open by design, same as skills/signal-radar/radar.mjs: one agent's compaction failing (bad
// creds, blob not found, malformed ledger) is logged and skipped, never crashes the job. The job
// process itself always exits 0 so a scheduled Azure Container App Job run is never marked failed
// by a transient or partial issue; real problems are visible in the job logs instead.
//
// Run: node run-compaction.mjs [--agents cfo,clo,commons] [--dry-run]
import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compactLedger, parseLedgerText, renderMarkdown } from "../compact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRY_RUN = argv.includes("--dry-run");
const ONLY = (val("--agents", "") || "").split(",").map((s) => s.trim()).filter(Boolean);

const SM = "otchealth-shared-prod";
// Same agent -> storage mapping as skills/kb-memory/mem.mjs (kept intentionally small and local here
// rather than imported, since mem.mjs has no exported config surface; this list is the set of ledgers
// worth compacting on a schedule and can grow independently of kb-memory's own agent roster).
const AGENTS = {
  cfo:     { accountSecret: "azure-cfo-storage-account",    keySecret: "azure-cfo-storage-key",    container: "cfo-source-docs" },
  clo:     { accountSecret: "azure-legal-storage-account",  keySecret: "azure-legal-storage-key",  container: "company" },
  commons: { accountSecret: "azure-commons-storage-account", keySecret: "azure-commons-storage-key", container: "company-journal" },
};

function resolveSaJson() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  const p = `${homedir()}/.gcp_claude_driver_sa.json`;
  try { if (existsSync(p)) return readFileSync(p, "utf8"); } catch {}
  return null;
}

function saJwt(sa, scope) {
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
}

let CACHED_TOKEN;
async function gtoken(sa) {
  if (CACHED_TOKEN) return CACHED_TOKEN;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt(sa, "https://www.googleapis.com/auth/cloud-platform"))}`,
  });
  return (CACHED_TOKEN = (await r.json()).access_token);
}
async function sm(sa, id) {
  const t = await gtoken(sa);
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: "Bearer " + t } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}

function buildSas(acct, key) {
  const sv = "2021-12-02", sp = "rwlc", ss = "b", srt = "co";
  const st = new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19) + "Z";
  const se = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 19) + "Z";
  const sts = [acct, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
}
const encPath = (name) => name.split("/").map(encodeURIComponent).join("/");

async function getText(acct, container, sas, name) {
  const r = await fetch(`https://${acct}.blob.core.windows.net/${container}/${encPath(name)}?${sas}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`get ${r.status}`);
  return await r.text();
}
async function putText(acct, container, sas, name, body, ct) {
  const r = await fetch(`https://${acct}.blob.core.windows.net/${container}/${encPath(name)}?${sas}`, {
    method: "PUT",
    headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": ct || "text/markdown; charset=utf-8" },
    body,
  });
  if (!r.ok) throw new Error(`put ${r.status} ${(await r.text()).slice(0, 160)}`);
}

async function compactOneAgent(sa, agent, cfg) {
  const acct = process.env.KB_ACCOUNT || (await sm(sa, cfg.accountSecret));
  const akey = process.env.KB_KEY || (await sm(sa, cfg.keySecret));
  if (!acct || !akey) throw new Error(`missing storage creds for agent '${agent}'`);
  const sas = buildSas(acct, akey);

  const ledgerName = `_MEMORY/${agent}.jsonl`;
  const outName = `_MEMORY/${agent}.compacted.md`;

  const text = await getText(acct, cfg.container, sas, ledgerName);
  if (text == null) return { agent, skipped: true, reason: "ledger blob not found (nothing to compact yet)" };

  const { rows, errors } = parseLedgerText(text);
  const result = compactLedger(rows);
  const md = renderMarkdown(result, `${agent} ledger (_MEMORY/${agent}.jsonl)`);

  if (!DRY_RUN) {
    // Write ONLY the separate compacted artifact. Never write back to ledgerName: the source ledger
    // blob is read-only from this job's point of view.
    await putText(acct, cfg.container, sas, outName, md, "text/markdown; charset=utf-8");
  }
  return { agent, skipped: false, stats: result.stats, parseErrors: errors.length, outName, dryRun: DRY_RUN };
}

async function main() {
  const raw = resolveSaJson();
  if (!raw) {
    console.error("[ledger-compaction] no service account available (GCP_CLAUDE_DRIVER_SA_JSON unset and ~/.gcp_claude_driver_sa.json missing). Fail-open: exiting 0, nothing compacted this run.");
    return;
  }
  let sa;
  try { sa = JSON.parse(raw); } catch (e) {
    console.error(`[ledger-compaction] service account JSON unparseable: ${e.message}. Fail-open: exiting 0.`);
    return;
  }

  const targets = ONLY.length ? ONLY.filter((a) => AGENTS[a]) : Object.keys(AGENTS);
  for (const agent of targets) {
    try {
      const outcome = await compactOneAgent(sa, agent, AGENTS[agent]);
      console.log(`[ledger-compaction] ${agent}: ${JSON.stringify(outcome)}`);
    } catch (e) {
      // Fail-open per agent: one agent's blob trouble never stops the others or fails the job.
      console.error(`[ledger-compaction] ${agent}: FAILED (${e.message}); skipping, continuing with remaining agents.`);
    }
  }
}

main().catch((e) => {
  // Last-resort fail-open: this job must never exit non-zero on an internal error.
  console.error(`[ledger-compaction] unexpected error: ${e.message}. Fail-open: exiting 0.`);
});

#!/usr/bin/env node
// backfill-indexed-at.mjs -- ONE-SHOT: stamp `indexed_at` on every EXISTING document in the room indexes.
//
// WHY: indexer.mjs now stamps indexed_at on every mergeOrUpload, but push-search SKIPS docs already in the
// index (aisExistingIds), so only NEW docs would ever get a timestamp. The ~60k existing docs would stay
// null forever -> the freshness canary would report every room index NO_DATE for days/weeks -> alarm
// fatigue, which is how a real signal gets ignored. This backfills a FLOOR timestamp on the existing docs.
//
// A backfill stamp is a FLOOR, NOT A LIE: it asserts only "we know this document existed as of <now>",
// which is true. It does NOT claim the content changed then. Real edits overwrite it on the next real push.
//
// CHEAP: mergeOrUpload with just { id, indexed_at } merges that ONE field and leaves content + contentVector
// untouched -- no re-embedding, no OpenAI quota. Do NOT run push-search --force instead (that re-embeds
// everything for nothing).
//
// Creds: azure-sp (read via the shared kvSecret, never a local AZURE_SP-only reader) -> ARM listAdminKeys
// (mergeOrUpload needs a WRITE key) -> AI Search data plane. Idempotent + resumable (re-running just
// re-stamps; already-stamped docs are cheaply overwritten). Run once per room index after indexer.mjs
// deploys and BEFORE the canary's first scheduled run.
//
// Usage: node setup/backfill-indexed-at.mjs [--index <name>] [--stamp <iso>] [--dry-run]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { kvSecret } from "../skills/kb-memory/azure-secret.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONLY = val("--index", "");
const STAMP = val("--stamp", new Date().toISOString());
const DRY = argv.includes("--dry-run");
const SUB = process.env.AZURE_SUBSCRIPTION_ID || "55c84f6b-ef90-4259-a58b-50835cc4cab4";
const SEARCH_RG = process.env.AZURE_SEARCH_RG || "otchealth-automation-rg";
const API = "2023-11-01";

async function armToken() {
  const tid = await kvSecret("azure-sp-tenant-id"), cid = await kvSecret("azure-sp-client-id"), sec = await kvSecret("azure-sp-client-secret");
  if (!tid || !cid || !sec) throw new Error("azure-sp creds unavailable");
  const r = await fetch(`https://login.microsoftonline.com/${tid}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: sec, scope: "https://management.azure.com/.default" }) });
  const j = await r.json(); if (!j.access_token) throw new Error(`ARM token mint failed (${r.status})`); return j.access_token;
}
const _admin = {};
async function adminKey(service) {
  if (_admin[service]) return _admin[service];
  const tok = await armToken();
  const r = await fetch(`https://management.azure.com/subscriptions/${SUB}/resourceGroups/${SEARCH_RG}/providers/Microsoft.Search/searchServices/${service}/listAdminKeys?api-version=${API}`, { method: "POST", headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`listAdminKeys(${service}) -> ${r.status}`);
  const j = await r.json(); const key = j.primaryKey || j.secondaryKey; if (!key) throw new Error(`no admin key for ${service}`);
  return (_admin[service] = key);
}
const dp = (service, path, method = "GET", body) =>
  adminKey(service).then((key) => fetch(`https://${service}.search.windows.net/${path}${path.includes("?") ? "&" : "?"}api-version=${API}`, { method, headers: { "api-key": key, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));

/** Ensure the index schema has a sortable `indexed_at` field; PUT it added if missing (non-breaking). */
async function ensureField(service, index) {
  const g = await (await dp(service, `indexes/${index}`)).json();
  if ((g.fields || []).some((f) => f.name === "indexed_at")) return "present";
  if (DRY) return "would-add";
  g.fields.push({ name: "indexed_at", type: "Edm.DateTimeOffset", filterable: true, sortable: true, retrievable: true });
  const r = await dp(service, `indexes/${index}`, "PUT", g);
  if (!r.ok) throw new Error(`add indexed_at field to ${index} -> ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return "added";
}

async function backfillIndex(service, index) {
  const fieldStatus = await ensureField(service, index);
  let skip = 0, total = 0, stamped = 0;
  while (true) {
    const r = await dp(service, `indexes/${index}/docs/search`, "POST", { search: "*", select: "id", top: 1000, skip });
    if (!r.ok) throw new Error(`page ${index}@${skip} -> ${r.status}: ${(await r.text()).slice(0, 120)}`);
    const rows = (await r.json()).value || [];
    if (!rows.length) break;
    total += rows.length;
    if (!DRY) {
      const actions = rows.map((d) => ({ "@search.action": "mergeOrUpload", id: d.id, indexed_at: STAMP }));
      const up = await dp(service, `indexes/${index}/docs/index`, "POST", { value: actions });
      if (!up.ok) throw new Error(`merge ${index}@${skip} -> ${up.status}: ${(await up.text()).slice(0, 160)}`);
      stamped += actions.length;
    }
    skip += rows.length;
    if (skip >= 100000) { console.warn(`::warning::[backfill] ${index}: hit the 100k $skip ceiling; ${total} stamped, remainder needs a keyset pass.`); break; }
  }
  console.log(`[backfill] ${index}: field=${fieldStatus}, ${DRY ? "would stamp" : "stamped"} ${DRY ? total : stamped} doc(s) with indexed_at=${STAMP}`);
  return { index, field: fieldStatus, docs: DRY ? total : stamped };
}

async function main() {
  const registry = JSON.parse(readFileSync(join(HERE, "expected-indexes.json"), "utf8"));
  const targets = (registry.indexes || []).filter((ix) => ix.timestamp_field === "indexed_at" && (!ONLY || ix.index === ONLY));
  if (!targets.length) { console.error(`[backfill] no matching indexed_at indexes${ONLY ? ` for --index ${ONLY}` : ""}.`); process.exit(1); }
  console.log(`[backfill] ${DRY ? "DRY RUN -- " : ""}${targets.length} index(es), floor stamp = ${STAMP}`);
  const results = [];
  for (const ix of targets) results.push(await backfillIndex(ix.service, ix.index));
  console.log(`[backfill] DONE: ${results.reduce((a, b) => a + b.docs, 0)} doc(s) across ${results.length} index(es).`);
}
main().catch((e) => { console.error(`[backfill] FATAL: ${e.message}`); process.exit(1); });

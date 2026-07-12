#!/usr/bin/env node
// image-drift.mjs — P0 stability (2026-07-04). Flags any Azure Container App / Container Apps Job
// running a MUTABLE image tag (":latest", ":main", etc.) instead of an immutable @sha256 digest —
// the "code changed but the image didn't" / hand-deploy risk. Report-only (never mutates). ARM via
// AZURE_SP_* (client_credentials). Dependency-free. Exits 0 (report) unless --strict (exit 3 on drift).
//
// 2026-07-12 FIX: arm() was a single-page GET with no nextLink handling -- the exact same bug
// already found and fixed in drift-recon.mjs on 2026-07-05 (that fix's own header comment:
// "signal-radar, decision-clock, memory-librarian all landed on page 2 and were wrongly reported
// NO-JOB"), but this script was never updated to match. otchealth-automation-rg already has 20+
// resources (the threshold where ARM starts paginating), so this script could have been silently
// under-reporting drift on every job/app past page 1. Fixed the same way: armList() below always
// follows nextLink to completion. No other script in this repo should still have this bug after
// this fix -- confirmed via repo-wide search that drift-recon.mjs, replica-timeout-audit.mjs, and
// resource-reconcile.mjs already paginate correctly.
const SUBS_RGS = [
  ["otchealth-automation-rg"],   // doc-indexer cron jobs
  ["rg-otchealth-apps-prod"],    // MCP gateway + apps
];
const TEN = process.env.AZURE_SP_TENANT_ID, CID = process.env.AZURE_SP_CLIENT_ID, CSEC = process.env.AZURE_SP_CLIENT_SECRET;
async function armToken() {
  if (!TEN || !CID || !CSEC) { console.error("[image-drift][FATAL] AZURE_SP_* not set."); process.exit(78); }
  const r = await fetch(`https://login.microsoftonline.com/${TEN}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: CID, client_secret: CSEC, scope: "https://management.azure.com/.default" }) });
  const j = await r.json(); if (!j.access_token) { console.error("[image-drift][FATAL] no ARM token"); process.exit(1); } return j.access_token;
}
// ALWAYS follows nextLink to completion -- never read only page 1 of an ARM list response.
async function armList(tok, path) {
  const out = [];
  let url = `https://management.azure.com${path}`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) break;
    const j = await r.json();
    out.push(...(j.value || []));
    url = j.nextLink || null;
  }
  return out;
}
const isPinned = (img) => /@sha256:/.test(img || "");
(async () => {
  const SUB = process.env.AZURE_SUBSCRIPTION_ID || (await (async () => { try { const m = await import("../skills/kb-memory/azure-secret.mjs"); return await m.kvSecret("azure-subscription-id"); } catch { return null; } })());
  if (!SUB) { console.error("[image-drift][FATAL] no subscription id"); process.exit(78); }
  const tok = await armToken();
  const rows = [];
  for (const [rg] of SUBS_RGS) {
    const jobs = await armList(tok, `/subscriptions/${SUB}/resourceGroups/${rg}/providers/Microsoft.App/jobs?api-version=2024-03-01`);
    for (const j of jobs) { const img = j.properties?.template?.containers?.[0]?.image || ""; rows.push({ kind: "job", rg, name: j.name, img, pinned: isPinned(img) }); }
    const apps = await armList(tok, `/subscriptions/${SUB}/resourceGroups/${rg}/providers/Microsoft.App/containerApps?api-version=2024-03-01`);
    for (const a of apps) { const img = a.properties?.template?.containers?.[0]?.image || ""; rows.push({ kind: "app", rg, name: a.name, img, pinned: isPinned(img) }); }
  }
  const drift = rows.filter((r) => !r.pinned);
  if (process.argv.includes("--json")) { console.log(JSON.stringify(rows, null, 2)); }
  else {
    console.log(`# IMAGE-DRIFT — ${rows.length} resource(s); ${drift.length} on MUTABLE tags (drift risk)`);
    for (const r of rows) console.log(`[${r.pinned ? "PINNED" : "DRIFT "}] ${r.kind} ${r.name.padEnd(30)} ${r.img.split("/").pop()}`);
    if (drift.length) console.log(`\nMUTABLE (pin by @sha256 to prevent 'code changed, image didn't'): ${drift.map((r) => r.name).join(", ")}`);
  }
  process.exit(process.argv.includes("--strict") && drift.length ? 3 : 0);
})().catch((e) => { console.error("[image-drift] ERROR: " + e.message); process.exit(1); });

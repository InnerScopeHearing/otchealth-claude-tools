#!/usr/bin/env node
// oauth-clients-canary.mjs — enforce the gateway invariant that its OAUTH_CLIENTS registry ALWAYS
// contains every canonical client (all client_credentials LANES + all Claude-Chat CONNECTOR clients).
//
// WHY THIS EXISTS: 2026-07-13 the cto-lane provisioning overwrote the gateway's inline `oauth-clients`
// secret with a PARTIAL KV registry (lane clients only), silently dropping all 8 `occ_` Claude-Chat
// connector clients -> connector /oauth/authorize returned invalid_client fleet-wide. The connectors
// were only ever in the flat gateway secret, mirrored to neither KV registry, so nothing caught the
// drop until a human noticed a dead connector. Regression ledger tag: oauth-clients-patch-drops-dcr-clients.
//
// THE INVARIANT (turned from a memory rule into an enforced check): the live gateway `oauth-clients`
// must contain the client_id of EVERY `oauth-lane-<lane>-id` and `oauth-connector-<lane>-id` secret in
// Key Vault. `check` fails (exit 3) the instant any is missing; a scheduled workflow runs it so an
// out-of-band drop is caught in hours, not by a broken connector. `reconcile` repairs by UNION (it only
// ever ADDS canonical clients + preserves whatever is live; it never drops), building the full registry
// from the canonical per-client secrets so a partial blob can never be the source of truth again.
//
// Usage:
//   node setup/oauth-clients-canary.mjs check        # exit 0 = invariant holds; exit 3 = client(s) MISSING
//   node setup/oauth-clients-canary.mjs reconcile    # union-restore the full set to the gateway + KV registries
//
// Auth: AZURE_SP_CLIENT_ID/SECRET/TENANT_ID (sandbox) OR `az account get-access-token` (CI after azure/login).
import { execFileSync } from "node:child_process";

const SUB = "55c84f6b-ef90-4259-a58b-50835cc4cab4";
const RG = "rg-otchealth-apps-prod";
const APP = "otchealth-mcp-gateway";
const KV = process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef";
const ARM_API = "2024-03-01";

// --- token: AZURE_SP client_credentials first (sandbox), else az-CLI (CI after azure/login) ---
async function token(resource) {
  const t = process.env.AZURE_SP_TENANT_ID, c = process.env.AZURE_SP_CLIENT_ID, s = process.env.AZURE_SP_CLIENT_SECRET;
  if (t && c && s) {
    const r = await fetch(`https://login.microsoftonline.com/${t}/oauth2/v2.0/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: c, client_secret: s, scope: `${resource}/.default` }),
    });
    const j = await r.json();
    if (j.access_token) return j.access_token;
  }
  try { return JSON.parse(execFileSync("az", ["account", "get-access-token", "--resource", resource, "-o", "json"], { encoding: "utf8" })).accessToken; }
  catch (e) { throw new Error(`no Azure token for ${resource} (need AZURE_SP_* env or a logged-in az CLI): ${e.message}`); }
}

async function kvListNames(tok) {
  const names = [];
  let url = `https://${KV}.vault.azure.net/secrets?api-version=7.4&maxresults=25`;
  while (url) {
    const j = await (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json();
    (j.value || []).forEach((s) => names.push(s.id.split("/").pop()));
    url = j.nextLink || null;
  }
  return names;
}
async function kvGet(tok, name) {
  const r = await fetch(`https://${KV}.vault.azure.net/secrets/${name}?api-version=7.4`, { headers: { Authorization: `Bearer ${tok}` } });
  return r.ok ? String((await r.json()).value).trim() : null;
}
async function kvPut(tok, name, value) {
  const r = await fetch(`https://${KV}.vault.azure.net/secrets/${name}?api-version=7.4`, { method: "PUT", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify({ value }) });
  return r.status;
}

// lane name from a canonical secret name: oauth-lane-clo-personal-id -> clo-personal ; oauth-connector-cto-id -> cto
export function laneOf(secretName) {
  const m = secretName.match(/^oauth-(?:lane|connector)-(.+)-id$/);
  return m ? m[1] : null;
}
// PURE (unit-tested): which expected client_ids are absent from the live set.
export function computeMissing(expectedIds, liveIds) {
  const live = new Set(liveIds);
  return expectedIds.filter((id) => id && !live.has(id));
}

async function gatewaySecrets(armTok) {
  const base = `https://management.azure.com/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/${APP}`;
  const ls = await (await fetch(`${base}/listSecrets?api-version=${ARM_API}`, { method: "POST", headers: { Authorization: `Bearer ${armTok}`, "Content-Type": "application/json" } })).json();
  return { base, all: ls.value || [] };
}

// Build the canonical client map from KV: every oauth-lane-* + oauth-connector-* -> {client_id, secret, agent}.
async function canonicalClients(kvTok, { withSecrets }) {
  const names = await kvListNames(kvTok);
  const idNames = names.filter((n) => /^oauth-(lane|connector)-.+-id$/.test(n));
  const out = [];
  for (const idName of idNames) {
    const lane = laneOf(idName);
    const client_id = await kvGet(kvTok, idName);
    if (!client_id) continue;
    const entry = { client_id, agent: lane, kind: idName.startsWith("oauth-connector-") ? "connector" : "lane" };
    if (withSecrets) entry.secret = await kvGet(kvTok, idName.replace(/-id$/, "-secret"));
    out.push(entry);
  }
  return out;
}

async function main() {
  const cmd = process.argv[2] || "check";
  const armTok = await token("https://management.azure.com");
  const kvTok = await token("https://vault.azure.net");
  const { base, all } = await gatewaySecrets(armTok);
  const ocRaw = all.find((s) => s.name === "oauth-clients");
  const live = ocRaw ? JSON.parse(ocRaw.value) : [];
  const liveIds = live.map((c) => c.client_id || c.id);
  const canon = await canonicalClients(kvTok, { withSecrets: cmd === "reconcile" });
  const expectedIds = canon.map((c) => c.client_id);
  const missing = computeMissing(expectedIds, liveIds);

  if (cmd === "check") {
    const conn = canon.filter((c) => c.kind === "connector").length;
    console.log(`[oauth-clients-canary] live gateway oauth-clients: ${liveIds.length} clients; canonical (KV): ${expectedIds.length} (${conn} connectors).`);
    if (missing.length) {
      console.error(`[oauth-clients-canary] FAIL: ${missing.length} canonical client(s) MISSING from the live gateway registry:`);
      for (const id of missing) console.error(`  MISSING ${id} (${canon.find((c) => c.client_id === id)?.kind}/${canon.find((c) => c.client_id === id)?.agent})`);
      console.error(`Run: node setup/oauth-clients-canary.mjs reconcile   (union-restores; never drops)`);
      process.exit(3);
    }
    console.log(`[oauth-clients-canary] OK: every canonical lane + connector client is present in the gateway registry.`);
    return;
  }

  if (cmd === "reconcile") {
    // UNION by client_id: keep everything live, ADD any canonical client that is missing. Never drop.
    const byId = new Map();
    for (const c of live) if (c && (c.client_id || c.id)) byId.set(c.client_id || c.id, { client_id: c.client_id || c.id, secret: c.secret, agent: c.agent });
    for (const c of canon) if (!byId.has(c.client_id) && c.secret) byId.set(c.client_id, { client_id: c.client_id, secret: c.secret, agent: c.agent });
    const full = [...byId.values()];
    const payload = JSON.stringify(full);
    // preserve every other gateway secret (name+value), swap only oauth-clients
    const arr = all.map((s) => (s.name === "oauth-clients" ? { name: s.name, value: payload } : { name: s.name, value: s.value }));
    if (!arr.every((s) => s.value)) throw new Error("refusing to PATCH: a gateway secret came back without a value");
    const patch = await fetch(`${base}?api-version=${ARM_API}`, { method: "PATCH", headers: { Authorization: `Bearer ${armTok}`, "Content-Type": "application/json" }, body: JSON.stringify({ properties: { configuration: { secrets: arr } } }) });
    if (patch.status >= 300) throw new Error(`gateway PATCH ${patch.status}: ${(await patch.text()).slice(0, 200)}`);
    // keep the two flat KV registries in sync so a deploy that reads them can't re-drop
    await kvPut(kvTok, "oauth-clients", payload);
    await kvPut(kvTok, "gateway-oauth-clients", payload);
    // restart active revisions so they reload OAUTH_CLIENTS
    const rv = await (await fetch(`${base}/revisions?api-version=${ARM_API}`, { headers: { Authorization: `Bearer ${armTok}` } })).json();
    for (const r of (rv.value || []).filter((x) => x.properties?.active)) {
      await fetch(`${base}/revisions/${r.name}/restart?api-version=${ARM_API}`, { method: "POST", headers: { Authorization: `Bearer ${armTok}` } });
    }
    console.log(`[oauth-clients-canary] reconciled: gateway + both KV registries now hold ${full.length} clients (added ${full.length - live.length}); active revisions restarted.`);
    return;
  }

  console.error("usage: oauth-clients-canary.mjs check | reconcile");
  process.exit(2);
}

// Only run the live path as a CLI; export pure helpers for the unit test.
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error("[oauth-clients-canary] ERROR: " + e.message); process.exit(1); });
}

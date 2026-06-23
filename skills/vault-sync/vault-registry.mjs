#!/usr/bin/env node
// vault-registry: regenerate the credential REGISTRY (names + metadata, NEVER values) from Secret
// Manager into the Azure brain (the commons), so "what credentials exist / by service / by ring /
// added when" is answerable WITHOUT Notion. Part of the Notion retirement: the registry's source of
// truth has always been Secret Manager; this writes the human/brain-readable view to Azure instead of
// the Notion "API Tokens & Credentials (Registry)" DB. Secret VALUES never leave Secret Manager.
//
// Usage: node skills/vault-sync/vault-registry.mjs            # write the registry into the commons
//        node skills/vault-sync/vault-registry.mjs --print    # also print the table to stdout
//        node skills/vault-sync/vault-registry.mjs --dry      # build but do not upload
import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const SMPROJ = "otchealth-shared-prod";
const DRY = process.argv.includes("--dry");
const PRINT = process.argv.includes("--print");

// ---- claude-driver SA (env, else on-disk; the hardened resolution) ----
function resolveSaJson() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  const p = `${homedir()}/.gcp_claude_driver_sa.json`;
  try { if (existsSync(p)) return readFileSync(p, "utf8"); } catch {}
  return null;
}
let TOKEN = null;
async function gcpToken() {
  if (TOKEN) return TOKEN;
  const raw = resolveSaJson();
  if (!raw) { console.error("no service account (set GCP_CLAUDE_DRIVER_SA_JSON or place ~/.gcp_claude_driver_sa.json)"); process.exit(3); }
  const sa = JSON.parse(raw), now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const jwt = i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}` });
  TOKEN = (await r.json()).access_token; return TOKEN;
}
async function sm(id) {
  const t = await gcpToken();
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SMPROJ}/secrets/${id}/versions/latest:access`, { headers: { Authorization: "Bearer " + t } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}
async function listSecrets() {
  const t = await gcpToken(); const out = []; let pt = "";
  do {
    const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SMPROJ}/secrets?pageSize=200${pt ? `&pageToken=${pt}` : ""}`, { headers: { Authorization: "Bearer " + t } });
    const j = await r.json();
    for (const s of (j.secrets || [])) out.push({ id: s.name.split("/secrets/")[1], created: (s.createTime || "").slice(0, 10) });
    pt = j.nextPageToken || "";
  } while (pt);
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ---- the credential classifier (kept in lockstep with vault-sync.mjs infer()) ----
function infer(id) {
  const map = [["ebay", "eBay"], ["fourvault", "FourVault"], ["azure", "Azure"], ["acr-", "Azure"], ["asc-", "Apple"], ["apple-", "Apple"], ["amzn", "Amazon"], ["github", "GitHub"], ["graph-", "Microsoft Graph"], ["datadog", "Datadog"], ["depot", "Depot"], ["daytona", "Daytona"], ["cloudflare", "Cloudflare"], ["elevenlabs", "ElevenLabs"], ["openai", "OpenAI"], ["plaid", "Plaid"], ["qbo", "QuickBooks"], ["xero", "Xero"], ["revenuecat", "RevenueCat"], ["sentry", "Sentry"], ["netlify", "Netlify"], ["railway", "Railway"], ["replicate", "Replicate"], ["massive", "Massive"], ["n8n", "n8n"], ["make-", "Make"], ["miro", "Miro"], ["greptile", "Greptile"], ["context7", "Context7"], ["posthog", "PostHog"], ["plantid", "PlantID"], ["flatstick", "Flatstick"], ["companion", "Companion"], ["medreview", "MedReview"], ["gmail", "Gmail"], ["govinfo", "GovInfo"], ["courtlistener", "CourtListener"], ["notion", "Notion"]];
  let service = "Other"; for (const [p, s] of map) { if (id.startsWith(p)) { service = s; break; } } if (service === "Other") for (const [p, s] of map) { if (id.includes(p)) { service = s; break; } }
  let type;
  if (/refresh/.test(id)) type = "OAuth refresh token";
  else if (/cert-id$/.test(id)) type = "OAuth client secret";
  else if (/client-secret/.test(id)) type = "OAuth client secret";
  else if (/client-id$|app-id$/.test(id)) type = "OAuth client ID";
  else if (/-p8$|key-p8$/.test(id)) type = "p8 cert";
  else if (/password/.test(id)) type = "password";
  else if (/database-url|connection/.test(id)) type = "connection string";
  else if (/^plaid-access|access-token/.test(id)) type = "access token";
  else if (/verification-token|webhook/.test(id)) type = "webhook token";
  else if (/endpoint|region|server$|account$|bucket|deployment|version|-env$|site$|realm|base-url|host$|-user$|key-id$|issuer|team-id|installation-id|project-id|dev-id$|storage-container|-region$/.test(id)) type = "config non-secret";
  else if (/secret$|-key$|api-key$|token$|password/.test(id)) type = /token$/.test(id) ? "access token" : "API key";
  else type = "API key";
  const ring = /^medreview/.test(id) ? "PHI-BAA" : "non-PHI";
  const env = /sandbox/.test(id) ? "sandbox" : "prod";
  return { service, type, ring, env };
}

// ---- commons blob write (account SAS) ----
const encPath = (n) => n.split("/").map(encodeURIComponent).join("/");
function buildSas(acct, key) {
  const sv = "2021-12-02", sp = "rwlc", ss = "b", srt = "co";
  const st = new Date(Date.now() - 3e5).toISOString().slice(0, 19) + "Z", se = new Date(Date.now() + 12 * 36e5).toISOString().slice(0, 19) + "Z";
  const sts = [acct, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
}

(async () => {
  const secrets = await listSecrets();
  const rows = secrets.map((s) => ({ id: s.id, ...infer(s.id), created: s.created }));
  const byService = {};
  for (const r of rows) (byService[r.service] = byService[r.service] || []).push(r);
  const services = Object.keys(byService).sort();
  const phi = rows.filter((r) => r.ring === "PHI-BAA").length;

  let md = `# Credential Registry (regenerated from Secret Manager)\n\n`;
  md += `_Source of truth = Secret Manager project ${SMPROJ}. This is the names + metadata VIEW only; secret VALUES never leave Secret Manager (fetch by SM ID via setup/get-secret.mjs). Replaces the Notion "API Tokens & Credentials (Registry)" DB. Rotation flags are tracked in the ROTATE-BEFORE-LAUNCH lists (otchealth-cto/CLAUDE.md)._\n\n`;
  md += `Generated ${new Date().toISOString()} | ${rows.length} credentials across ${services.length} services | ${phi} PHI-BAA, ${rows.length - phi} non-PHI.\n\n`;
  for (const svc of services) {
    md += `## ${svc} (${byService[svc].length})\n\n| Secret Manager ID | Type | Ring | Env | Added |\n|---|---|---|---|---|\n`;
    for (const r of byService[svc].sort((a, b) => a.id.localeCompare(b.id))) md += `| \`${r.id}\` | ${r.type} | ${r.ring} | ${r.env} | ${r.created || "?"} |\n`;
    md += `\n`;
  }
  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

  if (PRINT) console.log(md);
  console.log(`[vault-registry] ${rows.length} credentials, ${services.length} services (${phi} PHI-BAA).`);
  if (DRY) { console.log("(dry: not uploaded)"); return; }

  const acct = await sm("azure-commons-storage-account"), key = await sm("azure-commons-storage-key");
  if (!acct || !key) { console.error("missing commons storage creds"); process.exit(2); }
  const SAS = buildSas(acct, key), C = "company-journal";
  const put = async (name, body, ct) => { const r = await fetch(`https://${acct}.blob.core.windows.net/${C}/${encPath(name)}?${SAS}`, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": ct }, body }); if (!r.ok) throw new Error("put " + r.status + " " + (await r.text()).slice(0, 140)); };
  await put("_VAULT/registry.md", md, "text/markdown; charset=utf-8");
  await put("_VAULT/registry.jsonl", jsonl, "application/x-ndjson");
  console.log(`[vault-registry] wrote otchealthcommons/${C}/_VAULT/registry.{md,jsonl} -> the commons librarian indexes it into the brain (journal room).`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

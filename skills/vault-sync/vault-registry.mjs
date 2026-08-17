#!/usr/bin/env node
// vault-registry: regenerate the credential REGISTRY (names + metadata, NEVER values) from the LIVE
// secret store (Azure Key Vault) into the Azure brain (the commons), so "what credentials exist / by
// service / by ring / added when" is answerable WITHOUT Notion. Part of the Notion retirement: this
// writes the human/brain-readable view to the commons journal (the librarian indexes it into the
// brain). Secret VALUES never leave Key Vault.
//
// SOURCE = Azure Key Vault (2026-07-14: was GCP Secret Manager, now RETIRED — billing off 2026-07).
// KV secret NAMES are a 1:1 mirror of the old SM ids, so the classifier below is unchanged. Auth via
// the shared vaultToken() resolver (managed identity in a Container Apps Job -> SP -> az/OIDC), so it
// runs identically in the daily-digest job (UAMI id-otc-jobs-kv) and the local seat. Before this fix
// it read GCP SM and process.exit(3)'d in the job ("no service account"), which nightly.sh swallowed
// as "vault-registry non-fatal: 3" — the registry had NEVER regenerated. It does now.
//
// Usage: node skills/vault-sync/vault-registry.mjs            # write the registry into the commons
//        node skills/vault-sync/vault-registry.mjs --print    # also print the table to stdout
//        node skills/vault-sync/vault-registry.mjs --dry      # build but do not upload
import crypto from "node:crypto";
import { kvSecret, vaultToken } from "../kb-memory/azure-secret.mjs";
import { ssmListDetailed } from "../kb-memory/aws-secret.mjs";

const VAULT = process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef";
const DRY = process.argv.includes("--dry");
const PRINT = process.argv.includes("--print");

// ---- secret enumeration (NAMES + date only; values never read) ----
//
// AWS SSM FIRST, Key Vault second. This step's PURPOSE is to inventory the live secret store, so
// unlike the librarians -- which merely needed a credential to do non-Azure work -- it cannot be
// fixed by changing where credentials come from. It was doing the right thing against the wrong
// system: SSM (/otchealth/*) is where fleet secrets now live, and Key Vault is being retired.
//
// This is the exact failure that made daily-digest exit 3 on Fargate (observed 2026-08-16): the job
// generated its digest and staged it successfully, then died on the tail vault-registry step with
// "no Key Vault token ... (no managed identity)" -- because a Container Apps managed identity cannot
// exist on ECS. The registry had therefore never regenerated on AWS.
//
// Key Vault is retained as the fallback so this is byte-identical while Azure is still up, and so a
// seat that genuinely has Key Vault auth (a local az login) keeps working.
async function listSecretsSsm() {
  try {
    const rows = await ssmListDetailed();
    return rows.length ? rows : null;
  } catch {
    return null; // no AWS creds resolvable -> fall through to Key Vault
  }
}

let SOURCE = "";
async function listSecrets() {
  const fromSsm = await listSecretsSsm();
  if (fromSsm) { SOURCE = "AWS SSM Parameter Store (/otchealth)"; console.error(`vault-registry: source = ${SOURCE} (${fromSsm.length} parameters)`); return fromSsm; }
  const tok = await vaultToken();
  if (!tok) { console.error(`vault-registry: no secret store reachable -- AWS SSM returned nothing and there is no Key Vault token for ${VAULT} (no managed identity / AZURE_SP_* / az login)`); process.exit(3); }
  SOURCE = `Azure Key Vault ${VAULT}`;
  console.error(`vault-registry: source = ${SOURCE} (SSM unavailable; transition fallback)`);
  const out = [];
  let url = `https://${VAULT}.vault.azure.net/secrets?api-version=7.4&maxresults=25`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) { console.error(`vault-registry: KV list failed ${r.status} on ${VAULT}`); process.exit(3); }
    const j = await r.json();
    for (const s of (j.value || [])) {
      const id = s.id.split("/").pop();
      // KV attributes.created is a unix epoch (seconds); mirror the old SM createTime YYYY-MM-DD view.
      const created = s.attributes && s.attributes.created ? new Date(s.attributes.created * 1000).toISOString().slice(0, 10) : "";
      out.push({ id, created });
    }
    url = j.nextLink || "";
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ---- the credential classifier (kept in lockstep with vault-sync.mjs infer()) ----
export function infer(id) {
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

// ---- the registry markdown/jsonl builder (pure; exported for tests) ----
export function buildRegistry(secrets, source) {
  // Name the store the rows ACTUALLY came from. Passed in by main() from the same branch that
  // selected it, so the header can never drift from the enumeration that produced the rows.
  const STORE = source || `Azure Key Vault ${VAULT}`;
  const NAMECOL = /SSM/.test(STORE) ? "SSM parameter name" : "Key Vault secret name";
  const rows = secrets.map((s) => ({ id: s.id, ...infer(s.id), created: s.created }));
  const byService = {};
  for (const r of rows) (byService[r.service] = byService[r.service] || []).push(r);
  const services = Object.keys(byService).sort();
  const phi = rows.filter((r) => r.ring === "PHI-BAA").length;
  let md = `# Credential Registry (regenerated from the live secret store, ${STORE})\n\n`;
  md += `_Source of truth = ${STORE}. This is the names + metadata VIEW only; secret VALUES never leave the store (fetch by id via setup/get-secret-aws.mjs for SSM, setup/get-secret-azure.mjs for Key Vault). Replaces the Notion "API Tokens & Credentials (Registry)" DB. Rotation flags are tracked in the ROTATE-BEFORE-LAUNCH lists (otchealth-cto/CLAUDE.md)._\n\n`;
  md += `Generated ${new Date().toISOString()} | ${rows.length} credentials across ${services.length} services | ${phi} PHI-BAA, ${rows.length - phi} non-PHI.\n\n`;
  for (const svc of services) {
    md += `## ${svc} (${byService[svc].length})\n\n| ${NAMECOL} | Type | Ring | Env | Added |\n|---|---|---|---|---|\n`;
    for (const r of byService[svc].sort((a, b) => a.id.localeCompare(b.id))) md += `| \`${r.id}\` | ${r.type} | ${r.ring} | ${r.env} | ${r.created || "?"} |\n`;
    md += `\n`;
  }
  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  return { md, jsonl, rows, services, phi };
}

async function main() {
  const secrets = await listSecrets();
  const { md, jsonl, rows, services, phi } = buildRegistry(secrets, SOURCE);
  if (PRINT) console.log(md);
  console.log(`[vault-registry] ${rows.length} credentials, ${services.length} services (${phi} PHI-BAA).`);
  if (DRY) { console.log("(dry: not uploaded)"); return; }

  const acct = await kvSecret("azure-commons-storage-account"), key = await kvSecret("azure-commons-storage-key");
  if (!acct || !key) { console.error("vault-registry: missing commons storage creds (azure-commons-storage-account/-key) in Key Vault"); process.exit(2); }
  const SAS = buildSas(acct, key), C = "company-journal";
  const put = async (name, body, ct) => { const r = await fetch(`https://${acct}.blob.core.windows.net/${C}/${encPath(name)}?${SAS}`, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": ct }, body }); if (!r.ok) throw new Error("put " + r.status + " " + (await r.text()).slice(0, 140)); };
  await put("_VAULT/registry.md", md, "text/markdown; charset=utf-8");
  await put("_VAULT/registry.jsonl", jsonl, "application/x-ndjson");
  console.log(`[vault-registry] wrote otchealthcommons/${C}/_VAULT/registry.{md,jsonl} -> the commons librarian indexes it into the brain (journal room).`);
}

// Only run the live registry regeneration when invoked as a script; importing (e.g. from a test) must
// not touch Key Vault or the commons. Standard ESM main-module guard.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

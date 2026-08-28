#!/usr/bin/env node
// vault-registry: regenerate the credential REGISTRY (names + metadata, NEVER values) from the LIVE
// secret store (AWS SSM Parameter Store) into the commons (the company brain), so "what credentials
// exist / by service / by ring / added when" is answerable WITHOUT Notion. Part of the Notion
// retirement: this writes the human/brain-readable view to the commons journal (the librarian indexes
// it into the brain). Secret VALUES never leave SSM.
//
// SOURCE = AWS SSM Parameter Store, /otchealth/* (2026-08-28 Azure-retirement port: was Azure Key
// Vault kv-otc-55c84f6bef, which sat on the Azure subscription permanently deleted 2026-08-13; before
// that, GCP Secret Manager, RETIRED 2026-07). SSM secret NAMES are a 1:1 mirror of the old Key
// Vault/SM ids, so the classifier below is unchanged across all three migrations. The registry write
// target is the S3-backed commons facade (skills/kb-memory/commons-store.mjs), which replaced the old
// Azure Blob account-SAS PUT for the same reason.
//
// Usage: node skills/vault-sync/vault-registry.mjs            # write the registry into the commons
//        node skills/vault-sync/vault-registry.mjs --print    # also print the table to stdout
//        node skills/vault-sync/vault-registry.mjs --dry      # build but do not upload
import { ssmListDetailed } from "../kb-memory/aws-secret.mjs";
import { cPut } from "../kb-memory/commons-store.mjs";

const DRY = process.argv.includes("--dry");
const PRINT = process.argv.includes("--print");

// ---- secret enumeration (NAMES + date only; values never read) ----
//
// AWS SSM is the SOLE source (2026-08-28 Azure-retirement port). Key Vault kv-otc-55c84f6bef sat on
// the Azure subscription permanently deleted 2026-08-13, so the Key Vault listing branch that used to
// live here (a direct fetch to <vault>.vault.azure.net) could only ever throw -- dead code pretending
// to be a fallback, exactly the pattern skills/kb-memory/commons-store.mjs's own header calls out for
// the read side ("a branch that always throws is dead code pretending to be a feature"). Dropped
// entirely rather than kept as an unreachable branch.
//
// This is the same class of failure that made daily-digest exit 3 on Fargate (observed 2026-08-16,
// back when Key Vault was still the primary and SSM the new addition): a Container Apps managed
// identity cannot exist on ECS, so the OLD Key-Vault-first order failed outright there. SSM has been
// primary since that fix; this change only removes the now-pointless fallback leg.
//
// ssmListDetailed() itself distinguishes "no AWS credentials resolvable at all" (returns [], the
// ordinary case on a seat with none) from "a real mid-pagination failure" (throws, so an incomplete
// inventory is never mistaken for a complete one) -- see that function's own header. Both cases are
// handled below: an empty list exits loud (nothing left to fall back to), and a throw propagates
// naturally to main()'s own catch (also fail-loud).
let SOURCE = "";
async function listSecrets() {
  const rows = await ssmListDetailed();
  if (!rows.length) {
    console.error("vault-registry: AWS SSM Parameter Store (/otchealth) returned no parameters (or is unreachable) -- SSM is the sole secret source now (Azure Key Vault died with the permanently deleted subscription, 2026-08-13); refusing to publish an empty registry");
    process.exit(3);
  }
  SOURCE = "AWS SSM Parameter Store (/otchealth)";
  console.error(`vault-registry: source = ${SOURCE} (${rows.length} parameters)`);
  return rows;
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

// ---- the registry markdown/jsonl builder (pure; exported for tests) ----
export function buildRegistry(secrets, source) {
  // Name the store the rows ACTUALLY came from. Passed in by main() from the same branch that
  // selected it, so the header can never drift from the enumeration that produced the rows. The
  // fallback (only reached when a caller omits `source` entirely, e.g. a direct unit-test call) names
  // the one live store SSM is now the sole source, so it stays accurate even in that path.
  const STORE = source || "AWS SSM Parameter Store (/otchealth)";
  const NAMECOL = /SSM/.test(STORE) ? "SSM parameter name" : "Key Vault secret name";
  const rows = secrets.map((s) => ({ id: s.id, ...infer(s.id), created: s.created }));
  const byService = {};
  for (const r of rows) (byService[r.service] = byService[r.service] || []).push(r);
  const services = Object.keys(byService).sort();
  const phi = rows.filter((r) => r.ring === "PHI-BAA").length;
  let md = `# Credential Registry (regenerated from the live secret store, ${STORE})\n\n`;
  md += `_Source of truth = ${STORE}. This is the names + metadata VIEW only; secret VALUES never leave the store (fetch by id via setup/get-secret-aws.mjs). Replaces the Notion "API Tokens & Credentials (Registry)" DB. Rotation flags are tracked in the ROTATE-BEFORE-LAUNCH lists (otchealth-cto/CLAUDE.md)._\n\n`;
  md += `Generated ${new Date().toISOString()} | ${rows.length} credentials across ${services.length} services | ${phi} PHI-BAA, ${rows.length - phi} non-PHI.\n\n`;
  for (const svc of services) {
    md += `## ${svc} (${byService[svc].length})\n\n| ${NAMECOL} | Type | Ring | Env | Added |\n|---|---|---|---|---|\n`;
    for (const r of byService[svc].sort((a, b) => a.id.localeCompare(b.id))) md += `| \`${r.id}\` | ${r.type} | ${r.ring} | ${r.env} | ${r.created || "?"} |\n`;
    md += `\n`;
  }
  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  return { md, jsonl, rows, services, phi };
}

// ---- commons write (S3-backed via the shared facade, 2026-08-28 Azure-retirement port) ----
//
// The old hand-rolled account-SAS PUT against otchealthcommons.blob.core.windows.net died with the
// Azure subscription (permanently deleted 2026-08-13). commons-store.mjs's cPut already points at the
// live S3 mirror for this exact (account, container) -- see that file's own header for the full
// rationale (it replaces five toolkit callers that each hand-rolled the identical Azure block).
//
// Exported separately from main() so a test can exercise the ACTUAL write call (stubbing the network
// boundary beneath cPut, the same pattern tests/fleet-search-s3.test.mjs already established for a
// sibling port) without also invoking listSecrets()' process.exit() paths.
//
// Fails LOUD on any write failure: cPut/putObjectToS3 already throws on any non-2xx, and this function
// does not catch it -- the throw propagates to main()'s own top-level catch (process.exit(1)), exactly
// matching the old SAS-based put() helper's fail-loud contract (it also threw uncaught on a non-ok PUT).
export async function writeRegistry(md, jsonl) {
  await cPut("_VAULT/registry.md", md, "text/markdown; charset=utf-8");
  await cPut("_VAULT/registry.jsonl", jsonl, "application/x-ndjson");
}

async function main() {
  const secrets = await listSecrets();
  const { md, jsonl, rows, services, phi } = buildRegistry(secrets, SOURCE);
  if (PRINT) console.log(md);
  console.log(`[vault-registry] ${rows.length} credentials, ${services.length} services (${phi} PHI-BAA).`);
  if (DRY) { console.log("(dry: not uploaded)"); return; }

  await writeRegistry(md, jsonl);
  console.log(`[vault-registry] wrote otchealthcommons/company-journal/_VAULT/registry.{md,jsonl} -> the commons librarian indexes it into the brain (journal room).`);
}

// Only run the live registry regeneration when invoked as a script; importing (e.g. from a test) must
// not touch AWS. Standard ESM main-module guard.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

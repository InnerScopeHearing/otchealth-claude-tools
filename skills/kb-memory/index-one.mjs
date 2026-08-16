#!/usr/bin/env node
// index-one.mjs <agent> <entry-json> - write-through indexer. Embeds ONE just-shared memory entry and
// upserts it into the `memory-exec` index immediately, so a fact stated this minute is semantically
// recallable this minute (instead of waiting for the nightly/6h reindex). mem.mjs spawns this DETACHED
// + fire-and-forget after a SHARED write, so the write returns instantly and this runs in the
// background. RING-SAFE: only ever indexes content already published to the shared exec feed (the
// caller only spawns it for shared entries); never a private lane. Fail-open: exits 0 on any error.
//
// SEARCH_BACKEND=azure|opensearch and EMBEDDINGS_PROVIDER=foundry|openai (env, defaults azure/foundry)
// mean EXACTLY what they mean in semantic.mjs and ring-memory-index/index-ring-memory.mjs -- this is
// the THIRD and last of the fleet's memory writers to be ported off an unconditional Azure dependency.
//
// Why this one mattered even though it is "just" a cache-warmer: its Azure guard below is
// `if (!AIS_EP || !AIS_KEY || ...) process.exit(0)`. Combined with fail-open-exit-0 and the detached
// fire-and-forget spawn, an Azure outage (or a billing block) made every write-through silently
// evaporate -- no error, no log, no exit code anyone reads, and the parent write still reported
// success. The entry would still land in the ledger, but would not be semantically recallable until
// the next full reindex. Silent, and invisible from the caller's side: the exact failure class this
// migration exists to remove.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { kvSecret } from "./azure-secret.mjs";
import * as OS from "./opensearch-write.mjs";

const SM = "otchealth-shared-prod";
const IDX = "memory-exec";
const AIS_API = "2023-11-01";
// Read ONCE at module load, matching semantic.mjs's convention exactly.
const SEARCH_BACKEND = (process.env.SEARCH_BACKEND || "azure").toLowerCase(); // 'azure' | 'opensearch'
const EMBEDDINGS_PROVIDER = (process.env.EMBEDDINGS_PROVIDER || "foundry").toLowerCase(); // 'foundry' | 'openai'
const agent = (process.argv[2] || "").toLowerCase();
let entry; try { entry = JSON.parse(process.argv[3] || "{}"); } catch { process.exit(0); }
if (!agent || !entry.id || !entry.text) process.exit(0);

function resolveSa() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  try { return readFileSync(`${homedir()}/.gcp_claude_driver_sa.json`, "utf8"); } catch { return null; }
}
// GCP SA is OPTIONAL now (Azure Key Vault primary). Parse lazily; don't exit when it's absent.
const raw = resolveSa();
let sa = null; if (raw) { try { sa = JSON.parse(raw); } catch { sa = null; } }
function saJwt() {
  const n = Math.floor(Date.now() / 1e3), e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: n, exp: n + 3600 })}`;
  return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
}
async function sm(id) {
  // Azure Key Vault FIRST (GCP retired); GCP fallback only if a SA is present.
  const kv = await kvSecret(id);
  if (kv != null) return kv;
  if (!sa) return null;
  const t = (await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt())}` })).json()).access_token;
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: "Bearer " + t } });
  return r.ok ? Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim() : null;
}
// SAME doc-key scheme as semantic.mjs (agent__id, sanitized) so a write-through and the nightly reindex
// converge on the same doc -> mergeOrUpload, never a duplicate.
const docId = (a, id) => `${a}__${id}`.replace(/[^A-Za-z0-9_\-=]/g, "_");

(async () => {
  try {
    const text = `[${entry.type || "fact"}] ${entry.text} ${(entry.tags || []).join(" ")}`.slice(0, 8000);

    // ---- embed ----
    let vec;
    if (EMBEDDINGS_PROVIDER === "openai") {
      vec = (await OS.embedOpenAI([text]))[0];
    } else {
      const AOAI_EP = ((await sm("azure-foundry-openai-endpoint")) || (await sm("azure-openai-endpoint")) || "").replace(/\/$/, "");
      const AOAI_KEY = (await sm("azure-foundry-key")) || (await sm("azure-openai-key"));
      const AOAI_DEP = (await sm("azure-openai-embedding-deployment")) || "text-embedding-3-large";
      if (!AOAI_EP || !AOAI_KEY) process.exit(0);
      for (let a = 0; a < 4; a++) {
        const er = await fetch(`${AOAI_EP}/openai/deployments/${AOAI_DEP}/embeddings?api-version=2024-02-01`, { method: "POST", headers: { "api-key": AOAI_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ input: [text] }) });
        if (er.status === 429) { await new Promise((s) => setTimeout(s, 1500 * (a + 1))); continue; }
        if (!er.ok) process.exit(0);
        vec = (await er.json()).data[0].embedding; break;
      }
    }
    if (!vec) process.exit(0);

    // ---- upsert ----
    // Identical doc shape and doc-key on both backends, so a write-through and the nightly reindex
    // still converge on the SAME document rather than creating a duplicate. Azure expresses the
    // merge via the `@search.action` field; OpenSearch expresses it in the bulk request line, so
    // pushDocs takes the doc WITHOUT that marker and applies update + doc_as_upsert (the exact
    // equivalent of mergeOrUpload -- a partial write must never clobber the stored embedding).
    const fields = { id: docId(agent, entry.id), agent, type: entry.type || "", ts: entry.ts || "", tags: (entry.tags || []).join(", "), text: entry.text.slice(0, 16000), contentVector: vec };
    if (SEARCH_BACKEND === "opensearch") {
      await OS.pushDocs(IDX, [fields]);
    } else {
      const AIS_EP = (await sm("azure-search-endpoint") || "").replace(/\/$/, "");
      const AIS_KEY = await sm("azure-search-admin-key");
      if (!AIS_EP || !AIS_KEY) process.exit(0);
      const doc = { "@search.action": "mergeOrUpload", ...fields };
      await fetch(`${AIS_EP}/indexes/${IDX}/docs/index?api-version=${AIS_API}`, { method: "POST", headers: { "api-key": AIS_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ value: [doc] }) });
    }
  } catch {}
  process.exit(0);
})();

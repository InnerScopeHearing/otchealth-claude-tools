#!/usr/bin/env node
// growth-room — the fleet's nightly cross-app GROWTH digest. Pulls read-only signal from the three
// growth data sources the fleet already holds credentials for (Capgo OTA rollout health, RevenueCat
// subscription/MRR, PostHog per-app funnel), composes ONE dated Markdown "growth room" digest, and
// stages it into the commons brain (otchealthcommons/company-journal/_DOCS/growth-room/<date>.md)
// the SAME way daily-digest.mjs stages its own digest (skills/cfo-store/store.mjs put, then
// doc-indexer's `index` step writes the _TEXT/ sidecar so the room stays cloud-searchable). Once
// staged, `brain_search` federates it for every exec agent (CRO/CFO/COO/CTO): "what did installs/
// OTA/MRR/funnel look like this week" becomes answerable the same way "what did we ship yesterday"
// already is via daily-digest.
//
// READ-ONLY against every source. Never writes to Capgo/RevenueCat/PostHog; never posts anywhere but
// the commons data room. Non-PHI ring: MedReview (PostHog project 468398, PHI-hardened) is
// DELIBERATELY EXCLUDED from the app registry below — never add it here. INND financial specifics
// (revenue recognition, cap table, fundraising) are OUT OF SCOPE; this is app-growth/funnel telemetry
// only, not company financials (that is the CFO's separate reconstruction/xero lane).
//
// STORAGE (ported off Azure Blob, 2026-09-03): the digest used to stage via `store.mjs --azure`, a
// hardcoded override of that tool's own safe default. Azure subscription 55c84f6b (which held the
// `otchealthcommons` Blob account) was permanently deleted 2026-08-13, so that call could never have
// succeeded; it is now `store.mjs --s3`, targeting the SAME logical room
// (`otchealthcommons/company-journal`) via `skills/kb-memory/s3-blob.mjs`'s verified MIRROR row
// (bucket `otchealth-brain-dr-55c84f6b`). No new bucket mapping was needed. `--key-secret` was an
// Azure-only flag (a storage-account key secret name) and is dropped with the backend — S3 needs no
// per-room key, only the AWS credential `store.mjs` already resolves via the ECS task role / env.
//
// Secrets (self-resolved via skills/kb-memory/azure-secret.mjs's kvSecret(), which defaults to AWS
// SSM Parameter Store `/otchealth/*` — SECRET_BACKEND=ssm, the fleet default; Azure Key Vault and GCP
// Secret Manager are both retired): `capgo-token`, `posthog-personal-api-key`, `revenuecat-secret-key`.
// Any ONE missing degrades that source's section to "not configured" rather than failing the whole
// run — a partial digest beats no digest, the same posture cfo-reconstruction's kind-A snapshot takes
// for a missing manifest. The commons stage/index steps need no secret at all: AWS credentials for
// S3 resolve via the ECS task role (or AWS_ACCESS_KEY_ID/SECRET / OTC_AWS_ACCESS_KEY_ID/SECRET on a
// seat), the same chain every other ported skill in this fleet already uses.
//
// Usage:
//   node skills/growth-room/growth-room.mjs sweep [--days N] [--dry-run] [--json] [--out path]
//   node skills/growth-room/growth-room.mjs status              # what would sweep pull, no network calls
//
// `sweep` STAGES for real by default (writes to the commons data room), matching every other
// librarian/nightly job in this fleet (nightly.sh, librarian.sh, cfo-reconstruction's reconstruct.mjs
// sweep) — a read-only growth digest landing in the shared, non-sensitive commons room has no
// human-facing cost the way an email or a Xero write would, so there is no --commit gate here.
// --dry-run computes and prints the digest without staging (or calling doc-indexer) — use it to
// preview or to smoke-test after a deploy.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { kvSecret } from "../kb-memory/azure-secret.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE_MJS = join(HERE, "..", "cfo-store", "store.mjs");
const COMMONS_ACCOUNT = "otchealthcommons";
const COMMONS_CONTAINER = "company-journal";
const STAGE_PREFIX = "_DOCS/growth-room"; // the doc-indexer `index` step below writes this prefix's _TEXT/ sidecar

// ── The fleet app registry ──────────────────────────────────────────────────────────────────────
// bundleId is each app's real Capacitor appId (verified against each repo's own capacitor.config.*,
// 2026-07-21 — NOT guessed), used as the Capgo app_id (Capgo's app_id is the same reverse-domain
// identifier by design, per capgo.app/docs/public-api/app/) and as the RevenueCat app-matching key.
// posthogProjectId is each app's project number, per otchealth-cto/CLAUDE.md's PostHog Project
// Registry. MedReview (468398) is INTENTIONALLY ABSENT — PHI-hardened, never pulled from this
// non-PHI job. innd-website / otchealthmart are web properties (no Capacitor app, no Capgo/RevenueCat
// signal) but still carry a PostHog funnel worth digesting.
export const APPS = Object.freeze([
  { key: "iheartest", name: "iHEARtest", bundleId: "com.innerscope.iheartest", posthogProjectId: "468379" },
  { key: "aware", name: "AWARE Aural Rehab", bundleId: "com.innerscope.aware", posthogProjectId: "468388" },
  { key: "companion", name: "OTCHealth Companion", bundleId: "com.otchealth.companion", posthogProjectId: "468389" },
  { key: "innerease", name: "InnerEase", bundleId: "com.innerscope.innerease", posthogProjectId: "468390" },
  { key: "flatstick", name: "Flatstick", bundleId: "app.flatstick.ios", posthogProjectId: "468391" },
  { key: "fourvault", name: "FourVault", bundleId: "com.innerscope.fourvault", posthogProjectId: "468392" },
  { key: "fictionary", name: "Fictionary", bundleId: "com.innerscope.fictionary", posthogProjectId: "468393" },
  { key: "plantid", name: "PlantID Care", bundleId: "com.innerscope.plantid", posthogProjectId: "474011" },
  { key: "innd-website", name: "INND Website", bundleId: null, posthogProjectId: "468396" },
  { key: "otchealthmart", name: "OTCHealthMart", bundleId: null, posthogProjectId: "468397" },
]);

const argv = process.argv.slice(2);
function takeVal(name, def = null) { const i = argv.indexOf(name); if (i >= 0) { const v = argv[i + 1]; argv.splice(i, 2); return v; } return def; }
const DAYS = Math.max(1, parseInt(takeVal("--days", "7"), 10) || 7);
const OUT_OV = takeVal("--out");
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const DRY_RUN = flags.has("--dry-run");
const JSON_OUT = flags.has("--json");
const cmd = argv.find((a) => !a.startsWith("--")) || "help";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDate = (d = new Date()) => d.toISOString().slice(0, 10);

// ── Capgo Statistics API (api.capgo.app) ────────────────────────────────────────────────────────
// Real, confirmed endpoints (capgo.app/docs/public-api/statistics/): GET /statistics/app/:app_id/
// (daily {date, mau, storage, bandwidth}) and GET /statistics/app/:app_id/bundle_usage (per-version
// adoption %, chart-ready). Auth: x-api-key header (the docs' own statistics examples show a bare
// `authorization` header instead; x-api-key is documented as the current/recommended form on the
// public-api overview page, so that is what this uses — flagged in SKILL.md as worth re-confirming
// against a live call if Capgo ever 401s here). NOT CONFIRMED: an explicit per-app "fail/revert
// count" field — the statistics API returns MAU/storage/bandwidth and version-adoption %, not a
// device-reported failure counter, so "OTA health" here is read as "how concentrated is the fleet
// on the newest bundle version" (bundle_usage), not a literal revert-count metric. See SKILL.md.
async function capgoAppStats(bundleId, token, days) {
  const to = isoDate();
  const from = isoDate(new Date(Date.now() - days * 86400000));
  const headers = { "x-api-key": token };
  const statsR = await fetch(`https://api.capgo.app/statistics/app/${encodeURIComponent(bundleId)}/?from=${from}&to=${to}`, { headers });
  if (statsR.status === 404) return { ok: false, notWired: true }; // app has no Capgo statistics yet (not onboarded)
  if (!statsR.ok) throw new Error(`capgo statistics ${statsR.status}: ${(await statsR.text()).slice(0, 160)}`);
  const statsJ = await statsR.json();
  const rows = Array.isArray(statsJ) ? statsJ : Array.isArray(statsJ && statsJ.data) ? statsJ.data : [];
  const latest = rows[rows.length - 1] || null;
  const maus = rows.map((r) => Number(r && r.mau) || 0);
  const peakMau = maus.length ? Math.max(...maus) : 0;

  let topVersion = null, topVersionShare = null;
  try {
    const buR = await fetch(`https://api.capgo.app/statistics/app/${encodeURIComponent(bundleId)}/bundle_usage?from=${from}&to=${to}`, { headers });
    if (buR.ok) {
      const buJ = await buR.json();
      const body = buJ && buJ.data ? buJ.data : buJ;
      const datasets = (body && body.datasets) || [];
      if (datasets.length) {
        // last data point per dataset (most recent day), pick the highest-share version = the rollout leader
        let best = null;
        for (const ds of datasets) {
          const last = Array.isArray(ds.data) ? ds.data[ds.data.length - 1] : null;
          const pct = Number(last) || 0;
          if (!best || pct > best.pct) best = { label: ds.label, pct };
        }
        if (best) { topVersion = best.label; topVersionShare = best.pct; }
      }
    }
  } catch { /* bundle_usage is a bonus signal; a failure here doesn't fail the whole app-stats pull */ }

  return { ok: true, days: rows.length, latestMau: latest ? Number(latest.mau) || 0 : 0, peakMau, topVersion, topVersionShare };
}

// ── RevenueCat v2 API (api.revenuecat.com/v2) ───────────────────────────────────────────────────
// Confirmed endpoints (fetched from revenuecat.com/docs/api-v2 2026-07-21): GET /projects, GET
// /projects/{id}/apps, GET /projects/{id}/metrics/overview, GET /projects/{id}/charts/mrr. Auth:
// `Authorization: Bearer <key>` (v2 requires the Bearer form; v1's bare-key auth does not apply).
// The shared `revenuecat-secret-key` in Key Vault is confirmed working against PlantID's project
// (proj8d70e817, per otchealth-cto/CLAUDE.md) but NOT CONFIRMED as a fleet-wide/organization key —
// RevenueCat v2 secret keys are commonly project-scoped, so GET /projects here may return only ONE
// project (PlantID) rather than every monetized app. This function is written defensively: it lists
// whatever projects the key can see, matches by bundleId where possible, and reports per-app "no
// RevenueCat project visible to this key" rather than erroring — see SKILL.md's flagged-gap note.
async function revenuecatProjectApps(key) {
  const r = await fetch("https://api.revenuecat.com/v2/projects", { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`revenuecat projects ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  const projects = (j && j.items) || (j && j.data) || (Array.isArray(j) ? j : []);
  const out = []; // { projectId, appId, bundleId }
  for (const p of projects) {
    const projectId = p.id || p.project_id;
    if (!projectId) continue;
    await sleep(250); // stay well under the 25 req/min metrics-endpoint rate limit across a fleet sweep
    try {
      const ar = await fetch(`https://api.revenuecat.com/v2/projects/${encodeURIComponent(projectId)}/apps`, { headers: { Authorization: `Bearer ${key}` } });
      if (!ar.ok) continue;
      const aj = await ar.json();
      const apps = (aj && aj.items) || (aj && aj.data) || (Array.isArray(aj) ? aj : []);
      // LIVE-VERIFIED shape (2026-07-21, fetched against the real key): the bundle/package id is
      // NESTED under a per-store-type object (`app_store.bundle_id` for iOS, `play_store.package_name`
      // for Android), not a top-level field — e.g. {type:"app_store", app_store:{bundle_id:"com..."}}.
      // Falling back to a top-level guess (as an earlier draft of this function did) silently matched
      // ZERO apps against this repo's registry even for PlantID, whose project this key DOES cover.
      for (const a of apps) {
        const bundleId = (a.app_store && a.app_store.bundle_id) || (a.play_store && a.play_store.package_name) || a.bundle_id || a.package_name || null;
        if (bundleId) out.push({ projectId, appId: a.id, bundleId, name: a.name || null });
      }
    } catch { /* one bad project shouldn't kill the whole fleet lookup */ }
  }
  return out;
}

async function revenuecatOverview(projectId, key) {
  await sleep(250);
  const r = await fetch(`https://api.revenuecat.com/v2/projects/${encodeURIComponent(projectId)}/metrics/overview?currency=USD`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`revenuecat overview ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  // LIVE-VERIFIED shape (2026-07-21): `metrics` is an ARRAY of {id, name, value, unit, period}
  // objects (object:"overview_metric"), NOT a flat {mrr: N, active_subscriptions: N} map. Index by
  // `id` before picking — an earlier draft of this function assumed a flat object and silently
  // returned "n/a" for every field against the real, live PlantID project response.
  const list = (j && Array.isArray(j.metrics)) ? j.metrics : [];
  const byId = new Map(list.map((m) => [m.id, m.value]));
  const pick = (...ids) => { for (const id of ids) if (byId.has(id) && byId.get(id) != null) return byId.get(id); return null; };
  return {
    mrr: pick("mrr"),
    activeSubscriptions: pick("active_subscriptions", "active_subscribers"),
    activeTrials: pick("active_trials"),
    revenue: pick("revenue"),
  };
}

// ── PostHog HogQL (per otchealth-cto CLAUDE.md's per-app project registry) ─────────────────────
// Confirmed shape: mirrors skills/azure-canary/stream-freshness.mjs's own newestStreamEventTs()
// query pattern exactly (same auth, same endpoint, same DateTime64-string normalization) — this is
// a proven-live query path in this repo already, not a new integration guess.
async function posthogFunnel(projectId, key, days) {
  const hql = `SELECT count() AS events, count(DISTINCT person_id) AS actives FROM events WHERE timestamp > now() - INTERVAL ${days} DAY`;
  const r = await postHogQuery(projectId, key, hql);
  const row = (r.results || [])[0] || [0, 0];
  const topHql = `SELECT event, count() AS n FROM events WHERE timestamp > now() - INTERVAL ${days} DAY GROUP BY event ORDER BY n DESC LIMIT 8`;
  const topR = await postHogQuery(projectId, key, topHql);
  const top = (topR.results || []).map((row2) => ({ event: row2[0], n: Number(row2[1]) || 0 }));
  return { events: Number(row[0]) || 0, actives: Number(row[1]) || 0, topEvents: top };
}
async function postHogQuery(projectId, key, hql) {
  const r = await fetch(`https://us.posthog.com/api/projects/${projectId}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query: hql } }),
  });
  if (!r.ok) throw new Error(`posthog query -> ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

// ── Composition (pure — unit-testable without any network call) ────────────────────────────────
export function fmtNum(n) { return n == null ? "n/a" : typeof n === "number" ? n.toLocaleString("en-US") : String(n); }
export function fmtMoney(n) { return n == null ? "n/a" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
export function fmtPct(n) { return n == null ? "n/a" : `${Number(n).toFixed(1)}%`; }

export function composeMarkdown({ date, days, rows, capgoConfigured, revenuecatConfigured, posthogConfigured, revenuecatGap }) {
  let md = `# Growth Room — ${date}\n\n`;
  md += `> Cross-app growth digest for the fleet knowledge base (CRO/CFO/COO/CTO). Trailing ${days}-day window. `;
  md += `Generated ${new Date().toISOString()}. Sources: Capgo OTA statistics${capgoConfigured ? "" : " (NOT CONFIGURED this run)"}, `;
  md += `RevenueCat subscription metrics${revenuecatConfigured ? "" : " (NOT CONFIGURED this run)"}, `;
  md += `PostHog per-app funnel${posthogConfigured ? "" : " (NOT CONFIGURED this run)"}.\n\n`;
  if (revenuecatGap) md += `> NOTE: the RevenueCat key visible to this job maps to ${revenuecatGap} project(s) — likely project-scoped, not a fleet-wide key. See skills/growth-room/SKILL.md.\n\n`;

  md += `## Per-app summary\n\n`;
  md += `| App | Active devices (PostHog) | Top events | OTA (latest MAU / top bundle share) | RevenueCat (MRR / active subs) |\n`;
  md += `|---|---|---|---|---|\n`;
  for (const row of rows) {
    const ph = row.posthog;
    const cg = row.capgo;
    const rc = row.revenuecat;
    const phCell = ph && ph.ok ? `${fmtNum(ph.actives)}` : ph && ph.notConfigured ? "n/a" : ph && ph.error ? "ERROR" : "no project";
    const topEv = ph && ph.ok && ph.topEvents && ph.topEvents.length ? ph.topEvents.slice(0, 3).map((e) => `${e.event}(${e.n})`).join(", ") : "-";
    const cgCell = !row.bundleId ? "n/a (web)" : cg && cg.notWired ? "not wired" : cg && cg.ok ? `${fmtNum(cg.latestMau)} / ${cg.topVersion ? `${cg.topVersion} ${fmtPct(cg.topVersionShare)}` : "n/a"}` : cg && cg.error ? "ERROR" : cg && cg.notConfigured ? "n/a" : "-";
    const rcCell = !row.bundleId ? "n/a (web)" : rc && rc.ok ? `${fmtMoney(rc.mrr)} / ${fmtNum(rc.activeSubscriptions)}` : rc && rc.noProject ? "no RC project" : rc && rc.error ? "ERROR" : rc && rc.notConfigured ? "n/a" : "-";
    md += `| ${row.name} | ${phCell} | ${topEv} | ${cgCell} | ${rcCell} |\n`;
  }

  md += `\n## OTA rollout health (Capgo)\n`;
  const cgRows = rows.filter((r) => r.bundleId && r.capgo && r.capgo.ok);
  if (!cgRows.length) md += `\n_No Capgo-wired apps returned data this run (only iHEARtest is confirmed end-to-end wired as of 2026-07-21; the remaining fleet rollout is mid-flight — see research/capgo-2026-07-21/05-fleet-adoption-architecture.md)._\n`;
  for (const row of cgRows) {
    const cg = row.capgo;
    md += `- **${row.name}**: latest-day MAU ${fmtNum(cg.latestMau)} (peak ${fmtNum(cg.peakMau)} in window)`;
    if (cg.topVersion) md += `, top bundle \`${cg.topVersion}\` at ${fmtPct(cg.topVersionShare)} device share (rollout concentration, not a literal fail/revert count — Capgo's public statistics API does not expose one, see SKILL.md)`;
    md += `.\n`;
  }

  md += `\n## Subscription / MRR signal (RevenueCat)\n`;
  const rcRows = rows.filter((r) => r.bundleId && r.revenuecat && r.revenuecat.ok);
  if (!rcRows.length) md += `\n_No RevenueCat data this run (key not configured, or the configured key's visible project(s) did not match any app in the registry)._\n`;
  for (const row of rcRows) {
    const rc = row.revenuecat;
    md += `- **${row.name}**: MRR ${fmtMoney(rc.mrr)}, active subscriptions ${fmtNum(rc.activeSubscriptions)}, active trials ${fmtNum(rc.activeTrials)}.\n`;
  }

  md += `\n## Funnel highlights (PostHog)\n`;
  const phRows = rows.filter((r) => r.posthog && r.posthog.ok);
  if (!phRows.length) md += `\n_No PostHog data this run._\n`;
  for (const row of phRows) {
    const ph = row.posthog;
    const top = (ph.topEvents || []).map((e) => `${e.event} (${fmtNum(e.n)})`).join(", ") || "none";
    md += `- **${row.name}**: ${fmtNum(ph.events)} events / ${fmtNum(ph.actives)} distinct actives in the window. Top events: ${top}.\n`;
  }

  md += `\n## Open / flags\n`;
  const errs = rows.flatMap((r) => ["capgo", "revenuecat", "posthog"].filter((s) => r[s] && r[s].error).map((s) => `${r.name}/${s}: ${r[s].error}`));
  if (errs.length) for (const e of errs) md += `- ${e}\n`; else md += `- (none this run)\n`;

  return md;
}

// ── Sweep ────────────────────────────────────────────────────────────────────────────────────────
export async function runSweep({ days = DAYS, dryRun = DRY_RUN } = {}) {
  const [capgoToken, posthogKey, revenuecatKey] = await Promise.all([
    kvSecret("capgo-token"),
    kvSecret("posthog-personal-api-key"),
    kvSecret("revenuecat-secret-key"),
  ]);
  const capgoConfigured = Boolean(capgoToken);
  const posthogConfigured = Boolean(posthogKey);
  const revenuecatConfigured = Boolean(revenuecatKey);

  // resolve RevenueCat project/app map ONCE (not per app) — cheap, avoids N redundant /projects calls
  let rcMap = new Map(); // bundleId -> projectId
  let revenuecatGap = null;
  if (revenuecatConfigured) {
    try {
      const apps = await revenuecatProjectApps(revenuecatKey);
      for (const a of apps) if (a.bundleId) rcMap.set(a.bundleId, a.projectId);
      const distinctProjects = new Set(apps.map((a) => a.projectId)).size;
      if (distinctProjects <= 1) revenuecatGap = distinctProjects;
    } catch (e) {
      revenuecatGap = `lookup failed (${String(e.message || e).slice(0, 120)})`;
    }
  }

  const rows = [];
  for (const app of APPS) {
    const row = { key: app.key, name: app.name, bundleId: app.bundleId, posthog: null, capgo: null, revenuecat: null };

    if (app.posthogProjectId) {
      if (!posthogConfigured) row.posthog = { notConfigured: true };
      else { try { row.posthog = { ok: true, ...(await posthogFunnel(app.posthogProjectId, posthogKey, days)) }; } catch (e) { row.posthog = { error: String(e.message || e).slice(0, 160) }; } }
    }

    if (app.bundleId) {
      if (!capgoConfigured) row.capgo = { notConfigured: true };
      else { try { row.capgo = await capgoAppStats(app.bundleId, capgoToken, days); } catch (e) { row.capgo = { error: String(e.message || e).slice(0, 160) }; } }

      if (!revenuecatConfigured) row.revenuecat = { notConfigured: true };
      else {
        const pid = rcMap.get(app.bundleId);
        if (!pid) row.revenuecat = { noProject: true };
        else { try { row.revenuecat = { ok: true, ...(await revenuecatOverview(pid, revenuecatKey)) }; } catch (e) { row.revenuecat = { error: String(e.message || e).slice(0, 160) }; } }
      }
    }

    rows.push(row);
  }

  const date = isoDate();
  const md = composeMarkdown({ date, days, rows, capgoConfigured, revenuecatConfigured, posthogConfigured, revenuecatGap });
  const localPath = OUT_OV || `/tmp/growth-room-${date}.md`;
  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, md);

  let staged = false;
  if (!dryRun) {
    // --s3 (2026-09-03, was a hardcoded --azure override of store.mjs's own safe default). A missing
    // or unreachable bucket throws loud here: store.mjs's --s3 path exits non-zero before any network
    // call if the room has no verified row in s3-blob.mjs's MIRROR table, and putObjectToS3 throws on
    // any non-2xx response — execFileSync re-throws that as a real exception, and this call is NOT
    // wrapped in a try/catch, so growth-room-nightly.sh's `set -e` takes the whole job down loud
    // rather than reporting a silent "ok" for a digest that never actually staged.
    execFileSync("node", [STORE_MJS, "--s3", "--account", COMMONS_ACCOUNT, "--container", COMMONS_CONTAINER, "put", localPath, `${STAGE_PREFIX}/${date}.md`], { stdio: ["ignore", "pipe", "pipe"] });
    staged = true;
  }

  return { date, days, localPath, staged, capgoConfigured, revenuecatConfigured, posthogConfigured, rows };
}

async function main() {
  if (cmd === "status") {
    console.log(JSON.stringify({ apps: APPS.map((a) => ({ key: a.key, name: a.name, bundleId: a.bundleId, posthogProjectId: a.posthogProjectId })), days: DAYS }, null, 2));
    return;
  }
  if (cmd !== "sweep") {
    console.error(`usage: node growth-room.mjs sweep [--days N] [--dry-run] [--json] [--out path]\n       node growth-room.mjs status`);
    process.exit(2);
  }
  const result = await runSweep({ days: DAYS, dryRun: DRY_RUN });
  if (JSON_OUT) {
    console.log(JSON.stringify({ date: result.date, days: result.days, staged: result.staged, capgoConfigured: result.capgoConfigured, revenuecatConfigured: result.revenuecatConfigured, posthogConfigured: result.posthogConfigured }));
  } else {
    console.log(`[growth-room] wrote ${result.localPath}${result.staged ? ` and staged to ${COMMONS_ACCOUNT}/${COMMONS_CONTAINER}/${STAGE_PREFIX}/${result.date}.md` : " (--dry-run, not staged)"}`);
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error(`[growth-room] FATAL: ${e && e.stack || e}`); process.exit(1); });

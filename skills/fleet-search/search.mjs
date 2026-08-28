#!/usr/bin/env node
// fleet-search / search.mjs — ONE call that fans out across everything the fleet doctrine calls
// "INTERNAL" (2026-07-12, Matt directive): company-brain (semantic search over the ledger + the
// mirrored _DOCS/ living docs), the commons _DOCS/ prefix directly (belt-and-suspenders in case
// something hasn't been reindexed yet), and GitHub code search across the org's repos. Built so no
// agent has to remember to make three separate calls before falling back to WebSearch/Exa or asking
// Matt a question he's already answered. Only fall back externally if all three come back empty.
//
// Usage:
//   node search.mjs "<query>" [--n 8] [--rooms memory,legal,finance,commerce,journal] [--agent <role>]
//                    [--no-brain] [--no-docs] [--no-github] [--no-bulletin] [--json]
//
// Design notes:
// - Reuses company-brain's brain.mjs UNCHANGED (spawns it as a subprocess) rather than re-implementing
//   embedding/search/ring-safety logic a second time -- one source of truth for room selection and the
//   MNPI/privileged wall (see brain.mjs's selectRooms()). This script adds breadth, not a second brain.
// - _DOCS/ listing is a direct blob call (same Account-SAS pattern as sunset-protocol/protocol.mjs and
//   the cfo/coo/cro *_store.py scripts) so a doc that was just mirrored but not yet reindexed is still
//   discoverable by name, even before company-brain can find it by content.
// - GitHub search uses the same github-user-pat pattern already used for Actions-secret pushes
//   elsewhere in this repo's history (classic PAT, broader scope than the native gateway GitHub token).
// - Fail-open per source: one source erroring (e.g. GitHub rate limit) never blocks the other two from
//   reporting -- this tool's whole point is "check everything before giving up", so a partial result is
//   still far better than no result.
//
// 2026-07-12 ADDITION: side-effect bulletin check. Every call also checks FLEET-BULLETIN.md for
// entries since this agent's last-known point and prints them. This does NOT reuse bulletin.mjs's
// "since" command -- that tracks a LOCAL per-environment marker file (~/.claude/.octools-bulletin-seen)
// which is unreliable across a fleet spanning multiple engines/containers, and its own "add" command
// was separately found this same day to only edit a local file without ever actually committing/
// pushing despite printing a message implying it had. Both mistakes are avoided here by (a) reading
// FLEET-BULLETIN.md via the authenticated GitHub Contents API (never git clone / raw.githubusercontent
// -- the latter is CDN-cached and served stale content for several minutes on a real incident earlier
// today), and (b) persisting the per-agent "last seen" marker as a durable S3 object (see the STORAGE
// note below) in the shared commons (_BULLETIN_SEEN/<agent>.json), not a local file, so it means the
// same thing regardless of which engine or container is asking. Fail-open: any failure here never
// blocks the three main search results above.
//
// STORAGE (ported to S3, 2026-08-27): the _DOCS/ listing and the _BULLETIN_SEEN/ marker both used to
// go through a hand-rolled Azure Blob account-SAS in this file. That storage account died with the
// Azure subscription deletion (2026-08-13). Now routes through skills/kb-memory/commons-store.mjs (the
// same facade setup/heartbeat.mjs, fleet-dispatch/dispatch.mjs, fleet-medic/medic.mjs, and
// sunset-protocol/protocol.mjs use).
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { cGet, cPut, cListMeta } from "../kb-memory/commons-store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAIN_MJS = join(HERE, "..", "company-brain", "brain.mjs");

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FLAG = (f) => argv.includes(f);
const QUERY = argv.filter((a, i, arr) => !a.startsWith("--") && !(i > 0 && arr[i - 1].startsWith("--"))).join(" ").trim();
const N = parseInt(val("--n", "8"), 10) || 8;
const ROOMS = val("--rooms", "");
const AGENT = (val("--agent", "") || "unknown").toLowerCase();
const JSON_OUT = FLAG("--json");

// ---------------- commons store (S3, same account/container as sunset-protocol + kb-memory) ----------------
async function listDocsPrefix(prefix = "_DOCS/") {
  // cListMeta throws on a genuine failure (never returns "empty" for a failed listing -- see
  // s3-blob.mjs's own contract note); this try/catch is what turns that into the SAME {ok:false,...}
  // fail-open envelope callers already expect, so `main()`'s "one source erroring never blocks the
  // other two" behavior is unchanged by the storage swap.
  try {
    const rows = await cListMeta(prefix);
    const items = rows.map((r) => ({ name: r.name, size: r.size, mtime: r.lastModified }));
    return { ok: true, items };
  } catch (e) { return { ok: false, error: e.message, items: [] }; }
}
function filterDocsByQuery(items, query) {
  if (!query) return items;
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (!terms.length) return items;
  return items.filter((it) => { const n = it.name.toLowerCase(); return terms.some((t) => n.includes(t)); });
}

// ---------------- GitHub code search (classic PAT, org-wide) ----------------
const GH_ORG = "InnerScopeHearing";
let _ghPat; // cached for reuse by the bulletin fetch below

// Mint a fleet-bot GitHub App installation token from Key Vault App creds (github-app-id/
// -private-key/-installation-id) -- the canonical, always-fresh fleet GitHub identity (15k/hr).
// Mirrors regression-ledger/ledger.mjs's fleetBotToken(); kept self-contained. Returns null on any
// failure so callers fall through to the legacy PAT.
async function fleetBotToken() {
  try {
    const iss = (await kvSecret("github-app-id")) || (await kvSecret("github-app-client-id"));
    let key = await kvSecret("github-app-private-key");
    const installationId = await kvSecret("github-app-installation-id");
    if (!iss || !key || !installationId) return null;
    if (key.includes("\\n") && !key.includes("\n")) key = key.replace(/\\n/g, "\n"); // tolerate escaped newlines
    const now = Math.floor(Date.now() / 1000);
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss })}`;
    const jwt = `${input}.${crypto.createSign("RSA-SHA256").update(input).sign(key, "base64url")}`;
    const r = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!r.ok) return null;
    return (await r.json()).token || null;
  } catch { return null; }
}
// Prefer the always-fresh fleet-bot App token; fall back to the legacy github-user-pat only as a
// last resort (it went stale and broke GitHub calls -- the reason for the fleet-bot preference).
async function ghPat() { if (_ghPat === undefined) _ghPat = (await fleetBotToken()) || (await kvSecret("github-user-pat")) || null; return _ghPat; }
async function githubSearch(query, n) {
  try {
    const pat = await ghPat();
    if (!pat) return { ok: false, error: "github-user-pat unavailable", items: [] };
    const q = encodeURIComponent(`${query} org:${GH_ORG}`);
    const r = await fetch(`https://api.github.com/search/code?q=${q}&per_page=${n}`, {
      headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (r.status === 422) return { ok: true, items: [], note: "query syntax rejected by GitHub search (try simpler terms)" };
    if (!r.ok) return { ok: false, error: `search ${r.status}: ${(await r.text()).slice(0, 160)}`, items: [] };
    const j = await r.json();
    const items = (j.items || []).map((it) => ({ repo: it.repository?.full_name, path: it.path, url: it.html_url }));
    return { ok: true, items, total: j.total_count };
  } catch (e) { return { ok: false, error: e.message, items: [] }; }
}

// ---------------- company-brain (subprocess, reuses the real thing unchanged) ----------------
function brainAsk(query, { rooms, agent, n } = {}) {
  const args = ["ask", query, "--n", String(n || 6)];
  if (rooms) args.push("--rooms", rooms);
  if (agent) args.push("--agent", agent);
  try {
    const out = execFileSync("node", [BRAIN_MJS, ...args], { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, raw: out };
  } catch (e) {
    return { ok: false, error: (e.stderr || e.message || "").toString().slice(0, 300), raw: (e.stdout || "").toString() };
  }
}

// ---------------- bulletin side-effect (durable, per-agent, authenticated) ----------------
const ENTRY_RE = /^- (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z) \| (.+)$/;
const SEEN_PREFIX = "_BULLETIN_SEEN/";

async function fetchBulletinEntries() {
  const pat = await ghPat();
  if (!pat) return { ok: false, error: "github-user-pat unavailable", entries: [] };
  const r = await fetch(
    `https://api.github.com/repos/${GH_ORG}/otchealth-claude-tools/contents/FLEET-BULLETIN.md?ref=main`,
    { headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github.v3+json" } }
  );
  if (!r.ok) return { ok: false, error: `bulletin fetch ${r.status}`, entries: [] };
  const j = await r.json();
  const content = Buffer.from(j.content, "base64").toString("utf8");
  const entries = content.split("\n")
    .map((l) => l.match(ENTRY_RE))
    .filter(Boolean)
    .map((m) => ({ ts: m[1], text: m[2] }));
  return { ok: true, entries, sha: j.sha };
}
async function getSeenCount(agent) {
  try {
    const text = await cGet(SEEN_PREFIX + agent + ".json");
    if (text == null) return 0; // null on a genuine 404 (never seen before) -- see cGet's contract
    const j = JSON.parse(text);
    return j.seenCount || 0;
  } catch { return 0; } // malformed JSON or any other read failure: fail open to "nothing seen yet"
}
async function setSeenCount(agent, count) {
  try {
    const body = JSON.stringify({ seenCount: count, updatedAt: new Date().toISOString() });
    await cPut(SEEN_PREFIX + agent + ".json", body, "application/json");
    return true;
  } catch { return false; }
}
async function checkBulletin(agent) {
  const fetched = await fetchBulletinEntries();
  if (!fetched.ok) return { ok: false, error: fetched.error, newEntries: [] };
  const seen = await getSeenCount(agent);
  const newEntries = seen < fetched.entries.length ? fetched.entries.slice(seen) : [];
  if (newEntries.length) await setSeenCount(agent, fetched.entries.length);
  return { ok: true, totalEntries: fetched.entries.length, previouslySeen: seen, newEntries };
}

// ---------------- main ----------------
async function main() {
  if (!QUERY) { console.error('usage: search.mjs "<query>" [--n 8] [--rooms a,b] [--agent <role>] [--no-brain] [--no-docs] [--no-github] [--no-bulletin] [--json]'); process.exit(2); }

  const results = { query: QUERY, brain: null, docs: null, github: null, bulletin: null };

  if (!FLAG("--no-brain")) results.brain = brainAsk(QUERY, { rooms: ROOMS, agent: AGENT, n: N });
  if (!FLAG("--no-docs")) {
    const listing = await listDocsPrefix("_DOCS/");
    results.docs = { ok: listing.ok, error: listing.error, matches: filterDocsByQuery(listing.items, QUERY), allCount: listing.items.length };
  }
  if (!FLAG("--no-github")) results.github = await githubSearch(QUERY, N);
  if (!FLAG("--no-bulletin")) { try { results.bulletin = await checkBulletin(AGENT); } catch (e) { results.bulletin = { ok: false, error: e.message, newEntries: [] }; } }

  const brainEmpty = !results.brain || !results.brain.ok || /No grounded results/i.test(results.brain.raw || "");
  const docsEmpty = !results.docs || !results.docs.ok || results.docs.matches.length === 0;
  const githubEmpty = !results.github || !results.github.ok || results.github.items.length === 0;
  results.allEmpty = brainEmpty && docsEmpty && githubEmpty;

  if (JSON_OUT) { console.log(JSON.stringify(results, null, 2)); return; }

  console.log(`================ FLEET SEARCH (internal-first) ================`);
  console.log(`Q: ${QUERY}\n`);

  console.log(`--- company-brain (ledger + mirrored _DOCS/ content, semantic) ---`);
  if (results.brain) { if (results.brain.ok) console.log(results.brain.raw.trim()); else console.log(`(error: ${results.brain.error})`); }
  else console.log("(skipped)");

  console.log(`\n--- _DOCS/ prefix (direct listing, catches just-mirrored docs before reindex) ---`);
  if (results.docs) {
    if (!results.docs.ok) console.log(`(error: ${results.docs.error})`);
    else if (!results.docs.matches.length) console.log(`(no filename matches; ${results.docs.allCount} total docs in _DOCS/)`);
    else for (const m of results.docs.matches) console.log(`  ${m.name}  (${m.size}b, ${m.mtime.slice(0, 16)})`);
  } else console.log("(skipped)");

  console.log(`\n--- GitHub code search (org:${GH_ORG}) ---`);
  if (results.github) {
    if (!results.github.ok) console.log(`(error: ${results.github.error})`);
    else if (!results.github.items.length) console.log(`(no hits${results.github.note ? "; " + results.github.note : ""})`);
    else for (const it of results.github.items) console.log(`  ${it.repo}/${it.path}\n    ${it.url}`);
  } else console.log("(skipped)");

  if (results.bulletin) {
    console.log(`\n--- FLEET-BULLETIN.md (side effect: entries since agent '${AGENT}' last checked) ---`);
    if (!results.bulletin.ok) console.log(`(error: ${results.bulletin.error})`);
    else if (!results.bulletin.newEntries.length) console.log(`(no new entries; ${results.bulletin.totalEntries} total, ${results.bulletin.previouslySeen} already seen by '${AGENT}')`);
    else {
      console.log(`  ${results.bulletin.newEntries.length} NEW entr${results.bulletin.newEntries.length === 1 ? "y" : "ies"} since '${AGENT}' last checked:`);
      for (const e of results.bulletin.newEntries) console.log(`  [${e.ts}] ${e.text}`);
    }
  }

  console.log(`\n================================================================`);
  if (results.allEmpty) console.log(`ALL THREE SEARCH SOURCES EMPTY -- nothing internal found for this query. Safe to fall back to external search (Exa) or ask Matt, but say plainly that internal search was checked first and came up empty.`);
  else console.log(`At least one internal search source had a hit -- review above before reaching for external search or asking Matt something that may already be answered.`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) { main().catch((e) => { console.error("fleet-search ERROR: " + e.message); process.exit(1); }); }

export { listDocsPrefix, filterDocsByQuery, githubSearch, brainAsk, fetchBulletinEntries, checkBulletin, getSeenCount, setSeenCount };

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
// today), and (b) persisting the per-agent "last seen" marker as a durable Azure Blob object in the
// shared commons (_BULLETIN_SEEN/<agent>.json), not a local file, so it means the same thing regardless
// of which engine or container is asking. Fail-open: any failure here never blocks the three main
// search results above.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { kvSecret } from "../kb-memory/azure-secret.mjs";

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

// ---------------- commons blob (same account/container as sunset-protocol + kb-memory) ----------------
const COMMONS = { accountSecret: "azure-commons-storage-account", keySecret: "azure-commons-storage-key", container: "company-journal" };
const encPath = (name) => name.split("/").map(encodeURIComponent).join("/");
function buildSas(acct, key, write) {
  const sv = "2021-12-02", sp = write ? "rwlc" : "rl", ss = "b", srt = "co";
  const st = new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19) + "Z";
  const se = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 19) + "Z";
  const sts = [acct, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
}
async function commonsCreds() {
  const acct = await kvSecret(COMMONS.accountSecret);
  const key = await kvSecret(COMMONS.keySecret);
  return { acct, key };
}
async function listDocsPrefix(prefix = "_DOCS/") {
  try {
    const { acct, key } = await commonsCreds();
    if (!acct || !key) return { ok: false, error: "commons creds unavailable", items: [] };
    const sas = buildSas(acct, key, false);
    const items = [];
    let marker = "";
    do {
      let url = `https://${acct}.blob.core.windows.net/${COMMONS.container}?restype=container&comp=list&prefix=${encodeURIComponent(prefix)}&${sas}`;
      if (marker) url += `&marker=${encodeURIComponent(marker)}`;
      const r = await fetch(url);
      if (!r.ok) return { ok: false, error: `list ${r.status}`, items };
      const xml = await r.text();
      for (const m of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
        const b = m[1];
        const name = (b.match(/<Name>([^<]+)<\/Name>/) || [])[1];
        const size = +((b.match(/<Content-Length>([^<]+)<\/Content-Length>/) || [])[1] || 0);
        const mtime = (b.match(/<Last-Modified>([^<]+)<\/Last-Modified>/) || [])[1] || "";
        if (name) items.push({ name, size, mtime });
      }
      marker = (xml.match(/<NextMarker>([^<]+)<\/NextMarker>/) || [])[1] || "";
    } while (marker);
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
async function ghPat() { if (_ghPat === undefined) _ghPat = await kvSecret("github-user-pat"); return _ghPat; }
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
    const { acct, key } = await commonsCreds();
    if (!acct || !key) return 0;
    const sas = buildSas(acct, key, false);
    const url = `https://${acct}.blob.core.windows.net/${COMMONS.container}/${encPath(SEEN_PREFIX + agent + ".json")}?${sas}`;
    const r = await fetch(url);
    if (r.status === 404) return 0;
    if (!r.ok) return 0;
    const j = await r.json();
    return j.seenCount || 0;
  } catch { return 0; }
}
async function setSeenCount(agent, count) {
  try {
    const { acct, key } = await commonsCreds();
    if (!acct || !key) return false;
    const sas = buildSas(acct, key, true);
    const url = `https://${acct}.blob.core.windows.net/${COMMONS.container}/${encPath(SEEN_PREFIX + agent + ".json")}?${sas}`;
    const body = JSON.stringify({ seenCount: count, updatedAt: new Date().toISOString() });
    const r = await fetch(url, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": "application/json" }, body });
    return r.ok;
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

export { listDocsPrefix, filterDocsByQuery, githubSearch, brainAsk, fetchBulletinEntries, checkBulletin };

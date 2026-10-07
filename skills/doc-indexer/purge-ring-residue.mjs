#!/usr/bin/env node
// purge-ring-residue.mjs -- remove ring-private CHUNKS from the OPEN commons room (commons-company-journal).
//
// Why (brain-save adjudication round 2, 2026-09-29): a content-free count found 87 `_MEMORY/` chunks
// (exec-feed ledgers), 28 `_HANDOFF/` chunks (cfo.md, clo.md, capital.md) and 17 `_JOURNAL/cfo/` digest
// chunks in commons-company-journal, the room EVERY gateway lane (external ChatGPT/Perplexity
// connectors included) can read. SKIP_PREFIXES is a crawl-time rule; it never purged what an older
// unscoped push had already written.
//
// What it does: for every prefix in push-rules.mjs RING_PRIVATE_PREFIXES, find the chunk ids whose
// `path.keyword` (matched case-insensitively) starts with `otchealthcommons/company-journal/<prefix>` and bulk-delete them. It never
// reads or prints document content (ids and counts only) and never touches S3: the source objects stay
// exactly where they are (the privileged lanes' own tooling and the ring-aware memory-exec room read
// them), so the purge is reversible by construction.
//
//   node skills/doc-indexer/purge-ring-residue.mjs            # dry run: per-prefix counts, deletes nothing
//   node skills/doc-indexer/purge-ring-residue.mjs --commit   # delete, refresh, recount; exit 1 unless all 0
//   --prefixes a/,b/  restrict to a subset of RING_PRIVATE_PREFIXES (never widens it)
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveOpenSearchConfig, deleteDocs, refresh } from "../kb-memory/opensearch-write.mjs";
import { osSearch, osCount } from "./opensearch-client.mjs";
import { RING_PRIVATE_PREFIXES, COMMONS_ROOM, COMMONS_ROOM_PATH_PREFIX, parsePrefixList, pathPrefixQuery } from "./push-rules.mjs";

// ONE definition of the room (push-rules.mjs), shared with the write guard and the canary's prefix list, re-exported under the
// names this tool and its tests already use.
export const ROOM = COMMONS_ROOM;
export const ROOM_PATH_PREFIX = COMMONS_ROOM_PATH_PREFIX;

/** Pure: the prefixes to purge. A --prefixes list may only NARROW the reviewed set, never widen it. */
export function purgePrefixes(raw) {
  if (raw == null || raw === "") return RING_PRIVATE_PREFIXES.slice();
  const want = parsePrefixList(raw);
  const bad = want.filter((p) => !RING_PRIVATE_PREFIXES.includes(p));
  if (bad.length) throw new Error(`--prefixes may only name ring-private prefixes (${RING_PRIVATE_PREFIXES.join(" ")}); refused: ${bad.join(" ")}`);
  return want;
}

// CASE-INSENSITIVE (adjudication round 4, N2): a residue chunk under `_memory/` or `_Journal/` must be found too.
export const prefixQuery = (prefix) => pathPrefixQuery(`${ROOM_PATH_PREFIX}${prefix}`);

/** Pure (N3): the integer count of a `_count` response, or throw: a missing/non-numeric count must never read
 *  as 0, because "0 chunks left" is exactly what the purge's exit code and the canary trust. */
export function countOf(res, label) {
  const c = res && res.json ? res.json.count : undefined;
  if (typeof c !== "number" || !Number.isFinite(c) || c < 0) throw new Error(`_count for ${label}: response carried no numeric count; refusing to read it as 0`);
  return c;
}

async function countPrefix(cfg, prefix) {
  const r = await osCount(cfg, ROOM, prefixQuery(prefix));
  if (!r.ok) throw new Error(`_count HTTP ${r.status} for ${prefix}`);
  return countOf(r, prefix);
}

async function purgePrefix(cfg, prefix, { maxRounds = 200 } = {}) {
  let deleted = 0;
  for (let round = 0; round < maxRounds; round++) {
    const res = await osSearch(cfg, ROOM, { size: 500, _source: false, query: prefixQuery(prefix) });
    if (!res.ok) throw new Error(`_search HTTP ${res.status} for ${prefix}`);
    const ids = (res.json?.hits?.hits || []).map((h) => String(h._id));
    if (!ids.length) break;
    const d = await deleteDocs(ROOM, ids);
    if (!d.ok) throw new Error(`bulk delete failed for ${prefix}: ${JSON.stringify((d.errors || []).slice(0, 2)).slice(0, 200)}`);
    deleted += ids.length;
    await refresh(ROOM);
  }
  return deleted;
}

async function main() {
  const argv = process.argv.slice(2);
  const commit = argv.includes("--commit");
  const i = argv.indexOf("--prefixes");
  const prefixes = purgePrefixes(i >= 0 ? argv[i + 1] : null);
  const cfg = await resolveOpenSearchConfig();
  const before = [];
  for (const p of prefixes) before.push({ prefix: p, count: await countPrefix(cfg, p) });
  console.log(`[purge-ring-residue] ${ROOM} before: ${before.map((b) => `${b.prefix} ${b.count}`).join(", ")}`);
  if (!commit) { console.log("[purge-ring-residue] dry run: nothing deleted (pass --commit to purge)"); return 0; }
  for (const b of before) if (b.count) console.log(`[purge-ring-residue] ${b.prefix}: deleted ${await purgePrefix(cfg, b.prefix)} chunk(s)`);
  await refresh(ROOM);
  const after = [];
  for (const p of prefixes) after.push({ prefix: p, count: await countPrefix(cfg, p) });
  console.log(`[purge-ring-residue] ${ROOM} after: ${after.map((a) => `${a.prefix} ${a.count}`).join(", ")}`);
  return after.every((a) => a.count === 0) ? 0 : 1;
}

// Entry-point test through the symlink-resolved, percent-encoded URL: a plain `file://${argv[1]}` compare
// silently did nothing (exit 0) when launched through a symlinked directory or a path with a space.
function isEntryPoint() { try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } }

if (isEntryPoint()) {
  main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(`[purge-ring-residue] FATAL: ${String((e && e.message) || e).slice(0, 300)}`); process.exitCode = 1; });
}

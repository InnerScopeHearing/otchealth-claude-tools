#!/usr/bin/env node
// backfill-frozen-rooms.mjs — one-shot catch-up for every memory index that froze when Azure AI Search
// stopped receiving writes: measured 2026-08-16, memory-exec plus all 7 ring-memory indexes
// (legal-personal-memory, finance-cfo-memory, commons-{coo,cco,cro,cpo,developer}-memory) stuck at their
// 2026-08-13 doc counts while the Azure-side equivalents kept growing. See semantic.mjs's and
// ring-memory-index/index-ring-memory.mjs's SEARCH_BACKEND dispatcher headers for the full defect this
// closes; this script is the orchestration wrapper around that fix, not new indexing logic.
//
// It calls the SAME two verbs a human/cron would run separately (semantic.mjs's reindex() for memory-exec,
// index-ring-memory.mjs's run("all") for the other 7 rooms), with SEARCH_BACKEND=opensearch REQUIRED --
// this script exists specifically to backfill the OpenSearch side, so running it with SEARCH_BACKEND=azure
// would be a no-op on the very rooms that are not frozen. It reports each room's document count BEFORE and
// AFTER, and the delta, so the catch-up is independently verifiable from its own output, not just "the
// script exited 0".
//
// RUN (the exact command to use):
//   SEARCH_BACKEND=opensearch EMBEDDINGS_PROVIDER=openai node skills/kb-memory/backfill-frozen-rooms.mjs
//
// EMBEDDINGS_PROVIDER=openai is STRONGLY recommended alongside SEARCH_BACKEND=opensearch for a genuine
// Azure-outage backfill: SEARCH_BACKEND alone still calls Azure Foundry for embeddings by default (see
// opensearch-write.mjs's header). This script does not force EMBEDDINGS_PROVIDER -- an operator may
// legitimately want OpenSearch as the destination while Azure Foundry itself is still reachable (e.g. only
// AI Search is being retired for cost, not a full outage) -- but it prints a loud warning when
// EMBEDDINGS_PROVIDER is still the default 'foundry', so that choice is never silent.
//
// Idempotent and safe to re-run, or to run again after a partial/interrupted run: every underlying write
// is an upsert (mergeOrUpload on Azure, update+doc_as_upsert on OpenSearch -- see opensearch-write.mjs's
// header), so re-processing an already-caught-up room never duplicates or corrupts a row.
//
// RING SAFETY: this script does not touch ring membership or access control itself -- it only calls
// reindex()/run("all"), which already enforce it (legal-personal-memory only via index-ring-memory.mjs's
// own RINGS registry, never aggregated into the fleet-learning index; see that file's `private: true`
// convention). This script's own console output prints room NAMES and DOC COUNTS only, never content.
import { reindex, IDX as MEMORY_EXEC_INDEX } from "./semantic.mjs";
import { run as runRings, RINGS, FLEET_INDEX } from "../ring-memory-index/index-ring-memory.mjs";
import * as OS from "./opensearch-write.mjs";

const BACKEND = (process.env.SEARCH_BACKEND || "azure").toLowerCase();
if (BACKEND !== "opensearch") {
  console.error(`backfill-frozen-rooms.mjs is specifically the OpenSearch catch-up -- set SEARCH_BACKEND=opensearch (got "${BACKEND}"). The rooms this backfills are not frozen on Azure.`);
  process.exit(2);
}
if ((process.env.EMBEDDINGS_PROVIDER || "foundry").toLowerCase() !== "openai") {
  console.error(
    "[backfill] WARNING: EMBEDDINGS_PROVIDER is not 'openai' -- embeddings will still call Azure Foundry. " +
      "If this backfill is running because Azure itself is down/blocked, also set EMBEDDINGS_PROVIDER=openai, " +
      "or every embed() call will fail right along with Azure. Continuing anyway (this may be intentional if " +
      "only AI Search, not Foundry, is being retired).",
  );
}

// memory-exec + the 7 ring indexes. FLEET_INDEX is memory-exec too today (see index-ring-memory.mjs's own
// comment on why -- the AI Search service was at its index quota), so this is not a separate 9th room; it
// is exactly the frozen set named in the defect report.
const ROOMS = [MEMORY_EXEC_INDEX, ...RINGS.map((r) => r.index)];

async function countRoom(index) {
  try {
    return await OS.countDocs(index);
  } catch (e) {
    return `error: ${e.message}`;
  }
}

async function refreshRoom(index) {
  try {
    await OS.refresh(index);
  } catch {
    /* best-effort -- an unrefreshed room just reports a slightly stale "after" count, never a crash */
  }
}

async function main() {
  console.log(`[backfill] SEARCH_BACKEND=opensearch. Rooms (${ROOMS.length}): ${ROOMS.join(", ")}`);
  const before = {};
  for (const r of ROOMS) before[r] = await countRoom(r);
  console.log("[backfill] BEFORE counts:", before);

  console.log("[backfill] Step 1/2: semantic.mjs reindex() -- memory-exec, from the shared exec feed...");
  await reindex();

  console.log('[backfill] Step 2/2: ring-memory-index run("all") -- the 7 ring ledgers + their fleet-learning push into memory-exec...');
  const ringResults = await runRings("all");
  for (const r of ringResults) {
    console.log(r.error ? `  RING ${r.label}: ERROR ${r.error}` : `  RING ${r.label}: indexed ${r.indexed}/${r.total} -> ${r.index}${r.fleet ? ` (+ ${FLEET_INDEX})` : " (private)"}`);
  }

  for (const r of ROOMS) await refreshRoom(r);
  const after = {};
  for (const r of ROOMS) after[r] = await countRoom(r);
  console.log("[backfill] AFTER counts:", after);
  const delta = Object.fromEntries(ROOMS.map((r) => [r, typeof before[r] === "number" && typeof after[r] === "number" ? after[r] - before[r] : "n/a"]));
  console.log("[backfill] delta:", delta);
  console.log("[backfill] done.");
}

main().catch((e) => {
  console.error("[backfill] FATAL:", e.message);
  process.exit(1);
});

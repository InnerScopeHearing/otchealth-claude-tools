#!/usr/bin/env node
// index-writer-gate.mjs -- THE GATE THAT WOULD HAVE BLOCKED THE 12-DAY BLINDNESS.
//
// One rule: AN INDEX THAT A RETRIEVAL TOOL CAN QUERY MUST HAVE A WRITER THAT EXISTS AND IS SCHEDULED.
//
// On 2026-07-13 we found `otchealth-brain` (67,645 docs) -- the sole index the gateway's brain_search
// queried, whose own tool description ordered every agent to "Ground answers here and cite" -- had NO
// WRITER ANYWHERE IN EITHER REPO. Not a broken writer. None. It was a one-time snapshot created outside
// IaC, frozen ~2026-07-01, and the whole fleet grounded ~12 days of answers in it. Every monitor we had
// stayed green: a job NAMED `brain-reindex` ran Succeeded every 6h (it refreshes memory-exec), and the
// only freshness signal was a doc-count FLOOR -- which a frozen index never trips, because it does not
// decay, it just stops.
//
// This gate makes that class of failure UNSHIPPABLE. It is a pure structural assertion (no Azure calls
// in --offline mode, so it runs in CI on every PR):
//   (1) every index in expected-indexes.json declares a writer_job,
//   (2) every declared writer_job is a real job in expected-resources.json (so it cannot be a typo or a
//       job that quietly stopped existing -- resource-reconcile.mjs already proves those exist in ARM),
//   (3) every index declares a sortable timestamp_field + a max_age_h, so freshness is MEASURABLE
//       (the room indexes had NO time field at all until 2026-07-13, making staleness structurally
//       undetectable -- you cannot monitor what you did not instrument),
//   (4) nothing in `decommissioning` has crept back into `indexes` (the tombstone stays a tombstone).
//
// Usage: node setup/index-writer-gate.mjs            # structural gate (CI, offline, no creds)
//        node setup/index-writer-gate.mjs --json
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(HERE, f), "utf8"));

/**
 * PURE: given the index registry and the resource manifest, return every violation of the rule.
 * No I/O -> fully unit-testable, and the gate's logic can never drift from its test.
 */
export function auditIndexWriters(indexRegistry, resourceManifest) {
  const violations = [];
  const jobs = new Set(
    (resourceManifest.resources || [])
      .filter((r) => r.type === "containerAppJob")
      .map((r) => r.name),
  );
  const declared = indexRegistry.indexes || [];
  const tombstoned = new Set((indexRegistry.decommissioning || []).map((d) => d.index));

  for (const ix of declared) {
    const at = `index "${ix.index}"`;
    if (!ix.writer_job) {
      violations.push(`${at}: NO WRITER DECLARED. An index with no writer cannot be a source of truth -- this is exactly the otchealth-brain failure. Either register its writer, or move it to "decommissioning" and un-wire it from every retrieval tool.`);
    } else if (!jobs.has(ix.writer_job)) {
      violations.push(`${at}: writer_job "${ix.writer_job}" is NOT a containerAppJob in setup/expected-resources.json. A writer that is not tracked there is a writer that can silently go absent (that manifest is what resource-reconcile.mjs proves against live ARM). Add it, or fix the name.`);
    }
    if (!ix.timestamp_field && !ix.writer_indexer && !ix.writer_indexer_prefix) {
      violations.push(`${at}: no freshness mechanism. Freshness is then UNMEASURABLE and this index can freeze silently forever. Declare a sortable timestamp_field, OR a writer_indexer / writer_indexer_prefix (the S1 pull-indexer whose newest successful run is the freshness signal for a chunked room that carries no doc timestamp).`);
    }
    if (!(Number(ix.max_age_h) > 0)) {
      violations.push(`${at}: no positive max_age_h. Without a staleness SLO the freshness canary has nothing to assert.`);
    }
    if (!ix.service) violations.push(`${at}: no service declared (which AI Search service hosts it?).`);
    if (tombstoned.has(ix.index)) {
      violations.push(`${at}: is listed in BOTH "indexes" and "decommissioning". A tombstoned index must not be re-adopted as a live source of truth.`);
    }
  }

  for (const d of indexRegistry.decommissioning || []) {
    if (d.writer_job) {
      violations.push(`decommissioning index "${d.index}" declares a writer_job -- if it has a writer it is not being decommissioned. Resolve the contradiction.`);
    }
  }

  return violations;
}

function main() {
  const registry = load("expected-indexes.json");
  const resources = load("expected-resources.json");
  const violations = auditIndexWriters(registry, resources);
  const live = (registry.indexes || []).length;
  const dead = (registry.decommissioning || []).length;

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ok: violations.length === 0, live_indexes: live, tombstoned: dead, violations }, null, 2));
  } else {
    console.log(`[index-writer-gate] ${live} live index(es) with declared writers; ${dead} tombstoned.`);
    for (const ix of registry.indexes || []) {
      console.log(`  OK  ${ix.index.padEnd(30)} <- ${String(ix.writer_job).padEnd(24)} (every ${ix.cadence_min}m, stale after ${ix.max_age_h}h, via ${ix.timestamp_field})`);
    }
    for (const d of registry.decommissioning || []) console.log(`  TOMBSTONE  ${d.index} -- ${d.status}`);
    for (const v of violations) console.log(`::error::[index-writer-gate] ${v}`);
  }

  if (violations.length) {
    console.error(`\n[index-writer-gate] FAILED: ${violations.length} violation(s). An index a retrieval tool can query MUST have a real, scheduled writer.`);
    process.exit(1);
  }
  console.log("[index-writer-gate] PASS -- every queryable index has a registered writer and a measurable freshness SLO.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
